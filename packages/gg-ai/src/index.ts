// Core entry point
export { stream } from "./stream.js";

// Provider registry
export { providerRegistry } from "./provider-registry.js";
export type { ProviderStreamFn, ProviderEntry } from "./provider-registry.js";

// Types
export type {
  Provider,
  ThinkingLevel,
  CacheRetention,
  TextContent,
  ThinkingContent,
  ImageContent,
  VideoContent,
  ToolCall,
  ToolResult,
  ToolResultContent,
  ServerToolCall,
  ServerToolResult,
  ServerToolDefinition,
  RawContent,
  ContentPart,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  Tool,
  ToolChoice,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallDoneEvent,
  ServerToolCallEvent,
  ServerToolResultEvent,
  DoneEvent,
  ErrorEvent,
  StreamEvent,
  StopReason,
  StreamResponse,
  Usage,
  StreamOptions,
} from "./types.js";

// Classes
export { StreamResult, EventStream } from "./utils/event-stream.js";
export {
  GGAIError,
  ProviderError,
  formatError,
  formatErrorForDisplay,
  isUsageLimitError,
  isHardBillingMessage,
} from "./errors.js";
export type { ErrorSource, FormattedError } from "./errors.js";
export { classifyProviderError } from "./error-classification.js";

// Provider-level diagnostics (raw SSE event types, etc.)
export { setProviderDiagnostic } from "./utils/diag.js";
export type { ProviderDiagnosticFn } from "./utils/diag.js";

// Provider request transforms (exposed for request-building + verification)
export { toAnthropicMessages, toOpenAIMessages } from "./providers/transform.js";

// Cache pre-warming (Anthropic — fires a max_tokens:1 warm-up to prime the KV cache)
export { prewarmAnthropicCache } from "./providers/anthropic.js";

// Palsu provider (testing)
export {
  registerPalsuProvider,
  palsuText,
  palsuThinking,
  palsuToolCall,
  palsuAssistantMessage,
} from "./providers/palsu.js";
export type {
  PalsuProviderHandle,
  PalsuProviderConfig,
  PalsuProviderState,
  PalsuResponse,
  PalsuResponseFactory,
  PalsuModelConfig,
  PalsuModelHandle,
} from "./providers/palsu.js";
