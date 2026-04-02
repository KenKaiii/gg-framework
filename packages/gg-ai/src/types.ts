import type { z } from "zod";

// ── Providers ──────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "glm" | "moonshot" | "venice" | "palsu";

// ── Thinking ───────────────────────────────────────────────

export type ThinkingLevel = "low" | "medium" | "high" | "max";

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

export interface ToolCall {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
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
  | ToolCall
  | ServerToolCall
  | ServerToolResult
  | RawContent;

// ── Messages ───────────────────────────────────────────────

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | ContentPart[];
}

export interface ToolResultMessage {
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

export type StreamEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallDoneEvent
  | ServerToolCallEvent
  | ServerToolResultEvent
  | DoneEvent
  | ErrorEvent;

// ── Stop Reasons ───────────────────────────────────────────

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "pause_turn"
  | "stop_sequence"
  | "refusal"
  | "error";

// ── Response ───────────────────────────────────────────────

export interface StreamResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  usage: Usage;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  serverToolUse?: { webSearchRequests?: number; webFetchRequests?: number };
}

// ── Stream Options ─────────────────────────────────────────

export interface StreamOptions {
  provider: Provider;
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
  /** OpenAI ChatGPT account ID (from OAuth JWT) for codex endpoint */
  accountId?: string;
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
}
