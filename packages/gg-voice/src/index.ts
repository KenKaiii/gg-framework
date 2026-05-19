export type {
  AudioInputChunk,
  AudioOutputChunk,
  JsonObject,
  RealtimeFunctionToolDefinition,
  ToolConfirmationDecision,
  ToolConfirmationPolicy,
  ToolConfirmationRequest,
  ToolConfirmationResolver,
  VoiceAuthConfig,
  VoiceBridgeCommand,
  VoiceBridgeEvent,
  VoiceConnectionState,
  VoiceEvent,
  VoiceEventHandler,
  VoiceProvider,
  VoiceProviderConnectOptions,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionMetadata,
  VoiceTool,
  VoiceToolCall,
  VoiceToolContext,
  VoiceToolExecutionError,
  VoiceToolExecutionResult,
  VoiceToolResult,
  VoiceTransport,
  VoiceTransportConnectOptions,
  VoiceTransportEvent,
  VoiceTransportEventHandler,
  VoiceTransportSendEvent,
} from "./types.js";

export { createVoiceSession, normalizeVoiceProviderError } from "./session.js";
export type { VoiceSessionControllerOptions } from "./session.js";

export {
  agentToolToVoiceTool,
  executeVoiceToolCall,
  ggAiToolToRealtimeFunctionTool,
  ggAiToolToVoiceTool,
  voiceToolToRealtimeFunctionTool,
} from "./tools.js";
export type { ExecuteVoiceToolCallOptions, VoiceToolSource } from "./tools.js";

export { createInMemoryVoiceProvider } from "./providers/in-memory.js";
export type {
  InMemoryVoiceProvider,
  InMemoryVoiceProviderOptions,
  InMemoryVoiceSession,
} from "./providers/in-memory.js";

export type {
  OpenUrlRequest,
  PlatformAudioAdapter,
  PlatformNotification,
  PlatformSecureTokenStore,
  PlatformUrlOpener,
  RelayHttpClient,
  RelayRequest,
  RelayResponse,
} from "./platform.js";
