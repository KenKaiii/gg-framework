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
import type { StreamRulesConfig } from "./stream-rules.js";

// ── Tool Results ────────────────────────────────────────────

export interface StructuredToolResult {
  content: ToolResultContent;
  details?: unknown;
  /** End the run after persisting this result, without another model call or
   * draining steering/follow-ups. Use a sequential tool to also prevent later
   * calls in the same batch from running (e.g. a pending plan-review handoff).
   * Host control metadata only: never serialized into provider tool results. */
  endRun?: boolean;
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
  /**
   * Overrides the loop's default per-tool timeout. A tool that owns a longer
   * internal budget than the default must declare it here, or the loop cancels
   * it first and the tool's own timeout — with its specific, actionable error
   * message — becomes unreachable.
   */
  timeoutMs?: number;
  /**
   * Whether a mid-run steering message may preempt this tool. Defaults to
   * true, except for atomic file mutators (`edit`, `write`, …) which always
   * run to completion so they are never left half-applied.
   */
  interruptible?: boolean;
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
  /**
   * Set only when the call failed schema validation: how many consecutive
   * times this tool produced this same validation error. 1 means the model
   * still has room to self-correct; 3 is the threshold that ends the turn.
   * Logged so a retry loop shows up as a count instead of identical lines.
   */
  invalidArgAttempt?: number;
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

/**
 * A safe point between steps: the assistant message and every tool result for
 * this turn are now in the message array, and no provider call is in flight.
 *
 * Hosts that persist a transcript flush here. Without it a crash mid-run loses
 * the WHOLE turn — including tool results whose side effects already landed on
 * disk — because the only flush happens after the loop returns.
 *
 * Yielded immediately after tool results are appended, so it pairs with
 * `turn_end` (which covers the assistant half) to cover every message.
 */
export interface AgentCheckpointEvent {
  type: "checkpoint";
  turn: number;
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
 * Emitted when the loop was about to stop on an exhausted turn budget but the
 * host granted an extension instead. The effective budget is raised and the
 * loop continues with a continuation prompt, so this is NOT terminal — unlike
 * `max_turns`, which still fires if the extended budget is also spent.
 */
export interface AgentTurnBudgetExtendedEvent {
  type: "turn_budget_extended";
  /** Turn number at which the budget was exhausted. */
  turn: number;
  /** New effective `maxTurns` after the extension. */
  grantedTurns: number;
  /** 1-based extension count for this run. */
  extension: number;
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
  reason: "max_tokens" | "refusal" | "provider_error" | "empty_response";
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
    | "tool_argument_glitch"
    | "runaway_toolcall"
    | "stream_rule";
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

/**
 * A stream rule matched mid-response. The attempt was aborted and discarded
 * (no partial message persisted, no partial tool call executed), the rule's
 * reminder was appended to the context, and the step is retried. Always
 * followed by a silent `retry` (reason `stream_rule`) so UIs roll back the
 * streamed partial exactly as for any other replayed attempt.
 */
export interface AgentStreamRuleTriggeredEvent {
  type: "stream_rule_triggered";
  /** Names of the rules that matched (usually one). */
  rules: string[];
  source: "text" | "tool";
  /** Tool whose streamed arguments matched, for `source: "tool"`. */
  toolName?: string;
  attempt: number;
  maxAttempts: number;
  /**
   * ESTIMATED usage of the aborted attempt (providers report none for an
   * aborted stream): prompt chars/4 in, streamed chars/4 out. Already added to
   * the run's `totalUsage`.
   */
  usage: Usage;
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
  | AgentStreamRuleTriggeredEvent
  | AgentTurnEndEvent
  | AgentCheckpointEvent
  | AgentDoneEvent
  | AgentMaxTurnsEvent
  | AgentTurnBudgetExtendedEvent
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
  /**
   * How many times `onTurnBudgetExhausted` may grant extra turns in one run.
   * Each grant raises the effective budget by the original `maxTurns`.
   * Default: 2. Set 0 to disable extensions entirely.
   */
  maxTurnExtensions?: number;
  maxTokens?: number;
  temperature?: number;
  thinking?: StreamOptions["thinking"];
  apiKey?: string;
  /**
   * Re-resolve the credential at the start of every turn. A run can span many
   * minutes, and an OAuth grant refreshed by any process (another app window, a
   * CLI session, the usage poller) invalidates the access token captured when
   * the run began — so a pinned `apiKey` goes dead mid-run and every remaining
   * turn fails with an authentication error. Returning the current credential
   * here keeps a long run alive across rotations.
   *
   * Falls back to `apiKey`/`accountId`/`projectId` when omitted or when the
   * resolver throws (the provider call then surfaces the real auth error).
   */
  resolveCredentials?: () => Promise<{
    apiKey: string;
    accountId?: string;
    projectId?: string;
  }>;
  baseUrl?: string;
  signal?: AbortSignal;
  accountId?: string;
  transportSessionId?: StreamOptions["transportSessionId"];
  projectId?: StreamOptions["projectId"];
  cacheRetention?: StreamOptions["cacheRetention"];
  onContextPrepared?: StreamOptions["onContextPrepared"];
  /** Stable per-session cache routing key for providers that support it. */
  promptCacheKey?: StreamOptions["promptCacheKey"];
  /** Override the User-Agent sent with OAuth-authenticated Anthropic requests. */
  userAgent?: StreamOptions["userAgent"];
  /** Extra HTTP headers attached to every model request (e.g. Kimi For Coding
   *  client-identity headers). Merged into the underlying SDK default headers. */
  defaultHeaders?: StreamOptions["defaultHeaders"];
  /** Provider-specific request-body fields forwarded to every model request
   *  (e.g. OpenRouter `provider: { zdr: true }`). See gg-ai `ProviderOptions`. */
  providerOptions?: StreamOptions["providerOptions"];
  /** Custom fetch implementation forwarded to the provider transport. */
  fetch?: StreamOptions["fetch"];
  /** OpenAI service tier for latency-sensitive first-party API requests. */
  serviceTier?: StreamOptions["serviceTier"];
  /** Codex Responses-Lite request shape override (see StreamOptions). */
  responsesLite?: StreamOptions["responsesLite"];
  /** Codex strict tool schema override (see StreamOptions). */
  strictTools?: StreamOptions["strictTools"];
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
  /** Load a tool the model called by name that is not in `tools` yet (e.g. a
   *  deferred tool it saw advertised). Return it to run the call normally, or
   *  undefined for the usual "Unknown tool" result. Must append the tool to the
   *  live `tools` array itself so later turns see its schema. */
  resolveTool?: (name: string) => AgentTool | undefined;
  /** Optional post-processing of a SUCCESSFUL tool result (after redaction,
   *  before the tool_call_end event and the provider context). Return the
   *  content unchanged to leave it alone. A throw is ignored (original kept).
   *  Used e.g. to append a warning to untrusted-content results. */
  transformToolResult?: (
    call: { name: string; args: Record<string, unknown> },
    content: ToolResultContent,
  ) => ToolResultContent;
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
   * Instant interrupt (codex `instant_interrupt`): subscribe to "a steering
   * message just arrived". While tools are running, the listener preempts
   * interruptible tools (their AbortSignal fires; unfinished calls get an
   * "Interrupted" error result) and the loop drains steering and continues.
   * Distinct from `signal` (the Stop button), which ends the run. Returns an
   * unsubscribe function.
   */
  onSteeringAvailable?: (listener: () => void) => () => void;
  /**
   * Polled when the agent would otherwise stop (no tool calls, no steering).
   * Returns messages to inject and continue the loop. Lower priority than
   * steering — only checked after getSteeringMessages returns empty.
   * Return null/empty to inject nothing. Messages are consumed (cleared)
   * on read.
   */
  getFollowUpMessages?: () => Promise<Message[] | null> | Message[] | null;
  /**
   * Consulted when a tool-running turn exhausts the turn budget mid-task,
   * before the loop emits the terminal `max_turns` event. Return true to grant
   * another `maxTurns` worth of turns; false (the default when unset) keeps
   * today's hard cut-off. Hosts should only grant on evidence of progress —
   * extending a spinning agent just buys it more tokens to spin with.
   */
  onTurnBudgetExhausted?: (ctx: {
    turn: number;
    maxTurns: number;
    extension: number;
  }) => Promise<boolean> | boolean;
  /**
   * Regex rules matched against streamed assistant text and tool-call
   * arguments. A match aborts the attempt, discards it, appends the rule's
   * reminder and retries the step. Each rule fires at most once per run;
   * `maxRetries` (default 3) caps rule retries per run. Unset = no matching.
   */
  streamRules?: StreamRulesConfig;
}

// ── Agent Result ────────────────────────────────────────────

export interface AgentResult {
  message: AssistantMessage;
  totalTurns: number;
  totalUsage: Usage;
}
