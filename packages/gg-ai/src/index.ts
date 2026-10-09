// Core entry point
export { stream, localWireModelId } from "./stream.js";

// Embeddings + reranking (resolved through the same provider registry)
export { embed, rerank } from "./embed.js";
export type {
  EmbedInputType,
  EmbedOptions,
  EmbedResult,
  EmbedUsage,
  RerankOptions,
  RerankResponse,
  RerankResult,
  RerankUsage,
  ProviderEmbedFn,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderRerankFn,
  ProviderRerankRequest,
  ProviderRerankResponse,
} from "./embed-types.js";

// Provider registry
export { providerRegistry } from "./provider-registry.js";
export type { ProviderStreamFn, ProviderEntry, ProviderCapability } from "./provider-registry.js";

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
  MessageProvenanceSource,
  MessageProvenanceKind,
  MessageProvenanceVisibility,
  MessageProvenance,
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
  PreparedContext,
  ProviderOptions,
  OpenRouterProviderPreferences,
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
export { formatChatError } from "./chat-error.js";
export type { ChatErrorReason, FormattedChatError } from "./chat-error.js";
export { classifyProviderError } from "./error-classification.js";
export { REDACTION_MARKER, environmentSecrets, redactText, redactValue } from "./redaction.js";
export type { RedactionOptions } from "./redaction.js";

// UTF-16 well-formedness: providers reject request bodies holding lone surrogates.
export {
  hasLoneSurrogate,
  sanitizeMessagesForWire,
  sliceHead,
  sliceTail,
  toWellFormedText,
} from "./utils/well-formed.js";

// Provider-level diagnostics (raw SSE event types, etc.)
export { setProviderDiagnostic } from "./utils/diag.js";
export type { ProviderDiagnosticFn } from "./utils/diag.js";

// Tool schema serialization — the exact encoding every provider request uses
// (rawInputSchema passthrough for MCP tools, zodToJsonSchema otherwise).
export { resolveToolSchema } from "./utils/zod-to-json-schema.js";

// Provider request transforms (exposed for request-building + verification)
export {
  clampProviderContextImages,
  dropInvalidToolCalls,
  isValidToolCallName,
  toolCallNameRuleFor,
  TOOL_CALL_NAME_RULES,
  toAnthropicMessages,
  toOpenAIMessages,
} from "./providers/transform.js";
export type { ToolCallNameRule } from "./providers/transform.js";

// Codex model family served with the Responses-Lite request shape
export { usesResponsesLite } from "./providers/openai-codex.js";

// Cache pre-warming (Anthropic — fires a max_tokens:1 warm-up to prime the KV cache)
export { prewarmAnthropicCache } from "./providers/anthropic.js";

// Palsu provider (testing)
export {
  registerPalsuProvider,
  palsuText,
  palsuThinking,
  palsuToolCall,
  palsuAssistantMessage,
  palsuEmbedding,
  palsuRerankScore,
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
