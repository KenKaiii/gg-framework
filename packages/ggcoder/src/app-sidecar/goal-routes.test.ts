import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoal, goalsRoot, markGoalStarted, readGoal } from "../core/goals-store.js";
import { RunClaim } from "../core/run-claim.js";
import { goalRunMarkerPath } from "../core/goal-run-marker.js";
import { goalListStatus, handleGoalRoutes } from "./goal-routes.js";
import type { SessionRouteContext } from "./route-context.js";

interface Reply {
  status: number;
  body: unknown;
}

function fakeResponse(): { res: http.ServerResponse; reply: Promise<Reply> } {
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
  return { res: res as unknown as http.ServerResponse, reply };
}

describe("goal kickoff route", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goal-routes-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function goalContext(messages: unknown[] = [], workers: unknown[] = []) {
    const created = await createGoal(
      goalsRoot(tmp),
      { name: "Perf", goal: "Make it fast" },
      new Date(),
    );
    if (!created.ok) throw new Error(created.error);
    const prompt = vi.fn(async () => {});
    const runAgent = vi.fn(async (_label: string, run: () => Promise<void>) => run());
    const ctx = {
      goal: created.value,
      session: {
        getMessages: () => messages,
        prompt,
        listSubAgents: () => workers,
        addDirectory: vi.fn(async (root: string) => ({ ok: true as const, root })),
        notify: vi.fn(),
      },
      broadcast: vi.fn(),
      running: false,
      autopilotActive: false,
      runClaim: new RunClaim(),
      runAgent,
      paths: { agentDir: tmp, sessionsDir: path.join(tmp, "sessions") },
      sessionId: "me",
      sessionIdsAt: vi.fn((_cwd: string): string[] => []),
      busyAt: vi.fn((_cwd: string): boolean => false),
    };
    return { ctx, dir: created.value.dir, prompt, runAgent };
  }

  function remove(ctx: object, id: string): Promise<Reply> {
    const { res, reply } = fakeResponse();
    const req = Readable.from([Buffer.from(JSON.stringify({ id }))]);
    handleGoalRoutes(
      ctx as SessionRouteContext,
      req as unknown as http.IncomingMessage,
      res,
      "/goals/delete",
      "POST",
    );
    return reply;
  }

  function kickoff(ctx: object): Promise<Reply> {
    const { res, reply } = fakeResponse();
    const handled = handleGoalRoutes(
      ctx as SessionRouteContext,
      {} as http.IncomingMessage,
      res,
      "/goal/kickoff",
      "POST",
    );
    expect(handled).toBe(true);
    return reply;
  }

  it("starts the first reply once with a hidden runtime prompt, then never again", async () => {
    const { ctx, dir, prompt, runAgent } = await goalContext();

    expect(await kickoff(ctx)).toEqual({ status: 202, body: { started: true } });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(runAgent).toHaveBeenCalledWith("Perf", expect.any(Function));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('"Perf"'), {
      source: "runtime",
      kind: "automation",
      visibility: "hidden",
    });
    expect((await readGoal(dir))?.kickoffAt).toBeTypeOf("string");
    await vi.waitFor(() => expect(ctx.runClaim.active).toBe(false));

    expect(await kickoff(ctx)).toEqual({ status: 200, body: { started: false } });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not kick off a goal whose conversation already has messages", async () => {
    const { ctx, prompt } = await goalContext([{ role: "user", content: "hi" }]);
    expect(await kickoff(ctx)).toEqual({ status: 200, body: { started: false } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses while another run holds the claim", async () => {
    const { ctx, prompt } = await goalContext();
    ctx.runClaim.claim();
    expect(await kickoff(ctx)).toEqual({ status: 409, body: { error: "The agent is busy" } });
    expect(prompt).not.toHaveBeenCalled();
  });

  function call(ctx: object, url: string, body?: unknown): Promise<Reply> {
    const { res, reply } = fakeResponse();
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    expect(
      handleGoalRoutes(
        ctx as SessionRouteContext,
        req as unknown as http.IncomingMessage,
        res,
        url,
        "POST",
      ),
    ).toBe(true);
    return reply;
  }

  it("changes a goal's folders and instructions, and joins new folders to the workspace", async () => {
    const { ctx, dir } = await goalContext();
    const site = path.join(tmp, "site");
    await fs.mkdir(site);
    const reply = await call(ctx, "/goal/update", { context: [site], instructions: "No CI." });
    expect(reply).toEqual({
      status: 200,
      body: { context: [{ path: site, kind: "folder" }], instructions: "No CI." },
    });
    expect(ctx.session.addDirectory).toHaveBeenCalledWith(site);
    // Kleio Goals hears about it at its next turn, not only next session.
    expect(ctx.session.notify).toHaveBeenCalledWith(
      "goal-settings",
      expect.stringContaining("Standing instructions: No CI."),
    );
    expect((await readGoal(dir))?.instructions).toBe("No CI.");
    // Not mid-run: a folder could be detached under a working worker.
    ctx.running = true;
    expect((await call(ctx, "/goal/update", { instructions: "x" })).status).toBe(409);
  });

  it("pauses a goal, and resumes it with a hidden run that carries on", async () => {
    const { ctx, dir, prompt } = await goalContext();
    await markGoalStarted(dir, new Date());
    ctx.goal = { dir, record: (await readGoal(dir))! };
    expect((await call(ctx, "/goal/pause")).body).toMatchObject({ paused: true });
    expect((await readGoal(dir))?.pausedAt).toBeTypeOf("string");

    expect(await call(ctx, "/goal/resume")).toEqual({ status: 202, body: { resumed: true } });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Pick it up where it left off"), {
      source: "runtime",
      kind: "automation",
      visibility: "hidden",
    });
    expect((await readGoal(dir))?.pausedAt).toBeUndefined();
  });

  it("resumes a goal cut off by a restart, and leaves a finished one alone", async () => {
    // A worker the restart interrupted: carry on.
    const cut = await goalContext([], [{ state: "interrupted", recovered: true }]);
    await markGoalStarted(cut.dir, new Date());
    cut.ctx.goal = { dir: cut.dir, record: (await readGoal(cut.dir))! };
    expect((await call(cut.ctx, "/goal/resume")).body).toEqual({ resumed: true });
    await vi.waitFor(() => expect(cut.prompt).toHaveBeenCalledOnce());

    // Everything finished cleanly: nothing to do.
    const done = await goalContext(
      [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
      [{ state: "completed", recovered: true }],
    );
    await markGoalStarted(done.dir, new Date());
    done.ctx.goal = { dir: done.dir, record: (await readGoal(done.dir))! };
    expect(await call(done.ctx, "/goal/resume")).toEqual({ status: 200, body: { resumed: false } });
    expect(done.prompt).not.toHaveBeenCalled();
  });

  it("never resumes a goal another process is running", async () => {
    // Cut off as far as this window can tell (its last message is a tool
    // call), but the phone's `kleio-coder acp` is working on it right now.
    const busy = await goalContext([
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "bash", args: {} }] },
    ]);
    await markGoalStarted(busy.dir, new Date());
    busy.ctx.goal = { dir: busy.dir, record: (await readGoal(busy.dir))! };
    const at = new Date().toISOString();
    await fs.mkdir(path.dirname(goalRunMarkerPath(busy.dir)), { recursive: true });
    await fs.writeFile(
      goalRunMarkerPath(busy.dir),
      JSON.stringify({
        version: 1,
        pid: process.ppid,
        token: "acp",
        startedAt: at,
        heartbeatAt: at,
      }),
    );
    expect(await call(busy.ctx, "/goal/resume")).toEqual({ status: 200, body: { resumed: false } });
    expect(busy.prompt).not.toHaveBeenCalled();
  });

  it("tells the goal list where each goal stands: briefing, running, paused or idle", async () => {
    const { dir } = await goalContext();
    const record = (await readGoal(dir))!;
    expect(goalListStatus(record, false)).toBe("briefing");
    expect(goalListStatus(record, true)).toBe("running");
    const started = { ...record, startedAt: "2026-10-10T00:00:00.000Z" };
    expect(goalListStatus(started, false)).toBe("idle");
    expect(goalListStatus(started, true)).toBe("running");
    // Paused wins, even while its last turn winds down.
    const paused = { ...started, pausedAt: "2026-10-10T01:00:00.000Z" };
    expect(goalListStatus(paused, true)).toBe("paused");
    // Not working, its last turn never finished: interrupted. Busy wins.
    expect(goalListStatus(started, false, true)).toBe("interrupted");
    expect(goalListStatus(started, true, true)).toBe("running");
    expect(goalListStatus(paused, false, true)).toBe("paused");
  });

  it("keeps the standing instructions sent with a new goal", async () => {
    const { ctx } = await goalContext();
    const { res, reply } = fakeResponse();
    const body = { name: "Docs", goal: "Write docs", context: [], instructions: "No CI." };
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    handleGoalRoutes(
      ctx as unknown as SessionRouteContext,
      req as unknown as http.IncomingMessage,
      res,
      "/goals",
      "POST",
    );
    expect((await reply).status).toBe(200);
    expect((await readGoal(path.join(goalsRoot(tmp), "docs")))?.instructions).toBe("No CI.");
  });

  it("refuses a paid model for the workers, and pins a standard one", async () => {
    const { ctx, dir } = await goalContext();
    const withAuth = { ...ctx, auth: { hasProviderAuth: vi.fn(async () => true) } };
    const pin = async (model: string): Promise<Reply> => {
      const { res, reply } = fakeResponse();
      handleGoalRoutes(
        withAuth as unknown as SessionRouteContext,
        Readable.from([Buffer.from(JSON.stringify({ model }))]) as unknown as http.IncomingMessage,
        res,
        "/goal/critter-model",
        "POST",
      );
      return reply;
    };
    // Workers run in parallel and unwatched: real-money spend would multiply.
    const refused = await pin("claude-opus-5-5-fast");
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toContain("only for your main chat");
    expect((await readGoal(dir))?.critterModel).toBeUndefined();

    expect((await pin("claude-sonnet-5-5")).status).toBe(200);
    expect((await readGoal(dir))?.critterModel?.model).toBe("claude-sonnet-5-5");
  });

  it("is a 404 outside a goal window", async () => {
    const { ctx } = await goalContext();
    expect(await kickoff({ ...ctx, goal: null })).toEqual({
      status: 404,
      body: { error: "This window is not a goal" },
    });
  });

  it("deletes a goal only when no other window has it open and it is not running", async () => {
    const { ctx, dir } = await goalContext();

    ctx.sessionIdsAt.mockReturnValue(["me", "other"]);
    expect(await remove(ctx, "perf")).toEqual({
      status: 409,
      body: { error: "This goal is open in another window. Close it there first." },
    });

    ctx.sessionIdsAt.mockReturnValue(["me"]);
    ctx.running = true;
    expect(await remove(ctx, "perf")).toEqual({
      status: 409,
      body: { error: "This goal is still working. Stop it first." },
    });
    expect((await fs.stat(dir)).isDirectory()).toBe(true);

    ctx.running = false;
    expect(await remove(ctx, "perf")).toEqual({ status: 200, body: { ok: true } });
    await expect(fs.stat(dir)).rejects.toThrow();
    expect(ctx.goal).toBeNull();
    expect(await remove(ctx, "perf")).toEqual({ status: 404, body: { error: "Unknown goal" } });
  });
});
