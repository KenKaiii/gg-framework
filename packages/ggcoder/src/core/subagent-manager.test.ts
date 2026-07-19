import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./agents.js";
import { buildSubAgentCompletionFollowUp, SubAgentManager } from "./subagent-manager.js";
import { SubAgentStore, type PersistedSubAgentRecord } from "./subagent-store.js";

const workerEntry = fileURLToPath(
  new URL("../tools/__fixtures__/fake-subagent-worker.mjs", import.meta.url),
);
const agents: AgentDefinition[] = [
  {
    name: "fake",
    description: "Fake test worker",
    tools: ["read"],
    systemPrompt: "fake",
    source: "bundled",
  },
];
const managers: SubAgentManager[] = [];
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-subagent-manager-"));
  tempDirs.push(directory);
  return directory;
}

function manager(
  options: {
    idleTimeoutMs?: number;
    agentDefs?: AgentDefinition[];
    store?: SubAgentStore;
    cwd?: string;
    sessionRootDir?: string;
    maxPerModel?: number;
  } = {},
) {
  const instance = new SubAgentManager({
    cwd: options.cwd ?? process.cwd(),
    agents: options.agentDefs ?? agents,
    getProvider: () => "openai",
    getModel: () => "gpt-5.6-sol",
    getThinkingLevel: () => "ultra",
    getCacheKey: () => "parent-cache",
    getMaxPerModel: () => options.maxPerModel,
    workerEntry,
    idleTimeoutMs: options.idleTimeoutMs,
    store: options.store,
    sessionRootDir: options.sessionRootDir,
  });
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  const activeManagers = managers.splice(0);
  await Promise.all(activeManagers.map((instance) => instance.shutdownAll()));
  await Promise.all(activeManagers.map((instance) => instance.waitForPersistence()));
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("SubAgentManager", () => {
  it("partitions the worker cache key by selected model and agent family", async () => {
    const instance = manager();
    const requestSpy = vi.spyOn(
      instance as unknown as {
        request: (...args: unknown[]) => Promise<unknown>;
      },
      "request",
    );

    await instance.spawn("cache-child", "fast", "fake");

    const initializeCall = requestSpy.mock.calls.find(([, command]) => command === "initialize");
    expect(initializeCall?.[2]).toMatchObject({
      options: {
        model: "gpt-5.6-luna",
        promptCacheKey: "parent-cache:subagent:gpt-5.6-luna:fake",
      },
    });
  });

  it("returns after launch and overlaps four child turns", async () => {
    const instance = manager();
    const children = await Promise.all(
      [1, 2, 3, 4].map((number) => instance.spawn(`task-${number}`, "slow", "fake")),
    );
    // Returning every child in the running state proves spawn resolves on the
    // start acknowledgement rather than waiting for the turn to complete.
    // Avoid a wall-clock threshold here: process startup is scheduler-dependent
    // under the full parallel workspace suite.
    expect(children.every((child) => child.state === "running")).toBe(true);
    await expect(instance.spawn("fifth", "slow", "fake")).rejects.toThrow("At most 4");
    const result = await instance.wait(
      children.map((child) => child.agent_id),
      "all",
      1_000,
    );
    expect(result.timed_out).toBe(false);
    expect(result.agents.every((child) => child.state === "completed")).toBe(true);
    expect(result.agents[0]?.token_usage).toEqual({
      input: 10,
      output: 2,
      cacheRead: 20,
      cacheWrite: 5,
    });
  });

  it("waits for any, times out, steers, interrupts, and reuses context", async () => {
    const instance = manager();
    const fast = await instance.spawn("fast", "fast", "fake");
    const slow = await instance.spawn("slow", "slow", "fake");
    expect(await instance.sendMessage(slow.agent_id, "focus")).toBe(1);
    const any = await instance.wait([fast.agent_id, slow.agent_id], "any", 500);
    expect(any.timed_out).toBe(false);
    expect(any.agents.some((child) => child.state === "completed")).toBe(true);
    const timeout = await instance.wait([slow.agent_id], "all", 1);
    expect(timeout.timed_out).toBe(true);
    await instance.interrupt(slow.agent_id);
    const interrupted = await instance.wait([slow.agent_id], "all", 500);
    expect(interrupted.agents[0]?.state).toBe("interrupted");
    await instance.followup(slow.agent_id, "again");
    const followed = await instance.wait([slow.agent_id], "all", 500);
    expect(followed.agents[0]?.output).toContain("context:2");
  });

  it("enforces the per-model cap against the resolved child model", async () => {
    // The read-only "fake" agent resolves to the fast model (gpt-5.6-luna);
    // a shell-capable agent stays on the parent model (gpt-5.6-sol).
    const shellAgent: AgentDefinition = {
      name: "sheller",
      description: "Shell-capable worker",
      tools: ["read", "bash"],
      systemPrompt: "fake",
      source: "bundled",
    };
    const instance = manager({ agentDefs: [...agents, shellAgent], maxPerModel: 1 });

    const first = await instance.spawn("first-luna", "slow", "fake");
    expect(first.model).toBe("gpt-5.6-luna");

    // Same resolved model at the cap → rejected with the setting named.
    await expect(instance.spawn("second-luna", "slow", "fake")).rejects.toThrow(
      "At most 1 agents may run at once on model gpt-5.6-luna (subagentMaxPerModel)",
    );

    // A different resolved model is unaffected by the luna cap.
    const other = await instance.spawn("parent-model", "slow", "sheller");
    expect(other.model).toBe("gpt-5.6-sol");
  });

  it("counts followups toward the per-model cap", async () => {
    const instance = manager({ maxPerModel: 1 });
    const done = await instance.spawn("finished", "fast", "fake");
    await instance.wait([done.agent_id], "all", 1_000);

    // A fresh active child now occupies the single luna slot…
    await instance.spawn("occupier", "slow", "fake");

    // …so resuming the finished child on the same model must be rejected.
    await expect(instance.followup(done.agent_id, "again")).rejects.toThrow("subagentMaxPerModel");
  });

  it("allows four same-model children when no per-model cap is set (regression)", async () => {
    const instance = manager();
    const children = await Promise.all(
      [1, 2, 3, 4].map((n) => instance.spawn(`uncapped-${n}`, "slow", "fake")),
    );
    expect(children.every((child) => child.state === "running")).toBe(true);
  });

  it("rejects duplicate names and contains malformed-worker stdin errors", async () => {
    const instance = manager();
    await instance.spawn("same", "slow", "fake");
    await expect(instance.spawn("same", "other", "fake")).rejects.toThrow("already exists");

    const malformedDefs = [{ ...agents[0]!, name: "bad", systemPrompt: "malformed" }];
    const malformed = manager({ agentDefs: malformedDefs });
    await expect(malformed.spawn("bad", "task", "bad")).rejects.toThrow("malformed");
    // Let the worker exit and close stdin. A late EPIPE must be consumed by the
    // manager rather than surfacing as Vitest's process-level unhandled error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(malformed.list()).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("rejects a launch that is still starting when cancellation interrupts all workers", async () => {
    const hangingDefs = [{ ...agents[0]!, name: "hanging", systemPrompt: "hang" }];
    const instance = manager({ agentDefs: hangingDefs });
    const launch = instance.spawn("hanging", "task", "hanging");
    const rejection = expect(launch).rejects.toThrow("Subagent worker closed");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.interruptAll();
    await rejection;
  });

  it("keeps internally interrupted results uncollected until the parent waits", async () => {
    const instance = manager();
    const child = await instance.spawn("cancelled-child", "slow", "fake");

    await instance.interruptAll();
    expect(instance.list()).toEqual([
      expect.objectContaining({
        agent_id: child.agent_id,
        state: "interrupted",
        collected: false,
      }),
    ]);
    expect(instance.completionGate()).toMatchObject({ unresolved: 1 });

    const collected = await instance.wait([child.agent_id], "all", 500);
    expect(collected.agents[0]?.collected).toBe(true);
    expect(instance.completionGate().unresolved).toBe(0);
  });

  it("reaps idle workers and retains a bounded closed snapshot", async () => {
    const instance = manager({ idleTimeoutMs: 5 });
    const child = await instance.spawn("short", "fast", "fake");
    await instance.wait([child.agent_id], "all", 500);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(instance.list().find((item) => item.agent_id === child.agent_id)?.state).toBe("closed");
    await expect(instance.followup(child.agent_id, "late")).rejects.toThrow("reaped");
  });

  it("fails closed until active and terminal child results are collected", async () => {
    const instance = manager();
    const child = await instance.spawn("gate-child", "slow", "fake");
    expect(instance.completionGate()).toMatchObject({ unresolved: 1 });
    expect(instance.completionGateMessage()).toContain(child.agent_id);
    expect(buildSubAgentCompletionFollowUp(instance)?.[0]?.content).toContain(child.agent_id);

    await vi.waitFor(() => expect(instance.completionGate().active).toEqual([]), {
      timeout: 5_000,
    });
    expect(instance.completionGate()).toMatchObject({
      active: [],
      uncollected: [expect.objectContaining({ agent_id: child.agent_id })],
      unresolved: 1,
    });

    const collected = await instance.wait([child.agent_id], "all", 500);
    expect(collected.agents[0]?.collected).toBe(true);
    expect(instance.completionGateMessage()).toBeUndefined();
    expect(buildSubAgentCompletionFollowUp(instance)).toBeNull();
  });

  it("hydrates interrupted state and lazily respawns a recovered child session", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "project");
    const store = new SubAgentStore(path.join(root, "state"));
    await fs.mkdir(cwd, { recursive: true });
    const sessionRootDir = path.join(root, "sessions");
    const recovered: PersistedSubAgentRecord = {
      agent_id: "recovered-child",
      task_name: "durable-child",
      state: "running",
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 1,
      turn_count: 1,
      tool_use_count: 0,
      token_usage: { input: 2, output: 3 },
      agent_name: "fake",
      provider: "openai",
      model: "gpt-5.6-sol",
      child_session_id: "child-session",
      child_session_path: path.join(sessionRootDir, "project", "child.jsonl"),
      collected: false,
    };
    await store.save(cwd, "parent-a", [recovered]);
    const instance = manager({ store, cwd, sessionRootDir });
    await instance.hydrate("parent-a");
    expect(instance.list()[0]).toMatchObject({ state: "interrupted", recovered: true });

    const requestSpy = vi.spyOn(
      instance as unknown as { request: (...args: unknown[]) => Promise<Record<string, unknown>> },
      "request",
    );
    await instance.followup("recovered-child", "resume");
    const initialize = requestSpy.mock.calls.find(([, command]) => command === "initialize");
    expect(initialize?.[2]).toMatchObject({
      options: { childSessionPath: recovered.child_session_path },
    });
    const result = await instance.wait(["recovered-child"], "all", 500);
    expect(result.agents[0]).toMatchObject({ state: "completed", collected: true });
  });

  it("rejects recovered child paths outside the dedicated session root", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "project");
    const sessionRootDir = path.join(root, "sessions");
    const store = new SubAgentStore(path.join(root, "state"));
    await fs.mkdir(cwd, { recursive: true });
    await store.save(cwd, "parent-a", [
      {
        agent_id: "outside-child",
        task_name: "outside",
        state: "interrupted",
        started_at: 1,
        updated_at: 2,
        elapsed_ms: 1,
        turn_count: 0,
        tool_use_count: 0,
        token_usage: { input: 0, output: 0 },
        child_session_path: path.join(root, "outside.jsonl"),
      },
    ]);
    const instance = manager({ store, cwd, sessionRootDir });
    await instance.hydrate("parent-a");

    await expect(instance.followup("outside-child", "resume")).rejects.toThrow(
      "outside the subagent session root",
    );
  });

  it("waits for an in-flight shutdown before resetting parent state", async () => {
    const root = await tempDir();
    const store = new SubAgentStore(path.join(root, "state"));
    const instance = manager({ store });
    await instance.hydrate("parent-a");
    await instance.spawn("shutdown-child", "slow", "fake");

    const shutdown = instance.shutdownAll();
    await instance.resetParentSession("parent-new");
    await shutdown;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(instance.list()).toEqual([]);
    expect(await store.load(process.cwd(), "parent-new")).toEqual([]);
  });

  it("prunes only old child transcripts unreferenced by every durable parent", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "project-cwd");
    const sessionRootDir = path.join(root, "sessions");
    const sessionDirectory = path.join(sessionRootDir, "project");
    const unreferencedSession = path.join(sessionDirectory, "old-unreferenced.jsonl");
    const referencedSession = path.join(sessionDirectory, "old-referenced.jsonl");
    await fs.mkdir(sessionDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(unreferencedSession, "{}\n"),
      fs.writeFile(referencedSession, "{}\n"),
    ]);
    const old = new Date(Date.now() - 31 * 86_400_000);
    await Promise.all([
      fs.utimes(unreferencedSession, old, old),
      fs.utimes(referencedSession, old, old),
    ]);

    const store = new SubAgentStore(path.join(root, "state"));
    const otherParentRecord: PersistedSubAgentRecord = {
      agent_id: "other-parent-child",
      task_name: "durable history",
      state: "completed",
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 1,
      turn_count: 1,
      tool_use_count: 0,
      token_usage: { input: 2, output: 3 },
      child_session_path: referencedSession,
      collected: true,
    };
    await store.save(cwd, "other-parent", [otherParentRecord]);
    const instance = manager({ store, cwd, sessionRootDir });

    await instance.hydrate("current-parent");

    await expect(fs.stat(unreferencedSession)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(referencedSession)).resolves.toBeTruthy();
  });

  it("copies history to a compacted parent and resets a genuinely new parent", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "project");
    const store = new SubAgentStore(path.join(root, "state"));
    const completed: PersistedSubAgentRecord = {
      agent_id: "history-child",
      task_name: "history",
      state: "completed",
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 1,
      turn_count: 1,
      tool_use_count: 0,
      token_usage: { input: 2, output: 3 },
      output: "done",
      collected: true,
    };
    await store.save(cwd, "parent-before", [completed]);
    const instance = manager({ store, cwd });
    await instance.hydrate("parent-before");
    await instance.rebindParentSession("parent-compacted");
    expect(await store.load(cwd, "parent-compacted")).toEqual([
      expect.objectContaining({ agent_id: "history-child", output: "done" }),
    ]);

    await instance.resetParentSession("parent-new");
    expect(instance.list()).toEqual([]);
    expect(await store.load(cwd, "parent-new")).toEqual([]);
  });
});
