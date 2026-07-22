import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getAppPaths } from "@kenkaiiii/gg-core";
import type { AgentDefinition } from "./agents.js";
import { SubAgentStore, type PersistedSubAgentRecord } from "./subagent-store.js";
import { SessionManager } from "./session-manager.js";
import { log } from "./logger.js";
import {
  boundSubAgentOutput,
  childSubAgentEnv,
  childThinkingLevel,
  resolveSubAgentCliEntry,
  selectSubAgent,
  subAgentCacheKey,
  type SubAgentTokenUsage,
  SUB_AGENT_MAX_STDERR_CHARS,
} from "../tools/subagent-shared.js";

export type SubAgentState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "closed"
  | "reaped";

export interface SubAgentSnapshot {
  agent_id: string;
  task_name: string;
  state: SubAgentState;
  started_at: number;
  updated_at: number;
  elapsed_ms: number;
  current_activity?: string;
  turn_count: number;
  tool_use_count: number;
  token_usage: SubAgentTokenUsage;
  output?: string;
  error?: string;
  agent_name?: string;
  provider?: string;
  model?: string;
  child_session_id?: string;
  child_session_path?: string;
  collected?: boolean;
  recovered?: boolean;
}

export interface SubAgentManagerOptions {
  cwd: string;
  agents: AgentDefinition[];
  getProvider: () => Provider;
  getModel: () => string;
  getThinkingLevel: () => ThinkingLevel | undefined;
  getCacheKey?: () => string | undefined;
  getBaseUrl?: () => string | undefined;
  /** Optional per-model concurrency cap (subagentMaxPerModel setting). Counted
   *  against the RESOLVED child model — read-only agents may run on the fast
   *  model, so they count under that model, not the parent's. Only ever
   *  reduces concurrency below the global ACTIVE_LIMIT. */
  getMaxPerModel?: () => number | undefined;
  onState?: (snapshot: SubAgentSnapshot) => void;
  workerEntry?: string;
  idleTimeoutMs?: number;
  store?: SubAgentStore;
  sessionRootDir?: string;
}

interface WorkerRecord extends SubAgentSnapshot {
  process: ChildProcess;
  requests: Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >;
  requestSequence: number;
  stderr: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  taskOutput: string;
  turnResolvers: Set<() => void>;
}

const ACTIVE_LIMIT = 4;
const RETAINED_WORKER_LIMIT = 8;
const SNAPSHOT_LIMIT = 20;
const WAIT_OUTPUT_LIMIT = 100_000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;

function activity(name: string, args: Record<string, unknown>): string {
  const value = Object.values(args).find((candidate) => typeof candidate === "string");
  return value ? `${name}: ${String(value).slice(0, 60)}` : name;
}

/** Shared pre-finalization hook used by both AgentSession and the Ink host. */
export function buildSubAgentCompletionFollowUp(
  manager: Pick<SubAgentManager, "completionGateMessage"> | undefined,
): Message[] | null {
  const message = manager?.completionGateMessage();
  return message ? [{ role: "user", content: message }] : null;
}

export class SubAgentManager {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly snapshots = new Map<string, SubAgentSnapshot>();
  private readonly listeners = new Set<(snapshot: SubAgentSnapshot) => void>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly store: SubAgentStore;
  private readonly sessionRootDir: string;
  private parentSessionId?: string;
  private persistQueue: Promise<void> = Promise.resolve();
  private persistPending = false;
  private persistScheduled = false;

  constructor(private readonly options: SubAgentManagerOptions) {
    const paths = getAppPaths();
    this.store = options.store ?? new SubAgentStore(paths.subagentsDir);
    this.sessionRootDir = options.sessionRootDir ?? paths.subagentSessionsDir;
  }

  /** Restore bounded history; dead in-flight workers become honestly interrupted. */
  async hydrate(parentSessionId: string): Promise<void> {
    if (this.workers.size > 0) {
      await this.shutdownAll();
      this.workers.clear();
      this.shuttingDown = false;
      this.shutdownPromise = undefined;
    }
    await this.waitForPersistence();
    this.parentSessionId = parentSessionId;
    this.snapshots.clear();
    const records = await this.store.load(this.options.cwd, parentSessionId);
    for (const persisted of records) {
      const snapshot: SubAgentSnapshot = {
        ...persisted,
        ...(persisted.state === "starting" || persisted.state === "running"
          ? {
              state: "interrupted" as const,
              error: "Interrupted by process restart",
              updated_at: Date.now(),
              recovered: true,
            }
          : { recovered: true }),
      };
      this.snapshots.set(snapshot.agent_id, snapshot);
      this.options.onState?.(snapshot);
      for (const listener of this.listeners) listener(snapshot);
    }
    this.queuePersist();
    await this.waitForPersistence();
    const referencedChildSessions = await this.store.listChildSessionPaths();
    await new SessionManager(this.sessionRootDir)
      .pruneOldSessions({
        maxAgeDays: 30,
        keepPaths: referencedChildSessions,
      })
      .catch((error) => {
        log("WARN", "subagent", "Failed to prune old subagent sessions", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Rebind durable child history after parent compaction creates a continuation. */
  async rebindParentSession(parentSessionId: string): Promise<void> {
    await this.waitForPersistence();
    this.parentSessionId = parentSessionId;
    this.queuePersist();
    await this.persistQueue;
  }

  /** A genuinely new parent starts with no unrelated child history. */
  async resetParentSession(parentSessionId: string): Promise<void> {
    await this.shutdownAll();
    await this.waitForPersistence();
    this.shuttingDown = false;
    this.shutdownPromise = undefined;
    this.workers.clear();
    this.snapshots.clear();
    this.parentSessionId = parentSessionId;
    this.queuePersist();
    await this.persistQueue;
  }

  async waitForPersistence(): Promise<void> {
    await this.persistQueue;
  }

  async spawn(taskName: string, task: string, agentName?: string): Promise<SubAgentSnapshot> {
    this.assertAvailable();
    if (!taskName.trim()) throw new Error("task_name is required");
    if ([...this.workers.values()].some((worker) => worker.task_name === taskName)) {
      throw new Error(`An agent named "${taskName}" already exists`);
    }
    if (this.activeCount() >= ACTIVE_LIMIT)
      throw new Error(`At most ${ACTIVE_LIMIT} agents may run at once`);

    this.reapExcessIdle();
    const provider = this.options.getProvider();
    const parentModel = this.options.getModel();
    const selection = selectSubAgent(this.options.agents, agentName, provider, parentModel);
    if (agentName && !selection.agentDef) throw new Error(`Unknown agent: "${agentName}"`);
    this.assertModelCapacity(selection.model);

    const now = Date.now();
    const agentId = this.createId();
    const child = this.spawnWorkerProcess();
    const record: WorkerRecord = {
      agent_id: agentId,
      task_name: taskName,
      state: "starting",
      started_at: now,
      updated_at: now,
      elapsed_ms: 0,
      turn_count: 0,
      tool_use_count: 0,
      token_usage: { input: 0, output: 0 },
      agent_name: selection.agentDef?.name,
      provider,
      model: selection.model,
      collected: false,
      process: child,
      requests: new Map(),
      requestSequence: 0,
      stderr: "",
      taskOutput: "",
      turnResolvers: new Set(),
    };
    this.workers.set(agentId, record);
    this.publish(record);
    this.attach(record);
    await this.waitForPersistence();

    try {
      const initialized = await this.request(record, "initialize", {
        options: {
          provider,
          model: selection.model,
          fallbackModel: selection.model === parentModel ? undefined : parentModel,
          cwd: this.options.cwd,
          baseUrl: this.options.getBaseUrl?.(),
          systemPrompt: selection.agentDef?.systemPrompt,
          thinkingLevel: childThinkingLevel(this.options.getThinkingLevel()),
          allowedTools: selection.agentDef?.tools.length ? selection.agentDef.tools : undefined,
          promptCacheKey: subAgentCacheKey(
            this.options.getCacheKey?.(),
            selection.model,
            selection.agentDef?.name ?? "default",
          ),
          sessionRootDir: this.sessionRootDir,
        },
      });
      record.child_session_id =
        typeof initialized.child_session_id === "string" ? initialized.child_session_id : undefined;
      if (typeof initialized.model === "string") record.model = initialized.model;
      record.child_session_path =
        typeof initialized.child_session_path === "string"
          ? this.assertChildSessionPath(initialized.child_session_path)
          : undefined;
      this.publish(record);
      await this.waitForPersistence();
      await this.request(record, "start", { task });
      record.state = "running";
      record.updated_at = Date.now();
      this.publish(record);
      await this.waitForPersistence();
      return this.snapshot(record);
    } catch (error) {
      this.fail(record, error);
      await this.waitForPersistence();
      throw error;
    }
  }

  async sendMessage(agentId: string, message: string): Promise<number> {
    const worker = this.requireWorker(agentId);
    if (worker.state !== "running") throw new Error(`Agent ${agentId} is not running`);
    const result = await this.request(worker, "queue_message", { message });
    return Number(result.queued ?? 0);
  }

  async followup(agentId: string, task: string): Promise<SubAgentSnapshot> {
    this.assertAvailable();
    let worker = this.workers.get(agentId);
    if (!worker) {
      const recovered = this.snapshots.get(agentId);
      if (!recovered) throw new Error(`Unknown agent: ${agentId}`);
      worker = await this.respawnRecovered(recovered);
    }
    if (worker.state === "running" || worker.state === "starting") {
      throw new Error(`Agent ${agentId} already has an active turn`);
    }
    if (this.activeCount() >= ACTIVE_LIMIT)
      throw new Error(`At most ${ACTIVE_LIMIT} agents may run at once`);
    if (worker.model) this.assertModelCapacity(worker.model);
    clearTimeout(worker.idleTimer);
    worker.taskOutput = "";
    worker.output = undefined;
    worker.error = undefined;
    worker.collected = false;
    await this.request(worker, "followup", { task });
    worker.state = "running";
    worker.updated_at = Date.now();
    this.publish(worker);
    await this.waitForPersistence();
    return this.snapshot(worker);
  }

  async interrupt(agentId: string, collectResult = true): Promise<SubAgentSnapshot> {
    const worker = this.requireWorker(agentId);
    if (worker.state !== "running") throw new Error(`Agent ${agentId} is not running`);
    const changed = this.waitForChange(agentId);
    await this.request(worker, "interrupt");
    await changed;
    if (collectResult) this.markCollected(agentId);
    await this.waitForPersistence();
    return this.snapshot(worker);
  }

  subscribe(listener: (snapshot: SubAgentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SubAgentSnapshot[] {
    return [...this.snapshots.values()]
      .map((snapshot) => ({ ...snapshot, elapsed_ms: this.elapsed(snapshot) }))
      .sort((a, b) => a.started_at - b.started_at);
  }

  async wait(
    agentIds?: string[],
    condition: "any" | "all" = "any",
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<{ timed_out: boolean; agents: SubAgentSnapshot[] }> {
    const ids = agentIds?.length
      ? agentIds
      : [...this.workers.values()]
          .filter((worker) => this.isActive(worker))
          .map((worker) => worker.agent_id);
    if (ids.length === 0) return { timed_out: false, agents: [] };
    for (const id of ids) if (!this.snapshots.has(id)) throw new Error(`Unknown agent: ${id}`);
    const boundedTimeout = Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS);
    const terminal = () => ids.filter((id) => this.isTerminal(this.snapshots.get(id)?.state));
    const ready = () =>
      condition === "all" ? terminal().length === ids.length : terminal().length > 0;
    const deadline = Date.now() + boundedTimeout;
    let timedOut = false;
    while (!ready()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const pendingIds = ids.filter((id) => !this.isTerminal(this.snapshots.get(id)?.state));
      const changed = await Promise.race([
        Promise.race(pendingIds.map((id) => this.waitForChange(id))).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining)),
      ]);
      if (!changed && !ready()) timedOut = true;
      if (!changed) break;
    }
    for (const id of ids) {
      if (this.isTerminal(this.snapshots.get(id)?.state)) this.markCollected(id);
    }
    await this.waitForPersistence();
    let chars = 0;
    const agents = ids.map((id) => {
      const snapshot = { ...this.snapshots.get(id)! };
      if (snapshot.output) {
        const remaining = Math.max(0, WAIT_OUTPUT_LIMIT - chars);
        snapshot.output = snapshot.output.slice(0, remaining);
        chars += snapshot.output.length;
      }
      return snapshot;
    });
    return { timed_out: timedOut, agents };
  }

  completionGate(): {
    active: SubAgentSnapshot[];
    uncollected: SubAgentSnapshot[];
    unresolved: number;
  } {
    const snapshots = this.list();
    const active = snapshots.filter((snapshot) => this.isActive(snapshot));
    const uncollected = snapshots.filter(
      (snapshot) => this.isTerminal(snapshot.state) && snapshot.collected !== true,
    );
    return { active, uncollected, unresolved: active.length + uncollected.length };
  }

  completionGateMessage(): string | undefined {
    const gate = this.completionGate();
    if (gate.unresolved === 0) return undefined;
    const activeIds = gate.active.map((snapshot) => snapshot.agent_id).sort();
    const uncollectedIds = gate.uncollected.map((snapshot) => snapshot.agent_id).sort();
    const unresolvedIds = [...new Set([...activeIds, ...uncollectedIds])];
    return [
      "Child-agent completion gate: the parent cannot finish with unresolved child work.",
      `Unresolved agent IDs: ${unresolvedIds.join(", ")}.`,
      activeIds.length > 0
        ? `Active agent IDs: ${activeIds.join(", ")}. Wait for them with wait_agent, or interrupt them before collecting their terminal result.`
        : "All children are terminal, but their results have not been collected.",
      `Call wait_agent with agent_ids [${unresolvedIds.map((id) => `"${id}"`).join(", ")}] and condition "all" before finishing.`,
    ].join("\n");
  }

  async interruptAll(): Promise<void> {
    await Promise.allSettled(
      [...this.workers.values()]
        .filter((worker) => this.isActive(worker))
        .map((worker) =>
          worker.state === "starting" ? this.close(worker) : this.interrupt(worker.agent_id, false),
        ),
    );
  }

  async shutdownAll(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true;
      this.shutdownPromise = Promise.allSettled(
        [...this.workers.values()].map((worker) => this.close(worker, false, true)),
      ).then(() => undefined);
    }
    await this.shutdownPromise;
  }

  /** Synchronous process-exit fallback: terminate detached process groups immediately. */
  shutdownAllNow(): void {
    this.shuttingDown = true;
    for (const worker of this.workers.values()) this.kill(worker);
  }

  private markCollected(agentId: string): void {
    const worker = this.workers.get(agentId);
    if (worker) {
      worker.collected = true;
      worker.updated_at = Date.now();
      this.publish(worker);
      return;
    }
    const snapshot = this.snapshots.get(agentId);
    if (!snapshot) return;
    const collected = { ...snapshot, collected: true, updated_at: Date.now() };
    this.snapshots.set(agentId, collected);
    this.options.onState?.(collected);
    for (const listener of this.listeners) listener(collected);
    this.queuePersist();
  }

  private spawnWorkerProcess(): ChildProcess {
    return spawn(
      process.execPath,
      [this.options.workerEntry ?? resolveSubAgentCliEntry(), "--subagent-worker"],
      {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childSubAgentEnv(),
        detached: process.platform !== "win32",
      },
    );
  }

  private async respawnRecovered(snapshot: SubAgentSnapshot): Promise<WorkerRecord> {
    if (!snapshot.child_session_path) {
      throw new Error(`Agent ${snapshot.agent_id} was reaped and has no recoverable child session`);
    }
    const agentDef = snapshot.agent_name
      ? this.options.agents.find((candidate) => candidate.name === snapshot.agent_name)
      : undefined;
    const provider = (snapshot.provider as Provider | undefined) ?? this.options.getProvider();
    const model = snapshot.model ?? this.options.getModel();
    const parentModel = this.options.getModel();
    this.assertModelCapacity(model);
    const childSessionPath = this.assertChildSessionPath(snapshot.child_session_path);
    const child = this.spawnWorkerProcess();
    const worker: WorkerRecord = {
      ...snapshot,
      state: "starting",
      updated_at: Date.now(),
      current_activity: undefined,
      output: undefined,
      error: undefined,
      collected: false,
      recovered: false,
      process: child,
      requests: new Map(),
      requestSequence: 0,
      stderr: "",
      taskOutput: "",
      turnResolvers: new Set(),
    };
    this.workers.set(worker.agent_id, worker);
    this.publish(worker);
    this.attach(worker);
    await this.waitForPersistence();
    try {
      const initialized = await this.request(worker, "initialize", {
        options: {
          provider,
          model,
          fallbackModel: model === parentModel ? undefined : parentModel,
          cwd: this.options.cwd,
          baseUrl: this.options.getBaseUrl?.(),
          systemPrompt: agentDef?.systemPrompt,
          thinkingLevel: childThinkingLevel(this.options.getThinkingLevel()),
          allowedTools: agentDef?.tools.length ? agentDef.tools : undefined,
          promptCacheKey: subAgentCacheKey(
            this.options.getCacheKey?.(),
            model,
            agentDef?.name ?? "default",
          ),
          sessionRootDir: this.sessionRootDir,
          childSessionPath,
        },
      });
      if (typeof initialized.child_session_id === "string") {
        worker.child_session_id = initialized.child_session_id;
      }
      if (typeof initialized.child_session_path === "string") {
        worker.child_session_path = this.assertChildSessionPath(initialized.child_session_path);
      }
      if (typeof initialized.model === "string") worker.model = initialized.model;
      worker.state = snapshot.state;
      worker.updated_at = Date.now();
      this.publish(worker);
      await this.waitForPersistence();
      return worker;
    } catch (error) {
      this.fail(worker, error);
      await this.waitForPersistence();
      throw error;
    }
  }

  private attach(worker: WorkerRecord): void {
    const lines = createInterface({ input: worker.process.stdout! });
    lines.on("line", (line) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.fail(worker, new Error("Subagent worker emitted malformed protocol data"));
        return;
      }
      this.handleFrame(worker, frame);
    });
    worker.process.stderr?.on("data", (chunk: Buffer) => {
      worker.stderr = (worker.stderr + chunk.toString()).slice(-SUB_AGENT_MAX_STDERR_CHARS);
    });
    // A worker can exit between the writable check and stdin.write(). Consume
    // the pipe error here so EPIPE becomes worker failure instead of an
    // uncaught process-level exception (seen on faster CI runners).
    worker.process.stdin?.on("error", (error) => this.fail(worker, error));
    worker.process.once("error", (error) => this.fail(worker, error));
    worker.process.once("exit", (code) => {
      if (!this.isTerminal(worker.state) && worker.state !== "closed") {
        this.fail(
          worker,
          new Error(worker.stderr.trim() || `Subagent worker exited (${code})`),
          false,
        );
      }
    });
  }

  private handleFrame(worker: WorkerRecord, frame: Record<string, unknown>): void {
    if (frame.type === "ack") {
      const pending = worker.requests.get(String(frame.request_id));
      if (!pending) return;
      worker.requests.delete(String(frame.request_id));
      if (frame.ok) pending.resolve(frame);
      else pending.reject(new Error(String(frame.error ?? "Worker request failed")));
      return;
    }
    if (frame.type === "event") {
      const event = String(frame.event);
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      // text_delta / thinking_delta fire per token but change no snapshot
      // field (taskOutput is worker-local; the snapshot only carries the final
      // `output`). Publishing them broadcast an unchanged snapshot per token,
      // per agent — pure SSE + re-render churn downstream. Accumulate and move
      // on; real state changes publish below.
      if (event === "text_delta" || event === "thinking_delta") {
        if (event === "text_delta") worker.taskOutput += String(payload.text ?? "");
        worker.updated_at = Date.now();
        return;
      }
      if (event === "tool_call_start") {
        worker.tool_use_count++;
        worker.current_activity = activity(
          String(payload.name ?? "tool"),
          (payload.args ?? {}) as Record<string, unknown>,
        );
      }
      if (event === "turn_end") {
        worker.turn_count++;
        const usage = payload.usage as Record<string, number> | undefined;
        worker.token_usage.input += usage?.inputTokens ?? 0;
        worker.token_usage.output += usage?.outputTokens ?? 0;
        worker.token_usage.cacheRead =
          (worker.token_usage.cacheRead ?? 0) + (usage?.cacheRead ?? 0);
        worker.token_usage.cacheWrite =
          (worker.token_usage.cacheWrite ?? 0) + (usage?.cacheWrite ?? 0);
      }
      worker.updated_at = Date.now();
      const durableProgress = event === "tool_call_start" || event === "turn_end";
      this.publish(worker, durableProgress);
      return;
    }
    if (frame.type === "turn_complete") {
      worker.state =
        frame.status === "completed"
          ? "completed"
          : frame.status === "interrupted"
            ? "interrupted"
            : "failed";
      worker.output = boundSubAgentOutput(String(frame.output ?? worker.taskOutput));
      worker.error = frame.error ? String(frame.error) : undefined;
      if (typeof frame.model === "string") worker.model = frame.model;
      worker.current_activity = undefined;
      worker.updated_at = Date.now();
      this.publish(worker);
      for (const resolve of worker.turnResolvers) resolve();
      worker.turnResolvers.clear();
      this.scheduleIdleReap(worker);
    }
  }

  private request(
    worker: WorkerRecord,
    command: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!worker.process.stdin?.writable)
      return Promise.reject(new Error("Subagent worker is closed"));
    const requestId = `${worker.agent_id}-${++worker.requestSequence}`;
    return new Promise((resolve, reject) => {
      worker.requests.set(requestId, { resolve, reject });
      worker.process.stdin!.write(
        `${JSON.stringify({ request_id: requestId, command, ...payload })}\n`,
      );
    });
  }

  private waitForChange(agentId: string): Promise<void> {
    const worker = this.workers.get(agentId);
    if (!worker || this.isTerminal(worker.state)) return Promise.resolve();
    return new Promise((resolve) => {
      worker.turnResolvers.add(resolve);
    });
  }

  private publish(worker: WorkerRecord, persist = true): void {
    const snapshot = this.snapshot(worker);
    this.snapshots.delete(worker.agent_id);
    this.snapshots.set(worker.agent_id, snapshot);
    while (this.snapshots.size > SNAPSHOT_LIMIT)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    this.options.onState?.(snapshot);
    for (const listener of this.listeners) listener(snapshot);
    if (persist) this.queuePersist();
  }

  private snapshot(worker: SubAgentSnapshot): SubAgentSnapshot {
    return {
      agent_id: worker.agent_id,
      task_name: worker.task_name,
      state: worker.state,
      started_at: worker.started_at,
      updated_at: worker.updated_at,
      elapsed_ms: this.elapsed(worker),
      current_activity: worker.current_activity,
      turn_count: worker.turn_count,
      tool_use_count: worker.tool_use_count,
      token_usage: { ...worker.token_usage },
      output: worker.output,
      error: worker.error,
      agent_name: worker.agent_name,
      provider: worker.provider,
      model: worker.model,
      child_session_id: worker.child_session_id,
      child_session_path: worker.child_session_path,
      collected: worker.collected,
      recovered: worker.recovered,
    };
  }

  private queuePersist(): void {
    if (!this.parentSessionId) return;
    this.persistPending = true;
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    this.persistQueue = this.persistQueue
      .catch(() => {})
      .then(async () => {
        while (this.persistPending) {
          this.persistPending = false;
          const parentSessionId = this.parentSessionId;
          if (!parentSessionId) continue;
          const records = [...this.snapshots.values()].map(
            (snapshot): PersistedSubAgentRecord => ({
              ...snapshot,
              token_usage: { ...snapshot.token_usage },
            }),
          );
          await this.store.save(this.options.cwd, parentSessionId, records);
        }
      })
      .catch((error) => {
        this.persistPending = false;
        log("WARN", "subagent", "Failed to persist subagent state", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.persistScheduled = false;
        if (this.persistPending) this.queuePersist();
      });
  }

  private elapsed(snapshot: SubAgentSnapshot): number {
    return (
      (this.isTerminal(snapshot.state) ? snapshot.updated_at : Date.now()) - snapshot.started_at
    );
  }

  private activeCount(): number {
    return [...this.workers.values()].filter((worker) => this.isActive(worker)).length;
  }

  /** Enforce the optional per-model cap against the resolved child model. */
  private assertModelCapacity(model: string): void {
    const cap = this.options.getMaxPerModel?.();
    if (cap === undefined) return;
    const activeOnModel = [...this.workers.values()].filter(
      (worker) => this.isActive(worker) && worker.model === model,
    ).length;
    if (activeOnModel >= cap) {
      throw new Error(
        `At most ${cap} agents may run at once on model ${model} (subagentMaxPerModel) — ` +
          `wait for one to finish or choose a different agent`,
      );
    }
  }

  private isActive(worker: SubAgentSnapshot): boolean {
    return worker.state === "starting" || worker.state === "running";
  }

  private isTerminal(state: SubAgentState | undefined): boolean {
    return (
      state === "completed" ||
      state === "failed" ||
      state === "interrupted" ||
      state === "closed" ||
      state === "reaped"
    );
  }

  private requireWorker(agentId: string): WorkerRecord {
    const worker = this.workers.get(agentId);
    if (!worker) throw new Error(`Unknown or reaped agent: ${agentId}`);
    return worker;
  }

  private assertAvailable(): void {
    if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
  }

  private assertChildSessionPath(candidate: string): string {
    const root = path.resolve(this.sessionRootDir);
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(`${root}${path.sep}`) || path.extname(resolved) !== ".jsonl") {
      throw new Error("Recovered child session path is outside the subagent session root");
    }
    return resolved;
  }

  private createId(): string {
    let id: string;
    do id = randomUUID().replaceAll("-", "").slice(0, 8);
    while (this.snapshots.has(id));
    return id;
  }

  private scheduleIdleReap(worker: WorkerRecord): void {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(
      () => void this.close(worker),
      this.options.idleTimeoutMs ?? DEFAULT_IDLE_MS,
    );
    worker.idleTimer.unref?.();
    this.reapExcessIdle();
  }

  private reapExcessIdle(): void {
    const idle = [...this.workers.values()]
      .filter((worker) => this.isTerminal(worker.state))
      .sort((a, b) => a.updated_at - b.updated_at);
    while (idle.length > RETAINED_WORKER_LIMIT) void this.close(idle.shift()!, true);
  }

  private fail(worker: WorkerRecord, error: unknown, kill = true): void {
    if (this.isTerminal(worker.state)) return;
    worker.state = "failed";
    worker.error = error instanceof Error ? error.message : String(error);
    worker.output = boundSubAgentOutput(worker.taskOutput);
    worker.updated_at = Date.now();
    for (const pending of worker.requests.values()) pending.reject(new Error(worker.error));
    worker.requests.clear();
    this.publish(worker);
    for (const resolve of worker.turnResolvers) resolve();
    worker.turnResolvers.clear();
    if (kill) this.kill(worker);
  }

  private async close(
    worker: WorkerRecord,
    reaped = false,
    preserveTerminal = false,
  ): Promise<void> {
    clearTimeout(worker.idleTimer);
    if (worker.process.stdin?.writable) {
      await Promise.race([
        this.request(worker, "shutdown").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    this.kill(worker);
    const closedError = new Error("Subagent worker closed");
    for (const pending of worker.requests.values()) pending.reject(closedError);
    worker.requests.clear();
    for (const resolve of worker.turnResolvers) resolve();
    worker.turnResolvers.clear();
    if (reaped) worker.state = "reaped";
    else if (!preserveTerminal || !this.isTerminal(worker.state)) worker.state = "closed";
    worker.updated_at = Date.now();
    this.publish(worker);
    this.workers.delete(worker.agent_id);
  }

  private kill(worker: WorkerRecord): void {
    if (worker.process.exitCode !== null || worker.process.killed) return;
    try {
      if (process.platform === "win32" && worker.process.pid) {
        spawn("taskkill", ["/pid", String(worker.process.pid), "/T", "/F"], { stdio: "ignore" });
      } else if (worker.process.pid) {
        process.kill(-worker.process.pid, "SIGTERM");
      } else worker.process.kill("SIGTERM");
    } catch {
      worker.process.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
      if (worker.process.exitCode !== null) return;
      try {
        if (process.platform === "win32" && worker.process.pid) {
          spawn("taskkill", ["/pid", String(worker.process.pid), "/T", "/F"], { stdio: "ignore" });
        } else if (worker.process.pid) {
          process.kill(-worker.process.pid, "SIGKILL");
        } else worker.process.kill("SIGKILL");
      } catch {
        worker.process.kill("SIGKILL");
      }
    }, 3_000);
    timer.unref?.();
  }
}
