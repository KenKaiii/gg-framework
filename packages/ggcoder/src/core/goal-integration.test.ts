import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GoalRun, GoalTask } from "./goal-store.js";
import {
  confirmAndCommitMainIntegration,
  integrableWorktreeTasks,
  discardStagedIntegration,
  fileMatchesScope,
  finalizeStagedIntegration,
  stageGoalIntegration,
} from "./goal-integration.js";
import { commitGoalWorkerCandidate, createGoalWorkerWorktree } from "./goal-worktree.js";
import type { GoalWorktreeCommandRunner } from "./goal-worktree.js";

const execFileAsync = promisify(execFile);

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-int",
    title: "Integrate candidates",
    goal: "Apply accepted worktree candidates to main deterministically",
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    projectPath: "/main",
    successCriteria: [],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function candidateTask(overrides: Partial<GoalTask> = {}): GoalTask {
  return {
    id: "task-a",
    title: "Implement core change",
    prompt: "Do work",
    status: "done",
    attempts: 1,
    integration: "candidate",
    expectedChangedScope: ["packages/ggcoder/src/core/**"],
    worktree: {
      baseRef: "base",
      branchName: "goal/goal-int/task-a",
      path: "/wt-a",
      status: "created",
    },
    candidate: {
      baseRef: "base",
      headSha: "cand-sha",
      branchName: "goal/goal-int/task-a",
      changedFiles: ["packages/ggcoder/src/core/foo.ts"],
      committed: true,
    },
    ...overrides,
  };
}

type Handler = (call: { cwd: string; args: string[] }) => string | Error;

function makeRunner(handler: Handler): {
  runner: GoalWorktreeCommandRunner;
  calls: Array<{ cwd: string; args: string[] }>;
} {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const runner: GoalWorktreeCommandRunner = {
    async execFile(_file, args, opts) {
      const call = { cwd: opts.cwd, args: [...args] };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Error) throw out;
      return { stdout: out, stderr: "" };
    },
  };
  return { runner, calls };
}

describe("goal staged integration", () => {
  afterEach(() => {
    delete process.env.GG_GOAL_AUTO_INTEGRATE;
  });

  it("matches expected_changed_scope globs conservatively", () => {
    expect(
      fileMatchesScope("packages/ggcoder/src/core/x.ts", ["packages/ggcoder/src/core/**"]),
    ).toBe(true);
    expect(fileMatchesScope("packages/ggcoder/src/ui/x.ts", ["packages/ggcoder/src/core/**"])).toBe(
      false,
    );
    expect(fileMatchesScope("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(fileMatchesScope("src/nested/a.ts", ["src/*.ts"])).toBe(false);
  });

  it("integrates every non-manual worktree candidate", () => {
    const run = goalRun({
      tasks: [
        candidateTask({ id: "after-dep" }),
        candidateTask({ id: "parallel", integration: "candidate" }),
        candidateTask({ id: "serial", integration: "candidate" }),
        candidateTask({ id: "pending", status: "pending" }),
        candidateTask({ id: "manual", integration: "manual" }),
        candidateTask({ id: "no-wt", worktree: undefined }),
        // Read-only task (e.g. audit): worktree but no candidate changes -> excluded.
        candidateTask({ id: "readonly", candidate: undefined }),
      ],
    });
    expect(
      integrableWorktreeTasks(run)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["after-dep", "parallel", "serial"]);
  });

  it("stages an eligible typed candidate on a throwaway branch without touching main", () => {
    const { runner, calls } = makeRunner(({ args }) => {
      if (args[0] === "status") return ""; // main clean
      if (args[0] === "rev-parse") return "mainbase";
      if (args.includes("cherry-pick")) return "";
      return "";
    });

    return stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({ tasks: [candidateTask()] }),
      stagingRoot: "/stage",
      commandRunner: runner,
    }).then((out) => {
      expect(out).toMatchObject({
        status: "staged",
        stagingBranch: "goal/goal-int/integration",
        mainBase: "mainbase",
        integratedTaskIds: ["task-a"],
        changedFiles: ["packages/ggcoder/src/core/foo.ts"],
      });
      // Built a staging worktree and cherry-picked there; main never modified.
      expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
      expect(calls.some((c) => c.args.includes("cherry-pick"))).toBe(true);
      expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
      // No archaeology on the candidate worktree (typed packet used).
      expect(calls.some((c) => c.cwd === "/wt-a")).toBe(false);
    });
  });

  it("falls back when the main checkout is dirty", async () => {
    const { runner, calls } = makeRunner(({ args }) =>
      args[0] === "status" ? " M packages/ggcoder/src/core/foo.ts" : "",
    );
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({ tasks: [candidateTask()] }),
      commandRunner: runner,
    });
    expect(out.status).toBe("fallback");
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
  });

  it("falls back when a candidate changes files outside its scope", async () => {
    const { runner } = makeRunner(({ args }) => (args[0] === "rev-parse" ? "mainbase" : ""));
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({
        tasks: [candidateTask({ expectedChangedScope: ["packages/ggcoder/src/ui/**"] })],
      }),
      commandRunner: runner,
    });
    expect(out.status).toBe("fallback");
    expect(out.status === "fallback" && out.reason).toContain("outside expected_changed_scope");
  });

  it("falls back when a candidate has no expected_changed_scope", async () => {
    const { runner } = makeRunner(() => "");
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({ tasks: [candidateTask({ expectedChangedScope: [] })] }),
      commandRunner: runner,
    });
    expect(out.status).toBe("fallback");
  });

  it("falls back when candidates overlap on the same file", async () => {
    const { runner } = makeRunner(({ args }) => (args[0] === "rev-parse" ? "mainbase" : ""));
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({
        tasks: [
          candidateTask({ id: "task-a" }),
          candidateTask({
            id: "task-b",
            worktree: { baseRef: "base", branchName: "b-b", path: "/wt-b", status: "created" },
            candidate: {
              baseRef: "base",
              headSha: "cand-b",
              branchName: "b-b",
              changedFiles: ["packages/ggcoder/src/core/foo.ts"],
              committed: true,
            },
          }),
        ],
      }),
      commandRunner: runner,
    });
    expect(out.status).toBe("fallback");
    expect(out.status === "fallback" && out.reason).toContain("overlap");
  });

  it("aborts and cleans up staging on a cherry-pick conflict", async () => {
    const { runner, calls } = makeRunner(({ args }) => {
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return "mainbase";
      if (args.includes("cherry-pick") && !args.includes("--abort")) return new Error("CONFLICT");
      return "";
    });
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({ tasks: [candidateTask()] }),
      stagingRoot: "/stage",
      commandRunner: runner,
    });
    expect(out.status).toBe("fallback");
    expect(calls.some((c) => c.args.includes("cherry-pick") && c.args.includes("--abort"))).toBe(
      true,
    );
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
  });

  it("is a noop when there are no candidate worktree tasks", async () => {
    const { runner, calls } = makeRunner(() => "");
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({ tasks: [candidateTask({ integration: "manual" })] }),
      commandRunner: runner,
    });
    expect(out.status).toBe("noop");
    expect(calls).toHaveLength(0);
  });

  it("is disabled via GG_GOAL_AUTO_INTEGRATE=0", async () => {
    process.env.GG_GOAL_AUTO_INTEGRATE = "0";
    const { runner, calls } = makeRunner(() => "");
    const out = await stageGoalIntegration({
      projectPath: "/main",
      run: goalRun({ tasks: [candidateTask()] }),
      commandRunner: runner,
    });
    expect(out.status).toBe("fallback");
    expect(out.status === "fallback" && out.reason).toContain("GG_GOAL_AUTO_INTEGRATE=0");
    expect(calls).toHaveLength(0);
  });
});

describe("goal staged integration (real git)", () => {
  let tmp: string;
  let main: string;

  async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  }

  async function setupRepoWithCandidate(): Promise<{
    baseRef: string;
    run: GoalRun;
    staging: Awaited<ReturnType<typeof stageGoalIntegration>>;
  }> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-staged-real-"));
    main = path.join(tmp, "main");
    await fs.mkdir(main, { recursive: true });
    await git(main, ["init", "-b", "main"]);
    await git(main, ["config", "user.email", "goal@test.local"]);
    await git(main, ["config", "user.name", "Goal Test"]);
    await fs.mkdir(path.join(main, "src"), { recursive: true });
    await fs.writeFile(path.join(main, "src/app.ts"), "export const v = 1;\n", "utf-8");
    await git(main, ["add", "-A"]);
    await git(main, ["commit", "-m", "base"]);
    const baseRef = await git(main, ["rev-parse", "HEAD"]);

    const worktree = await createGoalWorkerWorktree({
      projectPath: main,
      goalRunId: "goal-real",
      goalTaskId: "task-a",
      workerId: "w1",
      baseRef,
      worktreesRoot: path.join(tmp, "worktrees"),
    });
    await fs.writeFile(path.join(worktree.path, "src/app.ts"), "export const v = 2;\n", "utf-8");
    const candidate = await commitGoalWorkerCandidate({
      worktreePath: worktree.path,
      branchName: worktree.branchName,
      baseRef: worktree.baseRef,
      message: "goal(goal-real): candidate task-a",
    });

    const run = goalRun({
      id: "goal-real",
      projectPath: main,
      tasks: [
        candidateTask({
          id: "task-a",
          expectedChangedScope: ["src/**"],
          worktree: {
            baseRef,
            branchName: worktree.branchName,
            path: worktree.path,
            status: "created",
          },
          ...(candidate ? { candidate } : {}),
        }),
      ],
    });
    const staging = await stageGoalIntegration({
      projectPath: main,
      run,
      stagingRoot: path.join(tmp, "staging"),
    });
    return { baseRef, run, staging };
  }

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("stages, verifies-then-fast-forwards main only on success", async () => {
    const { baseRef, staging } = await setupRepoWithCandidate();
    expect(staging.status).toBe("staged");
    // Staging built; main NOT yet advanced.
    expect(await git(main, ["rev-parse", "HEAD"])).toBe(baseRef);
    expect(await fs.readFile(path.join(main, "src/app.ts"), "utf-8")).toBe("export const v = 1;\n");

    if (staging.status !== "staged") throw new Error("expected staged");
    const { commitSha } = await finalizeStagedIntegration({ projectPath: main, staging });

    // After a green fast-forward, main holds the verified change.
    expect(await git(main, ["rev-parse", "HEAD"])).toBe(commitSha);
    expect(commitSha).not.toBe(baseRef);
    expect(await fs.readFile(path.join(main, "src/app.ts"), "utf-8")).toBe("export const v = 2;\n");
    // Staging branch is cleaned up.
    expect(await git(main, ["branch", "--list", staging.stagingBranch])).toBe("");
  });

  it("discards the staging and leaves main untouched on failure", async () => {
    const { baseRef, staging } = await setupRepoWithCandidate();
    expect(staging.status).toBe("staged");
    if (staging.status !== "staged") throw new Error("expected staged");

    await discardStagedIntegration({ projectPath: main, staging });

    // Main is exactly where it started; no unverified changes leaked in.
    expect(await git(main, ["rev-parse", "HEAD"])).toBe(baseRef);
    expect(await fs.readFile(path.join(main, "src/app.ts"), "utf-8")).toBe("export const v = 1;\n");
    expect(await git(main, ["branch", "--list", staging.stagingBranch])).toBe("");
  });

  async function freshRepo(): Promise<string> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-confirm-real-"));
    main = path.join(tmp, "main");
    await fs.mkdir(main, { recursive: true });
    await git(main, ["init", "-b", "main"]);
    await git(main, ["config", "user.email", "e2e@test.local"]);
    await git(main, ["config", "user.name", "E2E"]);
    await fs.writeFile(path.join(main, "a.txt"), "v1\n", "utf-8");
    await git(main, ["add", "-A"]);
    await git(main, ["commit", "-m", "base"]);
    return git(main, ["rev-parse", "HEAD"]);
  }

  it("commits an apply worker's uncommitted changes and confirms main advanced", async () => {
    const baseRef = await freshRepo();
    // Simulate an LLM apply worker that edited main but did NOT commit.
    await fs.writeFile(path.join(main, "a.txt"), "v2\n", "utf-8");

    const result = await confirmAndCommitMainIntegration({
      projectPath: main,
      baseRef,
      message: "goal(g): commit integrated changes",
    });

    expect(result.applied).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.files).toEqual(["a.txt"]);
    expect(result.sha).not.toBe(baseRef);
    // Main is now clean and committed.
    expect(await git(main, ["status", "--porcelain"])).toBe("");
    expect(await git(main, ["rev-parse", "HEAD"])).toBe(result.sha);
  });

  it("confirms applied when the apply worker already committed (nothing to commit)", async () => {
    const baseRef = await freshRepo();
    await fs.writeFile(path.join(main, "a.txt"), "v2\n", "utf-8");
    await git(main, ["add", "-A"]);
    await git(main, ["commit", "-m", "worker already committed"]);

    const result = await confirmAndCommitMainIntegration({
      projectPath: main,
      baseRef,
      message: "goal(g): commit integrated changes",
    });

    expect(result.applied).toBe(true);
    expect(result.committed).toBe(false); // nothing left to commit
    expect(result.files).toEqual(["a.txt"]);
  });

  it("reports not-applied when main is unchanged versus the base", async () => {
    const baseRef = await freshRepo();
    const result = await confirmAndCommitMainIntegration({
      projectPath: main,
      baseRef,
      message: "goal(g): commit integrated changes",
    });
    expect(result.applied).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.files).toEqual([]);
  });
});
