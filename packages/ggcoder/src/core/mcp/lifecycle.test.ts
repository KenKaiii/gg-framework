import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool, ToolContext } from "@kleio/agent";
import { MCPClientManager, MCP_DEFAULT_IDLE_TIMEOUT_MS } from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import { SharedMcpPool } from "./shared-pool.js";
import type { MCPServerConfig } from "./types.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "lifecycle-mcp-server.mjs",
);

const IDLE_MS = 60_000;

let dir: string;
const managers: MCPClientManager[] = [];

function manager(opts: { idleTimeoutMs?: number; sharedPool?: SharedMcpPool } = {}) {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "mcp-catalog.json")),
    sharedPool: opts.sharedPool ?? new SharedMcpPool(),
    idleTimeoutMs: opts.idleTimeoutMs ?? IDLE_MS,
  });
  managers.push(instance);
  return instance;
}

function server(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "life",
    command: process.execPath,
    args: [FIXTURE],
    timeout: 10_000,
    // Private connection by default so `isServerRunning` observes the child.
    shared: false,
    ...overrides,
  };
}

async function connect(m: MCPClientManager, config: MCPServerConfig): Promise<AgentTool[]> {
  const [result] = await m.connectAllDetailed([config]);
  expect(result?.error).toBeUndefined();
  return result!.tools;
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((t) => t.name === `mcp__life__${name}`);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function ctx(onUpdate?: (u: unknown) => void): ToolContext {
  return { signal: new AbortController().signal, toolCallId: "t", onUpdate };
}

async function call(tools: AgentTool[], name: string, args: object = {}, c = ctx()) {
  return tool(tools, name).execute(args, c);
}

/** Step fake time past the manager's 2s minimum gap between calls to one server. */
function skipCallGap(): void {
  vi.advanceTimersByTime(2_000);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-lifecycle-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("idle shutdown", () => {
  // Only timers and Date are faked: child-process I/O stays real, and the SDK's
  // request timers (fake) simply never fire unless advanced. Date is faked so
  // `skipCallGap` can step past the manager's 2s per-server call throttle.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("defaults to a conservative 15 minutes", () => {
    expect(MCP_DEFAULT_IDLE_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it("stops an idle stdio server and restarts it transparently on the next call", async () => {
    const m = manager();
    const tools = await connect(m, server());
    const firstPid = Number(await call(tools, "pid"));
    expect(alive(firstPid)).toBe(true);

    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(m.isServerRunning("life")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.isServerRunning("life")).toBe(false);
    await vi.waitFor(() => expect(alive(firstPid)).toBe(false), { timeout: 10_000 });

    // Same tool object the model already has — no republish needed.
    expect(await call(tools, "echo", { text: "back again" })).toBe("back again");
    expect(m.isServerRunning("life")).toBe(true);
    skipCallGap();
    const secondPid = Number(await call(tools, "pid"));
    expect(secondPid).not.toBe(firstPid);
  }, 30_000);

  it("keeps the published tool list identical across stop/restart", async () => {
    const m = manager();
    const tools = await connect(m, server());
    const before = tools.map((t) => ({ name: t.name, schema: t.rawInputSchema }));

    vi.advanceTimersByTime(IDLE_MS);
    expect(m.isServerRunning("life")).toBe(false);
    expect(await call(tools, "echo", { text: "x" })).toBe("x");

    expect(tools.map((t) => ({ name: t.name, schema: t.rawInputSchema }))).toEqual(before);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__life__pid",
      "mcp__life__echo",
      "mcp__life__slow",
      "mcp__life__fail",
      "mcp__life__progress",
    ]);
  }, 30_000);

  it("never stops a server with a call in flight", async () => {
    const m = manager();
    const tools = await connect(m, server());
    // Server replies after 500ms of REAL time; meanwhile fake idle time passes.
    const pending = call(tools, "slow", { ms: 500 });
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(m.isServerRunning("life")).toBe(true);
    expect(await pending).toBe("done");

    // The countdown restarts only once the call has finished.
    expect(m.isServerRunning("life")).toBe(true);
    vi.advanceTimersByTime(IDLE_MS);
    expect(m.isServerRunning("life")).toBe(false);
  }, 30_000);

  it("concurrent calls after a stop share one respawn", async () => {
    // Real timers: both calls race through the respawn, and the second then
    // sits out the real 2s call throttle.
    vi.useRealTimers();
    const m = manager({ idleTimeoutMs: 150 });
    const tools = await connect(m, server());
    await vi.waitFor(() => expect(m.isServerRunning("life")).toBe(false), { timeout: 5_000 });

    const [a, b] = await Promise.all([call(tools, "pid"), call(tools, "pid")]);
    expect(a).toBe(b);
    expect(alive(Number(a))).toBe(true);
  }, 30_000);

  it("respects keepAlive: true", async () => {
    const m = manager();
    const tools = await connect(m, server({ keepAlive: true }));
    await call(tools, "echo", { text: "x" });
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(m.isServerRunning("life")).toBe(true);
  }, 30_000);

  it("idleTimeoutMs: 0 disables idle shutdown", async () => {
    const m = manager({ idleTimeoutMs: 0 });
    await connect(m, server());
    vi.advanceTimersByTime(MCP_DEFAULT_IDLE_TIMEOUT_MS * 10);
    expect(m.isServerRunning("life")).toBe(true);
  }, 30_000);

  it("the idle timer is unref'd and cleared on dispose", async () => {
    // Real timers so the handles are genuine Node Timeouts.
    vi.useRealTimers();
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const m = manager();
    await connect(m, server());
    const idleIdx = setSpy.mock.calls.findIndex(([, ms]) => ms === IDLE_MS);
    expect(idleIdx).toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[idleIdx]!.value as NodeJS.Timeout;
    // Must never be what keeps the CLI/daemon process alive.
    expect(handle.hasRef()).toBe(false);

    await m.dispose();
    expect(clearSpy).toHaveBeenCalledWith(handle);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  }, 30_000);

  it("stops and respawns a POOLED server without evicting it from the pool", async () => {
    const pool = new SharedMcpPool();
    const a = manager({ sharedPool: pool });
    const b = manager({ sharedPool: pool });
    const config = server({ shared: true });
    const toolsA = await connect(a, config);
    const toolsB = await connect(b, config);
    expect(pool.size).toBe(1);

    const firstPid = Number(await call(toolsA, "pid"));
    vi.advanceTimersByTime(IDLE_MS);
    await vi.waitFor(() => expect(alive(firstPid)).toBe(false), { timeout: 10_000 });
    // An idle stop is not a death: the pooled entry (and both claims) survive.
    expect(pool.size).toBe(1);
    expect(pool.refCount(config)).toBe(2);

    const secondPid = Number(await call(toolsB, "pid"));
    expect(secondPid).not.toBe(firstPid);
    skipCallGap();
    expect(Number(await call(toolsA, "pid"))).toBe(secondPid);
  }, 30_000);
});

describe("progress-aware call timeout", () => {
  it("lets a call that reports progress run past its timeout", async () => {
    const m = manager();
    const tools = await connect(m, server({ timeout: 400 }));
    const updates: unknown[] = [];
    const result = await call(
      tools,
      "progress",
      { ms: 1_500, every: 100 },
      ctx((u) => updates.push(u)),
    );
    expect(result).toBe("done");
    expect(updates.length).toBeGreaterThan(3);
    expect(updates[0]).toMatchObject({ type: "mcp_progress", progress: 1, message: "step 1" });
  }, 30_000);

  it("still times out a call that reports no progress", async () => {
    const m = manager();
    const tools = await connect(m, server({ timeout: 400 }));
    // Thrown, so the agent loop records the call as failed, not as a success.
    await expect(call(tools, "slow", { ms: 1_500 })).rejects.toThrow(/MCP tool error:.*timed out/i);
  }, 30_000);

  it("reports a result the server marks isError as a failed call", async () => {
    const m = manager();
    const tools = await connect(m, server({}));
    await expect(call(tools, "fail", { text: "no such table: orders" })).rejects.toThrow(
      "no such table: orders",
    );
  }, 30_000);

  it("enforces maxTotalTimeout even while progress keeps arriving", async () => {
    const m = manager();
    // The per-call timeout sits well above the 100 ms progress interval, so a
    // stalled CI runner can't let it fire first; only the total cap can end
    // the call. (At 400 ms, a ~300 ms stall on macOS CI timed it out instead.)
    const tools = await connect(m, server({ timeout: 1_000, maxTotalTimeout: 1_500 }));
    const started = Date.now();
    await expect(call(tools, "progress", { ms: 5_000, every: 100 })).rejects.toThrow(
      /Maximum total timeout exceeded/,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  it("declares the progress budget to the agent loop", async () => {
    const m = manager();
    const tools = await connect(m, server({ timeout: 400, maxTotalTimeout: 800 }));
    expect(tool(tools, "echo").timeoutMs).toBe(1_200);
  }, 30_000);
});
