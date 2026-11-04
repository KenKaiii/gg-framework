import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./agents.js";
import { buildSubAgentCompletionFollowUp, SubAgentManager } from "./subagent-manager.js";
import { SubAgentStore, type PersistedSubAgentRecord } from "./subagent-store.js";
import { readTurnRecord, writeTurnRecord } from "./subagent-turn-record.js";
import { AgentNotificationQueue } from "./agent-notifications.js";

const workerEntry = fileURLToPath(
  new URL("../tools/__fixtures__/fake-subagent-worker.mjs", import.meta.url),
);
const agents: AgentDefinition[] = [
  {
    name: "fake",
    description: "Fake test worker",
    tools: ["read"],
    // Explicit cheap tier — the only way an agent opts out of the parent model.
    model: "fast",
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
    notifications?: AgentNotificationQueue;
    adoptionPollMs?: number;
  } = {},
) {
  const instance = new SubAgentManager({
    notifications: options.notifications,
    cwd: options.cwd ?? process.cwd(),
    agents: options.agentDefs ?? agents,
    getProvider: () => "openai",
    getModel: () => "gpt-6.1-sol",
    getThinkingLevel: () => "ultra",
    getCacheKey: () => "parent-cache",
    getMaxPerModel: () => options.maxPerModel,
    workerEntry,
    idleTimeoutMs: options.idleTimeoutMs,
    store: options.store,
    sessionRootDir: options.sessionRootDir,
    adoptionPollMs: options.adoptionPollMs,
  });
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  const activeManagers = managers.splice(0);
  await Promise.all(activeManagers.map((instance) => instance.shutdownAll()));
  await Promise.all(activeManagers.map((instance) => instance.waitForPersistence()));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) =>
        fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ),
  );
});

describe("SubAgentManager", () => {
  it("applies explicit spawn overrides for harness-owned children", async () => {
    const instance = manager();
    const requestSpy = vi.spyOn(
      instance as unknown as {
        request: (...args: unknown[]) => Promise<unknown>;
      },
      "request",
    );

    // The independent Ideal reviewer: read-only tools, forced ACTIVE model —
    // agent-definition routing ("fake" would use the fast model) is bypassed —
    // and its own shorter time limit, which the worker enforces.
    await instance.spawn("reviewer", "review the work", undefined, {
      model: "gpt-6.1-sol",
      tools: ["read", "grep", "find", "ls"],
      turnTimeoutMs: 120_000,
    });

    const initializeCall = requestSpy.mock.calls.find(([, command]) => command === "initialize");
    expect(initializeCall?.[2]).toMatchObject({
      options: {
        model: "gpt-6.1-sol",
        allowedTools: ["read", "grep", "find", "ls"],
        promptCacheKey: "parent-cache:subagent:gpt-6.1-sol:default",
        turnTimeoutMs: 120_000,
      },
    });
  });

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
        model: "gpt-6-luna",
        promptCacheKey: "parent-cache:subagent:gpt-6-luna:fake",
      },
    });
  });

  it("returns after launch and overlaps eight child turns", async () => {
    const instance = manager();
    // "hold" turns run until released, so all eight are provably still active
    // when the ninth spawn hits the cap. A timed turn raced process startup:
    // on a loaded runner the first child finished before the last one
    // launched, which freed a slot for the ninth.
    const children = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((number) => instance.spawn(`task-${number}`, "hold", "fake")),
    );
    // Returning every child in the running state proves spawn resolves on the
    // start acknowledgement rather than waiting for the turn to complete.
    // Avoid a wall-clock threshold here: process startup is scheduler-dependent
    // under the full parallel workspace suite.
    expect(children.every((child) => child.state === "running")).toBe(true);
    await expect(instance.spawn("ninth", "hold", "fake")).rejects.toThrow("At most 8");
    // A queued message releases each held turn.
    for (const child of children) {
      expect(await instance.sendMessage(child.agent_id, "release")).toBe(1);
    }
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

  it("holds the limit and unique names when a batch starts children together", async () => {
    const instance = manager();
    // spawn_agent's batch form starts every task at once with allSettled; the
    // limit and name checks must still see the siblings started in the same tick.
    const names = ["a", "b", "c", "d", "e", "f", "g", "a", "h", "i"];
    const settled = await Promise.allSettled(
      names.map((name) => instance.spawn(name, "hold", "fake")),
    );

    const started = settled.filter((result) => result.status === "fulfilled");
    const refused = settled.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : [],
    );
    expect(started).toHaveLength(8);
    expect(refused).toEqual([
      expect.stringContaining('An agent named "a" already exists'),
      expect.stringContaining("At most 8"),
    ]);
    for (const result of started) {
      expect(await instance.sendMessage(result.value.agent_id, "release")).toBe(1);
    }
  });

  it("pushes a bounded completion notification without waiting", async () => {
    const notifications = new AgentNotificationQueue();
    const instance = manager({ notifications });

    const child = await instance.spawn("notify-child", "fast", "fake");
    // Event-driven, but NOT a collection: the parent never calls wait().
    await instance.wait([child.agent_id], "all", 1_000);

    const drained = notifications.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ kind: "subagent", id: child.agent_id, terminal: true });
    expect(drained[0]!.text).toContain("notify-child");
    expect(drained[0]!.text).toContain("completed");
    expect(drained[0]!.text).toContain("wait_agent");
    expect(drained[0]!.text.length).toBeLessThanOrEqual(512);
  });

  it("carries the child's receipt in wait() payloads, after a truncated output", async () => {
    const instance = manager();
    const child = await instance.spawn("receipt-child", "x".repeat(40_000), "fake");
    const waited = await instance.wait([child.agent_id], "all", 1_000);
    const agent = waited.agents[0]!;
    expect(agent.state).toBe("completed");
    expect(agent.output).toContain("[output truncated at");
    expect(agent.receipt).toBe("Receipt (1 call): read a.ts");
    // Rendered after `output` in the wait_agent JSON the parent reads.
    const keys = Object.keys(agent);
    expect(keys.indexOf("receipt")).toBe(keys.indexOf("output") + 1);
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
    // The "fake" agent declares model: fast (gpt-6-luna); an agent with no
    // model policy inherits the parent model (gpt-6.1-sol).
    const shellAgent: AgentDefinition = {
      name: "sheller",
      description: "Shell-capable worker",
      tools: ["read", "bash"],
      systemPrompt: "fake",
      source: "bundled",
    };
    const instance = manager({ agentDefs: [...agents, shellAgent], maxPerModel: 1 });

    const first = await instance.spawn("first-luna", "slow", "fake");
    expect(first.model).toBe("gpt-6-luna");

    // Same resolved model at the cap → rejected with the setting named.
    await expect(instance.spawn("second-luna", "slow", "fake")).rejects.toThrow(
      "At most 1 agents may run at once on model gpt-6-luna (subagentMaxPerModel)",
    );

    // A different resolved model is unaffected by the luna cap.
    const other = await instance.spawn("parent-model", "slow", "sheller");
    expect(other.model).toBe("gpt-6.1-sol");
  });

  it("names the available agents when asked for one that does not exist", async () => {
    const instance = manager();

    await expect(instance.spawn("typo", "task", "hawk")).rejects.toThrow(
      'Unknown agent: "hawk". Available agents: fake',
    );
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

  it("allows eight same-model children when no per-model cap is set (regression)", async () => {
    const instance = manager();
    const children = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => instance.spawn(`uncapped-${n}`, "slow", "fake")),
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

  it("reaps idle workers and resumes them from the durable child session", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "project");
    const sessionRootDir = path.join(root, "sessions");
    await fs.mkdir(cwd, { recursive: true });
    const instance = manager({
      idleTimeoutMs: 5,
      cwd,
      sessionRootDir,
      store: new SubAgentStore(path.join(root, "state")),
    });
    const child = await instance.spawn("short", "fast", "fake");
    const completed = await instance.wait([child.agent_id], "all", 500);
    const childSessionPath = completed.agents[0]?.child_session_path;
    expect(childSessionPath?.startsWith(sessionRootDir)).toBe(true);
    await vi.waitFor(
      () =>
        expect(instance.list().find((item) => item.agent_id === child.agent_id)?.state).toBe(
          "closed",
        ),
      { timeout: 2_000 },
    );

    const requestSpy = vi.spyOn(
      instance as unknown as { request: (...args: unknown[]) => Promise<Record<string, unknown>> },
      "request",
    );
    await instance.followup(child.agent_id, "late");
    const initialize = requestSpy.mock.calls.find(([, command]) => command === "initialize");
    expect(initialize?.[2]).toMatchObject({
      options: { childSessionPath },
    });
    const resumed = await instance.wait([child.agent_id], "all", 500);
    expect(resumed.agents[0]).toMatchObject({ state: "completed", collected: true });
    expect(resumed.agents[0]?.output).toContain("late");
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
      model: "gpt-6.1-sol",
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

describe("durable turn-record adoption on hydrate", () => {
  const PARENT = "parent-adopt-1";

  async function adoptionFixture() {
    const root = await tempDir();
    const sessionRootDir = path.join(root, "sessions");
    const childPath = path.join(sessionRootDir, "child-1.jsonl");
    const record: PersistedSubAgentRecord = {
      agent_id: "a1",
      task_name: "orphan-task",
      state: "running",
      started_at: 1000,
      updated_at: 2000,
      elapsed_ms: 1000,
      turn_count: 2,
      tool_use_count: 1,
      token_usage: { input: 10, output: 2 },
      child_session_id: "child-1",
      child_session_path: childPath,
      collected: false,
    };
    return { root, sessionRootDir, childPath, record };
  }

  it("adopts a completed record newer than the parent's last observation", async () => {
    const { root, sessionRootDir, childPath, record } = await adoptionFixture();
    const store = new SubAgentStore(path.join(root, "store"));
    await store.save(root, PARENT, [record]);
    await writeTurnRecord(childPath, {
      status: "completed",
      output: "orphan result",
      receipt: "Receipt (2 calls): read src/a.ts ×2",
      model: "fast",
      turn_count: 4,
      token_usage: { input: 30, output: 8 },
      completed_at: 2500, // after the store's updated_at=2000
    });
    const notifications = new AgentNotificationQueue();
    const instance = manager({
      cwd: root,
      store,
      sessionRootDir,
      notifications,
      adoptionPollMs: 20,
    });

    await instance.hydrate(PARENT);
    const snapshot = instance.list().find((s) => s.agent_id === "a1")!;
    expect(snapshot.state).toBe("completed");
    expect(snapshot.output).toBe("orphan result");
    expect(snapshot.receipt).toBe("Receipt (2 calls): read src/a.ts ×2");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.turn_count).toBe(4);
    expect(snapshot.token_usage).toMatchObject({ input: 30, output: 8 });
    // One-shot adoption: the record is consumed.
    expect(await readTurnRecord(childPath)).toBeUndefined();
    const [notification] = notifications.drain();
    expect(notification?.text).toContain("finished during a parent restart");
    expect(notification?.terminal).toBe(true);
  });

  it("keeps a stale record out (older than the parent's last observation)", async () => {
    const { root, sessionRootDir, childPath, record } = await adoptionFixture();
    const store = new SubAgentStore(path.join(root, "store"));
    await store.save(root, PARENT, [record]);
    await writeTurnRecord(childPath, {
      status: "completed",
      output: "stale result from an earlier turn",
      turn_count: 1,
      token_usage: { input: 5, output: 1 },
      completed_at: 1500, // BEFORE the store's updated_at=2000
    });
    const instance = manager({ cwd: root, store, sessionRootDir, adoptionPollMs: 20 });

    await instance.hydrate(PARENT);
    const snapshot = instance.list().find((s) => s.agent_id === "a1")!;
    expect(snapshot.state).toBe("interrupted");
    expect(snapshot.output).toBeUndefined();
    // Record preserved — it belongs to a turn the parent already observed.
    expect(await readTurnRecord(childPath)).toBeDefined();
  });

  it("adopts an interrupted record's partial output and error", async () => {
    const { root, sessionRootDir, childPath, record } = await adoptionFixture();
    const store = new SubAgentStore(path.join(root, "store"));
    await store.save(root, PARENT, [record]);
    await writeTurnRecord(childPath, {
      status: "interrupted",
      output: "partial findings",
      error: "Interrupted",
      turn_count: 3,
      token_usage: { input: 20, output: 5 },
      completed_at: Date.now(),
    });
    const instance = manager({ cwd: root, store, sessionRootDir, adoptionPollMs: 20 });

    await instance.hydrate(PARENT);
    const snapshot = instance.list().find((s) => s.agent_id === "a1")!;
    expect(snapshot.state).toBe("interrupted");
    expect(snapshot.output).toBe("partial findings");
    expect(snapshot.error).toBe("Interrupted");
  });

  it("preserves a failed record's terminal state instead of masking it as interrupted", async () => {
    const { root, sessionRootDir, childPath, record } = await adoptionFixture();
    const store = new SubAgentStore(path.join(root, "store"));
    await store.save(root, PARENT, [record]);
    await writeTurnRecord(childPath, {
      status: "failed",
      output: "partial findings",
      error: "Timed out after 30 minutes; recovery summary failed",
      turn_count: 6,
      token_usage: { input: 25, output: 6 },
      completed_at: Date.now(),
    });
    const instance = manager({ cwd: root, store, sessionRootDir, adoptionPollMs: 20 });

    await instance.hydrate(PARENT);
    const snapshot = instance.list().find((s) => s.agent_id === "a1")!;
    expect(snapshot.state).toBe("failed");
    expect(snapshot.error).toBe("Timed out after 30 minutes; recovery summary failed");
  });

  it("adopts a late record that lands while the watcher is running", async () => {
    const { root, sessionRootDir, childPath, record } = await adoptionFixture();
    const store = new SubAgentStore(path.join(root, "store"));
    await store.save(root, PARENT, [record]);
    const notifications = new AgentNotificationQueue();
    const instance = manager({
      cwd: root,
      store,
      sessionRootDir,
      notifications,
      adoptionPollMs: 20,
    });
    await instance.hydrate(PARENT);
    // No record yet: pessimistic interrupted, watcher armed.
    expect(instance.list().find((s) => s.agent_id === "a1")!.state).toBe("interrupted");

    await writeTurnRecord(childPath, {
      status: "completed",
      output: "late orphan result",
      turn_count: 5,
      token_usage: { input: 50, output: 9 },
      completed_at: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const snapshot = instance.list().find((s) => s.agent_id === "a1")!;
    expect(snapshot.state).toBe("completed");
    expect(snapshot.output).toBe("late orphan result");
    expect(
      notifications.drain().some((n) => n.text.includes("late") || n.text.includes("restart")),
    ).toBe(true);
  });

  it("leaves terminal snapshots alone", async () => {
    const { root, sessionRootDir, childPath, record } = await adoptionFixture();
    const store = new SubAgentStore(path.join(root, "store"));
    await store.save(root, PARENT, [
      { ...record, state: "completed", output: "done before crash" },
    ]);
    await writeTurnRecord(childPath, {
      status: "completed",
      output: "should not overwrite",
      turn_count: 9,
      token_usage: { input: 1, output: 1 },
      completed_at: Date.now(),
    });
    const instance = manager({ cwd: root, store, sessionRootDir, adoptionPollMs: 20 });

    await instance.hydrate(PARENT);
    const snapshot = instance.list().find((s) => s.agent_id === "a1")!;
    expect(snapshot.state).toBe("completed");
    expect(snapshot.output).toBe("done before crash");
  });
});
