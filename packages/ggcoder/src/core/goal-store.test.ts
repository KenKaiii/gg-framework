import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendGoalDecision,
  appendGoalEvidence,
  createGoalTask,
  formatGoalBlockingPrerequisites,
  formatGoalPrerequisiteInstruction,
  getActiveGoalRun,
  getGoalRun,
  hashPath,
  loadGoalRuns,
  projectDir,
  reconcileActiveGoalRuns,
  saveGoalRuns,
  summarizeGoalCounts,
  summarizeGoalCountsFromRuns,
  updateGoalTask,
  upsertGoalRun,
  type GoalRun,
} from "./goal-store.js";

let tmpBase: string;
let tmpProject: string;

async function readGoalsFile(cwd: string): Promise<GoalRun[]> {
  const raw = await fs.readFile(path.join(projectDir(cwd), "goals.json"), "utf-8");
  return JSON.parse(raw) as GoalRun[];
}

beforeEach(async () => {
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goal-store-test-base-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-store-test-project-"));
  process.env.GG_GOALS_BASE = tmpBase;
});

afterEach(async () => {
  delete process.env.GG_GOALS_BASE;
  await fs.rm(tmpBase, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("goal store persistence", () => {
  it("returns empty runs for a project with no goal file", async () => {
    await expect(loadGoalRuns(tmpProject)).resolves.toEqual([]);
  });

  it("uses stable normalized per-project hashed directories", async () => {
    const relativeProject = path.relative(process.cwd(), tmpProject);
    expect(hashPath(tmpProject)).toHaveLength(16);
    expect(hashPath(relativeProject)).toBe(hashPath(tmpProject));
    expect(projectDir(relativeProject)).toBe(path.join(tmpBase, hashPath(tmpProject)));

    const run = await upsertGoalRun(relativeProject, {
      id: "normalized-run",
      title: "Normalized",
      goal: "Persist under stable absolute path",
    });
    expect(run.projectPath).toBe(path.resolve(relativeProject));
    await expect(getGoalRun(tmpProject, "normalized-run")).resolves.toMatchObject({
      id: "normalized-run",
    });
  });

  it("creates and updates a goal run", async () => {
    const created = await upsertGoalRun(tmpProject, {
      title: "Refine prompt",
      goal: "Build a repeatable prompt harness",
      successCriteria: ["Harness runs", "Verifier passes"],
      status: "ready",
      evidencePlan: [
        {
          id: "proof-a",
          label: "Browser smoke proof",
          mechanism: "browser",
          description: "Run a local browser smoke test.",
          status: "planned",
        },
      ],
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe("ready");
    expect(created.successCriteria).toEqual(["Harness runs", "Verifier passes"]);
    expect(created.evidencePlan[0]).toMatchObject({
      id: "proof-a",
      mechanism: "browser",
      status: "planned",
    });

    const updated = await upsertGoalRun(tmpProject, {
      id: created.id,
      title: "Refine prompt automatically",
      goal: created.goal,
      blockers: ["Need test persona list"],
      status: "blocked",
    });

    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("Refine prompt automatically");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    expect(updated.blockers).toEqual(["Need test persona list"]);
    expect(updated.evidencePlan[0]?.id).toBe("proof-a");

    const loaded = await getGoalRun(tmpProject, created.id.slice(0, 8));
    expect(loaded?.title).toBe("Refine prompt automatically");
  });

  it("formats user-facing prerequisite instructions", async () => {
    const run = await upsertGoalRun(tmpProject, {
      title: "Supabase setup",
      goal: "Connect to Supabase",
      status: "ready",
      prerequisites: [
        {
          id: "token",
          label: "Supabase token",
          status: "missing",
          instructions: "Provide SUPABASE_ACCESS_TOKEN in chat or the local environment.",
        },
      ],
    });

    expect(formatGoalPrerequisiteInstruction(run.prerequisites[0])).toBe(
      "Provide SUPABASE_ACCESS_TOKEN in chat or the local environment.",
    );
    expect(formatGoalBlockingPrerequisites(run)).toBe(
      "Supabase token: Provide SUPABASE_ACCESS_TOKEN in chat or the local environment.",
    );
  });

  it("marks a run blocked when prerequisites are unknown, missing, or met without evidence", async () => {
    const unknownRun = await upsertGoalRun(tmpProject, {
      title: "Expo audio check",
      goal: "Verify app audio playback programmatically",
      status: "ready",
      prerequisites: [
        { id: "ffmpeg", label: "ffmpeg available", status: "met", evidence: "ffmpeg exists" },
        { id: "sim", label: "iOS simulator available", status: "unknown" },
      ],
    });
    const uncheckedMetRun = await upsertGoalRun(tmpProject, {
      title: "Unchecked tooling",
      goal: "Prevent lazy prerequisite approval",
      status: "ready",
      prerequisites: [{ id: "tooling", label: "Local tooling", status: "met" }],
    });

    expect(unknownRun.status).toBe("blocked");
    expect(uncheckedMetRun.status).toBe("blocked");
    expect(formatGoalBlockingPrerequisites(uncheckedMetRun)).toBe(
      "Local tooling: Prerequisite is marked met but has no recorded check evidence; verify it locally and record non-secret evidence.",
    );

    const counts = summarizeGoalCountsFromRuns([unknownRun, uncheckedMetRun]);
    expect(counts.blocked).toBe(2);
    expect(counts.active).toBe(2);
  });

  it("merges stale run snapshots without dropping fresher task and evidence writes", async () => {
    const run = await upsertGoalRun(tmpProject, {
      id: "stale-merge-run",
      title: "Stale merge",
      goal: "Keep fresh task metadata",
      status: "ready",
      tasks: [createGoalTask({ id: "task-a", title: "Task A", prompt: "Do A" })],
    });
    const stale = { ...run, tasks: run.tasks.map((item) => ({ ...item })) };

    await updateGoalTask(tmpProject, run.id, "task-a", {
      status: "blocked",
      attempts: 2,
      lastSummary: "Paused after worker attempt limit.",
    });
    await appendGoalEvidence(tmpProject, run.id, {
      kind: "summary",
      label: "Goal paused",
      content: "Attempt limit reached",
    });

    const persisted = await upsertGoalRun(tmpProject, {
      ...stale,
      status: "paused",
      blockers: ["Attempt limit reached"],
    });

    expect(persisted.tasks[0]).toMatchObject({
      id: "task-a",
      status: "blocked",
      attempts: 2,
      lastSummary: "Paused after worker attempt limit.",
    });
    expect(persisted.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Goal paused" })]),
    );
  });

  it("updates task state and appends a new task if given a task input", async () => {
    const task = createGoalTask({
      id: "task-a",
      title: "Create harness",
      prompt: "Create scripts/goal-harness.ts",
    });
    const run = await upsertGoalRun(tmpProject, {
      title: "Harness",
      goal: "Build harness",
      tasks: [task],
    });

    const updatedRun = await updateGoalTask(tmpProject, run.id, "task-a", {
      status: "done",
      lastSummary: "Harness created",
    });
    expect(updatedRun?.tasks[0]?.status).toBe("done");
    expect(updatedRun?.tasks[0]?.lastSummary).toBe("Harness created");
    expect(updatedRun?.tasks[0]?.title).toBe("Create harness");
    expect(updatedRun?.tasks[0]?.prompt).toBe("Create scripts/goal-harness.ts");

    const appendedRun = await updateGoalTask(tmpProject, run.id, "new-task", {
      id: "task-b",
      title: "Run verifier",
      prompt: "Run pnpm test",
      status: "pending",
      dependsOn: ["task-a"],
      parallelGroup: "verify",
      expectedChangedScope: ["packages/ggcoder/src/core/goal-store.ts"],
      integration: "candidate",
    });
    expect(appendedRun?.tasks.map((item) => item.id)).toEqual(["task-a", "task-b"]);
    expect(appendedRun?.tasks[1]).toMatchObject({
      dependsOn: ["task-a"],
      parallelGroup: "verify",
      expectedChangedScope: ["packages/ggcoder/src/core/goal-store.ts"],
      integration: "candidate",
    });
  });

  it("discovers a run by id even when the caller cwd does not match the project cwd", async () => {
    const otherProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-store-test-other-project-"));
    try {
      await upsertGoalRun(tmpProject, {
        id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569",
        title: "Vanished run",
        goal: "Recover discoverability by UUID",
        status: "ready",
      });

      await expect(
        getGoalRun(otherProject, "099c9f7f-bce7-475c-93b8-d9b3f88a0569"),
      ).resolves.toMatchObject({
        id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569",
        projectPath: tmpProject,
      });
      await expect(getGoalRun(otherProject, "099c9f7f")).resolves.toMatchObject({
        id: "099c9f7f-bce7-475c-93b8-d9b3f88a0569",
      });
    } finally {
      await fs.rm(otherProject, { recursive: true, force: true });
    }
  });

  it("appends evidence to an existing run", async () => {
    const run = await upsertGoalRun(tmpProject, {
      title: "Evidence",
      goal: "Capture command output",
    });

    const updated = await appendGoalEvidence(tmpProject, run.id, {
      kind: "command",
      label: "Verifier output",
      content: "Exit code: 0",
    });

    expect(updated?.evidence).toHaveLength(1);
    expect(updated?.evidence[0]?.kind).toBe("command");
    expect(updated?.evidence[0]?.content).toBe("Exit code: 0");
  });

  it("appends durable decision evidence and generates a progress journal", async () => {
    const run = await upsertGoalRun(tmpProject, {
      id: "decision-run",
      title: "Decision",
      goal: "Record controller rationale",
      tasks: [createGoalTask({ id: "task-a", title: "Do work", prompt: "Do work" })],
    });

    await appendGoalDecision(tmpProject, run.id, {
      kind: "start_worker",
      task: run.tasks[0]!,
      attempts: 1,
      reason: "Task is ready.",
    });

    const loaded = await getGoalRun(tmpProject, run.id);
    expect(loaded?.evidence[0]).toMatchObject({
      kind: "summary",
      label: "Goal decision: start_worker",
    });
    expect(loaded?.evidence[0]?.content).toContain("reason=Task is ready.");
    const journal = await fs.readFile(
      path.join(projectDir(tmpProject), "journals", `${run.id}.md`),
      "utf-8",
    );
    expect(journal).toContain("# Decision");
    expect(journal).toContain("Goal decision: start_worker");
  });

  it("loads runs newest-first", async () => {
    const oldRun = await upsertGoalRun(tmpProject, {
      id: "old",
      title: "Old",
      goal: "Old goal",
    });
    const newRun = await upsertGoalRun(tmpProject, {
      id: "new",
      title: "New",
      goal: "New goal",
    });

    const saved = await readGoalsFile(tmpProject);
    saved[0] = { ...oldRun, updatedAt: "2020-01-01T00:00:00.000Z" };
    saved[1] = { ...newRun, updatedAt: "2021-01-01T00:00:00.000Z" };
    await saveGoalRuns(tmpProject, saved);

    const loaded = await loadGoalRuns(tmpProject);
    expect(loaded.map((run) => run.id)).toEqual(["new", "old"]);
  });

  it("falls back to empty runs for corrupt goal JSON", async () => {
    await fs.mkdir(projectDir(tmpProject), { recursive: true });
    await fs.writeFile(path.join(projectDir(tmpProject), "goals.json"), "{not-json", "utf-8");

    await expect(loadGoalRuns(tmpProject)).resolves.toEqual([]);
  });

  it("recovers stale goal store locks left by exited processes", async () => {
    await fs.mkdir(projectDir(tmpProject), { recursive: true });
    const stalePid = 999_999_999;
    await fs.writeFile(
      path.join(projectDir(tmpProject), "goals.lock"),
      `${stalePid}\n2024-01-01T00:00:00.000Z\n`,
      "utf-8",
    );

    await expect(
      upsertGoalRun(tmpProject, {
        id: "after-stale-lock",
        title: "After stale lock",
        goal: "Writes can recover stale locks",
      }),
    ).resolves.toMatchObject({ id: "after-stale-lock" });
    await expect(fs.stat(path.join(projectDir(tmpProject), "goals.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reconciles stale running workers and verifier state", async () => {
    const run = await upsertGoalRun(tmpProject, {
      id: "stale-run",
      title: "Stale",
      goal: "Recover stale goal state",
      status: "running",
      activeWorkerId: "worker-old",
      tasks: [
        createGoalTask({
          id: "task-running",
          title: "Interrupted task",
          prompt: "Do work",
          status: "running",
          workerId: "worker-old",
        }),
      ],
    });

    const result = await reconcileActiveGoalRuns(tmpProject, {
      isWorkerActive: () => false,
      isVerifierActive: () => false,
    });
    const repaired = result.runs.find((item) => item.id === run.id);

    expect(result.repairedRunIds).toEqual([run.id]);
    expect(repaired?.status).toBe("ready");
    expect(repaired?.activeWorkerId).toBeUndefined();
    expect(repaired?.tasks[0]?.status).toBe("pending");
    expect(repaired?.evidence.map((item) => item.label)).toEqual([
      "Goal worker reconciled",
      "Goal task reconciled",
    ]);
  });

  it("reconciles stale verifying state with blocker evidence", async () => {
    const run = await upsertGoalRun(tmpProject, {
      id: "verifying-run",
      title: "Verifying",
      goal: "Recover verifier",
      status: "verifying",
      verifier: { description: "test", command: "pnpm test" },
    });

    const result = await reconcileActiveGoalRuns(tmpProject, { isVerifierActive: () => false });
    const repaired = result.runs.find((item) => item.id === run.id);

    expect(repaired?.status).toBe("ready");
    expect(repaired?.blockers).toContain(
      "Verifier was interrupted; rerun or continue the Goal to verify again.",
    );
    expect(repaired?.evidence.at(-1)?.label).toBe("Goal verifier reconciled");
  });

  it("preserves observed active Goal workers", async () => {
    const run = await upsertGoalRun(tmpProject, {
      id: "active-run",
      title: "Active",
      goal: "Keep active worker",
      status: "running",
      activeWorkerId: "worker-live",
      tasks: [
        createGoalTask({
          id: "task-live",
          title: "Live task",
          prompt: "Do work",
          status: "running",
          workerId: "worker-live",
        }),
      ],
    });

    const result = await reconcileActiveGoalRuns(tmpProject, {
      isWorkerActive: (workerId) => workerId === "worker-live",
    });

    expect(result.repairedRunIds).toEqual([]);
    expect(result.runs.find((item) => item.id === run.id)?.status).toBe("running");
  });

  it("rejects saves that omit any active Goal work", async () => {
    await upsertGoalRun(tmpProject, {
      id: "active-run",
      title: "Active",
      goal: "Do not erase active work",
      status: "running",
      activeWorkerId: "worker-live",
      tasks: [
        createGoalTask({
          id: "task-live",
          title: "Live task",
          prompt: "Do work",
          status: "running",
          workerId: "worker-live",
        }),
      ],
    });

    await saveGoalRuns(tmpProject, [
      {
        id: "other-run",
        title: "Other",
        goal: "Other durable state",
        status: "ready",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectPath: tmpProject,
        successCriteria: [],
        prerequisites: [],
        harness: [],
        evidencePlan: [],
        tasks: [],
        evidence: [],
        blockers: [],
      },
    ]);
    const runs = await loadGoalRuns(tmpProject);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "active-run", status: "running" });
    expect(runs[0]?.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Goal store write rejected" })]),
    );
  });

  it("selects the active run and summarizes counts", async () => {
    await upsertGoalRun(tmpProject, {
      id: "passed",
      title: "Done",
      goal: "Done goal",
      status: "passed",
    });
    const running = await upsertGoalRun(tmpProject, {
      id: "running",
      title: "Running",
      goal: "Running goal",
      status: "running",
    });
    await upsertGoalRun(tmpProject, {
      id: "failed",
      title: "Failed",
      goal: "Failed goal",
      status: "failed",
    });

    const active = await getActiveGoalRun(tmpProject);
    expect(active?.id).toBe(running.id);

    const counts = await summarizeGoalCounts(tmpProject);
    expect(counts.total).toBe(3);
    expect(counts.running).toBe(1);
    expect(counts.passed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.active).toBe(1);
  });

  it("preserves every interleaved mutation without lost updates", async () => {
    await upsertGoalRun(tmpProject, {
      id: "race",
      title: "Race",
      goal: "Concurrent mutations must not clobber each other",
      status: "running",
    });
    await updateGoalTask(tmpProject, "race", "task-a", {
      id: "task-a",
      title: "Worker task",
      prompt: "Do work",
      status: "running",
      attempts: 0,
    });

    // Interleave evidence appends, a decision, and a task update the way the
    // parent orchestrator and a worker subprocess would race in a real run.
    await Promise.all([
      ...Array.from({ length: 12 }, (_unused, index) =>
        appendGoalEvidence(tmpProject, "race", {
          kind: "log",
          label: `Concurrent evidence ${index}`,
          content: `entry-${index}`,
        }),
      ),
      appendGoalDecision(tmpProject, "race", { kind: "start_worker", reason: "racing" }),
      updateGoalTask(tmpProject, "race", "task-a", { status: "done", attempts: 1 }),
    ]);

    const run = (await loadGoalRuns(tmpProject)).find((item) => item.id === "race");
    const labels = new Set((run?.evidence ?? []).map((item) => item.label));
    for (let index = 0; index < 12; index += 1) {
      expect(labels.has(`Concurrent evidence ${index}`)).toBe(true);
    }
    expect(labels.has("Goal decision: start_worker")).toBe(true);
    expect(run?.tasks[0]).toMatchObject({ id: "task-a", status: "done", attempts: 1 });
  });

  it("carries typed integration and lastSubstantiveWorkerAt through persistence", async () => {
    await upsertGoalRun(tmpProject, {
      id: "typed-state",
      title: "Typed state",
      goal: "Persist typed integration state",
      integration: {
        status: "committed",
        headSha: "abc1234",
        baseRef: "base-sha",
        files: ["src/x.ts"],
        updatedAt: "2024-01-01T00:00:05.000Z",
      },
      lastSubstantiveWorkerAt: "2024-01-01T00:00:04.000Z",
    });
    const run = (await loadGoalRuns(tmpProject)).find((item) => item.id === "typed-state");
    expect(run?.integration).toEqual({
      status: "committed",
      headSha: "abc1234",
      baseRef: "base-sha",
      files: ["src/x.ts"],
      updatedAt: "2024-01-01T00:00:05.000Z",
    });
    expect(run?.lastSubstantiveWorkerAt).toBe("2024-01-01T00:00:04.000Z");
  });

  it("infers typed integration and lastSubstantiveWorkerAt from legacy evidence labels", async () => {
    // A run persisted before typed integration/lastSubstantiveWorkerAt existed:
    // only evidence labels record what happened. The normalizer migrates it once.
    const dir = projectDir(tmpProject);
    await fs.mkdir(dir, { recursive: true });
    const legacyRun = {
      id: "legacy",
      title: "Legacy run",
      goal: "Legacy goal",
      status: "ready",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      projectPath: path.resolve(tmpProject),
      successCriteria: [],
      prerequisites: [],
      harness: [],
      evidencePlan: [],
      references: [],
      tasks: [],
      evidence: [
        {
          id: "worker-done",
          kind: "log",
          label: "Worker abc123 done",
          content: "impl complete",
          createdAt: "2024-01-01T00:00:02.000Z",
        },
        {
          id: "applied",
          kind: "summary",
          label: "Integrated worktree applied to main",
          content: "applied",
          createdAt: "2024-01-01T00:00:03.000Z",
        },
        {
          id: "committed",
          kind: "summary",
          label: "Integrated Goal changes committed",
          content: "committed",
          createdAt: "2024-01-01T00:00:04.000Z",
        },
      ],
      blockers: [],
    };
    await fs.writeFile(
      path.join(dir, "goals.json"),
      JSON.stringify([legacyRun], null, 2) + "\n",
      "utf-8",
    );
    const run = (await loadGoalRuns(tmpProject)).find((item) => item.id === "legacy");
    expect(run?.integration).toEqual({
      status: "committed",
      updatedAt: "2024-01-01T00:00:04.000Z",
    });
    expect(run?.lastSubstantiveWorkerAt).toBe("2024-01-01T00:00:02.000Z");
  });
});
