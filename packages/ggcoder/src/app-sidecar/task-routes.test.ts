import { Readable } from "node:stream";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunClaim } from "../core/run-claim.js";
import { RunLifecycle } from "../core/run-lifecycle.js";
import type { TaskRecord } from "../core/tasks-store.js";
import { createAutopilotRunner, type AutopilotRunnerContext } from "./autopilot-runner.js";
import { handlePromptRoutes } from "./prompt-routes.js";
import { handleTaskRoutes } from "./task-routes.js";
import type { SessionRouteContext } from "./route-context.js";

// The real store writes under the user's home directory.
const store = vi.hoisted(() => ({ tasks: [] as TaskRecord[] }));
vi.mock("../core/tasks-store.js", () => ({
  loadTasksSync: () => store.tasks,
  saveTasksSync: (_cwd: string, tasks: readonly TaskRecord[]) => {
    store.tasks = [...tasks];
  },
  pruneDoneTasksSync: () => (store.tasks = store.tasks.filter((t) => t.status !== "done")),
  getNextPendingTask: () => store.tasks.find((t) => t.status === "pending") ?? null,
  markTaskInProgress: (_cwd: string, id: string) => {
    store.tasks = store.tasks.map((t) => (t.id === id ? { ...t, status: "in-progress" } : t));
  },
}));

interface Reply {
  status: number;
  body: unknown;
}

type Handler = typeof handleTaskRoutes;

function post(handler: Handler, ctx: object, url: string, body: unknown): Promise<Reply> {
  let resolve: (reply: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload) as unknown });
    },
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  const handled = handler(
    ctx as SessionRouteContext,
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    url,
    "POST",
  );
  expect(handled).toBe(true);
  return reply;
}

function task(id: string, prompt: string): TaskRecord {
  return { id, title: prompt, prompt, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" };
}

function harness(tasks: TaskRecord[]) {
  store.tasks = tasks;
  const queue: Array<{ text: string; attachments: never[] }> = [];
  const prompts: string[] = [];
  const stats = { concurrent: 0, maxConcurrent: 0 };
  const session = {
    newSession: vi.fn(async () => {}),
    persistAppMarker: vi.fn(async () => {}),
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }),
    queueMessage: (text: string) => queue.push({ text, attachments: [] }),
    takeNextQueuedMessage: () => queue.shift() ?? null,
    getQueuedCount: () => queue.length,
    listQueuedMessages: () => queue.map((m, i) => ({ id: `q${i}`, text: m.text })),
    getMessages: () => [],
    getPlanMode: () => false,
    loadCustomCommands: async () => [],
    willExpandPromptTemplate: async () => false,
  };
  const ctx = {
    cwd: "/project",
    sessionId: "me",
    session,
    running: false,
    autopilot: false,
    autopilotActive: false,
    autopilotCancelled: false,
    taskRunAll: false,
    drainingStrandedQueue: false,
    scheduledRunActive: false,
    pendingPlanPath: null,
    injectedAutopilotPrompts: [] as string[],
    runClaim: new RunClaim(),
    runLifecycle: new RunLifecycle(),
    asks: { pendingCount: 0, cancelAll: vi.fn() },
    trophies: { count: vi.fn(async () => {}), recordPrompt: vi.fn(async () => {}) },
    broadcast: vi.fn(),
    broadcastError: vi.fn(),
    startGoalFromMessage: async () => {},
    loadWorkflowCommandSpecs: async () => [],
    clearPendingPlan: vi.fn(),
    deactivateApprovedPlan: vi.fn(),
    offerPendingPlan: vi.fn(),
    // Mirrors runAgent: `running` is true only while a run is in flight.
    runAgent: async (_label: string, run: () => Promise<void>) => {
      ctx.running = true;
      stats.concurrent += 1;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
      try {
        await run();
      } finally {
        stats.concurrent -= 1;
        ctx.running = false;
      }
    },
  };
  Object.assign(ctx, createAutopilotRunner(ctx as unknown as AutopilotRunnerContext));
  return { ctx, session, prompts, stats };
}

describe("task run-all sweep", () => {
  beforeEach(() => {
    store.tasks = [];
  });

  it("queues a prompt sent between two tasks instead of starting a second run", async () => {
    const { ctx, prompts, stats } = harness([
      task("aaaaaaaa1", "do one"),
      task("bbbbbbbb2", "do two"),
    ]);

    expect(await post(handleTaskRoutes, ctx, "/tasks/run", { all: true })).toMatchObject({
      status: 202,
    });
    // The pause between tasks: the first run has ended, the second has not begun.
    await vi.waitFor(() => {
      expect(prompts).toHaveLength(1);
      expect(ctx.running).toBe(false);
    });

    const reply = await post(handlePromptRoutes, ctx, "/prompt", { text: "follow-up" });
    expect(reply).toEqual({ status: 202, body: { queued: true, count: 1 } });

    await vi.waitFor(() => expect(ctx.runClaim.active).toBe(false), { timeout: 5_000 });
    // Never steered in by these fake runs, so it runs as its own turn afterwards.
    expect(prompts.map((p) => p.split("\n")[0])).toEqual(["do one", "do two", "follow-up"]);
    expect(stats.maxConcurrent).toBe(1);
  });

  it("refuses to start while a prompt holds the run claim", async () => {
    const { ctx, session } = harness([task("aaaaaaaa1", "do one")]);
    ctx.runClaim.claim();

    expect(await post(handleTaskRoutes, ctx, "/tasks/run", { all: true })).toMatchObject({
      status: 409,
    });
    expect(session.newSession).not.toHaveBeenCalled();
  });

  it("lets go of the run when a task's session reset fails", async () => {
    const { ctx, session } = harness([task("aaaaaaaa1", "do one")]);
    session.newSession.mockRejectedValueOnce(new Error("disk full"));

    await post(handleTaskRoutes, ctx, "/tasks/run", { all: true });

    await vi.waitFor(() =>
      expect(ctx.broadcastError).toHaveBeenCalledWith(
        "error",
        "task run failed",
        expect.any(Error),
      ),
    );
    expect(ctx.taskRunAll).toBe(false);
    expect(ctx.runClaim.active).toBe(false);
    expect(ctx.broadcast).toHaveBeenCalledWith("tasks_run_done", {});
  });
});
