import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolExecuteResult } from "@kenkaiiii/gg-agent";
import { createGoalsTool } from "./goals.js";
import { decideGoalNextAction } from "../core/goal-controller.js";
import {
  getActiveGoalRun,
  getGoalRun,
  upsertGoalRun,
  type GoalReference,
} from "../core/goal-store.js";

let tmpBase: string;
let tmpProject: string;

async function executeGoals(
  args: Parameters<ReturnType<typeof createGoalsTool>["execute"]>[0],
): Promise<ToolExecuteResult> {
  return createGoalsTool(tmpProject).execute(args, {
    signal: new AbortController().signal,
    toolCallId: "test-call",
  });
}

beforeEach(async () => {
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goals-tool-test-base-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goals-tool-test-project-"));
  process.env.GG_GOALS_BASE = tmpBase;
});

afterEach(async () => {
  delete process.env.GG_GOALS_BASE;
  await fs.rm(tmpBase, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("goals tool state guards", () => {
  it("checks runnable prerequisites during create before marking the Goal ready", async () => {
    await fs.writeFile(path.join(tmpProject, "fixture.txt"), "ready", "utf-8");

    await executeGoals({
      action: "create",
      run_id: "checked-create",
      title: "Checked create",
      goal: "Do not defer cheap prerequisite checks",
      success_criteria: ["fixture exists"],
      evidence_plan: [
        {
          id: "fixture-proof",
          label: "Fixture proof",
          mechanism: "command",
          description: "Check fixture file",
          status: "ready",
          command: "test -f fixture.txt",
          evidence: "checked",
        },
      ],
      verifier_command: "test -f fixture.txt",
      prerequisites: [
        {
          id: "fixture",
          label: "Fixture file exists",
          status: "unknown",
          check_command: "test -f fixture.txt",
        },
      ],
    });

    const run = await getGoalRun(tmpProject, "checked-create");
    expect(run?.status).toBe("ready");
    expect(run?.prerequisites[0]).toMatchObject({
      id: "fixture",
      status: "met",
      checkCommand: "test -f fixture.txt",
    });
    expect(run?.prerequisites[0]?.evidence).toContain("exited 0");
  });

  it("persists prerequisite kind and keeps a create with an unmet external prerequisite blocked", async () => {
    await executeGoals({
      action: "create",
      run_id: "kind-create",
      title: "Kind create",
      goal: "Prerequisite kind must round-trip",
      success_criteria: ["kind persisted"],
      evidence_plan: [
        {
          id: "kind-proof",
          label: "Kind proof",
          mechanism: "command",
          description: "Confirm kind",
          status: "ready",
          command: "true",
          evidence: "ok",
        },
      ],
      verifier_command: "true",
      prerequisites: [
        {
          id: "secret",
          label: "Production secret",
          status: "missing",
          kind: "external",
          instructions: "Provide PROD_SECRET.",
        },
      ],
    });

    const run = await getGoalRun(tmpProject, "kind-create");
    expect(run?.prerequisites[0]).toMatchObject({ id: "secret", kind: "external" });
    expect(run?.status).toBe("blocked");
  });

  it("rejects unsafe prerequisite check commands without executing them", async () => {
    const marker = path.join(tmpProject, "unsafe-marker.txt");

    await executeGoals({
      action: "create",
      run_id: "unsafe-prereq",
      title: "Unsafe prereq",
      goal: "Unsafe prerequisite commands must not mutate the project",
      success_criteria: ["unsafe command is blocked"],
      evidence_plan: [
        {
          id: "unsafe-proof",
          label: "Unsafe command proof",
          mechanism: "command",
          description: "Confirm unsafe command was rejected",
          status: "ready",
          command: "test ! -e unsafe-marker.txt",
          evidence: "marker absent",
        },
      ],
      verifier_command: "test ! -e unsafe-marker.txt",
      prerequisites: [
        {
          id: "unsafe",
          label: "Unsafe check",
          status: "unknown",
          check_command: "echo unsafe > unsafe-marker.txt",
        },
      ],
    });

    const run = await getGoalRun(tmpProject, "unsafe-prereq");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // A check_command implies a locally-resolvable prerequisite, so an unmet one
    // no longer blocks the run; the controller schedules a resolve task instead.
    expect(run?.status).toBe("ready");
    expect(run?.prerequisites[0]).toMatchObject({
      id: "unsafe",
      status: "missing",
      checkCommand: "echo unsafe > unsafe-marker.txt",
    });
    expect(run?.prerequisites[0]?.evidence).toContain("rejected as unsafe");
    expect(run?.prerequisites[0]?.evidence).toContain("Command was not executed");
  });

  it("blocks create when a prerequisite has not been checked or evidenced", async () => {
    const result = await executeGoals({
      action: "create",
      run_id: "unchecked-create",
      title: "Unchecked create",
      goal: "Do not accept lazy met prereqs",
      success_criteria: ["tooling checked"],
      evidence_plan: [
        {
          id: "tooling-proof",
          label: "Tooling proof",
          mechanism: "command",
          description: "Check tooling",
          status: "ready",
          command: "node --version",
          evidence: "checked",
        },
      ],
      verifier_command: "node --version",
      prerequisites: [{ id: "tooling", label: "Local tooling", status: "met" }],
    });

    const run = await getGoalRun(tmpProject, "unchecked-create");
    expect(result).toContain("blocked");
    expect(run?.status).toBe("blocked");
    expect(run?.prerequisites[0]).toMatchObject({
      id: "tooling",
      status: "met",
      instructions:
        "Check Local tooling locally and record non-secret evidence before workers can start.",
    });
    expect(run?.prerequisites[0]?.evidence).toBeUndefined();
  });

  it("creates minimal goals as draft with setup blockers", async () => {
    const result = await executeGoals({
      action: "create",
      run_id: "minimal-create",
      title: "Minimal create",
      goal: "Missing proof gates stay draft",
    });

    const run = await getGoalRun(tmpProject, "minimal-create");
    expect(result).toContain("draft");
    expect(run?.status).toBe("draft");
    expect(run?.blockers).toEqual(
      expect.arrayContaining([
        "Goal setup incomplete: success criteria are required.",
        "Goal setup incomplete: evidence_plan is required.",
        "Goal setup incomplete: verifier_command is required.",
      ]),
    );
  });

  it("clears stale setup blockers after create update supplies required setup", async () => {
    await executeGoals({
      action: "create",
      run_id: "draft-then-ready",
      title: "Draft then ready",
      goal: "Replace setup draft with complete Goal metadata",
    });

    const result = await executeGoals({
      action: "create",
      run_id: "draft-then-ready",
      title: "Draft then ready",
      goal: "Replace setup draft with complete Goal metadata",
      success_criteria: ["Ready setup has no stale blockers"],
      evidence_plan: [
        {
          id: "ready-proof",
          label: "Ready proof",
          mechanism: "test",
          description: "Focused test proves stale setup blockers clear",
          status: "ready",
          evidence: "configured",
        },
      ],
      verifier_command: "pnpm test",
    });

    const run = await getGoalRun(tmpProject, "draft-then-ready");
    expect(result).toContain("ready");
    expect(run?.status).toBe("ready");
    expect(run?.blockers).toEqual([]);
  });

  it("preserves earlier evidence when create update records planner GOAL_PLAN", async () => {
    await executeGoals({
      action: "create",
      run_id: "planner-evidence-merge",
      title: "Planner evidence merge",
      goal: "Keep preexisting evidence across setup updates",
      success_criteria: ["initial criterion"],
      evidence_plan: [
        {
          id: "initial-proof",
          label: "Initial proof",
          mechanism: "command",
          description: "Initial evidence plan",
          status: "ready",
          evidence: "configured",
        },
      ],
      verifier_command: "pnpm test",
    });
    await executeGoals({
      action: "evidence",
      run_id: "planner-evidence-merge",
      evidence_label: "Preexisting audit note",
      evidence_content: "must survive setup update",
    });

    await executeGoals({
      action: "create",
      run_id: "planner-evidence-merge",
      title: "Planner evidence merge",
      goal: "Keep preexisting evidence across setup updates GOAL_PLAN research=none success=ready",
      summary: "GOAL_PLAN\nresearch=none\nsuccess=ready\nEND_GOAL_PLAN",
    });

    const run = await getGoalRun(tmpProject, "planner-evidence-merge");
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Preexisting audit note" }),
        expect.objectContaining({ label: "Planner GOAL_PLAN" }),
      ]),
    );
  });

  it("routes worker goal tool writes to the original project path from isolated worktrees", async () => {
    const workerCwd = await fs.mkdtemp(path.join(os.tmpdir(), "goals-tool-worker-cwd-"));
    const previousProjectPath = process.env.GG_GOAL_PROJECT_PATH;
    try {
      process.env.GG_GOAL_PROJECT_PATH = tmpProject;
      await upsertGoalRun(tmpProject, {
        id: "worker-env-goal",
        title: "Worker env goal",
        goal: "Persist from isolated worker cwd",
        status: "ready",
        successCriteria: [],
        prerequisites: [],
        harness: [],
        evidencePlan: [],
        tasks: [],
        evidence: [],
        blockers: [],
      });

      const tool = createGoalsTool(workerCwd);
      const result = await tool.execute(
        {
          action: "evidence",
          evidence_kind: "summary",
          evidence_label: "Worker isolated evidence",
          evidence_content: "stored on original project",
        },
        { signal: new AbortController().signal, toolCallId: "test-call" },
      );

      const projectRun = await getGoalRun(tmpProject, "worker-env-goal");
      const workerRun = await getActiveGoalRun(workerCwd);
      expect(result).toBe('Evidence added to "Worker env goal".');
      expect(workerRun).toBeNull();
      expect(projectRun?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "Worker isolated evidence",
            content: "stored on original project",
          }),
        ]),
      );
    } finally {
      if (previousProjectPath === undefined) {
        delete process.env.GG_GOAL_PROJECT_PATH;
      } else {
        process.env.GG_GOAL_PROJECT_PATH = previousProjectPath;
      }
      await fs.rm(workerCwd, { recursive: true, force: true });
    }
  });

  it("updates an explicit run_id task and evidence when no active goal exists in the caller cwd", async () => {
    const runProject = await fs.mkdtemp(path.join(os.tmpdir(), "goals-tool-explicit-run-project-"));
    try {
      await upsertGoalRun(runProject, {
        id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569",
        title: "Explicit run",
        goal: "Update from worker cwd",
        status: "passed",
      });

      const tool = createGoalsTool(tmpProject);
      const taskResult = await tool.execute(
        {
          action: "task",
          run_id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569",
          task_id: "worker-task",
          task_title: "Worker callback",
          task_prompt: "Persist callback",
          task_status: "done",
          summary: "callback complete",
        },
        { signal: new AbortController().signal, toolCallId: "test-call" },
      );
      const evidenceResult = await tool.execute(
        {
          action: "evidence",
          run_id: "099c9f7f",
          evidence_kind: "summary",
          evidence_label: "Worker evidence",
          evidence_content: "same discovered run",
        },
        { signal: new AbortController().signal, toolCallId: "test-call" },
      );

      const run = await getGoalRun(runProject, "099c9f7f");
      expect(taskResult).toBe(
        'Goal task added: "Worker callback" (id: worker-task). Reference this id (or the exact title) in another task\'s depends_on.',
      );
      expect(evidenceResult).toBe('Evidence added to "Explicit run".');
      expect(run?.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "worker-task",
            status: "done",
            lastSummary: "callback complete",
          }),
        ]),
      );
      expect(run?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Worker evidence", content: "same discovered run" }),
        ]),
      );
    } finally {
      await fs.rm(runProject, { recursive: true, force: true });
    }
  });

  it("persists active Goal references and requires worker task prompts to name them", async () => {
    const reference: GoalReference = {
      id: "repo-reference",
      kind: "repo",
      label: "Reference repository https://github.com/acme/reference-ui",
      value: "https://github.com/acme/reference-ui",
    };
    const documentReference: GoalReference = {
      id: "doc-reference",
      kind: "text",
      label: "Attached text reference requirements.md",
      path: ".gg/goal-references/doc-reference-requirements.md",
    };
    const tool = createGoalsTool(tmpProject, undefined, () => [reference, documentReference]);

    await tool.execute(
      {
        action: "create",
        run_id: "reference-goal",
        title: "Match reference repo",
        goal: "Implement the UI from the reference repository",
        success_criteria: [
          "Implementation matches repo-reference and doc-reference visual and interaction patterns",
        ],
        evidence_plan: [
          {
            id: "reference-comparison",
            label: "repo-reference and doc-reference comparison",
            mechanism: "source",
            description: "Compare against repo-reference and doc-reference before completion",
            status: "ready",
            evidence: "reference captured",
          },
        ],
        verifier_command: "pnpm test",
        verifier_description: "Verifier compares output against repo-reference and doc-reference",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );

    const missingReferenceResult = await tool.execute(
      {
        action: "task",
        run_id: "reference-goal",
        task_id: "generic-task",
        task_title: "Implement UI",
        task_prompt: "Build the requested UI.",
        task_status: "pending",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );
    const referencedTaskResult = await tool.execute(
      {
        action: "task",
        run_id: "reference-goal",
        task_id: "reference-task",
        task_title: "Implement UI from repo-reference and doc-reference",
        task_prompt:
          "Use repo-reference / https://github.com/acme/reference-ui and doc-reference at .gg/goal-references/doc-reference-requirements.md as the source of truth while implementing.",
        task_status: "pending",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );
    const run = await getGoalRun(tmpProject, "reference-goal");

    expect(missingReferenceResult).toContain("task_prompt must explicitly include");
    expect(missingReferenceResult).toContain("repo-reference, doc-reference");
    expect(referencedTaskResult).toBe(
      'Goal task added: "Implement UI from repo-reference and doc-reference" (id: reference-task). Reference this id (or the exact title) in another task\'s depends_on.',
    );
    expect(run?.status).toBe("ready");
    expect(run?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining(reference),
        expect.objectContaining(documentReference),
      ]),
    );
    expect(run?.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "reference-task" })]),
    );
  });

  it("persists worker-worktree verifier cwd through setup and verifier results", async () => {
    await executeGoals({
      action: "create",
      run_id: "worktree-verifier-goal",
      title: "Worktree verifier",
      goal: "Verify from a worker worktree",
      success_criteria: ["Verifier runs"],
      evidence_plan: [
        {
          id: "proof",
          label: "Proof",
          mechanism: "command",
          description: "Run worker-built verifier",
          status: "ready",
          evidence: "configured",
        },
      ],
      verifier_command: ".goal-evidence/noop/audit.sh",
      verifier_description: "Worker-built verifier",
      verifier_cwd: "/tmp/project-goal-worktrees/task-worker",
    });

    await executeGoals({
      action: "verify",
      run_id: "worktree-verifier-goal",
      verification_status: "pass",
      summary: "Verifier passed in worker worktree",
      exit_code: 0,
    });

    const run = await getGoalRun(tmpProject, "worktree-verifier-goal");
    expect(run?.verifier).toMatchObject({
      command: ".goal-evidence/noop/audit.sh",
      cwd: "/tmp/project-goal-worktrees/task-worker",
      lastResult: {
        status: "pass",
        command: ".goal-evidence/noop/audit.sh",
        summary: "Verifier passed in worker worktree",
      },
    });
  });

  it("rejects passing final audits that omit mandatory Goal references", async () => {
    const reference: GoalReference = {
      id: "image-reference",
      kind: "image",
      label: "Attached image reference mockup.png",
      path: ".gg/goal-references/image-reference-mockup.png",
    };
    const tool = createGoalsTool(tmpProject, undefined, () => [reference]);
    await tool.execute(
      {
        action: "create",
        run_id: "reference-audit-goal",
        title: "Match screenshot",
        goal: "Implement UI from screenshot",
        success_criteria: ["UI matches image-reference"],
        evidence_plan: [
          {
            id: "image-reference-proof",
            label: "image-reference comparison",
            mechanism: "screenshot",
            description: "Compare output with image-reference",
            status: "ready",
            evidence: "comparison configured",
          },
        ],
        verifier_command: "pnpm test",
        verifier_description: "Verifier checks image-reference",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );
    await tool.execute(
      {
        action: "verify",
        run_id: "reference-audit-goal",
        verification_status: "pass",
        summary: "Verifier passed for image-reference",
        exit_code: 0,
        output_path: "artifacts/verifier.log",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );
    const checkedAt = (await getGoalRun(tmpProject, "reference-audit-goal"))?.verifier?.lastResult
      ?.checkedAt;

    const missingReferenceAudit = await tool.execute(
      {
        action: "audit",
        run_id: "reference-audit-goal",
        verification_status: "pass",
        summary: `FINAL_AUDIT_PASS verifier_checked_at=${checkedAt}; output=artifacts/verifier.log`,
        output_path: "artifacts/verifier.log",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );
    const referencedAudit = await tool.execute(
      {
        action: "audit",
        run_id: "reference-audit-goal",
        verification_status: "pass",
        summary: `FINAL_AUDIT_PASS verifier_checked_at=${checkedAt}; image-reference output=artifacts/verifier.log`,
        output_path: "artifacts/verifier.log",
      },
      { signal: new AbortController().signal, toolCallId: "test-call" },
    );

    expect(missingReferenceAudit).toContain(
      "must explicitly reference every non-prompt Goal reference",
    );
    expect(referencedAudit).toBe('Completion audit recorded for "Match screenshot": pass.');
  });

  it("persists typed Goal task DAG metadata and preserves it on status updates", async () => {
    await executeGoals({
      action: "create",
      run_id: "dag-goal",
      title: "Typed DAG",
      goal: "Persist Goal task dependency metadata",
      success_criteria: ["DAG metadata survives updates"],
      prerequisites: [],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "dag-proof",
          label: "DAG metadata proof",
          mechanism: "test",
          description: "Focused tests prove typed Goal task metadata is durable.",
          status: "ready",
          evidence: "configured",
        },
      ],
    });
    await executeGoals({
      action: "task",
      run_id: "dag-goal",
      task_id: "schema-task",
      task_title: "Build schema candidate",
      task_prompt: "Build only the schema candidate in an isolated worktree.",
      task_status: "done",
    });

    const addResult = await executeGoals({
      action: "task",
      run_id: "dag-goal",
      task_id: "ui-task",
      task_title: "Build UI candidate",
      task_prompt: "Build only the UI candidate in an isolated worktree.",
      task_status: "pending",
      depends_on: ["schema-task"],
      parallel_group: "frontend",
      expected_changed_scope: ["packages/ggcoder/src/ui/**"],
      integration: "candidate",
    });
    const updateResult = await executeGoals({
      action: "task",
      run_id: "dag-goal",
      task_id: "ui-task",
      task_status: "done",
      summary: "UI candidate complete",
    });

    const updated = await getGoalRun(tmpProject, "dag-goal");
    expect(addResult).toBe(
      'Goal task added: "Build UI candidate" (id: ui-task). Reference this id (or the exact title) in another task\'s depends_on.',
    );
    expect(updateResult).toBe(
      'Goal task updated: "Build UI candidate" (id: ui-task). Reference this id (or the exact title) in another task\'s depends_on.',
    );
    expect(updated?.tasks.find((task) => task.id === "ui-task")).toEqual(
      expect.objectContaining({
        id: "ui-task",
        title: "Build UI candidate",
        prompt: "Build only the UI candidate in an isolated worktree.",
        status: "done",
        lastSummary: "UI candidate complete",
        dependsOn: ["schema-task"],
        parallelGroup: "frontend",
        expectedChangedScope: ["packages/ggcoder/src/ui/**"],
        integration: "candidate",
      }),
    );
    const status = await executeGoals({ action: "status", run_id: "dag-goal" });
    expect(status).toContain(
      "[ready] Typed DAG (id: dag-goal) — no prereqs, 2/2 tasks done, verifier configured",
    );
    expect(status).not.toContain("DAG:");
    expect(status).not.toContain("expected_changed_scope=");
  });

  it("keeps status output compact without verbose reference or DAG detail blocks", async () => {
    await executeGoals({
      action: "create",
      run_id: "compact-status-goal",
      title: "Compact status",
      goal: "Show compact Goal status",
      success_criteria: ["Status is one line"],
      prerequisites: [],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "status-proof",
          label: "Status proof",
          mechanism: "test",
          description: "Focused tests prove status output does not wrap with verbose metadata.",
          status: "ready",
          evidence: "configured",
        },
      ],
    });
    await executeGoals({
      action: "task",
      run_id: "compact-status-goal",
      task_id: "audit-task",
      task_title: "Audit /goal efficiency hotspots",
      task_prompt: "Audit the /goal system.",
      task_status: "done",
      parallel_group: "analysis",
      expected_changed_scope: ["packages/ggcoder/src/tools/goals.ts"],
      integration: "manual",
    });

    const result = await executeGoals({ action: "status", run_id: "compact-status-goal" });

    expect(result).toContain(
      "[ready] Compact status (id: compact-) — no prereqs, 1/1 tasks done, verifier configured",
    );
    expect(result).not.toContain("\nReferences:");
    expect(result).not.toContain("\nTasks:");
    expect(result).not.toContain("DAG:");
    expect(result).not.toContain("expected_changed_scope=");
  });

  it("resolves task title dependencies to ids and rejects missing dependencies", async () => {
    await executeGoals({
      action: "create",
      run_id: "dag-title-goal",
      title: "Title dependencies",
      goal: "Normalize Goal task dependencies",
      success_criteria: ["Dependencies are stored as task ids"],
      prerequisites: [],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "dependency-proof",
          label: "Dependency proof",
          mechanism: "test",
          description: "Focused tests prove depends_on cannot create permanently blocked runs.",
          status: "ready",
          evidence: "configured",
        },
      ],
    });
    await executeGoals({
      action: "task",
      run_id: "dag-title-goal",
      task_id: "audit-task",
      task_title: "Audit /goal efficiency hotspots",
      task_prompt: "Audit the /goal system.",
      task_status: "done",
    });

    const missingResult = await executeGoals({
      action: "task",
      run_id: "dag-title-goal",
      task_id: "blocked-task",
      task_title: "Blocked task",
      task_prompt: "This should not be persisted with an invalid dependency.",
      depends_on: ["Missing task title"],
    });
    const titleResult = await executeGoals({
      action: "task",
      run_id: "dag-title-goal",
      task_id: "implementation-task",
      task_title: "Simplify goal routing/controller",
      task_prompt: "Implement the audited /goal simplification.",
      depends_on: ["Audit /goal efficiency hotspots"],
    });
    const run = await getGoalRun(tmpProject, "dag-title-goal");

    expect(missingResult).toContain(
      'depends_on entry "Missing task title" does not match an existing task id, id prefix, or exact title',
    );
    expect(titleResult).toBe(
      'Goal task added: "Simplify goal routing/controller" (id: implementation-task). Reference this id (or the exact title) in another task\'s depends_on.',
    );
    expect(run?.tasks.find((task) => task.id === "blocked-task")).toBeUndefined();
    expect(run?.tasks.find((task) => task.id === "implementation-task")?.dependsOn).toEqual([
      "audit-task",
    ]);
    expect(run ? decideGoalNextAction(run) : null).toMatchObject({
      kind: "start_worker",
      task: expect.objectContaining({ id: "implementation-task" }),
    });
  });

  it("returns the generated task id so dependents can reference it by id", async () => {
    await executeGoals({
      action: "create",
      run_id: "dag-id-goal",
      title: "Returned ids",
      goal: "Adding a task returns its id for depends_on wiring",
      success_criteria: ["task id is returned"],
      prerequisites: [],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "id-proof",
          label: "Id proof",
          mechanism: "test",
          description: "Adding a task echoes its id.",
          status: "ready",
          evidence: "configured",
        },
      ],
    });

    // No task_id supplied -> the tool generates one and must echo it back.
    const added = await executeGoals({
      action: "task",
      run_id: "dag-id-goal",
      task_title: "Baseline investigation",
      task_prompt: "Investigate first.",
      task_status: "done",
    });
    const match = /\(id: ([^)]+)\)/.exec(String(added));
    expect(match).not.toBeNull();
    const baselineId = match![1]!;

    // The dependent task can wire depends_on using the returned id.
    await executeGoals({
      action: "task",
      run_id: "dag-id-goal",
      task_id: "dependent-task",
      task_title: "Dependent work",
      task_prompt: "Runs after baseline.",
      depends_on: [baselineId],
    });
    const run = await getGoalRun(tmpProject, "dag-id-goal");
    expect(run?.tasks.find((task) => task.id === "dependent-task")?.dependsOn).toEqual([
      baselineId,
    ]);
  });

  it("status resolves full UUID, short ID, and completed latest fallback", async () => {
    await executeGoals({
      action: "create",
      run_id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569",
      title: "Status target",
      goal: "Status lookup",
      prerequisites: [],
    });
    await executeGoals({
      action: "verify",
      run_id: "099c9f7f",
      verification_status: "fail",
      summary: "failed",
    });

    await expect(
      executeGoals({ action: "status", run_id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569" }),
    ).resolves.toContain("Status target");
    await expect(executeGoals({ action: "status", run_id: "099c9f7f" })).resolves.toContain(
      "[ready] Status target",
    );
    await expect(
      executeGoals({
        action: "evidence",
        evidence_label: "Latest failed",
        evidence_content: "fallback",
      }),
    ).resolves.toBe('Evidence added to "Status target".');
  });

  it("persists evidence plans on create and preserves them on metadata updates", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-evidence-plan",
      title: "Proof plan",
      goal: "Verify real browser behavior",
      success_criteria: ["Browser flow passes"],
      prerequisites: [],
      evidence_plan: [
        {
          id: "browser-proof",
          label: "Browser smoke proof",
          mechanism: "browser",
          description: "Run Playwright locally and capture screenshot/log evidence.",
          status: "planned",
        },
        {
          id: "file-proof",
          label: "File artifact proof",
          mechanism: "file",
          description: "Inspect a durable generated artifact file.",
          status: "ready",
          path: "artifacts/proof.json",
          evidence: "artifact schema captured",
        },
      ],
    });
    await executeGoals({
      action: "create",
      run_id: "goal-evidence-plan",
      title: "Proof plan updated",
      goal: "Verify real browser behavior",
      success_criteria: ["Browser flow passes"],
      prerequisites: [],
      verifier_command: "pnpm test:e2e",
    });

    const run = await getGoalRun(tmpProject, "goal-evidence-plan");

    expect(run?.evidencePlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "browser-proof",
          mechanism: "browser",
          status: "planned",
        }),
        expect.objectContaining({
          id: "file-proof",
          mechanism: "file",
          status: "ready",
          path: "artifacts/proof.json",
        }),
      ]),
    );
    expect(run?.verifier?.command).toBe("pnpm test:e2e");
  });

  it("adds new evidence-plan items directly after minimal Goal creation", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-evidence-plan-add",
      title: "Proof plan add",
      goal: "Add proof paths after initial Goal creation",
      success_criteria: ["Evidence plan can be added after create"],
      verifier_command: "pnpm test",
    });

    const result = await executeGoals({
      action: "evidence_plan",
      run_id: "goal-evidence-plan-add",
      evidence_plan: [
        {
          id: "manual-proof",
          label: "Manual setup proof",
          mechanism: "manual",
          description: "Manual inspection proves setup worked.",
          status: "planned",
        },
      ],
    });
    const run = await getGoalRun(tmpProject, "goal-evidence-plan-add");

    expect(result).toBe('Evidence-plan item added for "Proof plan add": "Manual setup proof".');
    expect(run?.status).toBe("ready");
    expect(run?.blockers).toEqual([]);
    expect(run?.evidencePlan).toEqual([
      expect.objectContaining({
        id: "manual-proof",
        label: "Manual setup proof",
        mechanism: "manual",
        status: "planned",
      }),
    ]);
  });

  it("upserts evidence-plan items from evidence_plan arrays", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-evidence-plan-upsert",
      title: "Proof plan upsert",
      goal: "Update proof paths from an array call",
      success_criteria: ["Evidence plan can be upserted"],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "manual-proof",
          label: "Manual setup proof",
          mechanism: "manual",
          description: "Manual inspection proves setup worked.",
          status: "planned",
        },
      ],
    });

    const result = await executeGoals({
      action: "evidence_plan",
      run_id: "goal-evidence-plan-upsert",
      evidence_plan: [
        {
          id: "manual-proof",
          label: "Manual setup proof updated",
          mechanism: "manual",
          description: "Manual inspection now has durable evidence.",
          status: "ready",
          evidence: "inspection recorded",
        },
        {
          id: "log-proof",
          label: "Log proof",
          mechanism: "log",
          description: "Inspect durable setup log.",
          status: "planned",
          path: "artifacts/setup.log",
        },
      ],
    });
    const run = await getGoalRun(tmpProject, "goal-evidence-plan-upsert");

    expect(result).toBe(
      'Evidence-plan items upserted for "Proof plan upsert": 1 added, 1 updated.',
    );
    expect(run?.evidencePlan).toEqual([
      expect.objectContaining({
        id: "manual-proof",
        label: "Manual setup proof updated",
        status: "ready",
        evidence: "inspection recorded",
      }),
      expect.objectContaining({ id: "log-proof", label: "Log proof", path: "artifacts/setup.log" }),
    ]);
  });

  it("updates evidence-plan items directly for post-verifier reconciliation", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-evidence-reconcile",
      title: "Proof reconciliation",
      goal: "Reconcile proof bookkeeping after verifier pass",
      success_criteria: ["Verifier pass with evidence-plan ready"],
      prerequisites: [],
      evidence_plan: [
        {
          id: "slash-proof",
          label: "/goal slash wrapper evidence",
          mechanism: "test",
          description: "Prompt command tests prove slash wrapper behavior.",
          status: "planned",
          command: "pnpm --filter @kenkaiiii/ggcoder test -- prompt-commands.test.ts",
        },
      ],
      verifier_command: "pnpm test",
    });
    await upsertGoalRun(tmpProject, {
      id: "goal-evidence-reconcile",
      title: "Proof reconciliation",
      goal: "Reconcile proof bookkeeping after verifier pass",
      status: "blocked",
      blockers: ["stale evidence-plan mismatch"],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "pass",
          summary: "Verifier passed before reconciliation.",
          checkedAt: "2024-01-01T00:00:00.000Z",
        },
      },
    });

    const result = await executeGoals({
      action: "evidence_plan",
      run_id: "goal-evidence-reconcile",
      evidence_plan_item_id: "slash-proof",
      evidence_plan_status: "ready",
      evidence_content: "prompt-commands.test.ts passed as part of focused Goal coverage.",
    });
    const run = await getGoalRun(tmpProject, "goal-evidence-reconcile");

    expect(result).toBe(
      'Evidence-plan item updated for "Proof reconciliation": "/goal slash wrapper evidence" is ready.',
    );
    expect(run?.status).toBe("ready");
    expect(run?.blockers).toEqual([]);
    expect(run?.evidencePlan[0]).toMatchObject({
      id: "slash-proof",
      status: "ready",
      evidence: "prompt-commands.test.ts passed as part of focused Goal coverage.",
    });
    expect(run ? decideGoalNextAction(run) : null).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
      reason:
        "Verifier passed; creating final read-only completion audit before the Goal can pass (1/3).",
    });
  });

  it("persists evidence-plan evidence and path aliases used by coordinator calls", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-evidence-aliases",
      title: "Alias reconciliation",
      goal: "Persist coordinator evidence-plan aliases",
      success_criteria: ["Evidence plan is durable"],
      prerequisites: [],
      evidence_plan: [
        {
          id: "setup-plan",
          label: "GOAL_PLAN setup evidence",
          mechanism: "log",
          description: "Planner output must be durable.",
          status: "planned",
        },
      ],
      verifier_command: "pnpm test",
    });

    await executeGoals({
      action: "evidence_plan",
      run_id: "goal-evidence-aliases",
      evidence_plan_item_id: "setup-plan",
      evidence_plan_status: "ready",
      evidence: "Exact GOAL_PLAN evidence was recorded.",
      path: "artifacts/goal-plan.log",
    });
    const run = await getGoalRun(tmpProject, "goal-evidence-aliases");

    expect(run?.evidencePlan[0]).toMatchObject({
      status: "ready",
      evidence: "Exact GOAL_PLAN evidence was recorded.",
      path: "artifacts/goal-plan.log",
    });
  });

  it("does not complete without passing verifier evidence", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-a",
      title: "Guard completion",
      goal: "Only complete after proof",
      success_criteria: ["Verifier passes"],
      prerequisites: [],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "verifier-proof",
          label: "Verifier proof",
          mechanism: "command",
          description: "Run verifier command",
          status: "ready",
          command: "pnpm test",
          evidence: "configured",
        },
      ],
    });

    const result = await executeGoals({ action: "complete", run_id: "goal-a" });
    const run = await getGoalRun(tmpProject, "goal-a");

    expect(result).toBe("Error: cannot complete goal: Goal has no verifier evidence.");
    expect(run?.status).toBe("ready");
  });

  it("records verifier pass as ready when tasks remain incomplete", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-a",
      title: "Guard verifier",
      goal: "Verifier pass alone is not enough",
      success_criteria: ["Task and verifier pass"],
      prerequisites: [],
      verifier_command: "pnpm test",
    });
    await executeGoals({
      action: "task",
      run_id: "goal-a",
      task_id: "task-a",
      task_title: "Pending work",
      task_prompt: "Do the work",
    });

    await executeGoals({
      action: "verify",
      run_id: "goal-a",
      verification_status: "pass",
      summary: "Verifier passed",
      exit_code: 0,
    });
    const run = await getGoalRun(tmpProject, "goal-a");

    expect(run?.status).toBe("ready");
    expect(run?.verifier?.lastResult?.status).toBe("pass");
  });

  it("clears stale transient blockers but waits for final audit when verifier pass satisfies planned evidence", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-blocked-after-pass",
      title: "Blocked after pass",
      goal: "Recover from stale verifier interruption",
      success_criteria: ["Verifier pass with durable evidence completes"],
      prerequisites: [],
      evidence_plan: [
        {
          id: "planned-command-proof",
          label: "Targeted regression tests",
          mechanism: "test",
          description: "Run the focused local regression command.",
          status: "planned",
          command: "pnpm vitest run src/core/goal-controller.test.ts",
        },
        {
          id: "planned-log-proof",
          label: "Verifier log artifact",
          mechanism: "log",
          description: "Persist the verifier output log.",
          status: "planned",
          path: ".goal-evidence/blocked-after-pass.log",
        },
      ],
      verifier_command: "pnpm vitest run src/core/goal-controller.test.ts",
    });
    await executeGoals({
      action: "task",
      run_id: "goal-blocked-after-pass",
      task_id: "task-a",
      task_title: "Done work",
      task_prompt: "Do the work",
      task_status: "done",
    });
    await upsertGoalRun(tmpProject, {
      id: "goal-blocked-after-pass",
      title: "Blocked after pass",
      goal: "Recover from stale verifier interruption",
      status: "blocked",
      blockers: ["Verifier was interrupted; rerun or continue the Goal to verify again."],
    });
    await executeGoals({
      action: "evidence",
      run_id: "goal-blocked-after-pass",
      evidence_kind: "log",
      evidence_label: "Verifier log artifact",
      evidence_path: ".goal-evidence/blocked-after-pass.log",
      evidence_content: "Verifier passed after interruption.",
    });

    const result = await executeGoals({
      action: "verify",
      run_id: "goal-blocked-after-pass",
      verification_status: "pass",
      summary: "Targeted regression tests passed and wrote Verifier log artifact.",
      verifier_command: "pnpm vitest run src/core/goal-controller.test.ts",
      exit_code: 0,
      output_path: ".goal-evidence/blocked-after-pass.log",
    });
    const run = await getGoalRun(tmpProject, "goal-blocked-after-pass");

    expect(result).toBe('Verifier recorded for "Blocked after pass": pass.');
    expect(run?.status).toBe("ready");
    expect(run?.blockers).toEqual([]);
    expect(run?.evidencePlan.map((item) => item.status)).toEqual(["planned", "planned"]);
    expect(run?.completionAudit).toMatchObject({ status: "unknown" });
    expect(run ? decideGoalNextAction(run) : null).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
    });
  });

  it("records verifier failure as persisted command evidence and keeps the run recoverable", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-a",
      title: "Verifier fails",
      goal: "Persist failure evidence",
      success_criteria: ["Verifier passes"],
      prerequisites: [],
      verifier_command: "pnpm test",
    });
    await executeGoals({
      action: "task",
      run_id: "goal-a",
      task_id: "task-a",
      task_title: "Done work",
      task_prompt: "Do the work",
      task_status: "done",
    });

    const result = await executeGoals({
      action: "verify",
      run_id: "goal-a",
      verification_status: "fail",
      summary: "expected failure output",
      exit_code: 1,
      output_path: "artifacts/verifier.log",
    });
    const run = await getGoalRun(tmpProject, "goal-a");

    expect(result).toBe('Verifier recorded for "Verifier fails": fail.');
    expect(run?.status).toBe("ready");
    expect(run?.verifier?.lastResult).toMatchObject({
      status: "fail",
      summary: "expected failure output",
      exitCode: 1,
      outputPath: "artifacts/verifier.log",
    });
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "command",
          label: "Verifier result",
          content: "expected failure output",
          path: "artifacts/verifier.log",
        }),
      ]),
    );
  });

  it("allows corrective next task to be added after verifier failure evidence", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-a",
      title: "Correct verifier failure",
      goal: "Create corrective task",
      success_criteria: ["Verifier passes"],
      prerequisites: [],
      verifier_command: "pnpm test",
    });
    await executeGoals({
      action: "verify",
      run_id: "goal-a",
      verification_status: "fail",
      summary: "failing assertion",
      exit_code: 1,
    });

    const result = await executeGoals({
      action: "task",
      run_id: "goal-a",
      task_id: "repair-a",
      task_title: "Repair verifier failure",
      task_prompt: "Use Verifier result evidence to fix failing assertion",
      task_status: "pending",
    });
    const run = await getGoalRun(tmpProject, "goal-a");

    expect(result).toBe(
      'Goal task added: "Repair verifier failure" (id: repair-a). Reference this id (or the exact title) in another task\'s depends_on.',
    );
    expect(run?.status).toBe("ready");
    expect(run?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "repair-a",
          status: "pending",
          prompt: "Use Verifier result evidence to fix failing assertion",
        }),
      ]),
    );
    expect(run ? decideGoalNextAction(run) : null).toMatchObject({
      kind: "start_worker",
      task: expect.objectContaining({ id: "repair-a" }),
    });
  });

  it("records pause evidence after repeated non-progress", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-a",
      title: "Pause loop",
      goal: "Stop repeated non-progress",
      success_criteria: ["No infinite loop"],
      prerequisites: [],
    });
    await executeGoals({
      action: "task",
      run_id: "goal-a",
      task_id: "task-a",
      task_title: "Flaky work",
      task_prompt: "Try again",
      task_status: "failed",
      attempts: 6,
      summary: "same failure repeated",
    });
    await executeGoals({
      action: "evidence",
      run_id: "goal-a",
      evidence_kind: "summary",
      evidence_label: "Paused after repeated non-progress",
      evidence_content: "Attempt limit reached for Flaky work.",
    });

    const result = await executeGoals({ action: "pause", run_id: "goal-a" });
    const run = await getGoalRun(tmpProject, "goal-a");

    expect(result).toBe('Goal "Pause loop" is now paused.');
    expect(run?.status).toBe("paused");
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "summary",
          label: "Paused after repeated non-progress",
          content: "Attempt limit reached for Flaky work.",
        }),
      ]),
    );
  });

  it("resume-immediate records continuation intent and next action", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-resume",
      title: "Resume now",
      goal: "Continue",
      prerequisites: [],
    });
    await executeGoals({
      action: "task",
      run_id: "goal-resume",
      task_id: "task-a",
      task_title: "Work",
      task_prompt: "Do it",
    });

    const result = await executeGoals({ action: "resume", run_id: "goal-resume" });
    const run = await getGoalRun(tmpProject, "goal-resume");

    expect(result).toBe('Goal "Resume now" resume requested; next action: start_worker.');
    expect(run?.status).toBe("ready");
    expect(run?.continueRequestedAt).toBeTruthy();
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Goal resume requested" }),
        expect.objectContaining({ label: "Goal decision: resume" }),
      ]),
    );
  });

  it("resume-queued-behind-active-worker persists continuation intent", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-queued",
      title: "Queued resume",
      goal: "Continue later",
      prerequisites: [],
    });
    await executeGoals({
      action: "task",
      run_id: "goal-queued",
      task_id: "task-a",
      task_title: "Work",
      task_prompt: "Do it",
      task_status: "running",
      worker_id: "worker-a",
    });

    const result = await executeGoals({ action: "resume", run_id: "goal-queued" });
    const run = await getGoalRun(tmpProject, "goal-queued");

    expect(result).toBe('Goal "Queued resume" resume queued: Goal task "Work" is already running.');
    expect(run?.continueRequestedAt).toBeTruthy();
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Goal resume requested" }),
        expect.objectContaining({ label: "Goal decision: resume" }),
      ]),
    );
  });

  it("resume-blocked-prerequisite keeps exact missing instructions", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-blocked",
      title: "Blocked resume",
      goal: "Needs input",
      prerequisites: [
        { id: "key", label: "API key", status: "missing", instructions: "Set API_KEY locally." },
      ],
    });

    const result = await executeGoals({ action: "resume", run_id: "goal-blocked" });
    const run = await getGoalRun(tmpProject, "goal-blocked");

    expect(result).toBe('Goal "Blocked resume" resume blocked: API key: Set API_KEY locally.');
    expect(run?.status).toBe("blocked");
    expect(run?.blockers).toContain("API key: Set API_KEY locally.");
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Goal resume blocked",
          content: "API key: Set API_KEY locally.",
        }),
      ]),
    );
  });

  it("keeps a Goal ready when final audit creates a follow-up worker task", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-audit-missing",
      title: "Audit missing report",
      goal: "Ensure report matches verifier result",
      success_criteria: ["Report reflects latest verifier pass"],
      prerequisites: [],
      verifier_command: "pnpm test",
    });
    await executeGoals({
      action: "task",
      run_id: "goal-audit-missing",
      task_id: "report-task",
      task_title: "Write report",
      task_prompt: "Write the report",
      task_status: "done",
      attempts: 1,
    });
    await executeGoals({
      action: "verify",
      run_id: "goal-audit-missing",
      verification_status: "pass",
      summary: "Verifier passed",
      exit_code: 0,
      output_path: "artifacts/verifier.log",
    });

    await executeGoals({
      action: "task",
      run_id: "goal-audit-missing",
      task_id: "fix-report",
      task_title: "Fix stale final report",
      task_prompt: "Update the report to reflect the latest verifier pass.",
      task_status: "pending",
      summary: "Final audit found stale report content.",
    });
    await executeGoals({
      action: "audit",
      run_id: "goal-audit-missing",
      verification_status: "fail",
      summary: "FINAL_AUDIT_FAIL report still describes an earlier verifier failure.",
      output_path: "artifacts/verifier.log",
    });
    const run = await getGoalRun(tmpProject, "goal-audit-missing");

    expect(run?.status).toBe("ready");
    expect(run?.completionAudit).toMatchObject({ status: "fail" });
    expect(run?.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fix-report", status: "pending" })]),
    );
    expect(run ? decideGoalNextAction(run) : null).toMatchObject({
      kind: "start_worker",
      task: expect.objectContaining({ id: "fix-report" }),
    });
  });

  it("allows completion after all tasks are done, verifier passes, and final audit passes", async () => {
    await executeGoals({
      action: "create",
      run_id: "goal-a",
      title: "Complete safely",
      goal: "Complete after proof",
      success_criteria: ["Task and verifier pass"],
      prerequisites: [],
      verifier_command: "pnpm test",
      evidence_plan: [
        {
          id: "verifier-proof",
          label: "Verifier proof",
          mechanism: "command",
          description: "Run verifier command",
          status: "ready",
          command: "pnpm test",
          evidence: "configured",
        },
      ],
    });
    await executeGoals({
      action: "task",
      run_id: "goal-a",
      task_id: "task-a",
      task_title: "Done work",
      task_prompt: "Do the work",
      task_status: "done",
    });
    await executeGoals({
      action: "verify",
      run_id: "goal-a",
      verification_status: "pass",
      summary: "Verifier passed",
      exit_code: 0,
      output_path: "artifacts/verifier.log",
    });
    const beforeAudit = await executeGoals({ action: "complete", run_id: "goal-a" });
    expect(beforeAudit).toBe(
      "Error: cannot complete goal: Final completion audit status is unknown.",
    );
    await executeGoals({
      action: "task",
      run_id: "goal-a",
      task_id: "final-audit",
      task_title: "Audit Goal completion evidence",
      task_prompt: "Audit final durable artifacts.",
      task_status: "done",
      attempts: 1,
    });
    const auditResult = await executeGoals({
      action: "audit",
      run_id: "goal-a",
      verification_status: "pass",
      summary: `FINAL_AUDIT_PASS verifier_checked_at=${(await getGoalRun(tmpProject, "goal-a"))?.verifier?.lastResult?.checkedAt}; artifacts match verifier output.`,
      output_path: "artifacts/verifier.log",
    });

    const result = await executeGoals({ action: "complete", run_id: "goal-a" });
    const run = await getGoalRun(tmpProject, "goal-a");

    expect(auditResult).toBe('Completion audit recorded for "Complete safely": pass.');
    expect(result).toBe('Goal "Complete safely" is now passed.');
    expect(run?.status).toBe("passed");
    expect(run?.completionAudit).toMatchObject({ status: "pass" });
  });

  it("auto-stamps FINAL_AUDIT_PASS and verifier_checked_at so a plain prose pass audit succeeds", async () => {
    await executeGoals({
      action: "create",
      run_id: "autostamp-goal",
      title: "Auto stamp",
      goal: "Pass audits should not require transcribing structured tokens",
      success_criteria: ["audit passes from plain prose"],
      evidence_plan: [
        {
          id: "proof",
          label: "Proof",
          mechanism: "command",
          description: "Verifier log",
          status: "ready",
          path: "artifacts/verifier.log",
          evidence: "recorded",
        },
      ],
      verifier_command: "true",
    });
    await executeGoals({
      action: "task",
      run_id: "autostamp-goal",
      task_id: "task-a",
      task_title: "Done",
      task_prompt: "Do work",
      task_status: "done",
    });
    await executeGoals({
      action: "verify",
      run_id: "autostamp-goal",
      verification_status: "pass",
      summary: "Verifier passed",
      exit_code: 0,
      output_path: "artifacts/verifier.log",
    });

    // Plain prose summary: no FINAL_AUDIT_PASS prefix, no transcribed timestamp.
    const auditResult = await executeGoals({
      action: "audit",
      run_id: "autostamp-goal",
      verification_status: "pass",
      summary: "Compared the verifier log against the success criteria; everything matches.",
    });

    expect(auditResult).toBe('Completion audit recorded for "Auto stamp": pass.');
    const run = await getGoalRun(tmpProject, "autostamp-goal");
    const checkedAt = run?.verifier?.lastResult?.checkedAt;
    expect(run?.completionAudit?.status).toBe("pass");
    expect(run?.completionAudit?.summary).toMatch(/^FINAL_AUDIT_PASS/);
    expect(run?.completionAudit?.summary).toContain(`verifier_checked_at=${checkedAt}`);
    expect(run?.completionAudit?.outputPath).toBe("artifacts/verifier.log");
  });
});
