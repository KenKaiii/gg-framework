// Headless END-TO-END /goal run. Replicates the orchestration loop using the
// REAL core functions (controller decisions, real worker subprocesses in git
// worktrees, stage->verify->fast-forward integration, verifier, audit) against a
// throwaway git repo with a concrete, locally-verifiable goal. The point is to
// drive the full machinery and surface real issues.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const cliPath = join(distDir, "cli.js");

const store = await import(join(distDir, "core", "goal-store.js"));
const controller = await import(join(distDir, "core", "goal-controller.js"));
const engine = await import(join(distDir, "core", "goal-engine.js"));
const workerMod = await import(join(distDir, "core", "goal-worker.js"));
const integration = await import(join(distDir, "core", "goal-integration.js"));
const verifierMod = await import(join(distDir, "core", "goal-verifier.js"));

const PROVIDER = process.argv.includes("--gpt") ? "openai" : "anthropic";
const MODEL = PROVIDER === "openai" ? "gpt-5.5" : "claude-opus-4-8";
const RUN_ID = "e2e-slugify";
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "goal-e2e-"));
  const proj = join(root, "project");
  await mkdir(join(proj, "src"), { recursive: true });
  await mkdir(join(proj, "test"), { recursive: true });
  await writeFile(
    join(proj, "package.json"),
    JSON.stringify({ name: "slugfix", version: "1.0.0", type: "module" }, null, 2) + "\n",
  );
  await writeFile(
    join(proj, "src", "slugify.js"),
    "export function slugify(input) {\n  // TODO: implement\n  return input;\n}\n",
  );
  await writeFile(
    join(proj, "test", "slugify.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { slugify } from "../src/slugify.js";',
      "",
      'test("lowercases and hyphenates spaces", () => {',
      '  assert.equal(slugify("Hello World"), "hello-world");',
      "});",
      'test("strips punctuation", () => {',
      '  assert.equal(slugify("Hello, World!"), "hello-world");',
      "});",
      'test("collapses repeated separators", () => {',
      '  assert.equal(slugify("a   b___c"), "a-b-c");',
      "});",
      'test("trims leading/trailing separators", () => {',
      '  assert.equal(slugify("  --Hi--  "), "hi");',
      "});",
      'test("handles unicode-ish punctuation", () => {',
      '  assert.equal(slugify("Café & Tea"), "cafe-tea");',
      "});",
      "",
    ].join("\n"),
  );
  await git(proj, ["init", "-b", "main"]);
  await git(proj, ["config", "user.email", "e2e@test.local"]);
  await git(proj, ["config", "user.name", "E2E"]);
  await git(proj, ["add", "-A"]);
  await git(proj, ["commit", "-m", "base: failing slugify + tests"]);
  return { root, proj };
}

async function reload() {
  return (await store.loadGoalRuns(process.env.GG_GOAL_PROJECT_PATH)).find((r) => r.id === RUN_ID);
}

async function recordVerifierResult(projectPath, verification) {
  const status = verification.status;
  const latest = await reload();
  const updated = await store.upsertGoalRun(projectPath, {
    ...latest,
    verifier: {
      ...latest.verifier,
      description: latest.verifier?.description ?? "Goal verifier",
      command: latest.verifier?.command,
      lastResult: verification,
    },
    ...(status === "pass"
      ? {
          completionAudit: {
            status: "unknown",
            summary: "pending",
            checkedAt: verification.checkedAt,
            verifierCheckedAt: verification.checkedAt,
            ...(verification.outputPath ? { outputPath: verification.outputPath } : {}),
          },
        }
      : {}),
    status: "ready",
  });
  await store.appendGoalEvidence(projectPath, RUN_ID, {
    kind: "command",
    label: `Verifier ${status}`,
    content: (verification.summary ?? "").slice(0, 2000),
    ...(verification.outputPath ? { path: verification.outputPath } : {}),
  });
  log(`  verifier ${status}`);
  return updated;
}

async function runWorker(projectPath, task) {
  const inMain = task.title === controller.APPLY_INTEGRATION_TO_MAIN_TASK_TITLE;
  log(`  start_worker "${task.title}" (isolate=${!inMain})`);
  const rec = await workerMod.startGoalWorker({
    cwd: projectPath,
    provider: PROVIDER,
    model: MODEL,
    goalRunId: RUN_ID,
    goalTaskId: task.id,
    taskTitle: task.title,
    prompt: task.prompt,
    maxTurns: 14,
    timeoutMs: 6 * 60 * 1000,
    isolateWorktree: inMain ? false : undefined,
  });
  const deadline = Date.now() + 7 * 60 * 1000;
  while (rec.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
  }
  // The worker close handler updates the store (task status, cleared
  // activeWorkerId, candidate) asynchronously AFTER rec.status flips. Wait for
  // the store to reflect a terminal task state before continuing, so the
  // controller never sees a transient half-updated run.
  for (let i = 0; i < 40; i += 1) {
    const run = await reload();
    const t = run?.tasks.find((x) => x.id === task.id);
    if (run && !run.activeWorkerId && t && t.status !== "running" && t.status !== "verifying") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`  worker ${rec.id} -> ${rec.status} (exit ${rec.exitCode}) activity=${rec.currentActivity ?? "-"}`);

  // Stamp the substantive-worker clock (typed verifier/audit staleness) for any
  // worker that is neither the final audit nor an integration task.
  if (!inMain && task.title !== "Audit Goal completion evidence") {
    await store.recordGoalSubstantiveWorker(projectPath, RUN_ID, new Date().toISOString());
  }

  // Mirror the orchestrator's deterministic integration gate: after an apply
  // worker, confirm main contains the changes and record canonical evidence.
  if (rec.status === "done" && task.title === controller.APPLY_INTEGRATION_TO_MAIN_TASK_TITLE) {
    const run = await reload();
    const baseRef = run.tasks.map((t) => t.candidate?.baseRef).find((b) => !!b);
    if (baseRef) {
      const confirmed = await integration.confirmAndCommitMainIntegration({
        projectPath,
        baseRef,
        message: `goal(${RUN_ID}): commit integrated changes`,
      });
      log(`  integration confirm -> applied=${confirmed.applied} committed=${confirmed.committed} ${confirmed.reason}`);
      if (confirmed.applied) {
        await store.setGoalIntegrationState(projectPath, RUN_ID, {
          status: confirmed.committed ? "committed" : "applied",
          baseRef,
          ...(confirmed.sha ? { headSha: confirmed.sha } : {}),
          files: confirmed.files,
          updatedAt: new Date().toISOString(),
        });
        await store.appendGoalEvidence(projectPath, RUN_ID, {
          kind: "summary",
          label: "Integrated worktree applied to main",
          content: `Deterministic: commit=${confirmed.sha ?? ""}; files=${confirmed.files.join(", ")}`,
        });
        await store.appendGoalEvidence(projectPath, RUN_ID, {
          kind: "summary",
          label: "Integrated Goal changes committed",
          content: `Deterministic integration commit=${confirmed.sha ?? ""}.`,
        });
      }
    }
  }
}

async function main() {
  const { root, proj } = await makeRepo();
  const goalsBase = await mkdtemp(join(tmpdir(), "goal-e2e-store-"));
  process.env.GG_GOALS_BASE = goalsBase;
  process.env.GG_GOAL_PROJECT_PATH = proj;
  process.argv[1] = cliPath; // so startGoalWorker spawns the real CLI

  await store.upsertGoalRun(proj, {
    id: RUN_ID,
    title: "Implement slugify",
    goal: "Implement slugify(str) in src/slugify.js so `node --test` passes.",
    status: "ready",
    successCriteria: ["`node --test` passes with a correct slugify implementation"],
    prerequisites: [],
    harness: [],
    evidencePlan: [
      {
        id: "tests-green",
        label: "node --test green",
        mechanism: "test",
        description: "node --test passes for slugify",
        status: "planned",
        command: "node --test",
      },
    ],
    verifier: { description: "node test runner", command: "node --test" },
    tasks: [],
    evidence: [],
    blockers: [],
  });
  await store.updateGoalTask(proj, RUN_ID, "impl-slugify", {
    id: "impl-slugify",
    title: "Implement slugify to pass tests",
    prompt:
      "Implement the slugify(input) function in src/slugify.js (keep the ESM export) so the " +
      "existing tests in test/slugify.test.js pass: lowercase; spaces and underscores become " +
      "single hyphens; strip punctuation; collapse repeated separators; trim leading/trailing " +
      "hyphens; normalize accented letters (café -> cafe). Run `node --test` until green, then stop.",
    status: "pending",
    attempts: 0,
    integration: "candidate",
    expectedChangedScope: ["src/**"],
  });

  log(`E2E run on ${PROVIDER}/${MODEL}; project=${proj}`);

  // Thin adapter over the SAME pure engine the React hook drives: supply a
  // GoalEffects backed by the real store/worker/verifier/integration modules.
  const effects = {
    now: () => new Date().toISOString(),
    log: (_level, msg) => log(`  ${msg}`),
    reload: () => reload(),
    startWorker: async (task) => {
      await runWorker(proj, task);
    },
    runVerifier: async (command, cwd) => {
      const v = await verifierMod.runGoalVerifierCommand({
        cwd: cwd ?? proj,
        runId: RUN_ID,
        command,
        timeoutMs: 60_000,
      });
      return v.verification;
    },
    recordVerifierResult: async (verification) => recordVerifierResult(proj, verification),
    stageIntegration: async (run) => {
      const staged = await integration.stageGoalIntegration({ projectPath: proj, run });
      log(`  stageGoalIntegration -> ${staged.status} ${staged.reason ?? ""}`);
      return staged;
    },
    finalizeIntegration: async (staging) =>
      integration.finalizeStagedIntegration({ projectPath: proj, staging }),
    discardIntegration: async (staging) =>
      integration.discardStagedIntegration({ projectPath: proj, staging }),
    setIntegrationState: async (state) => {
      await store.setGoalIntegrationState(proj, RUN_ID, state);
    },
    createTask: async (title, prompt) => {
      await store.updateGoalTask(proj, RUN_ID, `auto-${Date.now()}`, {
        title,
        prompt,
        status: "pending",
      });
      log(`  created auto-task "${title}"`);
    },
    appendEvidence: async (entry) => {
      await store.appendGoalEvidence(proj, RUN_ID, entry);
    },
  };

  let result = "budget-exhausted";
  let run = await reload();
  for (let step = 0; step < 24; step += 1) {
    const decision = controller.decideGoalNextAction(run);
    log(`#${step} decision=${decision.kind} :: ${(decision.reason ?? "").slice(0, 150)}`);
    try {
      const cc = controller.canCompleteGoalRun(run);
      const fresh = controller.hasFreshGoalCompletionAudit(run);
      log(`   canComplete=${cc.ok} :: ${(cc.reason ?? "").slice(0, 160)}`);
      log(`   freshAudit=${fresh.ok} :: ${(fresh.reason ?? "").slice(0, 160)}`);
    } catch {
      /* helpers optional */
    }
    const stepResult = await engine.stepGoalRun(run, effects);
    run = await reload();
    if (stepResult.outcome === "complete") {
      result = "COMPLETE";
      break;
    }
    if (stepResult.outcome === "terminal" || stepResult.outcome === "blocked") {
      result = `STOP(${stepResult.outcome}): ${(decision.reason ?? "").slice(0, 300)}`;
      break;
    }
    if (stepResult.outcome === "wait") {
      // Transient settling (store catching up); briefly retry rather than bail.
      await new Promise((r) => setTimeout(r, 1000));
      run = await reload();
    }
  }

  const finalRun = await reload();
  log(`\n==== RESULT: ${result} ====`);
  log(`run.status=${finalRun?.status}; verifier=${finalRun?.verifier?.lastResult?.status}; audit=${finalRun?.completionAudit?.status}`);
  log(`tasks: ${finalRun?.tasks.map((t) => `${t.title}[${t.status}]`).join(", ")}`);
  log(`HEAD slugify in main:`);
  try {
    console.log(await execFileAsync("node", ["--test"], { cwd: proj }).then((r) => "node --test EXIT 0"));
  } catch (e) {
    console.log("node --test FAILED:", String(e).slice(0, 300));
  }
  console.log("\n--- src/slugify.js (main) ---");
  console.log(await execFileAsync("cat", ["src/slugify.js"], { cwd: proj }).then((r) => r.stdout).catch(() => "(missing)"));
  log(`evidence labels: ${finalRun?.evidence.map((e) => e.label).join(" | ")}`);

  log(`(store kept for inspection: ${goalsBase})`);
}

await main().catch((e) => {
  console.error("E2E driver error:", e);
  process.exit(1);
});
