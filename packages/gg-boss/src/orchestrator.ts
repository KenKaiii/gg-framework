import { Agent, isAbortError } from "@kenkaiiii/gg-agent";
import { compact, estimateConversationTokens, shouldCompact } from "@kenkaiiii/ggcoder";
import {
  AuthStorage,
  getContextWindow,
  getNextThinkingLevel,
  isThinkingLevelSupported,
} from "@kenkaiiii/gg-core";
import {
  formatError,
  type Message,
  type Provider,
  type ThinkingLevel,
  type Usage,
} from "@kenkaiiii/gg-ai";
import { Worker } from "./worker.js";
import { EventQueue } from "./event-queue.js";
import { createBossTools, WORKER_PROMPT_BRIEF } from "./tools.js";
import { createTaskTools } from "./task-tools.js";
import { tasksStore } from "./tasks-store.js";
import { saveSettings } from "./settings.js";
import { playDoneAudio, playReadyAudio } from "./audio.js";
import { log } from "./logger.js";
import { buildBossSystemPrompt } from "./boss-system-prompt.js";
import { bossStore } from "./boss-store.js";
import { truncateOversizedToolResults } from "./truncate-tool-results.js";
import {
  appendMessages,
  createSession,
  getMostRecent,
  getSessionById,
  loadSession,
} from "./sessions.js";
import type { BossEvent, ProjectSpec, WorkerTurnSummary } from "./types.js";

// ── Watchdog tuning ──────────────────────────────────────────
/** How often the stuck-worker watchdog ticks. */
const WATCHDOG_INTERVAL_MS = 30_000;
/** Silent for this long with no event → ping the boss. */
const SILENT_THRESHOLD_SEC = 90;
/** Running this long total → ping the boss even if events are still flowing. */
const WORKING_THRESHOLD_SEC = 600;

function normalizeBossThinkingLevel(
  provider: Provider,
  model: string,
  level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!level) return undefined;
  return isThinkingLevelSupported(provider, model, level)
    ? level
    : getNextThinkingLevel(provider, model, undefined);
}

export interface GGBossOptions {
  bossProvider: Provider;
  bossModel: string;
  /** Boss extended-thinking level. Toggled via Shift+Tab in the TUI. */
  bossThinkingLevel?: ThinkingLevel;
  workerProvider: Provider;
  workerModel: string;
  workerThinkingLevel?: ThinkingLevel;
  projects: ProjectSpec[];
  /** Resume a specific boss session by id. Mutually exclusive with continueRecent. */
  resumeSessionId?: string;
  /** Resume the most recently used boss session. */
  continueRecent?: boolean;
}

/**
 * The orchestrator. Owns N workers, a single shared event queue, and the boss Agent.
 * Each loop iteration: pop one event, format it as a user message, run the boss for
 * one full prompt (which may dispatch tool calls to workers), then await the next event.
 *
 * UI state is mirrored into bossStore — components subscribe via useBossState().
 */
export class GGBoss {
  private workers = new Map<string, Worker>();
  private lastSummaries = new Map<string, WorkerTurnSummary>();
  private queue = new EventQueue();
  private bossAgent!: Agent;
  private ac = new AbortController();
  /** Per-turn AbortController so ESC can cancel the current LLM call without killing workers. */
  private turnAc: AbortController | null = null;
  private running = false;
  private pendingUserMessages = 0;
  private opts: GGBossOptions;
  private authStorage = new AuthStorage();
  /** Path to the boss's per-session jsonl log under ~/.gg/boss/sessions/. */
  private sessionPath = "";
  /** Stable id for the current boss conversation, used as a provider cache routing key. */
  private bossSessionId = "";
  /** Last index in the boss's messages array we've persisted to disk. */
  private lastPersistedIndex = 0;
  /** project → task id currently dispatched to that worker. Used to mark
   *  the right task done/blocked when the worker_turn_complete event arrives. */
  private inFlightTaskByProject = new Map<string, string>();
  /**
   * Auto-chain notices waiting to be delivered to the boss. When the
   * orchestrator deterministically dispatches the next pending task for a
   * project (because the boss didn't), the boss has no other way to know it
   * happened — it'd see "X(working)" in the next event's other_workers
   * trailer and dismiss it as stale because it remembers receiving X's prior
   * completion event. We attach an explicit note to the next event so the
   * boss's mental model stays in sync with reality.
   */
  private pendingAutoChainNotices: { project: string; title: string }[] = [];
  /**
   * "Had any worker activity since the last all-clear chime?" Set true when
   * a worker_turn_complete or worker_error event arrives, cleared when we
   * detect the orchestrator has fully wound down (all workers idle, queue
   * empty, boss turn finished). Drives playReadyAudio so the chime fires
   * once per workflow instead of every time the boss replies to a chat
   * message that didn't dispatch any workers.
   */
  private hadWorkerActivitySinceReady = false;
  /**
   * Watchdog for stuck workers. Fires every WATCHDOG_INTERVAL_MS; if any
   * "working" worker has been silent past SILENT_THRESHOLD_SEC or running
   * past WORKING_THRESHOLD_SEC, push a `worker_stuck` event onto the queue.
   * The boss processes it like any other event — AFTER its current turn
   * (queue is FIFO, boss is single-event-at-a-time), so this never
   * interrupts an in-flight boss turn.
   */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-project debounce. Stores the worker's lastEventAtMs at the moment we
   * pushed the stuck event. If the worker's lastEventAt advances past that,
   * we know the worker recovered (emitted a new event), so we clear the entry
   * and become eligible to fire again on the next stall. Also cleared on
   * worker_turn_complete / worker_error.
   */
  private stuckPushedAt = new Map<string, number | null>();

  constructor(opts: GGBossOptions) {
    this.opts = {
      ...opts,
      bossThinkingLevel: normalizeBossThinkingLevel(
        opts.bossProvider,
        opts.bossModel,
        opts.bossThinkingLevel,
      ),
    };
  }

  async initialize(): Promise<void> {
    await this.authStorage.load();
    await tasksStore.load();
    const loggedInProviders = (await this.authStorage.listProviders()) as Provider[];

    bossStore.init({
      bossProvider: this.opts.bossProvider,
      bossModel: this.opts.bossModel,
      bossThinkingLevel: this.opts.bossThinkingLevel,
      workerProvider: this.opts.workerProvider,
      workerModel: this.opts.workerModel,
      loggedInProviders,
      workers: this.opts.projects.map((p) => ({ name: p.name, cwd: p.cwd })),
    });

    await Promise.all(
      this.opts.projects.map(async (p) => {
        const worker = new Worker({
          name: p.name,
          cwd: p.cwd,
          provider: this.opts.workerProvider,
          model: this.opts.workerModel,
          thinkingLevel: this.opts.workerThinkingLevel,
          signal: this.ac.signal,
          queue: this.queue,
        });
        await worker.initialize();
        this.workers.set(p.name, worker);
      }),
    );

    const creds = await this.authStorage.resolveCredentials(this.opts.bossProvider);
    const tools = this.buildToolSet();

    // Either resume a prior session (load messages from jsonl), or create a
    // new one. Either way we end up with `sessionPath` to persist into.
    let priorMessages: Message[] | undefined;
    if (this.opts.resumeSessionId) {
      const info = await getSessionById(this.opts.resumeSessionId);
      if (info) {
        this.sessionPath = info.path;
        this.bossSessionId = info.id;
        priorMessages = (await loadSession(info.path)).filter((m) => m.role !== "system");
      }
    } else if (this.opts.continueRecent) {
      const recent = await getMostRecent();
      if (recent) {
        this.sessionPath = recent.path;
        this.bossSessionId = recent.id;
        priorMessages = (await loadSession(recent.path)).filter((m) => m.role !== "system");
      }
    }
    if (!this.sessionPath) {
      const session = await createSession();
      this.sessionPath = session.filePath;
      this.bossSessionId = session.id;
    }
    // Rebuild the visible TUI history from the loaded messages so the chat
    // shows the prior conversation, not just the agent's hidden context.
    if (priorMessages && priorMessages.length > 0) {
      bossStore.restoreHistory(priorMessages);
    }

    this.bossAgent = new Agent({
      provider: this.opts.bossProvider,
      model: this.opts.bossModel,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
      promptCacheKey: this.getBossPromptCacheKey(),
      thinking: this.opts.bossThinkingLevel,
      priorMessages,
    });
    // Mark every loaded message as already persisted so we only append NEW
    // turns going forward. The system message is added by Agent's constructor
    // and we never want to write the system prompt to disk (it's rebuilt each
    // session from current project list) — so subtract one for it.
    this.lastPersistedIndex = this.bossAgent.getMessages().length;

    // Seed the context-bar estimate so it shows real progress before the first
    // turn_end event fires. Especially critical on `ggboss continue` where
    // we'd otherwise show 0% over a session that's already half-full.
    const initialMessages = this.bossAgent.getMessages();
    if (initialMessages.length > 1) {
      bossStore.setBossInputTokens(estimateConversationTokens(initialMessages));
    }
  }

  enqueueUserMessage(text: string): void {
    this.pendingUserMessages++;
    bossStore.setPendingMessages(this.pendingUserMessages);
    this.queue.push({
      kind: "user_message",
      text,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Abort the boss's current LLM call (e.g. user pressed ESC). Workers and the
   * orchestrator's run loop keep going. The next event in the queue gets a
   * fresh AbortController.
   */
  abort(): void {
    this.turnAc?.abort();
  }

  /** Boss tool set = orchestration tools + task management tools. */
  private buildToolSet() {
    const bossTools = createBossTools({
      workers: this.workers,
      lastSummaries: this.lastSummaries,
    });
    const taskTools = createTaskTools({
      workers: this.workers,
      dispatchTaskByDescription: (project, description, fresh, taskId) =>
        this.dispatchTaskByDescription(project, description, fresh, taskId),
    });
    return [...bossTools, ...taskTools];
  }

  /**
   * Dispatch a single task to a specific worker, marking it in_progress and
   * (eventually) done when the worker_turn_complete event arrives. Used by:
   *  - the dispatch_pending tool (called by the boss agent)
   *  - the Tasks overlay (when user presses Enter on a task)
   *
   * Returns immediately — fire-and-forget like prompt_worker.
   */
  async dispatchTaskById(taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const task = tasksStore.byId(taskId);
    if (!task) return { ok: false, reason: "unknown task id" };
    const w = this.workers.get(task.project);
    if (!w) return { ok: false, reason: `unknown project: ${task.project}` };
    if (w.getStatus() === "working") return { ok: false, reason: "worker is busy" };
    await tasksStore.update(task.id, { status: "in_progress" });
    return this.dispatchTaskByDescription(
      task.project,
      task.description,
      task.fresh === true,
      task.id,
    );
  }

  /**
   * Dispatch a task description to a worker. Used by both the task tool and
   * the overlay (via dispatchTaskById). Tracks the in-flight task id per
   * project so worker_turn_complete can resolve it back to the right task.
   */
  private async dispatchTaskByDescription(
    project: string,
    description: string,
    fresh: boolean,
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const w = this.workers.get(project);
    if (!w) {
      log("WARN", "dispatch", "unknown project", { project, taskId });
      return { ok: false, reason: `unknown project: ${project}` };
    }
    if (w.getStatus() === "working") {
      log("WARN", "dispatch", "worker busy", { project, taskId });
      return { ok: false, reason: "worker is busy" };
    }
    if (fresh) await w.newSession();
    this.inFlightTaskByProject.set(project, taskId);
    log("INFO", "dispatch", "task dispatched", { project, taskId, fresh });
    await w.prompt(WORKER_PROMPT_BRIEF + description);
    return { ok: true };
  }

  /**
   * Swap the boss's LLM model. Preserves message history so the conversation
   * continues seamlessly under the new model.
   */
  async switchBossModel(provider: Provider, model: string): Promise<void> {
    const tools = this.buildToolSet();
    const creds = await this.authStorage.resolveCredentials(provider);
    // Capture history minus the system message — Agent re-adds system from options.
    const oldMessages = this.bossAgent.getMessages().filter((m) => m.role !== "system");

    const thinking = normalizeBossThinkingLevel(provider, model, this.opts.bossThinkingLevel);
    this.opts.bossProvider = provider;
    this.opts.bossModel = model;
    this.opts.bossThinkingLevel = thinking;

    this.bossAgent = new Agent({
      provider,
      model,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
      promptCacheKey: this.getBossPromptCacheKey(),
      thinking,
      priorMessages: oldMessages,
    });

    bossStore.setBossModel(provider, model);
    bossStore.setBossThinking(thinking);
    await saveSettings({ bossProvider: provider, bossModel: model, bossThinkingLevel: thinking });
  }

  /** Swap every worker's model. Workers keep their per-project sessions. */
  async switchWorkerModel(provider: Provider, model: string): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.switchModel(provider, model)));
    this.opts.workerProvider = provider;
    this.opts.workerModel = model;
    bossStore.setWorkerModel(provider, model);
    await saveSettings({ workerProvider: provider, workerModel: model });
  }

  /**
   * Run a manual compaction now (driven by /compact). Will compact even if the
   * threshold isn't reached yet — useful for trimming context before a long task.
   */
  async manualCompact(): Promise<void> {
    await this.runCompaction(true);
  }

  /** Compact only when threshold (default 80%) is exceeded. */
  private async runCompaction(force: boolean): Promise<void> {
    const messages = this.bossAgent.getMessages();
    const contextWindow = getContextWindow(this.opts.bossModel);
    const tokens = bossStore.getInputTokens();
    if (!force && !shouldCompact(messages, contextWindow, 0.8, tokens)) return;

    bossStore.startCompaction();
    try {
      const creds = await this.authStorage.resolveCredentials(this.opts.bossProvider);
      const { messages: compactedMessages, result } = await compact(messages, {
        provider: this.opts.bossProvider,
        model: this.opts.bossModel,
        apiKey: creds.accessToken,
        contextWindow,
        signal: this.ac.signal,
      });
      // Start a new session file so `ggboss continue` resumes the COMPACTED
      // history, not the full original. Mirrors ggcoder/AgentSession.compact.
      // Set bossSessionId before rebuilding the Agent so its provider cache key
      // matches the new compacted session.
      const session = await createSession();
      this.sessionPath = session.filePath;
      this.bossSessionId = session.id;
      this.lastPersistedIndex = 0;
      await this.replaceBossMessages(compactedMessages);
      await this.persistNewMessages();
      bossStore.setBossInputTokens(0);
      bossStore.endCompaction(result.originalCount, result.newCount);
    } catch (err) {
      bossStore.cancelCompaction();
      if (!isAbortError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        bossStore.appendInfo(`Compaction failed: ${message}`, "error");
      }
    }
  }

  /**
   * Append any boss messages that haven't been written yet to the session log.
   * Skips the system message (regenerated each session from current project list).
   */
  /**
   * Walk boss + every worker message array and truncate oversized
   * tool_result content. In-place mutation — propagates back through
   * `Agent.getMessages()` shared references. Called once per boss
   * iteration after the turn finalizes.
   */
  private runPostTurnTruncation(): void {
    try {
      const bossTrimmed = truncateOversizedToolResults(this.bossAgent.getMessages());
      let workerTrimmed = 0;
      for (const w of this.workers.values()) {
        workerTrimmed += truncateOversizedToolResults(w.getMessagesRef());
      }
      if (bossTrimmed > 0 || workerTrimmed > 0) {
        log("INFO", "truncate_tool_results", "trimmed oversized results", {
          boss: bossTrimmed,
          workers: workerTrimmed,
        });
        // Hint the GC to actually reclaim the freed strings now — V8 won't
        // run a major GC purely from heap fragmentation, and we're explicitly
        // about to release megabytes of dead string data. Only available when
        // launched with --expose-gc (our shebang sets it).
        if (typeof globalThis.gc === "function") globalThis.gc();
      }
    } catch (err) {
      // Truncation must never break the run loop — if it throws, we just
      // skip this pass and try again next turn.
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "truncate_tool_results", message);
    }
  }

  private async persistNewMessages(): Promise<void> {
    if (!this.sessionPath) return;
    const all = this.bossAgent.getMessages();
    const newOnes = all.slice(this.lastPersistedIndex).filter((m) => m.role !== "system");
    if (newOnes.length === 0) return;
    try {
      await appendMessages(this.sessionPath, newOnes);
      this.lastPersistedIndex = all.length;
    } catch {
      // Persistence is best-effort — never crash the run loop on disk errors.
    }
  }

  /**
   * Toggle the boss's extended-thinking level. Recreates bossAgent with the
   * new setting (Anthropic SDK reads `thinking` once on construction). Mirrors
   * ggcoder's Shift+Tab UX. Persists to settings.json so the choice sticks
   * across restarts.
   */
  async setBossThinking(level: ThinkingLevel | undefined): Promise<void> {
    const nextLevel = normalizeBossThinkingLevel(
      this.opts.bossProvider,
      this.opts.bossModel,
      level,
    );
    this.opts.bossThinkingLevel = nextLevel;
    const tools = this.buildToolSet();
    const creds = await this.authStorage.resolveCredentials(this.opts.bossProvider);
    const oldMessages = this.bossAgent.getMessages().filter((m) => m.role !== "system");
    this.bossAgent = new Agent({
      provider: this.opts.bossProvider,
      model: this.opts.bossModel,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
      promptCacheKey: this.getBossPromptCacheKey(),
      thinking: nextLevel,
      priorMessages: oldMessages,
    });
    bossStore.setBossThinking(nextLevel);
    await saveSettings({ bossThinkingLevel: nextLevel });
  }

  /** Recreate bossAgent with a new message history (used by compact + /clear). */
  private async replaceBossMessages(newMessages: Message[]): Promise<void> {
    const tools = this.buildToolSet();
    const creds = await this.authStorage.resolveCredentials(this.opts.bossProvider);
    // Strip system — Agent re-adds it from `system`.
    const priorMessages = newMessages.filter((m) => m.role !== "system");
    this.bossAgent = new Agent({
      provider: this.opts.bossProvider,
      model: this.opts.bossModel,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
      promptCacheKey: this.getBossPromptCacheKey(),
      thinking: this.opts.bossThinkingLevel,
      priorMessages,
    });
  }

  /**
   * Start a brand-new boss session — fresh agent with no message history,
   * fresh session file on disk so `ggboss continue` picks up the new chat.
   * Workers are unaffected.
   */
  async newSession(): Promise<void> {
    const session = await createSession();
    this.sessionPath = session.filePath;
    this.bossSessionId = session.id;
    this.lastPersistedIndex = 0;
    await this.replaceBossMessages([]);
    bossStore.setBossInputTokens(0);
    // Mark the post-construction message count (just system) as persisted so
    // we don't try to write it.
    this.lastPersistedIndex = this.bossAgent.getMessages().length;
  }

  /** Alias kept for the existing /clear path which used "reset" terminology. */
  async resetConversation(): Promise<void> {
    return this.newSession();
  }

  private getBossPromptCacheKey(): string {
    return this.bossSessionId ? `ggboss:${this.bossSessionId}` : "ggboss";
  }

  async run(): Promise<void> {
    this.running = true;
    this.startWatchdog();
    while (this.running) {
      try {
        await this.runIteration();
      } catch (err) {
        // Safety net: any thrown error in a single iteration must NOT kill
        // the run loop. The loop drives every worker through the boss; if it
        // dies, no worker can ever complete another task in this session.
        // Log + surface a friendly notice + keep looping. Truly fatal
        // conditions (process kill, OOM) still terminate the process; this
        // catch only handles JS-level errors that escaped the inner try.
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "run_loop", "iteration threw", { message });
        try {
          bossStore.appendInfo(`Boss loop error (recovered): ${message}`, "error");
        } catch {
          // Even the recovery path can throw (e.g. bossStore tearing down)
          // — swallow rather than crash the loop.
        }
      }
    }
  }

  private async runIteration(): Promise<void> {
    const event = await this.queue.next();
    if (!this.running) return;

    if (event.kind === "user_message") {
      this.pendingUserMessages = Math.max(0, this.pendingUserMessages - 1);
      bossStore.setPendingMessages(this.pendingUserMessages);
    }
    // Captured so the post-turn auto-chain can tell whether THIS event was
    // a dispatched task (chain on) vs an ad-hoc prompt_worker like recon
    // (chain off). Lives outside the `if` so it stays in scope down below.
    let finishedTaskId: string | null = null;
    if (event.kind === "worker_turn_complete") {
      this.stuckPushedAt.delete(event.summary.project);
      // Play the completion chime — fire-and-forget. Multiple workers
      // finishing in quick succession will layer their sounds, which is
      // fine: it's a chime, not a long jingle.
      void playDoneAudio();
      this.hadWorkerActivitySinceReady = true;
      this.lastSummaries.set(event.summary.project, event.summary);
      log("INFO", "worker_turn_complete", "worker finished", {
        project: event.summary.project,
        turn: event.summary.turnIndex,
        tools: event.summary.toolsUsed.length,
        failed: event.summary.toolsUsed.filter((t) => !t.ok).length,
      });
      // Resolve any in-flight task for this project to its final status.
      // Boss can still override via update_task — this just gives it a sane
      // default so the user's overlay-driven dispatches close out cleanly.
      const taskId = this.inFlightTaskByProject.get(event.summary.project);
      finishedTaskId = taskId ?? null;
      if (taskId) {
        this.inFlightTaskByProject.delete(event.summary.project);
        const task = tasksStore.byId(taskId);
        if (task && task.status === "in_progress") {
          // Use the worker's SELF-REPORTED status from the trailer ("Status:
          // DONE | UNVERIFIED | PARTIAL | BLOCKED | INFO"). The previous
          // heuristic "any tool failed → blocked" was way too aggressive —
          // workers commonly have an incidental bash non-zero (grep with no
          // match, cd to wrong path) during exploration even when the task
          // itself was completed cleanly. Self-report is what the boss reads
          // anyway, so we should mark off the same signal.
          const reported = parseReportedStatus(event.summary.finalText);
          const newStatus = reportedToTaskStatus(
            reported,
            event.summary.toolsUsed.some((t) => !t.ok),
          );
          await tasksStore.update(taskId, {
            status: newStatus,
            resultSummary: event.summary.finalText,
          });
        }
      }
    }
    if (event.kind === "worker_error") {
      this.hadWorkerActivitySinceReady = true;
      this.stuckPushedAt.delete(event.project);
      log("ERROR", "worker_error", event.message, { project: event.project });
      const taskId = this.inFlightTaskByProject.get(event.project);
      if (taskId) {
        this.inFlightTaskByProject.delete(event.project);
        await tasksStore.update(taskId, {
          status: "blocked",
          notes: `Worker error: ${event.message}`,
        });
      }
    }
    if (event.kind === "worker_stuck") {
      log("WARN", "worker_stuck", `worker silent—pinging boss`, {
        project: event.project,
        reason: event.reason,
        silentSeconds: event.snapshot.silentSeconds,
        workingSeconds: event.snapshot.workingSeconds,
      });
      // No task-state mutation — the worker is still in-flight; we're just
      // notifying the boss so it can decide whether to peek/cancel/wait.
    }

    // Auto-compact when over 80% of context — mirrors AgentSession.runLoop.
    // Workers handle their own compaction independently (via AgentSession).
    await this.runCompaction(false);

    // Snapshot every worker's status at the moment the event arrives so the
    // boss reasons from live state, not from its memory of past dispatches.
    // Without this the boss can hallucinate "all idle" mid-batch — by event
    // 3 of 5 it has heard 3 completions and may assume the run is over even
    // though workers 4 and 5 are still active.
    const workerSnapshot = [...this.workers.entries()].map(([name, w]) => ({
      name,
      status: w.getStatus(),
    }));
    // Drain any auto-chain notices accumulated since the last event so the
    // boss is told explicitly which projects we re-dispatched on its behalf.
    const notices = this.pendingAutoChainNotices.splice(0);
    const text = formatEventForBoss(event, workerSnapshot, notices);
    bossStore.startStreaming();

    // Fresh AbortController for this turn so ESC can cancel just this call.
    this.turnAc = new AbortController();
    this.bossAgent.setSignal(this.turnAc.signal);

    try {
      const stream = this.bossAgent.prompt(text);
      for await (const e of stream) {
        switch (e.type) {
          case "text_delta":
            bossStore.appendStreamText(e.text);
            break;
          case "thinking_delta":
            bossStore.appendStreamThinking(e.text);
            break;
          case "tool_call_start":
            // Flush any preceding text so chronological order is preserved
            // in scrollback (text → tool → text → tool, not text-block then tool-block).
            bossStore.flushPendingText();
            bossStore.startTool(e.toolCallId, e.name, e.args);
            bossStore.setActivityPhase("tools");
            break;
          case "tool_call_end":
            bossStore.endTool(e.toolCallId, e.isError, e.durationMs, e.result, e.details);
            break;
          case "turn_end":
            // Mirror ggcoder/useAgentLoop: total context = uncached input +
            // cache reads + cache writes (Anthropic separates input/output,
            // others share the window so include output too). Without adding
            // cache, prompt-cached calls report a tiny inputTokens delta and
            // the footer bar appears stuck at 0%.
            if (e.usage) {
              bossStore.setBossInputTokens(computeContextUsed(e.usage, this.opts.bossProvider));
            }
            // Flush trailing text from this turn. Subsequent turns may add more.
            bossStore.flushPendingText();
            // Flush any tool-queued end-of-turn infos (e.g. add_task's
            // Ctrl+T hint) so they land AFTER the boss's tool calls, not
            // interleaved with them.
            bossStore.flushEndOfTurnInfos();
            break;
          case "retry":
            if (!e.silent) {
              bossStore.setRetryInfo({
                reason: e.reason,
                attempt: e.attempt,
                maxAttempts: e.maxAttempts,
                delayMs: e.delayMs,
              });
            }
            break;
          case "error":
            bossStore.appendInfo(formatProviderError(e.error), "error");
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        // Mirror ggcoder's onAborted: convert any in-flight tools to
        // "Stopped." entries so the user sees the same visual feedback.
        bossStore.interruptStreaming();
        if (!this.running) {
          bossStore.finishStreaming();
          return;
        }
        bossStore.finishStreaming();
        await this.persistNewMessages();
        // Was `continue` to skip post-stream cleanup. Now we're inside
        // runIteration() — `return` ends this iteration; the run() loop
        // picks up the next event on its own.
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "boss_turn", message);
      bossStore.appendInfo(formatProviderError(err), "error");
    }
    bossStore.finishStreaming();
    // Post-turn heap-pressure relief: truncate oversized tool_result blocks
    // in the boss's and every worker's message array BEFORE persisting, so
    // resumed sessions also start lean. Tail messages stay intact so the
    // model can reason over the most recent tool output. See
    // truncate-tool-results.ts for rationale.
    this.runPostTurnTruncation();
    await this.persistNewMessages();

    // Auto-chain: after the boss finishes processing a worker_turn_complete,
    // if it didn't dispatch anything for that project (worker is still idle)
    // AND there are more pending tasks for that project, fire the next one
    // automatically. The idle check arbitrates with the boss — if the boss
    // DID prompt_worker / dispatch_pending / re-prompt during its turn, the
    // worker is now "working", we skip. So this only kicks in when the boss
    // implicitly leaves the project parked.
    // Auto-chain ONLY fires when the just-finished event was itself a
    // dispatched task (had a taskId tracked in inFlightTaskByProject above).
    // Otherwise we'd hijack ad-hoc prompt_worker calls — e.g. recon prompts
    // — by dispatching pending backlog tasks the user never asked to run.
    if (event.kind === "worker_turn_complete" && finishedTaskId) {
      await this.maybeAutoChain(event.summary.project);
    }

    // All-clear chime — fires when the orchestrator winds down after a
    // burst of activity. Conditions: at least one worker event happened
    // since the last chime, every worker is now idle, and the queue is
    // drained (no more events queued for the boss). Resets the flag so
    // the next workflow gets its own chime.
    const allWorkersIdle = [...this.workers.values()].every((w) => w.getStatus() === "idle");
    if (this.hadWorkerActivitySinceReady && allWorkersIdle && this.queue.size() === 0) {
      this.hadWorkerActivitySinceReady = false;
      log("INFO", "all_clear", "all workers idle, queue empty");
      void playReadyAudio();
    }
  }

  private async maybeAutoChain(project: string): Promise<void> {
    const worker = this.workers.get(project);
    if (!worker || worker.getStatus() !== "idle") {
      log("DEBUG", "auto_chain", "skip — worker not idle", { project });
      return;
    }
    if (this.inFlightTaskByProject.has(project)) {
      log("DEBUG", "auto_chain", "skip — task already in flight", { project });
      return;
    }
    // Pull pending OR blocked — auto-chain retries blocked tasks too so a
    // single bad turn doesn't park the whole project. Pending is preferred.
    const next = tasksStore.nextDispatchable(project);
    if (!next) {
      log("DEBUG", "auto_chain", "skip — no dispatchable tasks", { project });
      return;
    }
    if (next.status === "blocked") {
      await tasksStore.update(next.id, { status: "pending", notes: undefined });
    }
    log("INFO", "auto_chain", "dispatching next task", {
      project,
      taskId: next.id,
      title: next.title,
      previousStatus: next.status,
    });
    await this.dispatchTaskByDescription(project, next.description, next.fresh === true, next.id);
    // Queue a note for the boss so it knows this project is on a fresh task.
    // Without this the boss sees "X(working)" in the next event's trailer and
    // dismisses it as stale.
    this.pendingAutoChainNotices.push({ project, title: next.title });
  }

  /**
   * Start the stuck-worker watchdog. Idempotent.
   *
   * Safety properties:
   *  - Pushes onto the same FIFO queue the boss already drains, so the boss
   *    never gets interrupted mid-turn — stuck pings are processed AFTER
   *    whatever it's currently doing.
   *  - Per-worker debounce (`stuckPushedAt`) prevents spam; a worker only
   *    gets re-flagged after it emits a new event AND stalls again, or after
   *    it completes/errors and stalls on a fresh turn.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      try {
        this.checkStuckWorkers();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "watchdog", "tick threw", { message });
      }
    }, WATCHDOG_INTERVAL_MS);
    // Don't keep the event loop alive just for this timer.
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private checkStuckWorkers(): void {
    for (const [name, worker] of this.workers) {
      const decision = decideStuckEvent({
        status: worker.getStatus(),
        activity: worker.getStatus() === "working" ? worker.getActivity() : null,
        lastPushedAt: this.stuckPushedAt.has(name)
          ? (this.stuckPushedAt.get(name) ?? null)
          : undefined,
        silentThresholdSec: SILENT_THRESHOLD_SEC,
        workingThresholdSec: WORKING_THRESHOLD_SEC,
      });

      if (decision.kind === "clear_debounce") {
        this.stuckPushedAt.delete(name);
        continue;
      }
      if (decision.kind === "skip") continue;

      // decision.kind === "push"
      this.stuckPushedAt.set(name, decision.lastEventAtMs);
      this.queue.push({
        kind: "worker_stuck",
        project: name,
        reason: decision.reason,
        snapshot: decision.snapshot,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async dispose(): Promise<void> {
    this.running = false;
    this.stopWatchdog();
    this.ac.abort();
    // Wake the queue if it's blocked on next() so the run loop can exit.
    this.queue.push({
      kind: "user_message",
      text: "[shutdown]",
      timestamp: new Date().toISOString(),
    });
    await Promise.all([...this.workers.values()].map((w) => w.dispose()));
  }
}

type ReportedStatus = "DONE" | "UNVERIFIED" | "PARTIAL" | "BLOCKED" | "INFO" | null;

/**
 * Pull the worker's self-reported "Status: X" line out of its final text. The
 * trailer is appended by every prompt via WORKER_PROMPT_BRIEF, so it should
 * always be there for task-style runs. Returns null if missing or unrecognised.
 */
export function parseReportedStatus(finalText: string): ReportedStatus {
  // Match the LAST "Status: X" line — workers occasionally mention statuses
  // mid-text and we want the trailer's value, not an example sentence.
  const matches = [
    ...finalText.matchAll(/^\s*Status:\s*(DONE|UNVERIFIED|PARTIAL|BLOCKED|INFO)\b/gim),
  ];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return last[1]!.toUpperCase() as ReportedStatus;
}

/**
 * Map worker self-report to the task plan's status enum. Falls back to the
 * tool-failure heuristic ONLY when the trailer is missing — that's the only
 * way to recover useful state for non-compliant workers.
 */
export function reportedToTaskStatus(
  reported: ReportedStatus,
  anyToolFailed: boolean,
): "done" | "blocked" | "in_progress" | "skipped" {
  if (reported === "DONE") return "done";
  if (reported === "INFO") return "done"; // question answered, nothing to retry
  if (reported === "BLOCKED") return "blocked";
  // UNVERIFIED / PARTIAL: keep the task as "in_progress" so the boss's next
  // re-prompt picks it up. Tasks-overlay shows it as the active row.
  if (reported === "UNVERIFIED" || reported === "PARTIAL") return "in_progress";
  // No trailer — last-resort heuristic.
  return anyToolFailed ? "blocked" : "done";
}

// ── Stuck-worker decision (pure, testable) ─────────────────────────────────────────
import type { WorkerActivity } from "./worker.js";
import type { WorkerStatus, WorkerStuckSnapshot } from "./types.js";

export interface StuckDecisionInput {
  status: WorkerStatus;
  activity: WorkerActivity | null;
  /**
   * Debounce state. `undefined` = no entry; `null` = entry exists but worker
   * had no events at push time; `number` = lastEventAtMs at push time.
   */
  lastPushedAt: number | null | undefined;
  silentThresholdSec: number;
  workingThresholdSec: number;
}

export type StuckDecision =
  | { kind: "skip" }
  | { kind: "clear_debounce" }
  | {
      kind: "push";
      reason: "silent" | "long_running";
      lastEventAtMs: number | null;
      snapshot: WorkerStuckSnapshot;
    };

/**
 * Pure decision: should we push a `worker_stuck` event for this worker?
 *
 * - Worker not `working` → clear any leftover debounce, then skip.
 * - Already debounced and worker hasn't emitted new activity since the push
 *   → skip (don't spam).
 * - Already debounced but worker emitted new activity since → fall through
 *   and re-evaluate against thresholds.
 * - Crosses silent OR long-running threshold → push.
 */
export function decideStuckEvent(input: StuckDecisionInput): StuckDecision {
  const { status, activity, lastPushedAt, silentThresholdSec, workingThresholdSec } = input;

  if (status !== "working" || !activity) {
    return lastPushedAt !== undefined ? { kind: "clear_debounce" } : { kind: "skip" };
  }

  // Already flagged — only re-flag once worker has emitted new activity since.
  if (lastPushedAt !== undefined) {
    const lastEvent = activity.lastEventAtMs;
    if (lastEvent === null || lastPushedAt === null || lastEvent <= lastPushedAt) {
      return { kind: "skip" };
    }
    // Worker resumed and stalled again — fall through to re-evaluate.
  }

  let reason: "silent" | "long_running" | null = null;
  if (activity.lastEventAtMs !== null && activity.silentSeconds >= silentThresholdSec) {
    reason = "silent";
  } else if (activity.workingSeconds >= workingThresholdSec) {
    reason = "long_running";
  }
  if (!reason) return { kind: "skip" };

  return {
    kind: "push",
    reason,
    lastEventAtMs: activity.lastEventAtMs,
    snapshot: {
      workingSeconds: activity.workingSeconds,
      silentSeconds: activity.silentSeconds,
      activeTools: activity.activeTools,
      completedTools: activity.completedTools,
      textTail: activity.textTail,
    },
  };
}

function formatEventForBoss(
  event: BossEvent,
  workerSnapshot: { name: string; status: string }[],
  autoChainNotices: { project: string; title: string }[],
): string {
  if (event.kind === "user_message") {
    return event.text;
  }
  // Live worker statuses, formatted as a single trailing line so the boss
  // always sees who's still running. Excludes the worker the event is FROM
  // (the boss can read that worker's outcome from the event body itself).
  const renderOthers = (excludeName: string): string => {
    const others = workerSnapshot
      .filter((w) => w.name !== excludeName)
      .map((w) => `${w.name}(${w.status})`)
      .join(" ");
    return others.length > 0 ? `\nother_workers: ${others}` : "";
  };

  // Auto-chain trailer — explicit per-project list so the boss can't dismiss
  // the trailer's "(working)" entries as stale.
  const renderAutoChain = (): string => {
    if (autoChainNotices.length === 0) return "";
    const lines = autoChainNotices.map((n) => `  - ${n.project}: "${n.title}"`);
    return `\nauto_dispatched_since_last_event:\n${lines.join("\n")}`;
  };

  if (event.kind === "worker_turn_complete") {
    const s = event.summary;
    const tools =
      s.toolsUsed.length > 0
        ? s.toolsUsed.map((t) => `${t.ok ? "✓" : "✗"}${t.name}`).join(", ")
        : "(none)";
    return `[event:worker_turn_complete] project="${s.project}" turn=${s.turnIndex} timestamp=${s.timestamp}
tools_used: ${tools}
final_text:
${s.finalText || "(empty)"}${renderOthers(s.project)}${renderAutoChain()}`;
  }
  if (event.kind === "worker_error") {
    return `[event:worker_error] project="${event.project}" timestamp=${event.timestamp}
${event.message}${renderOthers(event.project)}${renderAutoChain()}`;
  }
  // worker_stuck — informational ping, queued; boss decides whether to act.
  const s = event.snapshot;
  const completed =
    s.completedTools.length > 0
      ? s.completedTools.map((t) => `${t.ok ? "✓" : "✗"}${t.name}`).join(", ")
      : "(none)";
  const active = s.activeTools.length > 0 ? s.activeTools.join(", ") : "(none)";
  return `[event:worker_stuck] project="${event.project}" reason=${event.reason} timestamp=${event.timestamp}
working_seconds: ${s.workingSeconds}
silent_seconds: ${s.silentSeconds}
active_tools: ${active}
completed_this_turn: ${completed}
text_tail:
${s.textTail || "(no text yet)"}${renderOthers(event.project)}${renderAutoChain()}`;
}

/**
 * Total context used in tokens. Mirrors ggcoder/useAgentLoop: Anthropic counts
 * uncached input + cache reads/writes (output is metered separately); other
 * providers share a single window so output counts too.
 */
function computeContextUsed(usage: Usage, provider: Provider): number {
  const inputContext = (usage.inputTokens ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return provider === "anthropic" ? inputContext : inputContext + (usage.outputTokens ?? 0);
}

/**
 * Map raw provider error text to a human-friendly hint. Mirrors ggcoder's
 * pattern in App.tsx so users see the same diagnostic phrasing.
 */
function formatProviderError(err: unknown): string {
  const formatted = formatError(err);
  const message = formatted.message || (err instanceof Error ? err.message : String(err));
  const lines = [formatted.headline];
  if (message && message !== formatted.headline) lines.push(message);
  lines.push(`Hint: ${formatted.guidance}`);
  if (formatted.requestId) lines.push(`Request ID: ${formatted.requestId}`);
  return lines.join("\n");
}
