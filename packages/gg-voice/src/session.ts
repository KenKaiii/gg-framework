import type {
  AudioInputChunk,
  JsonObject,
  VoiceConnectionState,
  VoiceEvent,
  VoiceEventHandler,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionMetadata,
  VoiceToolResult,
  VoiceTransport,
  VoiceTransportEvent,
} from "./types.js";

export interface VoiceSessionControllerOptions {
  readonly id: string;
  readonly provider: string;
  readonly transport?: VoiceTransport;
  readonly metadata?: VoiceSessionMetadata;
  readonly onSendToolResult?: (result: VoiceToolResult, signal?: AbortSignal) => Promise<void>;
  readonly onSendAudio?: (chunk: AudioInputChunk, signal?: AbortSignal) => Promise<void>;
  readonly onSendText?: (text: string, signal?: AbortSignal) => Promise<void>;
  readonly onUpdateConfig?: (
    config: Partial<VoiceSessionConfig>,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly onClose?: (reason?: string) => Promise<void>;
}

export function createVoiceSession(options: VoiceSessionControllerOptions): VoiceSession {
  return new VoiceSessionController(options);
}

export function normalizeVoiceProviderError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  return new Error("Voice provider error", { cause: error });
}

class VoiceSessionController implements VoiceSession {
  readonly id: string;
  readonly provider: string;
  readonly metadata: VoiceSessionMetadata;
  #state: VoiceConnectionState = "connected";
  #handlers = new Set<VoiceEventHandler>();
  #unsubscribeTransport?: () => void;
  #options: VoiceSessionControllerOptions;

  constructor(options: VoiceSessionControllerOptions) {
    this.id = options.id;
    this.provider = options.provider;
    this.metadata = options.metadata ?? { sessionId: options.id, provider: options.provider };
    this.#options = options;
    this.#unsubscribeTransport = options.transport?.onEvent((event) => {
      this.#handleTransportEvent(event);
    });
  }

  get state(): VoiceConnectionState {
    return this.#state;
  }

  onEvent(handler: VoiceEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async sendAudio(chunk: AudioInputChunk, signal?: AbortSignal): Promise<void> {
    await this.#options.onSendAudio?.(chunk, signal);
    await this.#options.transport?.send({ type: "audio", chunk }, signal);
  }

  async sendText(text: string, signal?: AbortSignal): Promise<void> {
    await this.#options.onSendText?.(text, signal);
    await this.#options.transport?.send({ type: "text", text }, signal);
  }

  async sendToolResult(result: VoiceToolResult, signal?: AbortSignal): Promise<void> {
    await this.#options.onSendToolResult?.(result, signal);
    await this.#options.transport?.send({ type: "tool_result", result }, signal);
    this.#emit({ type: "tool_result_sent", result });
  }

  async updateConfig(config: Partial<VoiceSessionConfig>, signal?: AbortSignal): Promise<void> {
    await this.#options.onUpdateConfig?.(config, signal);
    await this.#options.transport?.send({ type: "config", config }, signal);
  }

  async close(reason?: string): Promise<void> {
    if (this.#state === "closed" || this.#state === "closing") {
      return;
    }
    this.#state = "closing";
    await this.#options.onClose?.(reason);
    await this.#options.transport?.close(reason);
    this.#unsubscribeTransport?.();
    this.#state = "closed";
    this.#emit({ type: "closed", reason });
  }

  #handleTransportEvent(event: VoiceTransportEvent): void {
    if (event.type === "raw") {
      return;
    }
    if (event.type === "closed") {
      this.#state = "closed";
    }
    this.#emit(event);
  }

  #emit(event: VoiceEvent): void {
    const handlers = [...this.#handlers];
    for (const handler of handlers) {
      handler(event);
    }
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
