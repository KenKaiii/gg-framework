import type {
  AudioInputChunk,
  VoiceEvent,
  VoiceEventHandler,
  VoiceProvider,
  VoiceProviderConnectOptions,
  VoiceSession,
  VoiceSessionConfig,
  VoiceToolCall,
  VoiceToolResult,
} from "../types.js";

export interface InMemoryVoiceProviderOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface InMemoryVoiceProvider extends Omit<VoiceProvider, "connect"> {
  readonly sessions: readonly InMemoryVoiceSession[];
  connect(options: VoiceProviderConnectOptions): Promise<InMemoryVoiceSession>;
}

export interface InMemoryVoiceSession extends VoiceSession {
  emit(event: VoiceEvent): void;
  readonly sentAudio: readonly AudioInputChunk[];
  readonly sentText: readonly string[];
  readonly sentToolResults: readonly VoiceToolResult[];
  triggerToolCall(call: VoiceToolCall): void;
}

export function createInMemoryVoiceProvider(
  options: InMemoryVoiceProviderOptions = {},
): InMemoryVoiceProvider {
  const sessions: InMemorySession[] = [];
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `voice_${sessions.length + 1}`);

  return {
    name: "in-memory",
    get sessions() {
      return sessions;
    },
    async connect(connectOptions: VoiceProviderConnectOptions): Promise<InMemoryVoiceSession> {
      const id = idFactory();
      const session = new InMemorySession(id, connectOptions.session, now);
      sessions.push(session);
      session.emit({
        type: "session_started",
        session: session.metadata,
      });
      return session;
    },
  };
}

class InMemorySession implements InMemoryVoiceSession {
  readonly id: string;
  readonly provider = "in-memory";
  readonly metadata;
  #state: VoiceSession["state"] = "connected";
  #handlers = new Set<VoiceEventHandler>();
  #sentAudio: AudioInputChunk[] = [];
  #sentText: string[] = [];
  #sentToolResults: VoiceToolResult[] = [];

  constructor(id: string, config: VoiceSessionConfig, now: () => Date) {
    this.id = id;
    this.metadata = {
      sessionId: id,
      provider: "in-memory",
      model: config.model,
      createdAt: now().toISOString(),
    };
  }

  get state(): VoiceSession["state"] {
    return this.#state;
  }

  get sentAudio(): readonly AudioInputChunk[] {
    return this.#sentAudio;
  }

  get sentText(): readonly string[] {
    return this.#sentText;
  }

  get sentToolResults(): readonly VoiceToolResult[] {
    return this.#sentToolResults;
  }

  onEvent(handler: VoiceEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async sendAudio(chunk: AudioInputChunk): Promise<void> {
    this.#sentAudio.push(chunk);
  }

  async sendText(text: string): Promise<void> {
    this.#sentText.push(text);
    this.emit({ type: "input_transcript_done", text });
  }

  async sendToolResult(result: VoiceToolResult): Promise<void> {
    this.#sentToolResults.push(result);
    this.emit({ type: "tool_result_sent", result });
  }

  async updateConfig(_config: Partial<VoiceSessionConfig>): Promise<void> {}

  async close(reason?: string): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.emit({ type: "closed", reason });
  }

  emit(event: VoiceEvent): void {
    const handlers = [...this.#handlers];
    for (const handler of handlers) {
      handler(event);
    }
  }

  triggerToolCall(call: VoiceToolCall): void {
    this.emit({ type: "tool_call", call });
  }
}
