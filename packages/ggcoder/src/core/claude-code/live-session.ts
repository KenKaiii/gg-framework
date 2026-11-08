import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  type EffortLevel,
  type Options as SdkOptions,
  type Query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Message, ThinkingLevel, UserMessage } from "@kenkaiiii/gg-ai";
import type { AgentEvent, AgentOptions, AgentResult } from "@kenkaiiii/gg-agent";
import { log, recordClaudeCodeRateLimit } from "@kenkaiiii/gg-core";
import {
  SdkMessageMapper,
  effortForThinking,
  renderTranscript,
  toSdkUserContent,
  toSdkUserMessage,
} from "./events.js";
import type { ClaudeCodeProcess } from "./complete.js";
import {
  CLAUDE_CODE_MCP_SERVER,
  createToolBridge,
  type ToolBridge,
  type ToolBridgeOptions,
} from "./tool-bridge.js";

export type ClaudeCodeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: SdkOptions;
}) => Query;

export interface ClaudeCodeSessionOptions extends ClaudeCodeProcess {
  /** Claude Code session to continue. Without it, prior history is sent as text. */
  resume?: string;
  /** Replaces the rendered transcript when seeding a fresh session (e.g. a summary). */
  seedText?: string;
  /** Character cap for the rendered transcript seed. */
  maxSeedChars?: number;
  title?: string;
  onSessionId?: (sessionId: string) => void;
  onRateLimit?: (info: SDKRateLimitInfo) => void;
}

export interface ClaudeCodeLoopOptions extends AgentOptions {
  claudeCode: ClaudeCodeSessionOptions;
  /** Steering the model already read (in an ask_user result): record it, don't send it again. */
  steeringAlreadyRead?: (message: Message) => boolean;
}

export interface ClaudeCodeLiveSessionOptions {
  /** Close the process after this long without a run (default 15 minutes). */
  idleMs?: number;
  /** How long Stop waits for the interrupted result before closing the process (default 5s). */
  interruptGraceMs?: number;
}

const DEFAULT_MAX_SEED_CHARS = 400_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const INTERRUPTED_NOTE = "Interrupted by the user before this tool call finished.";
const STDERR_TAIL_CHARS = 4_000;
/** A wedged process must not hold up the next message; it gets restarted instead. */
const EFFORT_CHANGE_TIMEOUT_MS = 5_000;
/** Output that means Claude Code ran a turn we never asked for. */
const IDLE_DRIFT_TYPES = new Set<string>(["assistant", "user", "stream_event", "result"]);

type Item =
  | { kind: "sdk"; message: SDKMessage }
  | { kind: "event"; event: AgentEvent }
  | { kind: "end" }
  | { kind: "error"; error: unknown }
  | { kind: "wake" };

export class Channel<T> {
  private items: T[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.waiter?.();
  }

  end(): void {
    this.closed = true;
    this.waiter?.();
  }

  /** Items pushed but not yet read. */
  takeRest(): T[] {
    return this.items.splice(0);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }
}

/** Trailing user messages: what this run adds on top of the session's history. */
export function splitPending(messages: readonly Message[]): {
  prior: Message[];
  pending: UserMessage[];
} {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === "user") start--;
  return {
    prior: messages.slice(0, start),
    pending: messages.slice(start) as UserMessage[],
  };
}

/** `options.system`, else the system message(s) at the head of the history (AgentSession's shape). */
export function systemPrompt(messages: readonly Message[], system: string | undefined): string {
  if (system !== undefined) return system;
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content as string)
    .join("\n\n");
}

function isAbortLike(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /abort/i.test(msg) || (err instanceof Error && err.name === "AbortError");
}

/**
 * One Claude Code process kept alive across runs (the SDK's streaming-input
 * mode): each run sends only its new user messages into the same query, so
 * later messages skip the process start, session reload and tool handshake.
 * The process starts with the first run's settings; the caller restarts it
 * (a new instance) when those change.
 */
export class ClaudeCodeLiveSession {
  private q: Query | undefined;
  private readonly input = new Channel<SDKUserMessage>();
  private bridge: ToolBridge | undefined;
  /** The active run's queue; undefined while idle. */
  private sink: Channel<Item> | undefined;
  private closedReason: string | undefined;
  private running = false;
  private runs = 0;
  private effort: EffortLevel | undefined;
  private stderrTail = "";
  private claudeSessionId: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleMs: number;
  private readonly interruptGraceMs: number;

  constructor(options: ClaudeCodeLiveSessionOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  }

  /** Started and not closed: the next run can reuse it. */
  get alive(): boolean {
    return this.q !== undefined && this.closedReason === undefined;
  }

  /** A run is in progress. */
  get busy(): boolean {
    return this.running;
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** The Claude Code session this process holds, once reported. */
  get sessionId(): string | undefined {
    return this.claudeSessionId;
  }

  /** Move to another effort level without a restart; false when that isn't possible. */
  async setEffort(thinking: ThinkingLevel | undefined): Promise<boolean> {
    const effort = effortForThinking(thinking);
    if (effort === this.effort) return true;
    if (!this.alive || effort === undefined || this.effort === undefined) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const applied = await Promise.race([
        this.q!.applyFlagSettings({ effortLevel: effort }).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), EFFORT_CHANGE_TIMEOUT_MS);
        }),
      ]);
      if (applied) this.effort = effort;
      return applied;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(reason = "closed"): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.clearIdleTimer();
    this.input.end();
    if (this.q) {
      this.q.close();
      log("INFO", "claude-code", "process closed", { reason, runs: this.runs });
    }
    this.sink?.push({ kind: "end" });
  }

  /**
   * `agentLoop` for a Claude subscription: Claude Code runs the model loop with
   * our system prompt and our tools (bridged over in-process MCP). Assistant and
   * tool-result messages are appended to `messages` in our format.
   */
  async *run(
    messages: Message[],
    options: ClaudeCodeLoopOptions,
  ): AsyncGenerator<AgentEvent, AgentResult> {
    if (this.closedReason !== undefined) throw new Error("This Claude Code process is closed.");
    if (this.running) throw new Error("A Claude Code run is already in progress.");
    this.running = true;
    this.clearIdleTimer();
    const cc = options.claudeCode;
    const channel = new Channel<Item>();
    let endRun = false;
    let aborted = !!options.signal?.aborted;
    // Why the process can't serve another run; cleared once the run ends cleanly at a result.
    let closeReason: string | undefined = "run did not finish";

    const bridgeOptions: Omit<ToolBridgeOptions, "relistWaitMs"> = {
      tools: options.tools ?? [],
      resolveTool: options.resolveTool,
      signal: options.signal,
      maxToolResultChars: options.maxToolResultChars,
      transformToolResult: options.transformToolResult,
      onEvent: (event) => channel.push({ kind: "event", event }),
      onEndRun: () => {
        endRun = true;
      },
    };
    const fresh = this.q === undefined;
    if (this.bridge) this.bridge.update(bridgeOptions);
    else this.bridge = createToolBridge(bridgeOptions);
    const bridge = this.bridge;
    const mapper = new SdkMessageMapper({
      messages,
      takeResult: (id) => bridge.takeResult(id),
      onSessionId: (id) => {
        this.claudeSessionId = id;
        cc.onSessionId?.(id);
      },
      onRateLimit: (info) => {
        // Shared with every GG process so the usage meter shows the subscription's windows.
        void recordClaudeCodeRateLimit(info);
        cc.onRateLimit?.(info);
      },
    });

    // Steering not yet placed in our transcript, and how many of those went to Claude Code.
    let unplaced: Message[] = [];
    let unplacedSent = 0;
    // Sends Claude Code hasn't answered yet: each result lists the uuids it consumed.
    // A send that misses the running turn gets a turn (and result) of its own.
    const unanswered = new Set<string>();
    const push = (message: SDKUserMessage) => {
      const uuid = randomUUID();
      unanswered.add(uuid);
      this.input.push({ ...message, uuid } as SDKUserMessage);
    };
    const sendUser = (message: Message) => {
      push(toSdkUserMessage(toSdkUserContent(message.content as UserMessage["content"])));
    };
    const placeSteering = function* (): Generator<AgentEvent> {
      for (const message of unplaced) {
        messages.push(message);
        yield { type: "steering_message", content: message.content };
      }
      unplaced = [];
      unplacedSent = 0;
    };
    /** Takes queued steering; returns how many messages went to Claude Code. */
    const drainSteering = async (): Promise<number> => {
      // Handed off (e.g. a submitted plan): queued messages stay queued for the next run.
      if (endRun) return 0;
      const steering = (await options.getSteeringMessages?.()) ?? [];
      let sent = 0;
      for (const message of steering) {
        unplaced.push(message);
        if (options.steeringAlreadyRead?.(message)) continue;
        sendUser(message);
        unplacedSent++;
        sent++;
      }
      return sent;
    };

    const { prior, pending } = splitPending(messages);
    const first = pending.flatMap((m) => toSdkUserContent(m.content));
    if (fresh && !cc.resume && prior.some((m) => m.role !== "system")) {
      const seed =
        cc.seedText ?? renderTranscript(prior, cc.maxSeedChars ?? DEFAULT_MAX_SEED_CHARS);
      first.unshift({ type: "text", text: seed });
    }
    if (first.length === 0) first.push({ type: "text", text: "Continue." });

    this.runs++;
    this.sink = channel;
    if (fresh) {
      this.start(messages, options);
    } else {
      log("INFO", "claude-code", "process reused", { run: this.runs });
      if (this.claudeSessionId) cc.onSessionId?.(this.claudeSessionId);
      // Tools promoted since the last run (MCP connect, exit_plan) must be listed before the prompt.
      await bridge.syncToolList();
    }
    const q = this.q!;
    push(toSdkUserMessage(first));

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimedOut = false;
    let queuedAfterStop = false;
    const onAbort = () => {
      aborted = true;
      q.interrupt()
        .then((receipt) => {
          // Claude Code would still run these after the interrupt, out of our sight.
          if (receipt?.still_queued?.length) queuedAfterStop = true;
        })
        .catch(() => {});
      graceTimer = setTimeout(() => {
        stopTimedOut = true;
        channel.push({ kind: "wake" });
      }, this.interruptGraceMs);
      channel.push({ kind: "wake" });
    };
    if (aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    // Take the queued message on the next tick, not inside the call that queued
    // it: the caller first reports the message as queued, and the app only drops
    // a bubble's "Queued" label once it has seen the message pending.
    // Cancelled when the run ends, so a late drain can't take a message off the
    // session queue after nothing is left to deliver it (it stays for the next run).
    let steeringTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribeSteering = options.onSteeringAvailable?.(() => {
      steeringTimer ??= setTimeout(() => {
        steeringTimer = undefined;
        // After the message is in Claude Code's queue, so it folds in with the cut-short result.
        void drainSteering().then(() => {
          if (unplaced.length > 0) bridge.preempt();
        });
      }, 0);
    });

    let hitMaxTurns = false;
    try {
      loop: for await (const item of channel) {
        switch (item.kind) {
          case "wake":
            if (stopTimedOut) {
              closeReason = "interrupt timed out";
              break loop;
            }
            continue;
          case "event":
            if (!aborted) yield item.event;
            continue;
          case "end":
            closeReason = this.closedReason ?? "process ended";
            break loop;
          case "error":
            closeReason = "process failed";
            if (aborted || isAbortLike(item.error)) break loop;
            throw item.error instanceof Error ? item.error : new Error(String(item.error));
          case "sdk":
            break;
        }
        const message = item.message;
        // After Stop, keep the transcript in step with Claude Code until it
        // reports the interrupted result, but stop emitting.
        if (aborted) {
          if (message.type === "result") {
            closeReason =
              unplaced.length > 0 || queuedAfterStop ? "stopped with input pending" : undefined;
            break;
          }
          mapper.handle(message);
          continue;
        }
        if (message.type !== "result") {
          for (const event of mapper.handle(message)) {
            yield event;
            if (event.type === "checkpoint") {
              // Claude Code runs its own model loop and would answer this result,
              // so a hand-off (submitted plan) has to stop it here, not at `result`.
              // The process saw the result we cut off, so it can't serve the next run.
              if (endRun) {
                closeReason = "hand-off";
                yield* placeSteering();
                break loop;
              }
              await drainSteering();
              yield* placeSteering();
            } else if (event.type === "turn_end" && event.stopReason !== "tool_use") {
              yield* placeSteering();
            }
          }
          continue;
        }

        if (message.subtype === "error_max_turns") {
          closeReason = "max turns";
          hitMaxTurns = true;
          break;
        }
        if (message.subtype !== "success") {
          closeReason = "error result";
          const detail =
            message.errors.join("\n") || mapper.syntheticError || this.stderrTail.trim();
          throw new Error(detail || `Claude Code stopped: ${message.subtype}`);
        }
        if (message.is_error) {
          closeReason = "error result";
          throw new Error(message.result || mapper.syntheticError || "Claude Code request failed.");
        }
        if (endRun) {
          closeReason = "hand-off";
          yield* placeSteering();
          break;
        }
        // Claude Code still owes a turn for a send queued behind this result.
        // (`queued_turn_count` reads 0 even then, so it can't be trusted.)
        const consumed =
          message.user_message_uuids ??
          (message.user_message_uuid ? [message.user_message_uuid] : undefined);
        let owed: boolean;
        if (consumed) {
          for (const uuid of consumed) unanswered.delete(uuid);
          owed = unanswered.size > 0;
        } else {
          // Older CLIs don't echo uuids; then only unplaced sent steering says so.
          unanswered.clear();
          owed = unplacedSent > 0;
        }
        if (owed) {
          yield* placeSteering();
          continue;
        }
        const sent = await drainSteering();
        yield* placeSteering();
        if (sent > 0) continue;
        const followUps = (await options.getFollowUpMessages?.()) ?? [];
        if (followUps.length > 0) {
          for (const followUp of followUps) {
            sendUser(followUp);
            messages.push(followUp);
            yield { type: "follow_up_message", content: followUp.content };
          }
          continue;
        }
        closeReason = undefined;
        break;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribeSteering?.();
      if (steeringTimer) clearTimeout(steeringTimer);
      if (graceTimer) clearTimeout(graceTimer);
      this.sink = undefined;
      channel.end();
      this.running = false;
      if (closeReason !== undefined) this.close(closeReason);
      else {
        this.armIdleTimer();
        // Output that raced the run's end (an exit right after `result`) is judged as idle output.
        for (const item of channel.takeRest()) if (item.kind !== "event") this.deliver(item);
      }
    }

    if (aborted) {
      mapper.pairDanglingToolCalls(INTERRUPTED_NOTE);
      unplaced.forEach((m) => messages.push(m));
    }
    if (hitMaxTurns) {
      yield { type: "max_turns", totalTurns: mapper.turn, maxTurns: options.maxTurns ?? 0 };
    }
    yield { type: "agent_done", totalTurns: mapper.turn, totalUsage: { ...mapper.totalUsage } };
    const message: AssistantMessage = mapper.lastAssistant ?? { role: "assistant", content: [] };
    return { message, totalTurns: mapper.turn, totalUsage: { ...mapper.totalUsage } };
  }

  private start(messages: readonly Message[], options: ClaudeCodeLoopOptions): void {
    const cc = options.claudeCode;
    const bridge = this.bridge!;
    this.effort = effortForThinking(options.thinking);
    const sdkOptions: SdkOptions = {
      cwd: cc.cwd,
      model: options.model,
      systemPrompt: { type: "custom", prompt: systemPrompt(messages, options.system) },
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { [CLAUDE_CODE_MCP_SERVER]: bridge.config },
      // No allowedTools: an entry there skips this check (the SDK warns about it).
      // Ours are allowed, including tools promoted mid-run; anything else stays off.
      canUseTool: async (toolName, toolInput) =>
        toolName.startsWith(`mcp__${CLAUDE_CODE_MCP_SERVER}__`)
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: `${toolName} is not available in GG Coder.` },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: cc.executable,
      env: cc.env,
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
      ...(cc.resume ? { resume: cc.resume } : {}),
      ...(cc.title && !cc.resume ? { title: cc.title } : {}),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(this.effort
        ? { thinking: { type: "adaptive" as const }, effort: this.effort }
        : { thinking: { type: "disabled" as const } }),
    };
    const q = (cc.query ?? sdkQuery)({ prompt: this.input, options: sdkOptions });
    this.q = q;
    log("INFO", "claude-code", "process started", {
      model: options.model,
      resume: cc.resume ? "yes" : "no",
    });
    void (async () => {
      try {
        for await (const message of q) this.deliver({ kind: "sdk", message });
        this.deliver({ kind: "end" });
      } catch (error) {
        this.deliver({ kind: "error", error });
      }
    })();
  }

  /** Route SDK output to the active run; while idle, anything but bookkeeping ends the process. */
  private deliver(item: Item): void {
    if (this.sink) {
      this.sink.push(item);
      return;
    }
    if (item.kind === "end") this.close("process ended");
    else if (item.kind === "error") this.close("process failed");
    else if (item.kind === "sdk") {
      const message = item.message;
      if (message.type === "rate_limit_event") {
        void recordClaudeCodeRateLimit(message.rate_limit_info);
      } else if (IDLE_DRIFT_TYPES.has(message.type)) {
        // Claude Code's history would no longer match ours.
        this.close("output while idle");
      }
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closedReason !== undefined) return;
    this.idleTimer = setTimeout(() => this.close("idle"), this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
