import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentDefinition } from "./agents.js";
import {
  boundSubAgentOutput,
  childSubAgentEnv,
  childThinkingLevel,
  resolveSubAgentCliEntry,
  selectSubAgent,
  subAgentCacheKey,
  SUB_AGENT_MAX_STDERR_CHARS,
} from "../tools/subagent-shared.js";

export type SubAgentState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "closed";

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
  token_usage: { input: number; output: number };
  output?: string;
  error?: string;
}

export interface SubAgentManagerOptions {
  cwd: string;
  agents: AgentDefinition[];
  getProvider: () => Provider;
  getModel: () => string;
  getThinkingLevel: () => ThinkingLevel | undefined;
  getCacheKey?: () => string | undefined;
  getBaseUrl?: () => string | undefined;
  onState?: (snapshot: SubAgentSnapshot) => void;
  workerEntry?: string;
  idleTimeoutMs?: number;
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

export class SubAgentManager {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly snapshots = new Map<string, SubAgentSnapshot>();
  private readonly listeners = new Set<(snapshot: SubAgentSnapshot) => void>();
  private shuttingDown = false;

  constructor(private readonly options: SubAgentManagerOptions) {}

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

    const now = Date.now();
    const agentId = this.createId();
    const child = spawn(
      process.execPath,
      [this.options.workerEntry ?? resolveSubAgentCliEntry(), "--subagent-worker"],
      {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childSubAgentEnv(),
        detached: process.platform !== "win32",
      },
    );
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

    try {
      await this.request(record, "initialize", {
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
        },
      });
      await this.request(record, "start", { task });
      record.state = "running";
      record.updated_at = Date.now();
      this.publish(record);
      return this.snapshot(record);
    } catch (error) {
      this.fail(record, error);
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
    const worker = this.requireWorker(agentId);
    if (worker.state === "running" || worker.state === "starting") {
      throw new Error(`Agent ${agentId} already has an active turn`);
    }
    if (this.activeCount() >= ACTIVE_LIMIT)
      throw new Error(`At most ${ACTIVE_LIMIT} agents may run at once`);
    clearTimeout(worker.idleTimer);
    worker.taskOutput = "";
    worker.output = undefined;
    worker.error = undefined;
    await this.request(worker, "followup", { task });
    worker.state = "running";
    worker.updated_at = Date.now();
    this.publish(worker);
    return this.snapshot(worker);
  }

  async interrupt(agentId: string): Promise<SubAgentSnapshot> {
    const worker = this.requireWorker(agentId);
    if (worker.state !== "running") throw new Error(`Agent ${agentId} is not running`);
    const changed = this.waitForChange(agentId);
    await this.request(worker, "interrupt");
    await changed;
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
    let timedOut = false;
    if (!ready()) {
      const changes = ids.map((id) => this.waitForChange(id));
      const requestedChange =
        condition === "all"
          ? Promise.all(changes).then(() => true)
          : Promise.race(changes).then(() => true);
      timedOut = !(await Promise.race([
        requestedChange,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), boundedTimeout)),
      ]));
    }
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

  async interruptAll(): Promise<void> {
    await Promise.allSettled(
      [...this.workers.values()]
        .filter((worker) => this.isActive(worker))
        .map((worker) =>
          worker.state === "starting" ? this.close(worker) : this.interrupt(worker.agent_id),
        ),
    );
  }

  async shutdownAll(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await Promise.allSettled([...this.workers.values()].map((worker) => this.close(worker)));
  }

  /** Synchronous process-exit fallback: terminate detached process groups immediately. */
  shutdownAllNow(): void {
    this.shuttingDown = true;
    for (const worker of this.workers.values()) this.kill(worker);
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
      if (event === "text_delta") worker.taskOutput += String(payload.text ?? "");
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
      }
      worker.updated_at = Date.now();
      this.publish(worker);
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

  private publish(worker: WorkerRecord): void {
    const snapshot = this.snapshot(worker);
    this.snapshots.delete(worker.agent_id);
    this.snapshots.set(worker.agent_id, snapshot);
    while (this.snapshots.size > SNAPSHOT_LIMIT)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    this.options.onState?.(snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }

  private snapshot(worker: SubAgentSnapshot): SubAgentSnapshot {
    return { ...worker, elapsed_ms: this.elapsed(worker), token_usage: { ...worker.token_usage } };
  }

  private elapsed(snapshot: SubAgentSnapshot): number {
    return (
      (this.isTerminal(snapshot.state) ? snapshot.updated_at : Date.now()) - snapshot.started_at
    );
  }

  private activeCount(): number {
    return [...this.workers.values()].filter((worker) => this.isActive(worker)).length;
  }

  private isActive(worker: SubAgentSnapshot): boolean {
    return worker.state === "starting" || worker.state === "running";
  }

  private isTerminal(state: SubAgentState | undefined): boolean {
    return (
      state === "completed" || state === "failed" || state === "interrupted" || state === "closed"
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
    while (idle.length > RETAINED_WORKER_LIMIT) void this.close(idle.shift()!);
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

  private async close(worker: WorkerRecord): Promise<void> {
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
    worker.state = "closed";
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
