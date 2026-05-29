import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { getGoalRun, updateGoalTask, upsertGoalRun } from "./goal-store.js";
import type { GoalWorktreeCommandRunner } from "./goal-worktree.js";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock, execFile: vi.fn() }));
vi.mock("../utils/process.js", () => ({ killProcessTree: killProcessTreeMock }));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  kill = vi.fn();
}

let tmpBase: string;
let tmpProject: string;
let child: FakeChild;

async function flushUntil(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function seedGoal(): Promise<void> {
  await upsertGoalRun(tmpProject, {
    id: "goal-a",
    title: "Worker harness",
    goal: "Exercise worker exits",
    status: "ready",
    successCriteria: ["worker covered"],
    prerequisites: [],
    harness: [],
    tasks: [],
    evidence: [],
    blockers: [],
  });
  await updateGoalTask(tmpProject, "goal-a", "task-a", {
    id: "task-a",
    title: "Run worker",
    prompt: "Do work",
    status: "pending",
    attempts: 0,
  });
}

async function start(onComplete = vi.fn()) {
  const mod = await import("./goal-worker.js");
  const record = await mod.startGoalWorker({
    cwd: tmpProject,
    provider: "anthropic",
    model: "claude-test",
    goalRunId: "goal-a",
    goalTaskId: "task-a",
    prompt: "Do deterministic work",
    isolateWorktree: false,
    onComplete,
  });
  return { mod, record, onComplete };
}

beforeEach(async () => {
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goal-worker-test-base-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-worker-test-project-"));
  process.env.GG_GOALS_BASE = tmpBase;
  child = new FakeChild();
  spawnMock.mockReturnValue(child as unknown as ChildProcess);
  killProcessTreeMock.mockReset();
  process.argv[1] = "/tmp/fake-ggcoder-cli.js";
  await seedGoal();
});

afterEach(async () => {
  const mod = await import("./goal-worker.js");
  mod.shutdownGoalWorkers(tmpProject);
  vi.clearAllMocks();
  delete process.env.GG_GOALS_BASE;
  await fs.rm(tmpBase, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

describe("goal worker failure propagation", () => {
  it("times out hanging workers, kills the process tree, and records timeout evidence", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const mod = await import("./goal-worker.js");
    const record = await mod.startGoalWorker({
      cwd: tmpProject,
      provider: "anthropic",
      model: "claude-test",
      goalRunId: "goal-a",
      goalTaskId: "task-a",
      prompt: "Hang forever",
      isolateWorktree: false,
      timeoutMs: 10,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(11);
    child.emit("close", null);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await flushUntil(() => expect(onComplete).toHaveBeenCalled());

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(record.status).toBe("failed");
    expect(run?.activeWorkerId).toBeUndefined();
    expect(run?.tasks[0]).toMatchObject({
      status: "failed",
      workerId: record.id,
      lastSummary: expect.stringContaining("timed out after 10ms"),
    });
    expect(run?.evidence.some((item) => item.label === `Worker ${record.id} timeout`)).toBe(true);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", exitCode: 124, reason: "timeout" }),
    );
  });

  it("prompts workers with explicit durable Goal context before claiming verification", async () => {
    await start();
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const systemPromptIndex = args.indexOf("--system-prompt") + 1;
    const prompt = args[systemPromptIndex];

    expect(args).not.toContain("--thinking");
    expect(prompt).toContain(`cwd=${tmpProject}`);
    expect(prompt).toContain("run_id=goal-a");
    expect(prompt).toContain("task_id=task-a");
    expect(prompt).toContain("model the intended experience");
    expect(prompt).toContain("choose the required senses/signals");
    expect(prompt).toContain("simplest local/free proof path");
    expect(prompt).toContain("when they directly observe those signals");
    expect(prompt).toContain("source_path/docs/kencode research when relevant");
    expect(prompt).toContain("do not default to generic artifacts");
    expect(prompt).toContain("command/file/screenshot/log evidence");
    expect(prompt).toContain("isolated git worktree");
    expect(prompt).toContain("do not merge or touch the main checkout");
    expect(prompt).toContain("candidate packet");
    expect(prompt).toContain("base SHA");
    expect(prompt).toContain("diffstat");
    expect(prompt).toContain("patch path");
    expect(prompt).toContain("depends_on");
    expect(prompt).toContain("parallel_group");
    expect(prompt).toContain("expected_changed_scope");
    expect(prompt).toContain("merge_strategy");
    expect(prompt).toContain(
      'goals({ action: "evidence" | "task", run_id: "goal-a", task_id: "task-a"',
    );
  });

  it("passes the active thinking level to the worker CLI when enabled", async () => {
    const mod = await import("./goal-worker.js");

    await mod.startGoalWorker({
      cwd: tmpProject,
      provider: "anthropic",
      model: "claude-test",
      thinkingLevel: "xhigh",
      goalRunId: "goal-a",
      goalTaskId: "task-a",
      prompt: "Do deterministic work",
      isolateWorktree: false,
    });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--thinking", "xhigh"]));
  });

  it("launches workers through JSON mode so they use the AgentSession auto-compaction path", async () => {
    await start();

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "--json",
        "--provider",
        "anthropic",
        "--model",
        "claude-test",
        "--max-turns",
        "12",
        "--system-prompt",
      ]),
    );
    expect(args.at(-1)).toBe("Do deterministic work");
  });

  it("creates and launches implementation workers inside an isolated git worktree by default", async () => {
    const worktreeCalls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        worktreeCalls.push(args);
        return { stdout: "", stderr: "" };
      }),
    };
    const mod = await import("./goal-worker.js");

    const record = await mod.startGoalWorker({
      cwd: tmpProject,
      provider: "anthropic",
      model: "claude-test",
      goalRunId: "goal-a",
      goalTaskId: "task-a",
      prompt: "Do deterministic work",
      worktreeBaseRef: "base-sha",
      worktreesRoot: path.join(tmpProject, "worktrees"),
      worktreeCommandRunner: runner,
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as {
      cwd: string;
      env: Record<string, string>;
    };
    const run = await getGoalRun(tmpProject, "goal-a");
    expect(record.projectPath).toBe(tmpProject);
    expect(record.cwd).toBe(path.join(tmpProject, "worktrees", `task-a-${record.id}`));
    expect(record.worktree).toMatchObject({
      baseRef: "base-sha",
      branchName: `goal/goal-a/task-a-${record.id}`,
      path: record.cwd,
    });
    expect(spawnOptions.cwd).toBe(record.cwd);
    expect(spawnOptions.env.GG_GOAL_PROJECT_PATH).toBe(tmpProject);
    expect(worktreeCalls).toEqual([
      ["status", "--porcelain"],
      ["status", "--porcelain"],
      ["worktree", "add", "-b", `goal/goal-a/task-a-${record.id}`, record.cwd, "base-sha"],
    ]);
    expect(run?.tasks[0]?.worktree).toMatchObject({
      baseRef: "base-sha",
      branchName: `goal/goal-a/task-a-${record.id}`,
      path: record.cwd,
      status: "created",
    });
    expect(
      run?.evidence.some(
        (item) => item.label === `Worker ${record.id} worktree created` && item.path === record.cwd,
      ),
    ).toBe(true);
  });

  it("launches the apply-integration task in the main checkout", async () => {
    const worktreeCalls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        worktreeCalls.push(args);
        return { stdout: "", stderr: "" };
      }),
    };
    const mod = await import("./goal-worker.js");

    const record = await mod.startGoalWorker({
      cwd: tmpProject,
      provider: "anthropic",
      model: "claude-test",
      goalRunId: "goal-a",
      goalTaskId: "task-a",
      taskTitle: "Apply integrated worktree to main",
      prompt: "Apply accepted integration worktree changes",
      isolateWorktree: false,
      worktreeCommandRunner: runner,
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { cwd: string };
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const systemPrompt = args[args.indexOf("--system-prompt") + 1];
    const run = await getGoalRun(tmpProject, "goal-a");
    expect(record.cwd).toBe(tmpProject);
    expect(record.worktree).toBeUndefined();
    expect(spawnOptions.cwd).toBe(tmpProject);
    expect(worktreeCalls).toEqual([]);
    expect(run?.tasks[0]?.worktree).toBeUndefined();
    expect(systemPrompt).toContain("controlled exception to worker isolation");
    expect(systemPrompt).toContain("main checkout");
  });

  it("auto-checkpoints a dirty working tree, records evidence, and proceeds", async () => {
    let committed = false;
    const worktreeCalls: Array<readonly string[]> = [];
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) => {
        worktreeCalls.push(args);
        if (args[0] === "status") {
          return committed
            ? { stdout: "", stderr: "" }
            : { stdout: " M packages/dirty.ts\n", stderr: "" };
        }
        if (args[0] === "commit") {
          committed = true;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") return { stdout: "checkpoint-sha\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }),
    };
    const mod = await import("./goal-worker.js");

    const record = await mod.startGoalWorker({
      cwd: tmpProject,
      provider: "anthropic",
      model: "claude-test",
      goalRunId: "goal-a",
      goalTaskId: "task-a",
      prompt: "Do deterministic work",
      worktreeBaseRef: "base-sha",
      worktreesRoot: path.join(tmpProject, "worktrees"),
      worktreeCommandRunner: runner,
    });

    expect(spawnMock).toHaveBeenCalled();
    expect(record.worktree).toBeDefined();
    expect(worktreeCalls).toEqual([
      ["status", "--porcelain"],
      ["add", "-A"],
      ["commit", "-m", `goal(goal-a): checkpoint uncommitted work before worker ${record.id}`],
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
      ["worktree", "add", "-b", `goal/goal-a/task-a-${record.id}`, record.cwd, "base-sha"],
    ]);
    const run = await getGoalRun(tmpProject, "goal-a");
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Goal working tree checkpoint",
          content: expect.stringContaining("checkpoint-sha"),
        }),
      ]),
    );
  });

  it("fails the task when the checkpoint commit cannot clean the working tree", async () => {
    const runner: GoalWorktreeCommandRunner = {
      execFile: vi.fn(async (_file, args) =>
        args[0] === "status"
          ? { stdout: " M packages/dirty.ts\n", stderr: "" }
          : { stdout: "", stderr: "" },
      ),
    };
    const mod = await import("./goal-worker.js");

    await expect(
      mod.startGoalWorker({
        cwd: tmpProject,
        provider: "anthropic",
        model: "claude-test",
        goalRunId: "goal-a",
        goalTaskId: "task-a",
        prompt: "Do deterministic work",
        worktreeCommandRunner: runner,
      }),
    ).rejects.toThrow("Goal workers need a clean working tree");

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(run?.tasks[0]).toMatchObject({
      status: "failed",
      lastSummary: expect.stringContaining("clean working tree"),
    });
    expect(run?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining("worktree failed"),
          content: expect.stringContaining("packages/dirty.ts"),
        }),
      ]),
    );
  });

  it("exports a testable worker system prompt/context helper", async () => {
    const mod = await import("./goal-worker.js");

    const prompt = mod.buildGoalWorkerSystemPrompt({
      cwd: "/repo",
      goalRunId: "goal-123",
      goalTaskId: "task-456",
      taskTitle: "Implement typed handoff",
    });

    expect(prompt).toContain("cwd=/repo");
    expect(prompt).toContain("run_id=goal-123");
    expect(prompt).toContain("task_id=task-456");
    expect(prompt).toContain("Implement typed handoff");
    expect(prompt).toContain("Do not mark the whole goal complete");
    expect(prompt).toContain("do not rely on narrative or human visual inspection");
    expect(prompt).toContain("isolated git worktree");
    expect(prompt).toContain("candidate packet");
    expect(prompt).toContain("depends_on");
    expect(prompt).toContain("parallel_group");
  });

  it("does not mark empty successful process exit as durable task completion", async () => {
    const { record, onComplete } = await start();

    child.emit("close", 0);
    await flushUntil(() => expect(onComplete).toHaveBeenCalled());

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(record.status).toBe("failed");
    expect(run?.tasks[0]).toMatchObject({
      status: "failed",
      workerId: record.id,
      lastSummary: expect.stringContaining("without durable proof evidence"),
    });
    expect(run?.evidence.some((item) => item.label === `Worker ${record.id} failed`)).toBe(true);
  });

  it("marks the task done, persists evidence, and notifies callbacks/subscribers for worker success", async () => {
    const { mod, record, onComplete } = await start();
    const listener = vi.fn();
    const unsubscribe = mod.subscribeGoalWorkerCompletions(listener, tmpProject);

    child.stdout.write(JSON.stringify({ type: "text_delta", text: "implemented" }) + "\n");
    child.stdout.write(
      JSON.stringify({
        type: "tool_call_start",
        toolCallId: "tool-a",
        name: "bash",
        args: { command: "pnpm test" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({ type: "tool_call_end", toolCallId: "tool-a", isError: false }) + "\n",
    );
    child.emit("close", 0);
    await flushUntil(() => expect(onComplete).toHaveBeenCalled());

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(record.status).toBe("done");
    expect(run?.activeWorkerId).toBeUndefined();
    expect(run?.tasks[0]).toMatchObject({
      status: "done",
      workerId: record.id,
      lastSummary: expect.stringContaining("implemented"),
    });
    expect(
      run?.evidence.some(
        (item) =>
          item.label === `Worker ${record.id} done` && item.content?.includes("implemented"),
      ),
    ).toBe(true);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "done",
        exitCode: 0,
        toolsUsed: [{ name: "bash", ok: true }],
      }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        worker: expect.objectContaining({ id: record.id, goalRunId: "goal-a" }),
        status: "done",
        exitCode: 0,
      }),
    );
    unsubscribe();
  });

  it("replays a pending completion to the next subscriber after a remount gap", async () => {
    const { mod, record } = await start();

    child.stdout.write(
      JSON.stringify({ type: "text_delta", text: "finished during remount" }) + "\n",
    );
    child.emit("close", 0);

    await flushUntil(() => expect(record.status).toBe("done"));
    const listener = vi.fn();
    const unsubscribe = mod.subscribeGoalWorkerCompletions(listener, tmpProject);

    await flushUntil(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          worker: expect.objectContaining({ id: record.id, cwd: tmpProject }),
          summary: expect.stringContaining("finished during remount"),
          status: "done",
        }),
      ),
    );
    unsubscribe();
  });

  it("marks the task failed and persists stderr evidence for worker non-zero exit", async () => {
    const { record, onComplete } = await start();

    child.stderr.write("boom from stderr");
    child.emit("close", 1);
    await flushUntil(() => expect(onComplete).toHaveBeenCalled());

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(record.status).toBe("failed");
    expect(run?.tasks[0]).toMatchObject({
      status: "failed",
      workerId: record.id,
      lastSummary: expect.stringContaining("boom from stderr"),
    });
    expect(
      run?.evidence.some(
        (item) => item.label === `Worker ${record.id} failed` && item.content?.includes("boom"),
      ),
    ).toBe(true);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", exitCode: 1 }),
    );
  });

  it("records spawn crashes as failed task evidence and notifies the orchestrator continuation path", async () => {
    const { mod, record, onComplete } = await start();
    const listener = vi.fn();
    const unsubscribe = mod.subscribeGoalWorkerCompletions(listener, tmpProject);

    child.emit("error", new Error("spawn exploded"));
    await flushUntil(async () => {
      const next = await getGoalRun(tmpProject, "goal-a");
      expect(next?.tasks[0]?.status).toBe("failed");
      expect(next?.evidence.some((item) => item.label === `Worker ${record.id} spawn failed`)).toBe(
        true,
      );
      expect(onComplete).toHaveBeenCalled();
    });

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(record.status).toBe("failed");
    expect(run?.tasks[0]).toMatchObject({
      status: "failed",
      lastSummary: "Failed to spawn Goal worker: spawn exploded",
    });
    expect(
      run?.evidence.some(
        (item) =>
          item.label === `Worker ${record.id} spawn failed` && item.content === "spawn exploded",
      ),
    ).toBe(true);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", exitCode: 1, reason: "spawn_error" }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        worker: expect.objectContaining({ id: record.id, cwd: tmpProject }),
        status: "failed",
        exitCode: 1,
        reason: "spawn_error",
      }),
    );
    unsubscribe();
  });

  it("manual stop blocks the task, clears the active worker, and ignores later close completion", async () => {
    const { mod, record, onComplete } = await start();

    const result = await mod.stopGoalWorker(record.id);
    child.emit("close", 0);
    await flushUntil(() => expect(record.status).toBe("stopped"));

    const run = await getGoalRun(tmpProject, "goal-a");
    expect(result).toBe(`Goal worker ${record.id} stopped.`);
    expect(record.status).toBe("stopped");
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(run?.activeWorkerId).toBeUndefined();
    expect(run?.tasks[0]).toMatchObject({
      status: "blocked",
      lastSummary: "Worker stopped by user.",
    });
    expect(
      run?.evidence.some(
        (item) => item.kind === "summary" && item.label === `Worker ${record.id} stopped`,
      ),
    ).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
