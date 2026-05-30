import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GoalRun } from "./goal-store.js";
import {
  checkGoalWorktreeIntegration,
  checkpointGoalWorkingTree,
  commitGoalWorkerCandidate,
  createGoalWorkerWorktree,
  goalWorktreeRoot,
  isGitWorktreeViable,
  removeGoalRunWorktrees,
  sanitizeWorktreeToken,
} from "./goal-worktree.js";
import type { GoalWorktreeCommandRunner } from "./goal-worktree.js";

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-a",
    title: "Integrate workers",
    goal: "Ensure worker artifacts reach main checkout before verifier.",
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    projectPath: "/tmp/project",
    successCriteria: ["Verifier sees worker artifacts"],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function runnerFor(statusByCwd: Record<string, string>): GoalWorktreeCommandRunner {
  return {
    async execFile(_file, args, options) {
      expect(args).toEqual(["status", "--porcelain"]);
      return { stdout: statusByCwd[options.cwd] ?? "", stderr: "" };
    },
  };
}

describe("goal worktree helpers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-worktree-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sanitizes worktree tokens for branch and path names", () => {
    expect(sanitizeWorktreeToken("Task: refactor / App?!")).toBe("Task-refactor-App");
    expect(sanitizeWorktreeToken("***")).toBe("item");
  });

  it("places worker worktrees beside the project checkout", () => {
    expect(goalWorktreeRoot(path.join("/tmp", "repo"))).toBe(
      path.join("/tmp", "repo-goal-worktrees"),
    );
  });

  it("creates a branch worktree from the requested base ref", async () => {
    const projectPath = path.join(tmpDir, "main");
    const root = path.join(tmpDir, "worktrees");
    await fs.mkdir(projectPath, { recursive: true });
    const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        return { stdout: "", stderr: "" };
      }),
    };

    const candidate = await createGoalWorkerWorktree({
      projectPath,
      goalRunId: "goal-123",
      goalTaskId: "task/app split",
      workerId: "worker-1",
      baseRef: "abc123",
      worktreesRoot: root,
      commandRunner: runner,
    });

    expect(candidate).toEqual({
      baseRef: "abc123",
      branchName: "goal/goal-123/task-app-split-worker-1",
      path: path.join(root, "task-app-split-worker-1"),
    });
    expect(calls).toEqual([
      {
        file: "git",
        args: ["status", "--porcelain"],
        cwd: projectPath,
      },
      {
        file: "git",
        args: ["worktree", "add", "-b", candidate.branchName, candidate.path, "abc123"],
        cwd: projectPath,
      },
    ]);
  });

  it("resolves HEAD as the base ref when no explicit base is supplied", async () => {
    const projectPath = path.join(tmpDir, "main");
    const root = path.join(tmpDir, "worktrees");
    await fs.mkdir(projectPath, { recursive: true });
    const calls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        calls.push(args);
        return args[0] === "rev-parse"
          ? { stdout: "head-sha\n", stderr: "" }
          : { stdout: "", stderr: "" };
      }),
    };

    const candidate = await createGoalWorkerWorktree({
      projectPath,
      goalRunId: "goal",
      goalTaskId: "task",
      workerId: "worker",
      worktreesRoot: root,
      commandRunner: runner,
    });

    expect(candidate.baseRef).toBe("head-sha");
    expect(calls[0]).toEqual(["status", "--porcelain"]);
    expect(calls[1]).toEqual(["rev-parse", "HEAD"]);
    expect(calls[2]?.at(-1)).toBe("head-sha");
  });

  it("refuses to create worker worktrees from dirty integration checkouts", async () => {
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) =>
        args[0] === "status"
          ? { stdout: " M packages/app.ts\n", stderr: "" }
          : { stdout: "", stderr: "" },
      ),
    };

    await expect(
      createGoalWorkerWorktree({
        projectPath: "/repo/main",
        goalRunId: "goal",
        goalTaskId: "task",
        workerId: "worker",
        baseRef: "base-sha",
        commandRunner: runner,
      }),
    ).rejects.toThrow("Goal workers need a clean working tree");
  });

  it("checkpoint is a no-op on a clean working tree", async () => {
    const calls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      }),
    };

    const result = await checkpointGoalWorkingTree({
      projectPath: "/repo/main",
      message: "goal(g): checkpoint",
      commandRunner: runner,
    });

    expect(result).toEqual({ committed: false, status: "" });
    expect(calls).toEqual([["status", "--porcelain"]]);
  });

  it("checkpoint commits a dirty working tree and returns sha and files", async () => {
    const calls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        calls.push(args);
        if (args[0] === "status") return { stdout: " M src/b.ts\n?? src/a.ts\n", stderr: "" };
        if (args[0] === "rev-parse") return { stdout: "checkpoint-sha\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }),
    };

    const result = await checkpointGoalWorkingTree({
      projectPath: "/repo/main",
      message: "goal(g): checkpoint uncommitted work before worker w1",
      commandRunner: runner,
    });

    expect(result).toEqual({
      committed: true,
      sha: "checkpoint-sha",
      status: " M src/b.ts\n?? src/a.ts",
      files: ["src/a.ts", "src/b.ts"],
    });
    expect(calls).toEqual([
      ["status", "--porcelain"],
      ["add", "-A"],
      ["commit", "-m", "goal(g): checkpoint uncommitted work before worker w1"],
      ["rev-parse", "HEAD"],
    ]);
  });

  it("detects git worktree viability (work tree + resolvable HEAD)", async () => {
    const viable: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) =>
        args[1] === "--is-inside-work-tree"
          ? { stdout: "true\n", stderr: "" }
          : { stdout: "sha\n", stderr: "" },
      ),
    };
    const notWorkTree: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async () => ({ stdout: "false\n", stderr: "" })),
    };
    const gitMissing: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async () => {
        throw new Error("spawn git ENOENT");
      }),
    };
    const noCommits: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        if (args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
        throw new Error("fatal: needed a single revision");
      }),
    };

    expect(await isGitWorktreeViable("/repo", viable)).toBe(true);
    expect(await isGitWorktreeViable("/repo", notWorkTree)).toBe(false);
    expect(await isGitWorktreeViable("/repo", gitMissing)).toBe(false);
    expect(await isGitWorktreeViable("/repo", noCommits)).toBe(false);
  });

  it("retries the checkpoint commit with a fallback identity when none is configured", async () => {
    const calls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        calls.push(args);
        if (args[0] === "status") return { stdout: " M a.ts\n", stderr: "" };
        if (args[0] === "config") throw new Error("unset"); // no user.email/name
        if (args.includes("commit") && !args.includes("-c")) {
          throw new Error("Please tell me who you are");
        }
        if (args.includes("commit")) return { stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { stdout: "sha\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }),
    };

    const result = await checkpointGoalWorkingTree({
      projectPath: "/repo",
      message: "goal(g): checkpoint",
      commandRunner: runner,
    });

    expect(result.committed).toBe(true);
    const retried = calls.find((args) => args.includes("-c") && args.includes("commit"));
    expect(retried).toBeDefined();
    expect(retried?.join(" ")).toContain("user.email=goal@ggcoder.local");
  });

  it("commits a dirty worktree into a typed candidate packet", async () => {
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        if (args[0] === "status") return { stdout: " M src/core/a.ts\n", stderr: "" };
        if (args[0] === "rev-parse") return { stdout: "candidate-sha\n", stderr: "" };
        if (args[0] === "diff") return { stdout: "src/core/a.ts\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }),
    };

    const candidate = await commitGoalWorkerCandidate({
      worktreePath: "/wt",
      branchName: "goal/g/task",
      baseRef: "base-sha",
      message: "goal(g): candidate task",
      commandRunner: runner,
    });

    expect(candidate).toEqual({
      baseRef: "base-sha",
      headSha: "candidate-sha",
      branchName: "goal/g/task",
      changedFiles: ["src/core/a.ts"],
      committed: true,
    });
  });

  it("returns no candidate when a worker produced no changes", async () => {
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        if (args[0] === "status") return { stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { stdout: "base-sha\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }),
    };

    const candidate = await commitGoalWorkerCandidate({
      worktreePath: "/wt",
      branchName: "goal/g/task",
      baseRef: "base-sha",
      message: "goal(g): candidate task",
      commandRunner: runner,
    });

    expect(candidate).toBeUndefined();
  });

  it("removes a completed run's worktrees, branches, and prunes", async () => {
    const calls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      }),
    };

    const result = await removeGoalRunWorktrees(
      "/main",
      goalRun({
        tasks: [
          {
            id: "task-a",
            title: "A",
            prompt: "x",
            status: "done",
            attempts: 1,
            worktree: {
              baseRef: "b",
              branchName: "goal/a/task-a",
              path: "/wt-a",
              status: "created",
            },
          },
          {
            id: "task-b",
            title: "B",
            prompt: "x",
            status: "done",
            attempts: 1,
            worktree: {
              baseRef: "b",
              branchName: "goal/a/task-b",
              path: "/wt-b",
              status: "created",
            },
          },
          { id: "task-c", title: "C", prompt: "x", status: "done", attempts: 1 },
        ],
      }),
      runner,
    );

    expect(result.removedPaths).toEqual(["/wt-a", "/wt-b"]);
    expect(result.removedBranches).toEqual(["goal/a/task-a", "goal/a/task-b"]);
    expect(calls).toContainEqual(["worktree", "remove", "--force", "/wt-a"]);
    expect(calls).toContainEqual(["branch", "-D", "goal/a/task-b"]);
    expect(calls).toContainEqual(["worktree", "prune"]);
  });

  it("tolerates already-removed worktrees during cleanup", async () => {
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        if (args[0] === "worktree" && args[1] === "remove") throw new Error("not a working tree");
        if (args[0] === "branch") throw new Error("branch not found");
        return { stdout: "", stderr: "" };
      }),
    };

    const result = await removeGoalRunWorktrees(
      "/main",
      goalRun({
        tasks: [
          {
            id: "task-a",
            title: "A",
            prompt: "x",
            status: "done",
            attempts: 1,
            worktree: {
              baseRef: "b",
              branchName: "goal/a/task-a",
              path: "/wt-a",
              status: "created",
            },
          },
        ],
      }),
      runner,
    );

    expect(result.removedPaths).toEqual([]);
    expect(result.removedBranches).toEqual([]);
  });

  it("passes integration check when completed worker worktrees are clean", async () => {
    const result = await checkGoalWorktreeIntegration(
      "/tmp/project",
      goalRun({
        tasks: [
          {
            id: "task-a",
            title: "Clean candidate",
            prompt: "Do work",
            status: "done",
            attempts: 1,
            workerId: "worker-a",
            worktree: {
              baseRef: "base",
              branchName: "goal/a/task-a-worker-a",
              path: "/tmp/worktree-a",
              status: "created",
            },
          },
        ],
      }),
      runnerFor({ "/tmp/worktree-a": "" }),
    );

    expect(result).toEqual({
      ok: true,
      issues: [],
      summary: "All completed Goal worktree tasks are integrated or clean.",
    });
  });

  it("blocks verifier when a completed worker still has unintegrated files", async () => {
    const result = await checkGoalWorktreeIntegration(
      "/tmp/project",
      goalRun({
        tasks: [
          {
            id: "task-a",
            title: "Verifier harness",
            prompt: "Create verifier",
            status: "done",
            attempts: 1,
            workerId: "worker-a",
            integration: "candidate",
            worktree: {
              baseRef: "base",
              branchName: "goal/a/task-a-worker-a",
              path: "/tmp/worktree-a",
              status: "created",
            },
          },
        ],
      }),
      runnerFor({
        "/tmp/worktree-a":
          "?? packages/ggcoder/scripts/verify-goal-overhead-harness.ts\n M packages/ggcoder/package.json\n",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      taskId: "task-a",
      taskTitle: "Verifier harness",
      workerId: "worker-a",
      worktreePath: "/tmp/worktree-a",
      files: [
        "packages/ggcoder/package.json",
        "packages/ggcoder/scripts/verify-goal-overhead-harness.ts",
      ],
    });
    expect(result.summary).toContain("stranded in isolated worktrees");
  });

  it("ignores pending tasks and manual integration candidates during integration check", async () => {
    const result = await checkGoalWorktreeIntegration(
      "/tmp/project",
      goalRun({
        tasks: [
          {
            id: "manual-task",
            title: "Manual candidate",
            prompt: "Do work",
            status: "done",
            attempts: 1,
            integration: "manual",
            worktree: {
              baseRef: "base",
              branchName: "goal/a/manual",
              path: "/tmp/manual",
              status: "created",
            },
          },
          {
            id: "pending-task",
            title: "Pending candidate",
            prompt: "Do work",
            status: "pending",
            attempts: 0,
            worktree: {
              baseRef: "base",
              branchName: "goal/a/pending",
              path: "/tmp/pending",
              status: "created",
            },
          },
        ],
      }),
      runnerFor({
        "/tmp/manual": "?? stranded.ts\n",
        "/tmp/pending": "?? stranded.ts\n",
      }),
    );

    expect(result.ok).toBe(true);
  });
});
