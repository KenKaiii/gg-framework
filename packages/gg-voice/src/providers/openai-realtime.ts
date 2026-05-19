import { createVoiceSession, normalizeVoiceProviderError } from "../session.js";
import { voiceToolToRealtimeFunctionTool } from "../tools.js";
import type {
  JsonObject,
  RealtimeFunctionToolDefinition,
  VoiceEvent,
  VoiceProvider,
  VoiceProviderConnectOptions,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionMetadata,
  VoiceToolCall,
  VoiceToolResult,
  VoiceTransport,
  VoiceTransportEvent,
} from "../types.js";

export interface OpenAIRealtimeProviderOptions {
  readonly baseUrl?: string;
  readonly providerName?: string;
}

export interface OpenAIRealtimeSessionConfig {
  readonly type: "realtime";
  readonly model: string;
  readonly instructions?: string;
  readonly audio?: JsonObject;
  readonly tools?: readonly RealtimeFunctionToolDefinition[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface OpenAIClientSecretRequest {
  readonly session: OpenAIRealtimeSessionConfig;
}

export interface OpenAIRealtimeCallRequest {
  readonly sdp: string;
  readonly session: OpenAIRealtimeSessionConfig;
}

export interface OpenAIRealtimeHttpClient {
  createClientSecret(
    request: OpenAIClientSecretRequest,
    options: { readonly signal?: AbortSignal },
  ): Promise<JsonObject>;
  createCall(
    request: OpenAIRealtimeCallRequest,
    options: { readonly signal?: AbortSignal },
  ): Promise<string>;
}

export function createOpenAIRealtimeProvider(
  options: OpenAIRealtimeProviderOptions = {},
): VoiceProvider {
  return {
    name: options.providerName ?? "openai-realtime",
    async connect(connectOptions: VoiceProviderConnectOptions): Promise<VoiceSession> {
      if (!connectOptions.transport) {
        throw new Error("OpenAI Realtime provider requires an injected VoiceTransport");
      }
      const sessionConfig = toOpenAISessionConfig(connectOptions.session);
      await connectOptions.transport.connect(connectOptions);
      return createVoiceSession({
        id: createSessionId(connectOptions.session),
        provider: options.providerName ?? "openai-realtime",
        transport: createNormalizingTransport(connectOptions.transport),
        metadata: createMetadata(connectOptions.session),
        onSendToolResult: async (result, signal) => {
          await connectOptions.transport?.send(
            { type: "tool_result", result: toOpenAIToolResult(result) },
            signal,
          );
        },
        onUpdateConfig: async (config, signal) => {
          await connectOptions.transport?.send(
            {
              type: "config",
              config: { ...config, session: sessionConfig } as Partial<VoiceSessionConfig>,
            },
            signal,
          );
        },
      });
    },
  };
}

export function toOpenAISessionConfig(config: VoiceSessionConfig): OpenAIRealtimeSessionConfig {
  const audio: JsonObject = {};
  if (config.voice) {
    audio.output = { voice: config.voice };
  }
  if (config.inputAudioFormat) {
    audio.input = { format: config.inputAudioFormat };
  }
  if (config.outputAudioFormat) {
    audio.output = {
      ...(audio.output as JsonObject | undefined),
      format: config.outputAudioFormat,
    };
  }
  if (config.turnDetection !== undefined) {
    audio.input = {
      ...(audio.input as JsonObject | undefined),
      turn_detection: config.turnDetection,
    };
  }

  return {
    type: "realtime",
    model: config.model,
    ...(config.instructions ? { instructions: config.instructions } : {}),
    ...(Object.keys(audio).length > 0 ? { audio } : {}),
    ...(config.tools && config.tools.length > 0
      ? { tools: config.tools.map((tool) => voiceToolToRealtimeFunctionTool(tool)) }
      : {}),
    ...(config.metadata ? { metadata: config.metadata } : {}),
  };
}

export function normalizeOpenAIRealtimeEvent(event: unknown): VoiceEvent | null {
  if (!isJsonObject(event)) {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "session.created":
    case "session.updated":
      return {
        type: "session_started",
        session: normalizeSessionMetadata(event.session),
      };
    case "conversation.item.input_audio_transcription.delta":
      return {
        type: "input_transcript_delta",
        delta: stringValue(event.delta),
        itemId: stringOrUndefined(event.item_id),
      };
    case "conversation.item.input_audio_transcription.completed":
      return {
        type: "input_transcript_done",
        text: stringValue(event.transcript),
        itemId: stringOrUndefined(event.item_id),
      };
    case "response.output_audio_transcript.delta":
      return {
        type: "output_text_delta",
        delta: stringValue(event.delta),
        itemId: stringOrUndefined(event.item_id),
      };
    case "response.output_audio_transcript.done":
      return {
        type: "output_text_done",
        text: stringValue(event.transcript),
        itemId: stringOrUndefined(event.item_id),
      };
    case "response.output_text.delta":
    case "response.text.delta":
      return {
        type: "output_text_delta",
        delta: stringValue(event.delta),
        itemId: stringOrUndefined(event.item_id),
      };
    case "response.output_text.done":
    case "response.text.done":
      return {
        type: "output_text_done",
        text: stringValue(event.text),
        itemId: stringOrUndefined(event.item_id),
      };
    case "response.output_audio.delta":
    case "response.audio.delta":
      return {
        type: "output_audio_delta",
        chunk: { data: stringValue(event.delta), format: "base64" },
        itemId: stringOrUndefined(event.item_id),
      };
    case "response.output_audio.done":
    case "response.audio.done":
      return { type: "output_audio_done", itemId: stringOrUndefined(event.item_id) };
    case "response.function_call_arguments.done":
      return { type: "tool_call", call: normalizeToolCall(event) };
    case "error":
      return {
        type: "error",
        error: normalizeVoiceProviderError(event.error ?? event),
        recoverable: true,
      };
    default:
      return null;
  }
}

function createNormalizingTransport(transport: VoiceTransport): VoiceTransport {
  return {
    kind: transport.kind,
    connect: transport.connect.bind(transport),
    send: transport.send.bind(transport),
    close: transport.close.bind(transport),
    onEvent(handler) {
      return transport.onEvent((event) => {
        handler(normalizeTransportEvent(event));
      });
    },
  };
}

function normalizeTransportEvent(event: VoiceTransportEvent): VoiceTransportEvent {
  if (event.type !== "raw") {
    return event;
  }
  const normalized = normalizeOpenAIRealtimeEvent(event.data);
  return normalized ?? event;
}

function normalizeToolCall(event: JsonObject): VoiceToolCall {
  const args = parseJsonObject(event.arguments);
  return {
    id: stringValue(event.call_id ?? event.item_id ?? event.event_id),
    name: stringValue(event.name),
    args,
    providerCallId: stringOrUndefined(event.call_id),
    raw: event,
  };
}

function toOpenAIToolResult(result: VoiceToolResult): VoiceToolResult {
  return result;
}

function createMetadata(config: VoiceSessionConfig): VoiceSessionMetadata {
  return {
    provider: "openai-realtime",
    model: config.model,
    createdAt: new Date().toISOString(),
  };
}

function createSessionId(config: VoiceSessionConfig): string {
  const model = config.model.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `openai_${model}_${Date.now()}`;
}

function normalizeSessionMetadata(value: unknown): VoiceSessionMetadata {
  if (!isJsonObject(value)) {
    return { provider: "openai-realtime" };
  }
  return {
    sessionId: stringOrUndefined(value.id),
    provider: "openai-realtime",
    model: stringOrUndefined(value.model),
  };
}

function parseJsonObject(value: unknown): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
