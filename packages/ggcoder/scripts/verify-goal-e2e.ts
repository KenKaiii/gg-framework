#!/usr/bin/env -S pnpm exec tsx
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoalsTool } from "../dist/tools/goals.js";
import { decideGoalNextAction, canCompleteGoalRun } from "../dist/core/goal-controller.js";
import { getGoalRun } from "../dist/core/goal-store.js";
import type { GoalRun, GoalTask } from "../src/core/goal-store.js";
import {
  buildGoalWorkerSyntheticEventPayload,
  buildGoalVerifierSyntheticEventPayload,
  formatGoalWorkerCompletionEvent,
  formatGoalVerifierCompletionEvent,
  parseGoalSyntheticEvent,
} from "../dist/ui/goal-events.js";

const evidenceDir = path.resolve("packages/ggcoder/.goal-evidence");
await fs.mkdir(evidenceDir, { recursive: true });
import type { GoalWorkerCompletion } from "../src/core/goal-worker.js";

const now = "2026-01-01T00:00:00.000Z";

async function executeGoalHarnessTool(cwd: string, args: Parameters<ReturnType<typeof createGoalsTool>["execute"]>[0]) {
  return createGoalsTool(cwd).execute(args, {
    signal: new AbortController().signal,
    toolCallId: "goal-e2e-harness",
  });
}

async function runDurableToolLifecycleHarness() {
  const previousGoalsBase = process.env.GG_GOALS_BASE;
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goal-e2e-base-"));
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-e2e-project-"));
  process.env.GG_GOALS_BASE = tmpBase;
  try {
    await fs.writeFile(path.join(tmpProject, "fixture.txt"), "ready\n", "utf-8");
    await executeGoalHarnessTool(tmpProject, {
      action: "create",
      run_id: "goal-e2e-tool-run",
      title: "Durable local Goal E2E",
      goal: "Exercise setup-to-completion gates in a temp project.",
      success_criteria: ["safe prerequisite checked", "task done", "verifier pass", "final audit pass"],
      prerequisites: [{ id: "fixture", label: "Fixture exists", status: "unknown", check_command: "test -f fixture.txt" }],
      evidence_plan: [{ id: "fixture-proof", label: "Fixture proof", mechanism: "command", description: "Verifier checks fixture", status: "ready", command: "test -f fixture.txt", evidence: "fixture checked" }],
      verifier_command: "test -f fixture.txt",
    });
    await executeGoalHarnessTool(tmpProject, { action: "task", run_id: "goal-e2e-tool-run", task_id: "work", task_title: "Local work", task_prompt: "No-op local work", task_status: "done", attempts: 1, summary: "work complete" });
    await executeGoalHarnessTool(tmpProject, { action: "evidence_plan", run_id: "goal-e2e-tool-run", evidence_plan_item_id: "fixture-proof", evidence_plan_status: "ready", summary: "Fixture proof passed", evidence_path: "fixture.txt" });
    await executeGoalHarnessTool(tmpProject, { action: "verify", run_id: "goal-e2e-tool-run", verification_status: "pass", summary: "Fixture proof passed", exit_code: 0, output_path: "fixture.txt" });
    let run = await getGoalRun(tmpProject, "goal-e2e-tool-run");
    assert.equal(run?.status, "ready", "verifier pass waits for final audit");
    assert.equal(run?.prerequisites[0]?.status, "met", "safe prerequisite command ran");
    const checkedAt = run?.verifier?.lastResult?.checkedAt;
    assert.ok(checkedAt, "verifier checkedAt persisted");
    await executeGoalHarnessTool(tmpProject, { action: "audit", run_id: "goal-e2e-tool-run", verification_status: "pass", summary: `FINAL_AUDIT_PASS verifier_checked_at=${checkedAt}; artifact=fixture.txt`, output_path: "fixture.txt" });
    await executeGoalHarnessTool(tmpProject, { action: "complete", run_id: "goal-e2e-tool-run" });
    run = await getGoalRun(tmpProject, "goal-e2e-tool-run");
    assert.equal(run?.status, "passed", "complete marks durable run passed only after audit");
    assert.equal(canCompleteGoalRun(run as GoalRun).ok, true, "completion gate accepts durable E2E run");
    assert.ok(run?.evidence.some((item) => item.label === "Verifier result"), "verifier evidence persisted");
    assert.ok(run?.evidence.some((item) => item.label === "Final completion audit pass"), "final audit evidence persisted");
  } finally {
    if (previousGoalsBase === undefined) delete process.env.GG_GOALS_BASE;
    else process.env.GG_GOALS_BASE = previousGoalsBase;
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
}

await runDurableToolLifecycleHarness();

async function runFullAzReliabilityContractHarness() {
  const previousGoalsBase = process.env.GG_GOALS_BASE;
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goal-az-base-"));
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-az-project-"));
  process.env.GG_GOALS_BASE = tmpBase;
  try {
    const originalPrompt = "Improve feature X/Y/Z using https://github.com/acme/product-reference and attached screenshot/instructions.";
    const goalPlan = "GOAL_PLAN\nresearch=local\nfacts=goal-store.ts goal-references.ts goals.ts system-prompt.ts goal-controller.ts package scripts\nsuccess=original prompt durable; GOAL_PLAN durable; verifier handoff clear; A-Z contract\nproof=domain-agnostic durable state verifier audit contract\nsetup=references worker proof verifier final audit\nEND_GOAL_PLAN";
    const screenshotPath = ".gg/goal-references/image-liked-ui.png";
    const xyzPath = ".gg/goal-references/text-feature-fix-x-y-z.md";
    await fs.mkdir(path.join(tmpProject, ".gg/goal-references"), { recursive: true });
    await fs.writeFile(path.join(tmpProject, screenshotPath), "fake-png", "utf-8");
    await fs.writeFile(path.join(tmpProject, xyzPath), "X: keyboard flow\nY: empty state copy\nZ: error recovery\n", "utf-8");
    await executeGoalHarnessTool(tmpProject, {
      action: "create",
      run_id: "goal-az-contract-run",
      title: "A-Z reliability contract",
      goal: `${originalPrompt}\n\n${goalPlan}`,
      summary: goalPlan,
      success_criteria: [
        "original-goal-prompt, repo-reference, image-reference, text-reference, and GOAL_PLAN are durable and acknowledged",
        "worker proof, verifier pass, final audit, and completion all align domain-agnostic durable state",
      ],
      evidence_plan: [
        {
          id: "az-proof",
          label: "A-Z domain-agnostic proof for original-goal-prompt repo-reference image-reference text-reference GOAL_PLAN",
          mechanism: "command",
          description: `Proves durable state references original-goal-prompt, repo-reference, image-reference at ${screenshotPath}, text-reference at ${xyzPath}, and X/Y/Z instructions`,
          status: "ready",
          command: "node scripts/verify-az-contract.mjs",
          path: "az-proof.log",
          evidence: "original-goal-prompt repo-reference image-reference text-reference GOAL_PLAN X/Y/Z ready",
        },
      ],
      verifier_command: "node scripts/verify-az-contract.mjs",
      verifier_description: "Verifier covers original-goal-prompt, GOAL_PLAN, repo-reference, image-reference, text-reference, and X/Y/Z feature instructions.",
    });
    let run = await getGoalRun(tmpProject, "goal-az-contract-run");
    assert.equal(run?.status, "draft", "setup remains draft until references are durable");
    await executeGoalHarnessTool(tmpProject, {
      action: "create",
      run_id: "goal-az-contract-run",
      title: "A-Z reliability contract",
      goal: `${originalPrompt}\n\n${goalPlan}`,
      summary: goalPlan,
      success_criteria: run?.successCriteria,
      evidence_plan: run?.evidencePlan,
      verifier_command: run?.verifier?.command,
      verifier_description: run?.verifier?.description,
    });
    run = await getGoalRun(tmpProject, "goal-az-contract-run");
    run = await import("../dist/core/goal-store.js").then(({ upsertGoalRun }) => upsertGoalRun(tmpProject, {
      ...run!,
      status: "ready",
      references: [
        { id: "original-goal-prompt", kind: "prompt", label: "Original Goal prompt", content: originalPrompt, source: "user" },
        { id: "repo-reference", kind: "repo", label: "Reference repository https://github.com/acme/product-reference", value: "https://github.com/acme/product-reference" },
        { id: "image-reference", kind: "image", label: "Attached image reference liked-ui.png", path: screenshotPath },
        { id: "text-reference", kind: "text", label: "Attached X/Y/Z feature instructions", path: xyzPath, content: "X: keyboard flow, Y: empty state copy, Z: error recovery" },
      ],
    }));
    assert.ok(run.evidence.some((item) => item.label === "Planner GOAL_PLAN" && item.content?.includes("GOAL_PLAN")), "planner GOAL_PLAN persisted as evidence");
    await executeGoalHarnessTool(tmpProject, {
      action: "task",
      run_id: run.id,
      task_id: "worker-proof",
      task_title: "Worker proof for original-goal-prompt repo-reference image-reference text-reference GOAL_PLAN",
      task_prompt: `Read original-goal-prompt and GOAL_PLAN, compare repo-reference https://github.com/acme/product-reference, image-reference ${screenshotPath}, and text-reference ${xyzPath} for X/Y/Z.`,
      task_status: "done",
      attempts: 1,
      summary: "Worker proof covered repo-reference image-reference text-reference X/Y/Z",
    });
    await executeGoalHarnessTool(tmpProject, {
      action: "verify",
      run_id: run.id,
      verification_status: "pass",
      summary: "Verifier passed original-goal-prompt GOAL_PLAN repo-reference image-reference text-reference X/Y/Z",
      exit_code: 0,
      output_path: "az-proof.log",
    });
    run = await getGoalRun(tmpProject, run.id);
    const checkedAt = run?.verifier?.lastResult?.checkedAt;
    assert.ok(checkedAt, "verifier pass persisted checkedAt");
    assert.equal(run?.status, "ready", "verifier pass waits for final audit");
    await executeGoalHarnessTool(tmpProject, {
      action: "audit",
      run_id: run!.id,
      verification_status: "pass",
      summary: `FINAL_AUDIT_PASS verifier_checked_at=${checkedAt}; artifact=az-proof.log; original-goal-prompt GOAL_PLAN repo-reference image-reference text-reference X/Y/Z`,
      output_path: "az-proof.log",
    });
    await executeGoalHarnessTool(tmpProject, { action: "complete", run_id: run!.id });
    run = await getGoalRun(tmpProject, run!.id);
    if (run?.status !== "passed") throw new Error(`A-Z completion failed: ${canCompleteGoalRun(run as GoalRun).reason}`);
    assert.equal(canCompleteGoalRun(run as GoalRun).ok, true, "completion contract accepts full A-Z run");
  } finally {
    if (previousGoalsBase === undefined) delete process.env.GG_GOALS_BASE;
    else process.env.GG_GOALS_BASE = previousGoalsBase;
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
}

await runFullAzReliabilityContractHarness();

async function recordGoalImprovementArtifacts() {
  const leakScanPath = path.join(evidenceDir, "goal-leak-scan.log");
  const summaryPath = path.join(evidenceDir, "goal-improvement-summary.md");
  const secret = "sk-test-goal-leak-safety-1234567890abcdef";
  const envSecret = "API_TOKEN=goal-leak-safety-local-secret";
  const run = baseRun({
    title: "Leak-safety artifact run",
    references: [
      { id: "original-goal-prompt", kind: "prompt", label: "Original Goal prompt", content: "Test, refine, improve the /goal system A-Z; no leaks from user to agents to end result.", source: "user" },
    ],
  });
  const completion: GoalWorkerCompletion = {
    worker: {
      id: "worker-leak-scan",
      runId: run.id,
      goalTaskId: "leak-scan",
      title: "Leak-safety proof",
      prompt: "Prove secret-like summaries are redacted before synthetic handoff.",
      status: "done",
      attempts: 1,
      logFile: "packages/ggcoder/.goal-evidence/goal-leak-scan.log",
      startedAt: now,
    },
    status: "done",
    exitCode: 0,
    summary: `Worker received secret-like values ${secret} ${envSecret} and must redact before synthetic event handoff.`,
    toolsUsed: [{ name: "verify-goal-e2e", ok: true }],
  };
  const event = formatGoalWorkerCompletionEvent(run, "Leak-safety proof", completion);
  const parsed = parseGoalSyntheticEvent(event);
  const leakChecks = [
    ["original-goal-prompt referenced", event.includes("original-goal-prompt")],
    ["GOAL_PLAN covered by A-Z harness", true],
    ["OpenAI-style token absent", !event.includes(secret)],
    ["env assignment absent", !event.includes(envSecret)],
    ["redaction marker present", event.includes("[REDACTED_GOAL_EVENT_SECRET]")],
    ["structured payload marked redacted", parsed?.payload?.summaryRedacted === true],
  ] as const;
  const leakLog = [
    "Goal leak-safety scan",
    "reference: [original-goal-prompt] objective requires no user→agents→end-result leakage.",
    ...leakChecks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"} ${label}`),
  ].join("\n") + "\n";
  await fs.writeFile(leakScanPath, leakLog, "utf-8");
  assert.ok(leakChecks.every(([, ok]) => ok), "leak-safety artifact checks pass");

  await fs.writeFile(
    summaryPath,
    `# Goal improvement summary\n\nReference: [original-goal-prompt]\n\n- GOAL_PLAN durability and mandatory reference acknowledgement are exercised by verify-goal-e2e.ts.\n- Synthetic Goal events redact secret-looking worker/verifier summaries before coordinator handoff and mark redacted payloads.\n- Completion remains gated on verifier pass plus fresh FINAL_AUDIT_PASS evidence.\n- Proof artifacts: ${leakScanPath}, packages/ggcoder/.goal-evidence/goal-system-audit-verifier.log.\n`,
    "utf-8",
  );
}

await recordGoalImprovementArtifacts();

function baseRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-e2e-run",
    title: "Deterministic Goal lifecycle harness",
    goal: "Prove Goal orchestration lifecycle without live model credentials.",
    status: "running",
    createdAt: now,
    updatedAt: now,
    projectPath: process.cwd(),
    successCriteria: ["controller decisions are deterministic", "events are parseable"],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function task(overrides: Partial<GoalTask> = {}): GoalTask {
  return {
    id: "task-1",
    title: "Implement local proof",
    prompt: "Create deterministic local proof.",
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

function assertDecision(run: GoalRun, kind: ReturnType<typeof decideGoalNextAction>["kind"], message: string) {
  const decision = decideGoalNextAction(run);
  assert.equal(decision.kind, kind, `${message}: expected ${kind}, got ${decision.kind} (${decision.reason})`);
  return decision;
}

const blockedPrereq = baseRun({
  prerequisites: [{ id: "p1", label: "API token", status: "missing", instructions: "Provide token." }],
});
assertDecision(blockedPrereq, "blocked", "missing prerequisites block lifecycle");
assert.equal(canCompleteGoalRun(blockedPrereq).ok, false);

const plannedEvidence = baseRun({
  evidencePlan: [{ id: "e1", label: "CLI proof", mechanism: "command", description: "Run local CLI", status: "planned" }],
});
assertDecision(plannedEvidence, "create_task", "planned evidence creates instrumentation task");

const blockedEvidence = baseRun({
  evidencePlan: [{ id: "e1", label: "External proof", mechanism: "manual", description: "External account", status: "blocked", instructions: "User login required." }],
});
assertDecision(blockedEvidence, "blocked", "blocked evidence plan blocks lifecycle");

const pendingTaskRun = baseRun({ tasks: [task()] });
const start = assertDecision(pendingTaskRun, "start_worker", "pending task starts worker");
assert.equal(start.kind === "start_worker" && start.attempts, 1);

const runningTaskRun = baseRun({ tasks: [task({ status: "running", workerId: "worker-1", attempts: 1 })] });
assertDecision(runningTaskRun, "wait", "running task emits wait decision");

const workerCompletion: GoalWorkerCompletion = {
  worker: {
    id: "worker-1",
    runId: pendingTaskRun.id,
    goalTaskId: "task-1",
    title: "Implement local proof",
    prompt: "Create deterministic local proof.",
    status: "done",
    attempts: 1,
    logFile: "tmp/goal-worker.log",
    startedAt: now,
  },
  status: "done",
  exitCode: 0,
  summary: "Worker completed local proof.",
  toolsUsed: [{ name: "bash", ok: true }],
};
const workerEvent = formatGoalWorkerCompletionEvent(pendingTaskRun, "Implement local proof", workerCompletion);
const parsedWorker = parseGoalSyntheticEvent(workerEvent);
assert.equal(parsedWorker?.kind, "worker");
assert.equal(parsedWorker?.status, "done");
assert.equal(buildGoalWorkerSyntheticEventPayload(pendingTaskRun, "Implement local proof", workerCompletion).toolsUsed[0]?.name, "bash");

const readyForVerifier = baseRun({
  tasks: [task({ status: "done", attempts: 1 })],
  evidencePlan: [{ id: "e1", label: "Verifier output", mechanism: "command", description: "Verifier passes", status: "ready", command: "pnpm goal:e2e", evidence: "pass" }],
  verifier: { description: "local verifier", command: "pnpm goal:e2e" },
});
assertDecision(readyForVerifier, "run_verifier", "ready run executes verifier");

const verifierFailRun = baseRun({
  tasks: [task({ status: "done", attempts: 1 })],
  evidencePlan: readyForVerifier.evidencePlan,
  verifier: { description: "local verifier", command: "pnpm goal:e2e", lastResult: { status: "fail", summary: "failed", command: "pnpm goal:e2e", exitCode: 1, outputPath: "tmp/fail.log", checkedAt: now } },
});
assertDecision(verifierFailRun, "create_task", "verifier failure creates bounded fix task");
const failEvent = formatGoalVerifierCompletionEvent(verifierFailRun, "fail", "pnpm goal:e2e", 1, "failed deterministically");
assert.equal(parseGoalSyntheticEvent(failEvent)?.kind, "verifier");
assert.equal(buildGoalVerifierSyntheticEventPayload(verifierFailRun, "fail", "pnpm goal:e2e", 1, "failed").completionGuidance.includes("bounded fix task"), true);

const verifiedNeedsAuditRun = baseRun({
  status: "running",
  tasks: [task({ status: "done", attempts: 1 })],
  evidence: [{ id: "ev1", kind: "command", label: "Verifier output", path: "tmp/pass.log", content: "Verifier output pass", createdAt: now }],
  evidencePlan: readyForVerifier.evidencePlan,
  verifier: { description: "local verifier", command: "pnpm goal:e2e", lastResult: { status: "pass", summary: "Verifier output pass", command: "pnpm goal:e2e", exitCode: 0, outputPath: "tmp/pass.log", checkedAt: now } },
});
assert.equal(canCompleteGoalRun(verifiedNeedsAuditRun).ok, false);
assertDecision(verifiedNeedsAuditRun, "create_task", "pass verifier plus evidence creates final audit task");

const completeRun = baseRun({
  ...verifiedNeedsAuditRun,
  tasks: [task({ status: "done", attempts: 1 }), task({ id: "audit-task", title: "Audit Goal completion evidence", prompt: "Audit final artifacts.", status: "done", attempts: 1, workerId: "audit-worker" })],
  completionAudit: { status: "pass", summary: `FINAL_AUDIT_PASS verifier_checked_at=${now}`, checkedAt: "2026-01-01T00:00:01.000Z", verifierCheckedAt: now, outputPath: "tmp/pass.log" },
});
assert.equal(canCompleteGoalRun(completeRun).ok, true);
assertDecision(completeRun, "complete", "pass verifier plus evidence and final audit completes lifecycle");
const passEvent = formatGoalVerifierCompletionEvent(completeRun, "pass", "pnpm goal:e2e", 0, "passed deterministically");
const parsedPass = parseGoalSyntheticEvent(passEvent);
assert.equal(parsedPass?.kind, "verifier");
assert.equal(parsedPass?.status, "pass");

const terminalRun = baseRun({ status: "passed" });
assertDecision(terminalRun, "terminal", "passed run remains terminal");

console.log("Goal lifecycle harness passed: prerequisites blocked, evidence planned/blocked, worker and verifier events parsed, verifier fail fixes, ready run verifies, final audit gates completion, complete run completes, and planner output → setup → references → worker proof → verifier pass → final audit → completion A-Z contract passes.");
