import type { z } from "zod";
import type {
  Tool,
  AssistantMessage,
  Message,
  ServerToolDefinition,
  StopReason,
  ToolResultContent,
  Usage,
  StreamOptions,
} from "@kenkaiiii/gg-ai";

// ── Tool Results ────────────────────────────────────────────

export interface StructuredToolResult {
  content: ToolResultContent;
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

export type ToolExecutionMode = "parallel" | "sequential";

export interface AgentTool<T extends z.ZodType = z.ZodType> extends Tool {
  parameters: T;
  /**
   * Per-tool execution hint for batches of tool calls from one assistant turn.
   * Tools default to parallel. If any requested tool is sequential, the whole
   * batch runs in source order so stateful mutations cannot race each other.
   */
  executionMode?: ToolExecutionMode;
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

export interface AgentTurnTiming {
  /** Logical turn start, before context transforms or provider retries. Unix epoch milliseconds. */
  startedAt: number;
  /** First provider event, or full-response arrival for non-streaming fallback. */
  firstProviderEventAt?: number;
  /** Successful provider response completion. Unix epoch milliseconds. */
  completedAt: number;
  /** Time spent awaiting provider attempts, including failed attempts but excluding retry backoff. */
  providerDurationMs: number;
  /** Time from logical turn start to the first provider event. */
  ttftMs?: number;
  /** Output tokens divided by total provider duration. Omitted when no rate is measurable. */
  outputTokensPerSecond?: number;
}

export interface AgentTurnEndEvent {
  type: "turn_end";
  turn: number;
  stopReason: StopReason;
  usage: Usage;
  timing: AgentTurnTiming;
}

export interface AgentDoneEvent {
  type: "agent_done";
  totalTurns: number;
  totalUsage: Usage;
}

/**
 * Terminal signal emitted when the loop stops because it exhausted its turn
 * budget (`maxTurns`) mid-task — i.e. the model still wanted to run tools but
 * ran out of turns. Distinguishes a hard cut-off from a clean completion so
 * callers (e.g. the subagent spawner) can tell the parent the output may be
 * incomplete. Yielded immediately before the final `agent_done`.
 */
export interface AgentMaxTurnsEvent {
  type: "max_turns";
  totalTurns: number;
  maxTurns: number;
}

/**
 * Warning signal emitted when a turn ended on a non-clean stop reason —
 * `max_tokens` (output clipped at the model's output-token limit), `refusal`,
 * or a provider-reported `error` stop. Distinguishes a truncated/degraded
 * completion from a clean one so hosts can warn the user instead of silently
 * presenting incomplete output as done.
 */
export interface AgentTruncatedEvent {
  type: "truncated";
  reason: "max_tokens" | "refusal" | "provider_error";
  /** True when the loop injected a continuation and will keep going. */
  continued: boolean;
}

export interface AgentRetryEvent {
  type: "retry";
  reason:
    | "overloaded"
    | "rate_limit"
    | "provider_error"
    | "empty_response"
    | "stream_stall"
    | "overflow_compact"
    | "tool_argument_glitch";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** Provider-reported prompt/context token count, when present in an overflow error. */
  observedTokens?: number;
  /** Provider-reported context/token limit, when present in an overflow error. */
  observedLimit?: number;
  /** When true, the retry should not be shown to the user (hidden retry). */
  silent?: boolean;
  /**
   * Chars of streamed text preserved in message history across this retry
   * (transport failures only). When > 0 the retry CONTINUES from the partial
   * instead of replaying — UIs must keep the streamed text on screen rather
   * than rolling it back.
   */
  preservedChars?: number;
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
  | AgentMaxTurnsEvent
  | AgentTruncatedEvent
  | AgentErrorEvent;

// ── Agent Options ───────────────────────────────────────────

export interface TransformContextOptions {
  /** Force a transform after the provider reports context overflow. */
  force?: boolean;
  /** Latest successful provider usage, anchored at its assistant message. */
  usage?: Usage;
  /** Messages appended after that usage sample and not yet seen by the provider. */
  pendingMessages: Message[];
}

export interface AgentOptions {
  provider: StreamOptions["provider"];
  model: string;
  system?: string;
  /** Prior conversation messages (excluding system) to hydrate the Agent on construction. Used for session resume. */
  priorMessages?: Message[];
  tools?: AgentTool[];
  serverTools?: ServerToolDefinition[];
  /** Control whether tools may/must be called, or select a named tool when supported. */
  toolChoice?: StreamOptions["toolChoice"];
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  thinking?: StreamOptions["thinking"];
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  accountId?: string;
  transportSessionId?: StreamOptions["transportSessionId"];
  projectId?: StreamOptions["projectId"];
  cacheRetention?: StreamOptions["cacheRetention"];
  /** Stable per-session cache routing key for providers that support it. */
  promptCacheKey?: StreamOptions["promptCacheKey"];
  /** Override the User-Agent sent with OAuth-authenticated Anthropic requests. */
  userAgent?: StreamOptions["userAgent"];
  /** Extra HTTP headers attached to every model request (e.g. Kimi For Coding
   *  client-identity headers). Merged into the underlying SDK default headers. */
  defaultHeaders?: StreamOptions["defaultHeaders"];
  /** OpenAI service tier for latency-sensitive first-party API requests. */
  serviceTier?: StreamOptions["serviceTier"];
  /** Whether the target model supports image input. When false, image blocks
   *  in messages/tool_results are downgraded to text placeholders. Default: true. */
  supportsImages?: boolean;
  /** Whether the target model supports video input. When false, video blocks
   *  in messages are downgraded to text placeholders. Default: false. */
  supportsVideo?: boolean;
  /** Enable provider-native web search. */
  webSearch?: boolean;
  /** Enable server-side compaction (Anthropic only, beta). */
  compaction?: boolean;
  /** Enable server-side clearing of old tool use/result pairs (Anthropic only, beta). */
  clearToolUses?: boolean;
  /** Max characters for a single tool result. Results exceeding this are truncated with a notice. */
  maxToolResultChars?: number;
  /** Aggregate budget for ALL tool results in one assistant turn. Protects
   *  against parallel fan-outs injecting huge uncached context in one turn;
   *  the largest results are trimmed (water-filling) with a re-run notice. */
  maxTurnToolResultChars?: number;
  /** Max consecutive pause_turn continuations before stopping (default: 5).
   *  Prevents infinite loops when server-side tools keep pausing. */
  maxContinuations?: number;
  /**
   * Called before each LLM call. Allows the caller to inspect and transform
   * the messages array (e.g. compaction, truncation). Return the same array
   * for no-op, or a new array to replace the conversation context.
   *
   * The latest provider usage is authoritative for the history through its
   * assistant response. `pendingMessages` contains context appended afterward.
   * When `options.force` is true, the caller should compact unconditionally
   * (e.g. after a context overflow error from the API).
   */
  transformContext?: (
    messages: Message[],
    options: TransformContextOptions,
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
