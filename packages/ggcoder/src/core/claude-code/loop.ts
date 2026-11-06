import {
  query as sdkQuery,
  type Options as SdkOptions,
  type Query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Message, UserMessage } from "@kenkaiiii/gg-ai";
import type { AgentEvent, AgentOptions, AgentResult } from "@kenkaiiii/gg-agent";
import { recordClaudeCodeRateLimit } from "@kenkaiiii/gg-core";
import {
  SdkMessageMapper,
  effortForThinking,
  renderTranscript,
  toSdkUserContent,
  toSdkUserMessage,
} from "./events.js";
import type { ClaudeCodeProcess } from "./complete.js";
import { CLAUDE_CODE_MCP_SERVER, createToolBridge } from "./tool-bridge.js";

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
}

const DEFAULT_MAX_SEED_CHARS = 400_000;
/** How long `interrupt()` gets before the process is killed outright. */
const INTERRUPT_GRACE_MS = 5_000;
const INTERRUPTED_NOTE = "Interrupted by the user before this tool call finished.";
const STDERR_TAIL_CHARS = 4_000;

type Item =
  | { kind: "sdk"; message: SDKMessage }
  | { kind: "event"; event: AgentEvent }
  | { kind: "end" }
  | { kind: "error"; error: unknown }
  | { kind: "wake" };

class Channel<T> {
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
function splitPending(messages: readonly Message[]): { prior: Message[]; pending: UserMessage[] } {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role === "user") start--;
  return {
    prior: messages.slice(0, start),
    pending: messages.slice(start) as UserMessage[],
  };
}

/** `options.system`, else the system message(s) at the head of the history (AgentSession's shape). */
function systemPrompt(messages: readonly Message[], system: string | undefined): string {
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
 * `agentLoop` for a Claude subscription: Claude Code runs the model loop with
 * our system prompt and our tools (bridged over in-process MCP). Assistant and
 * tool-result messages are appended to `messages` in our format.
 */
export async function* claudeCodeLoop(
  messages: Message[],
  options: ClaudeCodeLoopOptions,
): AsyncGenerator<AgentEvent, AgentResult> {
  const cc = options.claudeCode;
  const channel = new Channel<Item>();
  const input = new Channel<SDKUserMessage>();
  let endRun = false;
  let aborted = !!options.signal?.aborted;
  let stderrTail = "";

  const bridge = createToolBridge({
    tools: options.tools ?? [],
    resolveTool: options.resolveTool,
    signal: options.signal,
    maxToolResultChars: options.maxToolResultChars,
    transformToolResult: options.transformToolResult,
    onEvent: (event) => channel.push({ kind: "event", event }),
    onEndRun: () => {
      endRun = true;
    },
  });
  const mapper = new SdkMessageMapper({
    messages,
    takeResult: (id) => bridge.takeResult(id),
    onSessionId: cc.onSessionId,
    onRateLimit: (info) => {
      // Shared with every GG process so the usage meter shows the subscription's windows.
      void recordClaudeCodeRateLimit(info);
      cc.onRateLimit?.(info);
    },
  });

  // Steering sent to Claude Code but not yet placed in our transcript.
  let unplaced: Message[] = [];
  const sendUser = (message: Message) => {
    input.push(toSdkUserMessage(toSdkUserContent(message.content as UserMessage["content"])));
  };
  const placeSteering = function* (): Generator<AgentEvent> {
    for (const message of unplaced) {
      messages.push(message);
      yield { type: "steering_message", content: message.content };
    }
    unplaced = [];
  };
  const drainSteering = async (): Promise<boolean> => {
    const steering = (await options.getSteeringMessages?.()) ?? [];
    for (const message of steering) {
      sendUser(message);
      unplaced.push(message);
    }
    return steering.length > 0;
  };

  const { prior, pending } = splitPending(messages);
  const first = pending.flatMap((m) => toSdkUserContent(m.content));
  if (!cc.resume && prior.some((m) => m.role !== "system")) {
    const seed = cc.seedText ?? renderTranscript(prior, cc.maxSeedChars ?? DEFAULT_MAX_SEED_CHARS);
    first.unshift({ type: "text", text: seed });
  }
  if (first.length === 0) first.push({ type: "text", text: "Continue." });
  input.push(toSdkUserMessage(first));

  const abortController = new AbortController();
  const effort = effortForThinking(options.thinking);
  const sdkOptions: SdkOptions = {
    cwd: cc.cwd,
    model: options.model,
    systemPrompt: { type: "custom", prompt: systemPrompt(messages, options.system) },
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [CLAUDE_CODE_MCP_SERVER]: bridge.config },
    allowedTools: bridge.allowedTools(),
    // Tools promoted mid-run are not in allowedTools; ours are always fine,
    // anything else stays off.
    canUseTool: async (toolName, toolInput) =>
      toolName.startsWith(`mcp__${CLAUDE_CODE_MCP_SERVER}__`)
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: `${toolName} is not available in GG Coder.` },
    includePartialMessages: true,
    pathToClaudeCodeExecutable: cc.executable,
    env: cc.env,
    abortController,
    stderr: (data) => {
      stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
    },
    ...(cc.resume ? { resume: cc.resume } : {}),
    ...(cc.title && !cc.resume ? { title: cc.title } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(effort
      ? { thinking: { type: "adaptive" as const }, effort }
      : { thinking: { type: "disabled" as const } }),
  };

  const q = (cc.query ?? sdkQuery)({ prompt: input, options: sdkOptions });
  void (async () => {
    try {
      for await (const message of q) channel.push({ kind: "sdk", message });
      channel.push({ kind: "end" });
    } catch (error) {
      channel.push({ kind: "error", error });
    }
  })();

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    aborted = true;
    input.end();
    q.interrupt().catch(() => {});
    killTimer = setTimeout(() => abortController.abort(), INTERRUPT_GRACE_MS);
    channel.push({ kind: "wake" });
  };
  if (aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const unsubscribeSteering = options.onSteeringAvailable?.(() => {
    void drainSteering();
  });

  let hitMaxTurns = false;
  try {
    loop: for await (const item of channel) {
      switch (item.kind) {
        case "wake":
          continue;
        case "event":
          if (!aborted) yield item.event;
          continue;
        case "end":
          break loop;
        case "error":
          if (aborted || isAbortLike(item.error)) break loop;
          throw item.error instanceof Error ? item.error : new Error(String(item.error));
        case "sdk":
          break;
      }
      const message = item.message;
      // After Stop, keep the transcript in step with Claude Code until it
      // reports the interrupted result, but stop emitting.
      if (aborted) {
        if (message.type === "result") break;
        mapper.handle(message);
        continue;
      }
      if (message.type !== "result") {
        for (const event of mapper.handle(message)) {
          yield event;
          if (event.type === "checkpoint") {
            await drainSteering();
            yield* placeSteering();
          } else if (event.type === "turn_end" && event.stopReason !== "tool_use") {
            yield* placeSteering();
          }
        }
        continue;
      }

      if (message.subtype === "error_max_turns") {
        hitMaxTurns = true;
        break;
      }
      if (message.subtype !== "success") {
        const detail = message.errors.join("\n") || mapper.syntheticError || stderrTail.trim();
        throw new Error(detail || `Claude Code stopped: ${message.subtype}`);
      }
      if (message.is_error) {
        throw new Error(message.result || mapper.syntheticError || "Claude Code request failed.");
      }
      if (endRun) break;
      // Claude Code may still hold steering it has not answered yet.
      if (unplaced.length > 0) {
        yield* placeSteering();
        continue;
      }
      if (await drainSteering()) {
        yield* placeSteering();
        continue;
      }
      const followUps = (await options.getFollowUpMessages?.()) ?? [];
      if (followUps.length > 0) {
        for (const followUp of followUps) {
          sendUser(followUp);
          messages.push(followUp);
          yield { type: "follow_up_message", content: followUp.content };
        }
        continue;
      }
      break;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribeSteering?.();
    input.end();
    channel.end();
    if (killTimer) clearTimeout(killTimer);
    q.close();
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
