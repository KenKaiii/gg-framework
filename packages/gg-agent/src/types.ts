import type { z } from "zod";
import type {
  Tool,
  AssistantMessage,
  Message,
  ServerToolDefinition,
  StopReason,
  Usage,
  StreamOptions,
} from "@kenkaiiii/gg-ai";

// ── Tool Results ────────────────────────────────────────────

export interface StructuredToolResult {
  content: string;
  details?: unknown;
}

export type ToolExecuteResult = string | StructuredToolResult;

// ── Tool Context ────────────────────────────────────────────

export interface ToolContext {
  signal: AbortSignal;
  toolCallId: string;
  onUpdate?: (update: unknown) => void;
}

// ── Agent Tool ──────────────────────────────────────────────

export interface AgentTool<T extends z.ZodType = z.ZodType> extends Tool {
  parameters: T;
  execute: (
    args: z.infer<T>,
    context: ToolContext,
  ) => ToolExecuteResult | Promise<ToolExecuteResult>;
}

// ── Agent Events ────────────────────────────────────────────

export interface AgentTextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface AgentThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}

export interface AgentToolCallStartEvent {
  type: "tool_call_start";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolCallUpdateEvent {
  type: "tool_call_update";
  toolCallId: string;
  update: unknown;
}

export interface AgentToolCallEndEvent {
  type: "tool_call_end";
  toolCallId: string;
  result: string;
  details?: unknown;
  isError: boolean;
  durationMs: number;
}

export interface AgentTurnEndEvent {
  type: "turn_end";
  turn: number;
  stopReason: StopReason;
  usage: Usage;
}

export interface AgentDoneEvent {
  type: "agent_done";
  totalTurns: number;
  totalUsage: Usage;
}

export interface AgentRetryEvent {
  type: "retry";
  reason: "overloaded" | "rate_limit" | "empty_response" | "context_overflow" | "stream_stall";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** When true, the retry should not be shown to the user (hidden retry). */
  silent?: boolean;
}

export interface AgentToolCallDeltaEvent {
  type: "toolcall_delta";
  chars: number;
}

export interface AgentErrorEvent {
  type: "error";
  error: Error;
}

export interface AgentServerToolCallEvent {
  type: "server_tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface AgentServerToolResultEvent {
  type: "server_tool_result";
  toolUseId: string;
  resultType: string;
  data: unknown;
}

export interface AgentSteeringMessageEvent {
  type: "steering_message";
  content: Message["content"];
}

export interface AgentFollowUpMessageEvent {
  type: "follow_up_message";
  content: Message["content"];
}

export type AgentEvent =
  | AgentTextDeltaEvent
  | AgentThinkingDeltaEvent
  | AgentToolCallStartEvent
  | AgentToolCallUpdateEvent
  | AgentToolCallEndEvent
  | AgentToolCallDeltaEvent
  | AgentServerToolCallEvent
  | AgentServerToolResultEvent
  | AgentSteeringMessageEvent
  | AgentFollowUpMessageEvent
  | AgentRetryEvent
  | AgentTurnEndEvent
  | AgentDoneEvent
  | AgentErrorEvent;

// ── Agent Options ───────────────────────────────────────────

export interface AgentOptions {
  provider: StreamOptions["provider"];
  model: string;
  system?: string;
  tools?: AgentTool[];
  serverTools?: ServerToolDefinition[];
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  thinking?: StreamOptions["thinking"];
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  accountId?: string;
  cacheRetention?: StreamOptions["cacheRetention"];
  /** Enable provider-native web search. */
  webSearch?: boolean;
  /** Enable server-side compaction (Anthropic only, beta). */
  compaction?: boolean;
  /** Enable server-side clearing of old tool use/result pairs (Anthropic only, beta). */
  clearToolUses?: boolean;
  /** Max characters for a single tool result. Results exceeding this are truncated with a notice. */
  maxToolResultChars?: number;
  /** Max consecutive pause_turn continuations before stopping (default: 5).
   *  Prevents infinite loops when server-side tools keep pausing. */
  maxContinuations?: number;
  /**
   * Called before each LLM call. Allows the caller to inspect and transform
   * the messages array (e.g. compaction, truncation). Return the same array
   * for no-op, or a new array to replace the conversation context.
   *
   * When `options.force` is true, the caller should compact unconditionally
   * (e.g. after a context overflow error from the API).
   */
  transformContext?: (
    messages: Message[],
    options?: { force?: boolean },
  ) => Message[] | Promise<Message[]>;
  /**
   * Polled after tool execution completes each turn. Returns user messages
   * to inject into the conversation before the next LLM call (steering).
   * Return null/empty to inject nothing. Messages are consumed (cleared)
   * on read.
   */
  getSteeringMessages?: () => Promise<Message[] | null> | Message[] | null;
  /**
   * Polled when the agent would otherwise stop (no tool calls, no steering).
   * Returns messages to inject and continue the loop. Lower priority than
   * steering — only checked after getSteeringMessages returns empty.
   * Return null/empty to inject nothing. Messages are consumed (cleared)
   * on read.
   */
  getFollowUpMessages?: () => Promise<Message[] | null> | Message[] | null;
}

// ── Agent Result ────────────────────────────────────────────

export interface AgentResult {
  message: AssistantMessage;
  totalTurns: number;
  totalUsage: Usage;
}
