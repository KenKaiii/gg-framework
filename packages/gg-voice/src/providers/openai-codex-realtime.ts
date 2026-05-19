import { createOpenAIRealtimeProvider, toOpenAISessionConfig } from "./openai-realtime.js";
import type {
  OpenAIRealtimeCallRequest,
  OpenAIRealtimeProviderOptions,
  OpenAIRealtimeSessionConfig,
} from "./openai-realtime.js";
import type { JsonObject, VoiceProvider, VoiceSessionConfig } from "../types.js";

export interface ExperimentalCodexRealtimeProviderOptions extends OpenAIRealtimeProviderOptions {
  readonly baseUrl?: string;
}

export interface ExperimentalCodexRealtimeCallRequest {
  readonly sdp: string;
  readonly session: OpenAIRealtimeSessionConfig;
}

export function createExperimentalCodexRealtimeProvider(
  options: ExperimentalCodexRealtimeProviderOptions = {},
): VoiceProvider {
  return createOpenAIRealtimeProvider({
    ...options,
    baseUrl: options.baseUrl ?? "https://chatgpt.com/backend-api/codex",
    providerName: "openai-codex-realtime-experimental",
  });
}

export function toExperimentalCodexRealtimeCallRequest(
  request: OpenAIRealtimeCallRequest,
): ExperimentalCodexRealtimeCallRequest {
  return {
    sdp: request.sdp,
    session: request.session,
  };
}

export function toExperimentalCodexSessionConfig(config: VoiceSessionConfig): JsonObject {
  const session = toOpenAISessionConfig(config);
  const { type: _type, ...rest } = session;
  return rest;
}
