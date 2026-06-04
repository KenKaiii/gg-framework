import { AgentSession } from "@kenkaiiii/ggcoder";
import {
  classifyProviderError,
  type Message,
  type Provider,
  type ThinkingLevel,
} from "@kenkaiiii/gg-ai";
import type { EventQueue } from "./event-queue.js";
import type { ToolUseSummary, WorkerStatus, WorkerTurnSummary } from "./types.js";
import { bossStore } from "./boss-store.js";
import { log } from "./logger.js";

/**
 * Wrap a sync event-bus handler so any thrown error becomes a worker_error
 * event instead of cascading up through ggcoder's eventBus.emit and
 * potentially killing the boss process. Worker bus handlers do non-trivial
 * work (state mutations, queue pushes); a bug in any of them must NEVER
 * crash gg-boss because that would take down all 6+ workers in the same
 * process.
 */
/**
 * Provider-error classification moved to @kenkaiiii/gg-ai
 * (`classifyProviderError`) so provider-wording changes are a one-file edit
 * next to `formatError` / `isHardBillingMessage`. Re-exported under the
 * historical name so existing callers and tests in gg-boss are unchanged.
 */
export const classifyWorkerError = classifyProviderError;

function safeBusHandler<T>(
  workerName: string,
  handlerName: string,
  fn: (event: T) => void,
  onError: (message: string) => void,
): (event: T) => void {
  return (event) => {
    try {
      fn(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "worker", `bus handler "${handlerName}" threw`, {
        worker: workerName,
        message,
      });
      onError(`Worker "${workerName}" event handler error: ${message}`);
    }
  };
}

export interface WorkerOptions {
  name: string;
  cwd: string;
  provider: Provider;
  model: string;
  thinkingLevel?: ThinkingLevel;
  signal: AbortSignal;
  queue: EventQueue;
}

export interface WorkerActivity {
  status: WorkerStatus;
  /** ISO timestamp when the current turn started, or null if idle. */
  startedAt: string | null;
  /** ISO timestamp of the last event from the agent (text/tool), or null if no events yet. */
  lastEventAt: string | null;
  /** Seconds since the turn started. 0 if idle. */
  workingSeconds: number;
  /** Seconds since the last event arrived. Useful for detecting hangs. 0 if no events yet. */
  silentSeconds: number;
  /** Tool names currently mid-execution. */
  activeTools: string[];
  /** Tools completed so far in this turn (✓/✗). */
  completedTools: ToolUseSummary[];
  /** Tail of the assistant's streamed text so far this turn (last ~400 chars). */
  textTail: string;
  /** Raw ms timestamp of the last event — used by the orchestrator's watchdog to detect recovery. */
  lastEventAtMs: number | null;
}

/**
 * One worker per project. Wraps an AgentSession and translates its event
 * stream into BossEvents pushed onto the shared queue.
 *
 * - prompt() is fire-and-forget: returns immediately, completion arrives later
 *   on the queue as a worker_turn_complete event.
 * - The worker buffers text + tool calls during a turn and emits a single
 *   summary on agent_done.
 */
export class Worker {
  readonly name: string;
  readonly cwd: string;

  private session: AgentSession;
  private queue: EventQueue;
  private status: WorkerStatus = "idle";
  private turnCount = 0;
  private currentText = "";
  private currentTools: ToolUseSummary[] = [];
  private activeTools = new Map<string, string>();
  /** Parent (orchestrator-wide) signal — fires only on full shutdown. */
  private parentSignal: AbortSignal;
  /** Per-turn AbortController so the boss can cancel one worker mid-flight without taking down the whole pool. */
  private turnAc: AbortController | null = null;
  /** Set true when cancel() fired so the silent-death guard reports "Cancelled by boss" instead of a generic abort error. */
  private wasCancelled = false;
  private startedAt: number | null = null;
  private lastEventAt: number | null = null;

  constructor(opts: WorkerOptions) {
    this.name = opts.name;
    this.cwd = opts.cwd;
    this.queue = opts.queue;
    this.parentSignal = opts.signal;
    this.session = new AgentSession({
      provider: opts.provider,
      model: opts.model,
      cwd: opts.cwd,
      thinkingLevel: opts.thinkingLevel,
      signal: opts.signal,
      promptCacheKeyPrefix: `ggboss-worker:${opts.name}`,
    });
  }

  async initialize(): Promise<void> {
    await this.session.initialize();
    this.wireEvents();
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  async prompt(text: string): Promise<void> {
    if (this.status === "working") {
      throw new Error(`Worker "${this.name}" is already working`);
    }
    this.status = "working";
    bossStore.setWorkerStatus(this.name, "working");
    this.currentText = "";
    this.currentTools = [];
    this.activeTools.clear();
    this.wasCancelled = false;
    this.startedAt = Date.now();
    this.lastEventAt = null;

    // Per-turn AbortController layered under the orchestrator's master signal.
    // cancel() aborts only this turn's controller — other workers untouched.
    // Parent abort (full shutdown) propagates down to every active turn.
    const turnAc = new AbortController();
    this.turnAc = turnAc;
    const onParentAbort = (): void => turnAc.abort();
    if (this.parentSignal.aborted) turnAc.abort();
    else this.parentSignal.addEventListener("abort", onParentAbort, { once: true });
    this.session.setSignal(turnAc.signal);

    // Fire-and-forget. Errors surface via the eventBus error handler below.
    void this.session
      .prompt(text)
      .then(() => {
        // Silent-death guard: AgentSession.runLoop swallows abort-classified
        // errors with a bare `return`, so prompt() can resolve cleanly without
        // ever emitting `agent_done`. Without this check, status stays
        // "working" forever, the orchestrator's inFlightTaskByProject entry
        // never clears, and the task is stuck in_progress with no signal to
        // the boss. Convert it into an explicit worker_error so the boss can
        // diagnose / retry.
        if (this.status === "working") {
          const message = this.wasCancelled
            ? "Cancelled by boss."
            : "Session ended without agent_done — likely a silently swallowed abort or stream interruption.";
          const ts = new Date().toISOString();
          this.status = "error";
          this.startedAt = null;
          log(
            this.wasCancelled ? "INFO" : "ERROR",
            "worker",
            this.wasCancelled ? "cancelled" : "silent session end",
            { worker: this.name },
          );
          this.queue.removeStuckFor(this.name);
          bossStore.appendWorkerError(this.name, message, ts);
          this.queue.push({
            kind: "worker_error",
            project: this.name,
            message,
            timestamp: ts,
          });
        }
      })
      .catch((err) => {
        const rawMessage = this.wasCancelled
          ? "Cancelled by boss."
          : err instanceof Error
            ? err.message
            : String(err);
        const message = this.wasCancelled ? rawMessage : classifyWorkerError(rawMessage);
        this.status = "error";
        this.startedAt = null;
        const ts = new Date().toISOString();
        this.queue.removeStuckFor(this.name);
        bossStore.appendWorkerError(this.name, message, ts);
        this.queue.push({
          kind: "worker_error",
          project: this.name,
          message,
          timestamp: ts,
        });
      })
      .finally(() => {
        this.parentSignal.removeEventListener("abort", onParentAbort);
        if (this.turnAc === turnAc) this.turnAc = null;
      });
  }

  /**
   * Cancel the current turn. Aborts only this worker's per-turn controller —
   * other workers keep running. The aborted turn surfaces as a `worker_error`
   * event with message "Cancelled by boss." so the orchestrator clears its
   * in-flight task entry and the boss is notified.
   *
   * Returns true if a turn was actually cancelled.
   */
  cancel(): boolean {
    if (this.status !== "working" || !this.turnAc) return false;
    this.wasCancelled = true;
    this.turnAc.abort();
    return true;
  }

  /**
   * Snapshot of the worker's current activity. Cheap to call; safe while the
   * worker is mid-turn. Used by the boss's get_worker_activity tool to peek
   * inside a long-running turn without waiting for completion.
   */
  getActivity(): WorkerActivity {
    const now = Date.now();
    const TEXT_TAIL = 400;
    const tail =
      this.currentText.length > TEXT_TAIL
        ? "…" + this.currentText.slice(-TEXT_TAIL)
        : this.currentText;
    return {
      status: this.status,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      workingSeconds: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0,
      silentSeconds: this.lastEventAt ? Math.floor((now - this.lastEventAt) / 1000) : 0,
      activeTools: [...this.activeTools.values()],
      completedTools: [...this.currentTools],
      textTail: tail,
      lastEventAtMs: this.lastEventAt,
    };
  }

  /**
   * Hard reset: cancel any in-flight turn, wipe conversation history, force
   * status back to idle. Use when a worker is wedged in `error` or stuck on a
   * bad context that re-prompting can't recover from.
   */
  async reset(): Promise<void> {
    this.cancel();
    await this.session.newSession();
    this.turnCount = 0;
    this.currentText = "";
    this.currentTools = [];
    this.activeTools.clear();
    this.startedAt = null;
    this.lastEventAt = null;
    this.wasCancelled = false;
    this.status = "idle";
    bossStore.setWorkerStatus(this.name, "idle");
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }

  async switchModel(provider: Provider, model: string): Promise<void> {
    await this.session.switchModel(provider, model);
  }

  /**
   * Live ref to this worker's message array (NOT a copy). Used by the
   * orchestrator's post-turn truncation pass to mutate oversized tool
   * results in place — long-running workers accumulate huge `read` /
   * `bash` outputs in their history and that's the dominant heap consumer.
   */
  getMessagesRef(): Message[] {
    return this.session.getMessages();
  }

  /**
   * Wipe this worker's conversation history and start a new session file.
   * Used by `prompt_worker(..., fresh: true)` when the boss declares the
   * incoming task is a meaningful direction change — keeps the worker's
   * context lean instead of dragging stale exploration along forever.
   */
  async newSession(): Promise<void> {
    await this.session.newSession();
    this.turnCount = 0;
  }

  private wireEvents(): void {
    const bus = this.session.eventBus;
    // Every handler is wrapped in safeBusHandler so a thrown error becomes
    // a worker_error event instead of bubbling up through eventBus.emit
    // and crashing the boss process. The shared single-process model means
    // ANY uncaught throw here would take all workers down with it.
    const reportError = (rawMessage: string): void => {
      const ts = new Date().toISOString();
      const message = classifyWorkerError(rawMessage);
      this.status = "error";
      // Drop any queued stuck pings for this worker — they're stale now that
      // we've terminated the turn with an explicit error.
      this.queue.removeStuckFor(this.name);
      bossStore.appendWorkerError(this.name, message, ts);
      this.queue.push({
        kind: "worker_error",
        project: this.name,
        message,
        timestamp: ts,
      });
    };

    bus.on(
      "text_delta",
      safeBusHandler<{ text: string }>(
        this.name,
        "text_delta",
        ({ text }) => {
          this.currentText += text;
          this.lastEventAt = Date.now();
        },
        reportError,
      ),
    );

    bus.on(
      "tool_call_start",
      safeBusHandler<{ toolCallId: string; name: string }>(
        this.name,
        "tool_call_start",
        ({ toolCallId, name }) => {
          this.activeTools.set(toolCallId, name);
          this.lastEventAt = Date.now();
        },
        reportError,
      ),
    );

    bus.on(
      "tool_call_end",
      safeBusHandler<{ toolCallId: string; isError: boolean }>(
        this.name,
        "tool_call_end",
        ({ toolCallId, isError }) => {
          const name = this.activeTools.get(toolCallId);
          this.activeTools.delete(toolCallId);
          if (name) this.currentTools.push({ name, ok: !isError });
          this.lastEventAt = Date.now();
        },
        reportError,
      ),
    );

    bus.on(
      "agent_done",
      safeBusHandler<unknown>(
        this.name,
        "agent_done",
        () => {
          this.turnCount += 1;
          const summary: WorkerTurnSummary = {
            project: this.name,
            cwd: this.cwd,
            status: "idle",
            finalText: this.currentText.trim(),
            toolsUsed: [...this.currentTools],
            turnIndex: this.turnCount,
            timestamp: new Date().toISOString(),
          };
          this.currentText = "";
          this.currentTools = [];
          this.activeTools.clear();
          this.startedAt = null;
          this.lastEventAt = null;
          this.status = "idle";
          // Drop any queued stuck pings for this worker — they're stale now
          // that the worker has cleanly completed.
          this.queue.removeStuckFor(this.name);
          bossStore.appendWorkerEvent(summary);
          this.queue.push({ kind: "worker_turn_complete", summary });
        },
        reportError,
      ),
    );

    bus.on(
      "error",
      safeBusHandler<{ error: Error }>(
        this.name,
        "error",
        ({ error }) => {
          reportError(error.message);
        },
        reportError,
      ),
    );
  }
}
