import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getAppPaths } from "@kenkaiiii/gg-core";
import { mcpServersForAgent, type AgentDefinition } from "./agents.js";
import { SubAgentStore, type PersistedSubAgentRecord } from "./subagent-store.js";
import { SessionManager } from "./session-manager.js";
import { log } from "./logger.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";
import type { AcceptanceCheck } from "./acceptance-checks.js";
import {
  clearTurnRecord,
  readTurnRecord,
  type SubagentTurnRecord,
} from "./subagent-turn-record.js";
import {
  boundSubAgentOutput,
  childSubAgentEnv,
  resolveSubAgentCliEntry,
  selectSubAgent,
  subAgentCacheKey,
  subAgentThinkingLevel,
  type SubAgentTokenUsage,
  SUB_AGENT_MAX_STDERR_CHARS,
  SUB_AGENT_TIMEOUT_MS,
} from "../tools/subagent-shared.js";

export type SubAgentState =
  "starting" | "running" | "completed" | "failed" | "interrupted" | "closed" | "reaped";

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
  /**
   * Engine-built receipt of the last turn's tool calls plus any paths the
   * report names that the child never opened. Kept apart from `output` so
   * wait()'s head truncation can never cut it and output parsers (the ideal
   * reviewer) see the child's prose unchanged.
   */
  receipt?: string;
  /**
   * One-line verdict of the parent's acceptance checks for the last turn
   * (`2/3 passed, 1 unverified`); the per-check lines ride in `receipt`.
   */
  acceptance?: string;
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
  getThinkingLevel?: () => ThinkingLevel | undefined;
  getCacheKey?: () => string | undefined;
  getBaseUrl?: () => string | undefined;
  /** Optional per-model concurrency cap (subagentMaxPerModel setting). Counted
   *  against the RESOLVED child model — an agent pinned to its own model id
   *  counts under that model, not the parent's. Only ever
   *  reduces concurrency below the global ACTIVE_LIMIT. */
  getMaxPerModel?: () => number | undefined;
  onState?: (snapshot: SubAgentSnapshot) => void;
  /**
   * Push queue for child-completion notifications. When set, a finished child
   * announces itself into the parent's next turn instead of waiting to be
   * discovered by `wait_agent` or the pre-stop completion gate.
   */
  notifications?: AgentNotificationQueue;
  workerEntry?: string;
  idleTimeoutMs?: number;
  /** Poll interval for adopting turn records of children orphaned mid-turn.
   *  Test-only knob; production default 5s. */
  adoptionPollMs?: number;
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

/** Children that may be starting or running at once. */
export const ACTIVE_LIMIT = 8;
const RETAINED_WORKER_LIMIT = 8;
const SNAPSHOT_LIMIT = 20;
/**
 * Chars of child output `wait_agent` returns — in total, and per agent.
 *
 * Whatever comes back is pasted into the PARENT's context: the old 100k cap
 * could hand a single wait ~25k tokens of transcript. The full output always
 * remains readable at each child's `child_session_path`.
 */
const WAIT_OUTPUT_LIMIT = 60_000;
const WAIT_OUTPUT_PER_AGENT_LIMIT = 30_000;
/**
 * Wait budgets, aligned with the child's own `SUB_AGENT_TIMEOUT_MS` (10 min).
 * The previous 30s default and 5-min ceiling meant a parent waiting on a
 * legitimately long child gave up ~20x early and finalized on a half-answer.
 */
export const DEFAULT_WAIT_MS = 120_000;
export const MAX_WAIT_MS = SUB_AGENT_TIMEOUT_MS;
const DEFAULT_IDLE_MS = 10 * 60_000;

function activity(name: string, args: Record<string, unknown>): string {
  const value = Object.values(args).find((candidate) => typeof candidate === "string");
  return value ? `${name}: ${String(value).slice(0, 60)}` : name;
}

/** Chars of a child's result kept in its completion notification. */
const NOTIFICATION_DIGEST_CHARS = 160;

/**
 * One-line gist of a child's result for a push notification. The full output
 * stays behind `wait_agent`; this only has to tell the parent whether the
 * result is worth collecting now.
 */
function summarizeForNotification(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length <= NOTIFICATION_DIGEST_CHARS
    ? collapsed
    : `${collapsed.slice(0, NOTIFICATION_DIGEST_CHARS - 1)}\u2026`;
}

/** Shared pre-finalization hook used by both AgentSession and the Ink host. */
export function buildSubAgentCompletionFollowUp(
  manager: Pick<SubAgentManager, "completionGateMessage"> | undefined,
): Message[] | null {
  const message = manager?.completionGateMessage();
  return message
    ? [
        {
          role: "user",
          content: message,
          provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
        },
      ]
    : null;
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
  /** Bounded watcher for turn records of children orphaned mid-turn. */
  private adoptionWatcher?: NodeJS.Timeout;
  private adoptionDeadline = 0;
  private persistPending = false;
  private persistScheduled = false;

  /** Agent definitions `spawn` resolves names against — the delegation roster. */
  get agents(): readonly AgentDefinition[] {
    return this.options.agents;
  }

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
    // Snapshots that were mid-turn at parent death. Their detached child may
    // still be finishing (stdin-close → orphan mode → durable turn record),
    // so adoption is checked now AND watched for a bounded window.
    const adoptable: Array<{ snapshot: SubAgentSnapshot; lastObservedAt: number }> = [];
    for (const persisted of records) {
      const wasActive = persisted.state === "starting" || persisted.state === "running";
      const snapshot: SubAgentSnapshot = {
        ...persisted,
        ...(wasActive
          ? {
              state: "interrupted" as const,
              error: "Interrupted by process restart",
              updated_at: Date.now(),
              recovered: true,
            }
          : { recovered: true }),
      };
      if (wasActive && snapshot.child_session_path) {
        adoptable.push({ snapshot, lastObservedAt: persisted.updated_at });
      }
      this.snapshots.set(snapshot.agent_id, snapshot);
      this.options.onState?.(snapshot);
      for (const listener of this.listeners) listener(snapshot);
    }
    this.queuePersist();
    await this.waitForPersistence();
    await this.settleAdoptableTurns(adoptable);
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

  /**
   * Adopt durable turn records for snapshots that were mid-turn at restart.
   * A record newer than the parent's last observation of that child is the
   * child's own terminal verdict — it outranks the pessimistic "interrupted".
   * Still-running orphans get a bounded watcher: the record usually lands
   * within one turn timeout, and adoption then notifies the parent's next
   * turn like any other completion.
   */
  private async settleAdoptableTurns(
    adoptable: Array<{ snapshot: SubAgentSnapshot; lastObservedAt: number }>,
  ): Promise<void> {
    clearInterval(this.adoptionWatcher);
    if (adoptable.length === 0) return;
    const pending = new Map(adoptable.map((entry) => [entry.snapshot.agent_id, entry]));
    const settle = async () => {
      for (const [agentId, entry] of pending) {
        // Skip anything re-spawned or already terminal via another path.
        const current = this.snapshots.get(agentId);
        if (!current || current.state !== "interrupted" || this.workers.has(agentId)) {
          pending.delete(agentId);
          continue;
        }
        const record = await readTurnRecord(current.child_session_path);
        if (!record || record.completed_at <= entry.lastObservedAt) continue;
        pending.delete(agentId);
        this.adoptTurnRecord(current, record);
      }
      if (pending.size === 0 || Date.now() > this.adoptionDeadline) {
        clearInterval(this.adoptionWatcher);
        this.adoptionWatcher = undefined;
      }
    };
    this.adoptionDeadline = Date.now() + SUB_AGENT_TIMEOUT_MS + 60_000;
    await settle();
    if (pending.size > 0) {
      this.adoptionWatcher = setInterval(() => void settle(), this.options.adoptionPollMs ?? 5_000);
      this.adoptionWatcher.unref?.();
    }
  }

  /** Fold a durable turn record into the snapshot and announce the adoption. */
  private adoptTurnRecord(snapshot: SubAgentSnapshot, record: SubagentTurnRecord): void {
    const adopted: SubAgentSnapshot = {
      ...snapshot,
      state: record.status === "completed" ? "completed" : record.status,
      output: record.output,
      receipt: record.receipt,
      error:
        record.status === "completed"
          ? undefined
          : (record.error ?? "Turn ended during a parent restart"),
      model: record.model ?? snapshot.model,
      turn_count: record.turn_count,
      token_usage: {
        ...snapshot.token_usage,
        input: record.token_usage.input,
        output: record.token_usage.output,
      },
      updated_at: Date.now(),
      recovered: true,
    };
    this.snapshots.set(adopted.agent_id, adopted);
    this.options.onState?.(adopted);
    for (const listener of this.listeners) listener(adopted);
    this.queuePersist();
    // One record is adopted once; clearing prevents a re-hydrate double-adoption
    // racing a persist that has not landed yet.
    void clearTurnRecord(adopted.child_session_path);
    log("INFO", "subagent", "Adopted child turn record after restart", {
      agent_id: adopted.agent_id,
      status: record.status,
    });
    this.options.notifications?.enqueue(
      "subagent",
      adopted.agent_id,
      `Child agent "${adopted.task_name}" (${adopted.agent_id}) finished during a parent ` +
        `restart and its result was recovered (${record.status}). ` +
        `Collect the full output with wait_agent agent_ids ["${adopted.agent_id}"].`,
      { terminal: true },
    );
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

  /** Explicit per-spawn overrides. Used by harness-owned children (the
   * independent Ideal reviewer): a read-only tool list and/or a forced model —
   * bypassing agent-definition routing entirely — and a shorter turn time
   * limit, after which the child answers from what it has gathered. */
  async spawn(
    taskName: string,
    task: string,
    agentName?: string,
    overrides?: {
      model?: string;
      tools?: readonly string[];
      turnTimeoutMs?: number;
      checks?: readonly AcceptanceCheck[];
    },
  ): Promise<SubAgentSnapshot> {
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
    const parentThinkingLevel = this.options.getThinkingLevel?.();
    const base = selectSubAgent(
      this.options.agents,
      agentName,
      provider,
      parentModel,
      parentThinkingLevel,
    );
    const model = overrides?.model ?? base.model;
    const selection = {
      agentDef: base.agentDef,
      provider: base.provider,
      parentModel: base.parentModel,
      model,
      // Resolve against the actual child model, including harness overrides.
      thinkingLevel: subAgentThinkingLevel(provider, model, parentThinkingLevel),
      tools: overrides?.tools ?? base.agentDef?.tools ?? [],
    };
    if (agentName && !selection.agentDef) {
      // Name the real roster: an unqualified "unknown agent" gives the model
      // nothing to correct against, so it re-guesses the same wrong name.
      const available = this.options.agents.map((a) => a.name).join(", ") || "none";
      throw new Error(`Unknown agent: "${agentName}". Available agents: ${available}`);
    }
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
          // Composed, not replaced — the child keeps its Tools section, project
          // context and Environment facts alongside its agent body.
          agentPrompt: selection.agentDef?.systemPrompt,
          agentContext: selection.agentDef?.context,
          thinkingLevel: selection.thinkingLevel,
          parentThinkingLevel,
          allowedTools: selection.tools.length ? [...selection.tools] : undefined,
          // Without this, an allow-listed child connects NO MCP servers — even
          // when its `tools:` frontmatter names `mcp__<server>__<tool>`.
          allowedMcpServers: selection.tools.length
            ? mcpServersForAgent([...selection.tools])
            : undefined,
          promptCacheKey: subAgentCacheKey(
            this.options.getCacheKey?.(),
            selection.model,
            selection.agentDef?.name ?? "default",
          ),
          sessionRootDir: this.sessionRootDir,
          turnTimeoutMs: overrides?.turnTimeoutMs,
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
      await this.request(record, "start", { task, checks: overrides?.checks ?? [] });
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

  async followup(
    agentId: string,
    task: string,
    checks: readonly AcceptanceCheck[] = [],
  ): Promise<SubAgentSnapshot> {
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
    worker.receipt = undefined;
    worker.acceptance = undefined;
    worker.error = undefined;
    worker.collected = false;
    await this.request(worker, "followup", { task, checks });
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
        // Head, not tail: a child's report leads with its answer. Bounded per
        // agent as well as in total so one verbose child cannot consume the
        // whole budget and starve the others of any output at all.
        const budget = Math.min(
          WAIT_OUTPUT_PER_AGENT_LIMIT,
          Math.max(0, WAIT_OUTPUT_LIMIT - chars),
        );
        if (snapshot.output.length > budget) {
          const path = snapshot.child_session_path;
          snapshot.output =
            snapshot.output.slice(0, budget) +
            `\n\n[output truncated at ${budget} chars${path ? `; full transcript: ${path}` : ""}]`;
        }
        chars += Math.min(budget, snapshot.output.length);
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
    clearInterval(this.adoptionWatcher);
    this.adoptionWatcher = undefined;
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
    clearInterval(this.adoptionWatcher);
    this.adoptionWatcher = undefined;
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
    const parentThinkingLevel = this.options.getThinkingLevel?.();
    this.assertModelCapacity(model);
    const childSessionPath = this.assertChildSessionPath(snapshot.child_session_path);
    const child = this.spawnWorkerProcess();
    const worker: WorkerRecord = {
      ...snapshot,
      state: "starting",
      updated_at: Date.now(),
      current_activity: undefined,
      output: undefined,
      receipt: undefined,
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
          agentPrompt: agentDef?.systemPrompt,
          agentContext: agentDef?.context,
          thinkingLevel: subAgentThinkingLevel(provider, model, parentThinkingLevel),
          parentThinkingLevel,
          allowedTools: agentDef?.tools.length ? agentDef.tools : undefined,
          allowedMcpServers: agentDef?.tools.length
            ? mcpServersForAgent(agentDef.tools)
            : undefined,
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
      worker.receipt = typeof frame.receipt === "string" ? frame.receipt : undefined;
      worker.acceptance = typeof frame.acceptance === "string" ? frame.acceptance : undefined;
      worker.error = frame.error ? String(frame.error) : undefined;
      if (typeof frame.model === "string") worker.model = frame.model;
      worker.current_activity = undefined;
      worker.updated_at = Date.now();
      this.publish(worker);
      this.notifyTerminal(worker);
      for (const resolve of worker.turnResolvers) resolve();
      worker.turnResolvers.clear();
      this.scheduleIdleReap(worker);
    }
  }

  /**
   * Announce a finished child into the parent's next turn. Carries the id, the
   * state and a short digest — NOT the output, which stays behind `wait_agent`
   * so a chatty child cannot dump its transcript into the parent's context.
   */
  private notifyTerminal(worker: WorkerRecord): void {
    const queue = this.options.notifications;
    if (!queue) return;
    const digest = summarizeForNotification(worker.error ?? worker.output ?? "");
    queue.enqueue(
      "subagent",
      worker.agent_id,
      `Child agent "${worker.task_name}" (${worker.agent_id}) is ${worker.state} after ` +
        `${worker.turn_count} turn(s)${digest ? `: ${digest}` : ""}. ` +
        `${worker.acceptance ? `Acceptance checks: ${worker.acceptance}. ` : ""}` +
        `Collect its full output with wait_agent agent_ids ["${worker.agent_id}"].`,
      { terminal: true },
    );
  }

  private request(
    worker: WorkerRecord,
    command: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const stdin = worker.process.stdin;
    if (!stdin?.writable) return Promise.reject(new Error("Subagent worker is closed"));
    const requestId = `${worker.agent_id}-${++worker.requestSequence}`;
    return new Promise((resolve, reject) => {
      worker.requests.set(requestId, { resolve, reject });
      stdin.write(`${JSON.stringify({ request_id: requestId, command, ...payload })}\n`);
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
    for (const id of this.snapshots.keys()) {
      if (this.snapshots.size <= SNAPSHOT_LIMIT) break;
      this.snapshots.delete(id);
    }
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
      receipt: worker.receipt,
      ...(worker.acceptance !== undefined && { acceptance: worker.acceptance }),
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
          const records = [...this.snapshots.values()].map((snapshot): PersistedSubAgentRecord => ({
            ...snapshot,
            token_usage: { ...snapshot.token_usage },
          }));
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
    for (const worker of idle.slice(0, Math.max(0, idle.length - RETAINED_WORKER_LIMIT))) {
      void this.close(worker, true);
    }
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
