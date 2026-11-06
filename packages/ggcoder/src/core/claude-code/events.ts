import type {
  AssistantMessage,
  ContentPart,
  Message,
  StopReason,
  ThinkingLevel,
  ToolCall,
  ToolResult,
  ToolResultContent,
  Usage,
  UserMessage,
} from "@kenkaiiii/gg-ai";
import type { AgentEvent, AgentRetryEvent } from "@kenkaiiii/gg-agent";
import type { SDKMessage, SDKRateLimitInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { stripClaudeCodeToolPrefix } from "./tool-bridge.js";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
type Block = Record<string, unknown> & { type?: string };
type UserBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

/** Claude Code tops out at `max`; our `ultra` rung means "as much as possible". */
export function effortForThinking(level: ThinkingLevel | undefined): EffortLevel | undefined {
  if (!level) return undefined;
  return level === "ultra" ? "max" : level;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const usage: Usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  const reasoning = num(
    (u.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
  );
  if (reasoning) usage.reasoningTokens = reasoning;
  if (num(u.cache_read_input_tokens)) usage.cacheRead = num(u.cache_read_input_tokens);
  if (num(u.cache_creation_input_tokens)) usage.cacheWrite = num(u.cache_creation_input_tokens);
  const server = u.server_tool_use as Record<string, unknown> | undefined;
  if (num(server?.web_search_requests) || num(server?.web_fetch_requests)) {
    usage.serverToolUse = {
      webSearchRequests: num(server?.web_search_requests),
      webFetchRequests: num(server?.web_fetch_requests),
    };
  }
  return usage;
}

export function addUsage(total: Usage, usage: Usage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (usage.reasoningTokens)
    total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens;
  if (usage.cacheRead) total.cacheRead = (total.cacheRead ?? 0) + usage.cacheRead;
  if (usage.cacheWrite) total.cacheWrite = (total.cacheWrite ?? 0) + usage.cacheWrite;
  if (usage.serverToolUse) {
    const s = (total.serverToolUse ??= {});
    s.webSearchRequests = (s.webSearchRequests ?? 0) + (usage.serverToolUse.webSearchRequests ?? 0);
    s.webFetchRequests = (s.webFetchRequests ?? 0) + (usage.serverToolUse.webFetchRequests ?? 0);
  }
}

const STOP_REASONS = new Set<StopReason>([
  "end_turn",
  "tool_use",
  "max_tokens",
  "pause_turn",
  "stop_sequence",
  "refusal",
]);

export function toStopReason(raw: unknown): StopReason {
  return typeof raw === "string" && STOP_REASONS.has(raw as StopReason)
    ? (raw as StopReason)
    : "end_turn";
}

export function fromSdkContentBlock(block: Block): ContentPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") };
    case "thinking":
      return {
        type: "thinking",
        text: String(block.thinking ?? ""),
        ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      };
    case "tool_use":
      return {
        type: "tool_call",
        id: String(block.id),
        name: stripClaudeCodeToolPrefix(String(block.name)),
        args: (block.input ?? {}) as Record<string, unknown>,
      };
    case "server_tool_use":
      return {
        type: "server_tool_call",
        id: String(block.id),
        name: String(block.name),
        input: block.input,
      };
    default:
      if (typeof block.tool_use_id === "string") {
        return {
          type: "server_tool_result",
          toolUseId: block.tool_use_id,
          resultType: String(block.type),
          data: block,
        };
      }
      return { type: "raw", data: block, origin: "claude-code" };
  }
}

/** A tool result Claude Code produced itself (the call never reached our bridge). */
export function fromSdkToolResult(block: Block): ToolResult {
  const raw = block.content;
  let content: ToolResultContent;
  if (typeof raw === "string") content = raw;
  else if (Array.isArray(raw)) {
    content = (raw as Block[]).map((part) =>
      part.type === "image" && part.source && typeof part.source === "object"
        ? {
            type: "image" as const,
            mediaType: String((part.source as Block).media_type ?? "image/png"),
            data: String((part.source as Block).data ?? ""),
          }
        : { type: "text" as const, text: String(part.text ?? "") },
    );
  } else content = "";
  return {
    type: "tool_result",
    toolCallId: String(block.tool_use_id),
    content,
    ...(block.is_error ? { isError: true } : {}),
  };
}

export function resultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

/** Text parts of a reply, one per line. */
export function assistantText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function toSdkUserContent(content: UserMessage["content"]): UserBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): UserBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType as "image/png",
          data: part.data,
        },
      };
    }
    return { type: "text", text: `[${part.type} attachment omitted: not supported here]` };
  });
}

export function toSdkUserMessage(content: UserBlock[]): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  const lines: string[] = [];
  for (const part of message.content as (ContentPart | ToolResult)[]) {
    switch (part.type) {
      case "text":
        lines.push(part.text);
        break;
      case "tool_call":
        lines.push(`[called ${part.name} ${JSON.stringify(part.args)}]`);
        break;
      case "tool_result":
        lines.push(`[${part.isError ? "error" : "result"}] ${resultText(part.content)}`);
        break;
      case "image":
      case "video":
        lines.push(`[${part.type}]`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

const ROLE_LABEL: Record<Message["role"], string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/**
 * Our history as one text block, for a fresh Claude Code session that never
 * saw it. Keeps the newest messages when over `maxChars`.
 */
export function renderTranscript(messages: readonly Message[], maxChars: number): string {
  const entries: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "system") continue;
    const text = messageText(message).trim();
    if (!text) continue;
    const entry = `${ROLE_LABEL[message.role]}: ${text}`;
    if (used + entry.length > maxChars) {
      dropped = i + 1;
      break;
    }
    entries.unshift(entry);
    used += entry.length + 2;
  }
  const head = dropped > 0 ? `[${dropped} earlier messages omitted]\n\n` : "";
  return (
    "<conversation_so_far>\nThis conversation started before this session. " +
    "Earlier messages, oldest first:\n\n" +
    head +
    entries.join("\n\n") +
    "\n</conversation_so_far>"
  );
}

export interface SdkMessageMapperOptions {
  /** Live transcript; assistant and tool-result messages are appended to it. */
  messages: Message[];
  /** The bridge's copy of a result (capped exactly as the model saw it). */
  takeResult: (toolCallId: string) => ToolResult | undefined;
  onSessionId?: (sessionId: string) => void;
  onRateLimit?: (info: SDKRateLimitInfo) => void;
  now?: () => number;
}

const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Turns the SDK's message stream into our events and transcript. Stateful:
 * one instance per run. `result` messages are left to the loop.
 */
export class SdkMessageMapper {
  turn = 0;
  readonly totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  lastAssistant: AssistantMessage | undefined;
  /** Text of Claude Code's own error message (e.g. "API Error: …"), if any. */
  syntheticError: string | undefined;
  private current: { id: string; message: AssistantMessage } | undefined;
  private turnStartedAt: number | undefined;
  private firstEventAt: number | undefined;
  private stopReason: StopReason = "end_turn";
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private readonly now: () => number;

  constructor(private readonly options: SdkMessageMapperOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Tool calls of the latest assistant message that have no result yet. */
  unpairedToolCalls(): ToolCall[] {
    const last = this.options.messages.at(-1);
    if (last?.role !== "assistant" || typeof last.content === "string") return [];
    return last.content.filter((p): p is ToolCall => p.type === "tool_call");
  }

  handle(msg: SDKMessage): AgentEvent[] {
    if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return [];
    switch (msg.type) {
      case "system":
        return this.handleSystem(msg as unknown as Block);
      case "stream_event":
        return this.handleStreamEvent(msg.event as unknown as Block);
      case "assistant":
        return this.handleAssistant(msg.message as unknown as Block);
      case "user":
        return this.handleUser(msg.message.content);
      case "rate_limit_event":
        this.options.onRateLimit?.(msg.rate_limit_info);
        return [];
      default:
        return [];
    }
  }

  private handleSystem(msg: Block): AgentEvent[] {
    if (msg.subtype === "init" && typeof msg.session_id === "string") {
      this.options.onSessionId?.(msg.session_id);
    } else if (msg.subtype === "status" && msg.status === "requesting") {
      this.turnStartedAt ??= this.now();
    } else if (msg.subtype === "api_retry") {
      const status = msg.error_status;
      const reason: AgentRetryEvent["reason"] =
        status === 429 ? "rate_limit" : status === 529 ? "overloaded" : "provider_error";
      return [
        {
          type: "retry",
          reason,
          attempt: num(msg.attempt),
          maxAttempts: num(msg.max_retries),
          delayMs: num(msg.retry_delay_ms),
        },
      ];
    }
    return [];
  }

  private handleStreamEvent(event: Block): AgentEvent[] {
    switch (event.type) {
      case "message_start":
        this.turnStartedAt ??= this.now();
        this.firstEventAt = this.now();
        this.stopReason = "end_turn";
        this.usage = toUsage((event.message as Block | undefined)?.usage);
        return [];
      case "content_block_delta": {
        const delta = (event.delta ?? {}) as Block;
        if (delta.type === "text_delta") return [{ type: "text_delta", text: String(delta.text) }];
        if (delta.type === "thinking_delta") {
          return [{ type: "thinking_delta", text: String(delta.thinking) }];
        }
        if (delta.type === "input_json_delta") {
          const chars = String(delta.partial_json ?? "").length;
          return chars > 0 ? [{ type: "toolcall_delta", chars }] : [];
        }
        return [];
      }
      case "message_delta":
        this.stopReason = toStopReason((event.delta as Block | undefined)?.stop_reason);
        this.usage = toUsage(event.usage);
        return [];
      case "message_stop":
        return this.endTurn();
      default:
        return [];
    }
  }

  private endTurn(): AgentEvent[] {
    this.turn++;
    const completedAt = this.now();
    const startedAt = this.turnStartedAt ?? completedAt;
    const providerDurationMs = completedAt - startedAt;
    const usage = this.usage;
    addUsage(this.totalUsage, usage);
    this.turnStartedAt = undefined;
    const events: AgentEvent[] = [
      {
        type: "turn_end",
        turn: this.turn,
        stopReason: this.stopReason,
        usage,
        timing: {
          startedAt,
          completedAt,
          providerDurationMs,
          ...(this.firstEventAt !== undefined
            ? { firstProviderEventAt: this.firstEventAt, ttftMs: this.firstEventAt - startedAt }
            : {}),
          ...(providerDurationMs > 0 && usage.outputTokens > 0
            ? { outputTokensPerSecond: usage.outputTokens / (providerDurationMs / 1000) }
            : {}),
        },
      },
    ];
    if (this.stopReason === "max_tokens" || this.stopReason === "refusal") {
      events.push({ type: "truncated", reason: this.stopReason, continued: false });
    }
    this.firstEventAt = undefined;
    return events;
  }

  private handleAssistant(message: Block): AgentEvent[] {
    const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
    if (message.model === SYNTHETIC_MODEL) {
      const text = blocks.map((b) => (b.type === "text" ? String(b.text) : "")).join("");
      if (text) this.syntheticError = text;
      return [];
    }
    const id = String(message.id ?? "");
    if (!this.current || this.current.id !== id) {
      const fresh: AssistantMessage = { role: "assistant", content: [] };
      this.current = { id, message: fresh };
      this.options.messages.push(fresh);
      this.lastAssistant = fresh;
    }
    const content = this.current.message.content as ContentPart[];
    const events: AgentEvent[] = [];
    for (const block of blocks) {
      const part = fromSdkContentBlock(block);
      content.push(part);
      if (part.type === "server_tool_call") {
        events.push({ type: "server_tool_call", id: part.id, name: part.name, input: part.input });
      } else if (part.type === "server_tool_result") {
        events.push({
          type: "server_tool_result",
          toolUseId: part.toolUseId,
          resultType: part.resultType,
          data: part.data,
        });
      }
    }
    return events;
  }

  private handleUser(raw: SDKUserMessage["message"]["content"]): AgentEvent[] {
    if (typeof raw === "string") return [];
    const blocks = (raw as unknown as Block[]).filter((b) => b.type === "tool_result");
    if (blocks.length === 0) return [];
    const calls = new Map(this.unpairedToolCalls().map((c) => [c.id, c]));
    const events: AgentEvent[] = [];
    const results: ToolResult[] = blocks.map((block) => {
      const id = String(block.tool_use_id);
      const bridged = this.options.takeResult(id);
      if (bridged) return bridged;
      // Claude Code answered this call itself (e.g. denied it), so no
      // tool events went out yet.
      const result = fromSdkToolResult(block);
      const call = calls.get(id);
      events.push(
        {
          type: "tool_call_start",
          toolCallId: id,
          name: call?.name ?? "tool",
          args: call?.args ?? {},
        },
        {
          type: "tool_call_end",
          toolCallId: id,
          result: resultText(result.content),
          isError: !!result.isError,
          durationMs: 0,
        },
      );
      return result;
    });
    this.options.messages.push({ role: "tool", content: results });
    this.current = undefined;
    events.push({ type: "checkpoint", turn: this.turn });
    return events;
  }

  /** Close dangling tool calls (after an abort) so the transcript stays paired. */
  pairDanglingToolCalls(note: string): void {
    const pending = this.unpairedToolCalls();
    if (pending.length === 0) return;
    this.options.messages.push({
      role: "tool",
      content: pending.map(
        (call) =>
          this.options.takeResult(call.id) ?? {
            type: "tool_result",
            toolCallId: call.id,
            content: note,
            isError: true,
          },
      ),
    });
    this.current = undefined;
  }
}
