import type { z } from "zod";

// ── Providers ──────────────────────────────────────────────

export type Provider =
  | "anthropic"
  | "xiaomi"
  | "openai"
  | "gemini"
  | "glm"
  | "moonshot"
  | "minimax"
  | "deepseek"
  | "openrouter"
  | "sakana"
  | "xai"
  | "palsu"
  /** Hugging Face Inference Providers router (OpenAI-compatible). */
  | "huggingface"
  /** Locally hosted OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM). */
  | "local";

// ── Thinking ───────────────────────────────────────────────

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

// ── Cache ─────────────────────────────────────────────────

export type CacheRetention = "none" | "short" | "long";

// ── Content Types ──────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
  signature?: string;
}

export interface ImageContent {
  type: "image";
  mediaType: string;
  data: string; // base64
}

export interface VideoContent {
  type: "video";
  mediaType: string; // e.g. "video/mp4"
  data: string; // base64
  /** Moonshot/Kimi file id (e.g. "d4f0…") after uploading via the files API.
   *  Moonshot rejects inline base64 video; the provider uploads the clip once
   *  and caches the id here so later turns reference `ms://<fileId>` instead of
   *  re-sending the bytes. */
  fileId?: string;
}

export interface ToolCall {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ToolResultContent = string | (TextContent | ImageContent | VideoContent)[];

export interface ToolResult {
  type: "tool_result";
  toolCallId: string;
  content: ToolResultContent;
  isError?: boolean;
  /**
   * Set when the agent loop trimmed `content` to fit a per-result or per-turn
   * budget. The provider (model input) and the persistent transcript both see
   * the trimmed `content`, but the live `tool_call_end` event carried the FULL
   * preview — so this marker makes that divergence explicit and reconcilable.
   * Internal metadata only: it is never serialized onto the provider wire.
   */
  capped?: {
    /** Length of the original, untrimmed string content. */
    originalChars: number;
    /** Length of the trimmed content actually sent to the model. */
    keptChars: number;
    /** Which budget triggered the trim. */
    scope: "per-result" | "per-turn";
  };
}

export interface ServerToolCall {
  type: "server_tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ServerToolResult {
  type: "server_tool_result";
  toolUseId: string;
  resultType: string;
  data: unknown;
}

/** Opaque content block preserved for round-tripping (e.g. compaction blocks). */
export interface RawContent {
  type: "raw";
  data: Record<string, unknown>;
}

export type ContentPart =
  | TextContent
  | ThinkingContent
  | ImageContent
  | VideoContent
  | ToolCall
  | ServerToolCall
  | ServerToolResult
  | RawContent;

// ── Messages ───────────────────────────────────────────────

export type MessageProvenanceSource = "human" | "agent" | "runtime";

export type MessageProvenanceKind =
  | "prompt"
  | "steering"
  | "notification"
  | "completion_gate"
  | "review_follow_up"
  | "continuation"
  | "model_switch"
  | "automation"
  | "compaction_summary"
  | "compaction_ack";

export type MessageProvenanceVisibility = "transcript" | "hidden" | "summary";

/** Internal message metadata. `stream()` removes it before provider dispatch. */
export interface MessageProvenance {
  source: MessageProvenanceSource;
  kind: MessageProvenanceKind;
  visibility: MessageProvenanceVisibility;
}

interface MessageMetadata {
  provenance?: MessageProvenance;
}

export interface SystemMessage extends MessageMetadata {
  role: "system";
  content: string;
}

export interface UserMessage extends MessageMetadata {
  role: "user";
  content: string | (TextContent | ImageContent | VideoContent)[];
}

export interface AssistantMessage extends MessageMetadata {
  role: "assistant";
  content: string | ContentPart[];
}

export interface ToolResultMessage extends MessageMetadata {
  role: "tool";
  content: ToolResult[];
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// ── Tools ──────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodType;
  /** Raw JSON Schema — bypasses zodToJsonSchema when set (used by MCP tools) */
  rawInputSchema?: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

// ── Server Tools ────────────────────────────────────────────

export interface ServerToolDefinition {
  type: string;
  name: string;
  [key: string]: unknown;
}

// ── Stream Events ──────────────────────────────────────────

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}

export interface ToolCallDeltaEvent {
  type: "toolcall_delta";
  id: string;
  name: string;
  argsJson: string;
}

export interface ToolCallDoneEvent {
  type: "toolcall_done";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DoneEvent {
  type: "done";
  stopReason: StopReason;
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface ServerToolCallEvent {
  type: "server_toolcall";
  id: string;
  name: string;
  input: unknown;
}

export interface ServerToolResultEvent {
  type: "server_toolresult";
  toolUseId: string;
  resultType: string;
  data: unknown;
}

export interface KeepaliveEvent {
  type: "keepalive";
}

export type StreamEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallDoneEvent
  | ServerToolCallEvent
  | ServerToolResultEvent
  | DoneEvent
  | ErrorEvent
  | KeepaliveEvent;

// ── Stop Reasons ───────────────────────────────────────────

export type StopReason =
  "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "stop_sequence" | "refusal" | "error";

// ── Response ───────────────────────────────────────────────

export interface StreamResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  usage: Usage;
}

export interface Usage {
  inputTokens: number;
  /** Total billed output tokens, including reasoning tokens when the provider reports them separately. */
  outputTokens: number;
  /** Reasoning/thinking-token subset of outputTokens. */
  reasoningTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  serverToolUse?: { webSearchRequests?: number; webFetchRequests?: number };
}

// ── Stream Options ─────────────────────────────────────────

export interface PreparedContext {
  /** Read-only observation after generic sanitization/image limiting, before provider encoding.
   * Do not log or retain these messages: they may contain secrets and image data. */
  messages: readonly Message[];
  tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
  imagesBefore: number;
  imagesAfter: number;
  /** First message whose images were removed for this request, or null. */
  firstImageDropMessage: number | null;
}

export interface StreamOptions {
  provider: Provider;
  /** Optional, synchronous diagnostics observer. Exceptions cannot fail a model request. */
  onContextPrepared?: (context: PreparedContext) => void;
  model: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  serverTools?: ServerToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  thinking?: ThinkingLevel;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  /** Prompt cache retention preference. Providers map this to their supported values. Default: "short". */
  cacheRetention?: CacheRetention;
  /** Stable per-session cache routing key for providers that support it (OpenAI, Moonshot, Gemini Code Assist). */
  promptCacheKey?: string;
  /** OpenAI service tier for latency-sensitive requests. Only sent to first-party OpenAI API calls. */
  serviceTier?: "auto" | "default" | "flex" | "priority";
  /** Codex endpoint only: send the Responses-Lite request shape (lite header,
   *  `parallel_tool_calls: false`, all-turns reasoning context). Unset follows
   *  the model family (on for gpt-5.6/gpt-6 models). Lite allows only one tool
   *  call per response, so turning it off lets the model batch calls. */
  responsesLite?: boolean;
  /** OpenAI only (Codex and API-key routes): send tools with strict
   *  (grammar-constrained) schemas. Default true. Strict calls carry every
   *  optional field as null, which costs output tokens and latency per call. */
  strictTools?: boolean;
  /** OpenAI ChatGPT account ID (from OAuth JWT) for codex endpoint */
  accountId?: string;
  /** Stable conversation identity for Codex transport headers. This is distinct from
   *  promptCacheKey: sessions with matching prefixes may share a cache key, but must
   *  retain independent session/thread identities. */
  transportSessionId?: string;
  /** Google Cloud/Code Assist project ID used by Gemini OAuth transport. */
  projectId?: string;
  /** Enable provider-native web search. Each provider uses its own format:
   *  - Anthropic: server tool `web_search_20250305`
   *  - Moonshot: `builtin_function` `$web_search`
   *  - GLM: web search via MCP servers (not inline — this flag is a no-op)
   *  - OpenAI/Codex: not supported (Chat Completions / Codex APIs lack web search) */
  webSearch?: boolean;
  /** Enable server-side compaction (Anthropic only, beta). Automatically
   *  summarizes earlier context when approaching the context window limit. */
  compaction?: boolean;
  /** Enable server-side clearing of old tool use/result pairs (Anthropic only, beta).
   *  The API automatically removes older tool interactions to free context. */
  clearToolUses?: boolean;
  /** Custom fetch implementation. Useful in non-Node environments (e.g. Expo/React Native)
   *  where the default `globalThis.fetch` doesn't support streaming properly.
   *  Passed directly to the underlying provider SDK. */
  fetch?: typeof globalThis.fetch;
  /** Whether the target model supports image input. When false, image content
   *  in user messages and tool_result messages is downgraded to a text placeholder
   *  before being sent to the provider. Default: true. */
  supportsImages?: boolean;
  /** Whether the target model supports video input. When false, video content
   *  in user messages is downgraded to a text placeholder before being sent to
   *  the provider. Default: false. */
  supportsVideo?: boolean;
  /** Use streaming transport (default: true). When false, providers issue a
   *  single non-streaming request and synthesize events from the full response.
   *  The agent loop flips this to `false` as a fallback after repeated stream
   *  stalls — broken SSE connections (transient CDN / proxy issues) often
   *  recover when the same request is issued over a plain HTTP request/response. */
  streaming?: boolean;
  /** Cache prewarm (Anthropic only; other providers ignore it). Sends the exact
   *  same request prefix (system, tools, messages, thinking, betas) with
   *  `max_tokens: 1` over a non-streaming request so the prompt cache is written
   *  before the user's next real turn. If the configured thinking mode cannot be
   *  kept identical at `max_tokens: 1` (budget thinking requires
   *  budget_tokens < max_tokens), no request is sent and the response has
   *  zero usage with stopReason "end_turn". */
  prewarm?: boolean;
  /** Override the User-Agent sent with OAuth-authenticated Anthropic requests.
   *  Anthropic's OAuth edge rejects requests whose claude-cli version lags too
   *  far behind the real Claude Code release; callers that track the live
   *  version should pass it here. Ignored for non-Anthropic providers and for
   *  Anthropic requests using a regular API key. */
  userAgent?: string;
  /** Extra HTTP headers attached to every model request. Used by providers
   *  whose endpoint gates on client identity (e.g. Kimi For Coding requires a
   *  `User-Agent: kimi-code-cli/...` and `X-Msh-*` device headers). Merged
   *  into the underlying SDK's default headers. */
  defaultHeaders?: Record<string, string>;
  /** Provider-specific request-body fields, merged into the JSON body of every
   *  model request (e.g. OpenRouter's routing object:
   *  `{ provider: { zdr: true, data_collection: "deny" } }`). Fields gg-ai
   *  sets itself — `model`, `messages`, `tools`, `stream`, sampling and
   *  reasoning parameters, and so on — always win; see `ProviderOptions`. */
  providerOptions?: ProviderOptions;
}

// ── Provider-specific request options ──────────────────────

/**
 * Provider-specific JSON body fields passed through to the provider unchanged
 * by `stream()`, `embed()` and `rerank()`.
 *
 * Merge rules: a field is added only when gg-ai hasn't set it on the request.
 * Core fields (`model`, `messages`, `input`, `query`, `documents`, `stream`,
 * `tools`, `system`, `contents`, `requests`, `dimensions`, `encoding_format`,
 * `top_n`) are never taken from here, even when gg-ai left them unset — use the
 * dedicated option instead. Keys are applied in sorted order, so the merged body
 * is deterministic.
 *
 * ```ts
 * providerOptions: {
 *   provider: { zdr: true, data_collection: "deny" } satisfies OpenRouterProviderPreferences,
 * }
 * ```
 */
export type ProviderOptions = Readonly<Record<string, unknown>>;

/**
 * OpenRouter's provider-routing preferences (the `provider` body field on
 * `/chat/completions`, `/embeddings` and `/rerank`). Pass it through
 * `providerOptions: { provider: … }`. Only the commonly used fields are typed;
 * anything else OpenRouter documents is passed through as-is.
 * See https://openrouter.ai/docs/features/provider-routing.
 */
export interface OpenRouterProviderPreferences {
  /** Allow backup providers when the preferred ones are unavailable (default true). */
  allow_fallbacks?: boolean;
  /** Only route to providers that don't retain prompts. */
  zdr?: boolean;
  /** `"deny"` restricts routing to providers that don't collect user data. */
  data_collection?: "allow" | "deny";
  /** Only route to providers that support every parameter in the request. */
  require_parameters?: boolean;
  /** Provider slugs to try, in order. */
  order?: string[];
  /** Provider slugs to allow. */
  only?: string[];
  /** Provider slugs to skip. */
  ignore?: string[];
  /** Quantization levels to allow (e.g. `"fp8"`). */
  quantizations?: string[];
  /** Sort strategy (`"price"`, `"throughput"`, `"latency"`) or a sort config object. */
  sort?: string | Readonly<Record<string, unknown>>;
  /** Maximum price per million tokens, by usage kind. */
  max_price?: Readonly<Record<string, number | string>>;
  [key: string]: unknown;
}
