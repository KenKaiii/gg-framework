export type JsonObject = Record<string, unknown>;

export type VoiceConnectionState = "idle" | "connecting" | "connected" | "closing" | "closed";

export interface VoiceSessionMetadata {
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly createdAt?: string;
}

export interface VoiceAuthConfig {
  readonly apiKey?: string;
  readonly ephemeralKey?: string;
  readonly accessToken?: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface VoiceSessionConfig {
  readonly model: string;
  readonly instructions?: string;
  readonly voice?: string;
  readonly modalities?: readonly ("audio" | "text")[];
  readonly inputAudioFormat?: string;
  readonly outputAudioFormat?: string;
  readonly turnDetection?: JsonObject | null;
  readonly tools?: readonly VoiceTool[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface VoiceProviderConnectOptions {
  readonly auth?: VoiceAuthConfig;
  readonly session: VoiceSessionConfig;
  readonly transport?: VoiceTransport;
  readonly signal?: AbortSignal;
}

export interface VoiceProvider {
  readonly name: string;
  connect(options: VoiceProviderConnectOptions): Promise<VoiceSession>;
}

export interface VoiceSession {
  readonly id: string;
  readonly provider: string;
  readonly state: VoiceConnectionState;
  readonly metadata: VoiceSessionMetadata;
  onEvent(handler: VoiceEventHandler): () => void;
  sendAudio(chunk: AudioInputChunk, signal?: AbortSignal): Promise<void>;
  sendText(text: string, signal?: AbortSignal): Promise<void>;
  sendToolResult(result: VoiceToolResult, signal?: AbortSignal): Promise<void>;
  updateConfig(config: Partial<VoiceSessionConfig>, signal?: AbortSignal): Promise<void>;
  close(reason?: string): Promise<void>;
}

export type VoiceEventHandler = (event: VoiceEvent) => void;

export interface AudioInputChunk {
  readonly data: ArrayBuffer | Uint8Array | string;
  readonly format?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly timestampMs?: number;
}

export interface AudioOutputChunk {
  readonly data: ArrayBuffer | Uint8Array | string;
  readonly format?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly timestampMs?: number;
}

export interface VoiceSessionStartedEvent {
  readonly type: "session_started";
  readonly session: VoiceSessionMetadata;
}

export interface VoiceInputTranscriptDeltaEvent {
  readonly type: "input_transcript_delta";
  readonly delta: string;
  readonly itemId?: string;
}

export interface VoiceInputTranscriptDoneEvent {
  readonly type: "input_transcript_done";
  readonly text: string;
  readonly itemId?: string;
}

export interface VoiceOutputTextDeltaEvent {
  readonly type: "output_text_delta";
  readonly delta: string;
  readonly itemId?: string;
}

export interface VoiceOutputTextDoneEvent {
  readonly type: "output_text_done";
  readonly text: string;
  readonly itemId?: string;
}

export interface VoiceOutputAudioStartedEvent {
  readonly type: "output_audio_started";
  readonly itemId?: string;
}

export interface VoiceOutputAudioDeltaEvent {
  readonly type: "output_audio_delta";
  readonly chunk: AudioOutputChunk;
  readonly itemId?: string;
}

export interface VoiceOutputAudioDoneEvent {
  readonly type: "output_audio_done";
  readonly itemId?: string;
}

export interface VoiceToolCallEvent {
  readonly type: "tool_call";
  readonly call: VoiceToolCall;
}

export interface VoiceToolResultSentEvent {
  readonly type: "tool_result_sent";
  readonly result: VoiceToolResult;
}

export interface VoiceErrorEvent {
  readonly type: "error";
  readonly error: Error;
  readonly recoverable: boolean;
}

export interface VoiceClosedEvent {
  readonly type: "closed";
  readonly reason?: string;
}

export type VoiceEvent =
  | VoiceSessionStartedEvent
  | VoiceInputTranscriptDeltaEvent
  | VoiceInputTranscriptDoneEvent
  | VoiceOutputTextDeltaEvent
  | VoiceOutputTextDoneEvent
  | VoiceOutputAudioStartedEvent
  | VoiceOutputAudioDeltaEvent
  | VoiceOutputAudioDoneEvent
  | VoiceToolCallEvent
  | VoiceToolResultSentEvent
  | VoiceErrorEvent
  | VoiceClosedEvent;

export interface RealtimeFunctionToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

export type ToolConfirmationPolicy =
  | "never"
  | "always"
  | "destructive"
  | ((
      request: ToolConfirmationRequest,
    ) => ToolConfirmationDecision | Promise<ToolConfirmationDecision>);

export interface ToolConfirmationRequest {
  readonly call: VoiceToolCall;
  readonly tool: VoiceTool;
}

export type ToolConfirmationDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string };

export type ToolConfirmationResolver = (
  request: ToolConfirmationRequest,
) => ToolConfirmationDecision | Promise<ToolConfirmationDecision>;

export interface VoiceToolContext {
  readonly signal: AbortSignal;
  readonly toolCallId: string;
  readonly confirmation?: ToolConfirmationResolver;
  readonly onUpdate?: (update: unknown) => void;
}

export interface VoiceTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly confirmation?: ToolConfirmationPolicy;
  readonly destructive?: boolean;
  execute?(
    args: JsonObject,
    context: VoiceToolContext,
  ): VoiceToolExecutionResult | Promise<VoiceToolExecutionResult>;
}

export interface VoiceToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly providerCallId?: string;
  readonly raw?: unknown;
}

export type VoiceToolExecutionResult = string | JsonObject | readonly JsonObject[];

export interface VoiceToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly content: VoiceToolExecutionResult;
  readonly isError?: boolean;
}

export interface VoiceToolExecutionError {
  readonly type: "tool_not_found" | "tool_confirmation_denied" | "tool_execution_failed";
  readonly message: string;
  readonly cause?: unknown;
}

export interface VoiceTransportConnectOptions {
  readonly auth?: VoiceAuthConfig;
  readonly session: VoiceSessionConfig;
  readonly signal?: AbortSignal;
}

export interface VoiceTransport {
  readonly kind: "webrtc" | "websocket" | "custom";
  connect(options: VoiceTransportConnectOptions): Promise<void>;
  onEvent(handler: VoiceTransportEventHandler): () => void;
  send(event: VoiceTransportSendEvent, signal?: AbortSignal): Promise<void>;
  close(reason?: string): Promise<void>;
}

export type VoiceTransportEventHandler = (event: VoiceTransportEvent) => void;

export type VoiceTransportSendEvent =
  | { readonly type: "audio"; readonly chunk: AudioInputChunk }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_result"; readonly result: VoiceToolResult }
  | { readonly type: "config"; readonly config: Partial<VoiceSessionConfig> };

export type VoiceTransportEvent = VoiceEvent | { readonly type: "raw"; readonly data: unknown };

export type VoiceBridgeCommand =
  | {
      readonly type: "prompt";
      readonly text: string;
      readonly sessionId?: string;
      readonly project?: string;
    }
  | { readonly type: "cancel"; readonly sessionId?: string }
  | { readonly type: "status"; readonly sessionId?: string }
  | { readonly type: "new_session"; readonly project?: string }
  | { readonly type: "switch_project"; readonly project: string }
  | { readonly type: "switch_model"; readonly provider: string; readonly model: string }
  | { readonly type: "list_projects" };

export type VoiceBridgeEvent =
  | { readonly type: "text_delta"; readonly text: string; readonly sessionId?: string }
  | {
      readonly type: "tool_start";
      readonly name: string;
      readonly id?: string;
      readonly sessionId?: string;
    }
  | {
      readonly type: "tool_end";
      readonly name: string;
      readonly id?: string;
      readonly isError?: boolean;
      readonly sessionId?: string;
    }
  | { readonly type: "task_dispatch"; readonly workerId?: string; readonly text: string }
  | { readonly type: "completion"; readonly sessionId?: string }
  | { readonly type: "status"; readonly status: JsonObject; readonly sessionId?: string }
  | { readonly type: "error"; readonly error: string; readonly sessionId?: string };
