import type {
  AssistantMessage,
  ContentPart,
  Message,
  StopReason,
  StreamOptions,
  Usage,
} from "../types.js";
import { StreamResult } from "../utils/event-stream.js";
import { providerRegistry } from "../provider-registry.js";

// ── Response Types ────────────────────────────────────────

export interface PalsuProviderState {
  callCount: number;
}

export type PalsuResponseFactory = (
  messages: Message[],
  options: StreamOptions,
  state: PalsuProviderState,
) => AssistantMessage | Promise<AssistantMessage>;

export type PalsuResponse = AssistantMessage | PalsuResponseFactory;

// ── Helper Constructors ───────────────────────────────────

/** Create an assistant message with a single text block. */
export function palsuText(text: string): AssistantMessage {
  return { role: "assistant", content: text ? [{ type: "text", text }] : [] };
}

/** Create an assistant message with a thinking block and optional text reply. */
export function palsuThinking(thinking: string, text?: string): AssistantMessage {
  const content: ContentPart[] = [{ type: "thinking", text: thinking }];
  if (text) content.push({ type: "text", text });
  return { role: "assistant", content };
}

/** Create an assistant message with a single tool call. */
export function palsuToolCall(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: id ?? `palsu_${name}_${Date.now()}`, name, args }],
  };
}

/** Create an assistant message from content parts with optional stop reason. */
export function palsuAssistantMessage(
  content: ContentPart[],
  options?: { stopReason?: StopReason },
): AssistantMessage & { _stopReason?: StopReason } {
  return { role: "assistant", content, _stopReason: options?.stopReason };
}

// ── Streaming Simulation ──────────────────────────────────

const DEFAULT_CHUNK_SIZE = 20;

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [""];
}

interface CacheUsage {
  cacheRead: number;
  cacheWrite: number;
}

function simulateStream(
  message: AssistantMessage,
  stopReason: StopReason,
  result: StreamResult,
  signal?: AbortSignal,
  cacheUsage?: CacheUsage,
): void {
  if (signal?.aborted) {
    result.abort(new Error("aborted"));
    return;
  }

  const content =
    typeof message.content === "string"
      ? message.content
        ? [{ type: "text" as const, text: message.content }]
        : []
      : message.content;

  let outputChars = 0;

  for (const part of content) {
    if (signal?.aborted) {
      result.abort(new Error("aborted"));
      return;
    }

    if (part.type === "text") {
      const chunks = chunkText(part.text, DEFAULT_CHUNK_SIZE);
      for (const chunk of chunks) {
        result.push({ type: "text_delta", text: chunk });
        outputChars += chunk.length;
      }
    } else if (part.type === "thinking") {
      result.push({ type: "thinking_delta", text: part.text });
      outputChars += part.text.length;
    } else if (part.type === "tool_call") {
      const argsJson = JSON.stringify(part.args);
      result.push({ type: "toolcall_delta", id: part.id, name: part.name, argsJson });
      result.push({ type: "toolcall_done", id: part.id, name: part.name, args: part.args });
      outputChars += argsJson.length;
    }
  }

  // Rough token estimate: ~4 chars per token
  const outputTokens = Math.max(1, Math.ceil(outputChars / 4));
  const usage: Usage = {
    inputTokens: 100,
    outputTokens,
    ...(cacheUsage?.cacheRead ? { cacheRead: cacheUsage.cacheRead } : {}),
    ...(cacheUsage?.cacheWrite ? { cacheWrite: cacheUsage.cacheWrite } : {}),
  };

  result.push({ type: "done", stopReason });
  result.complete({ message, stopReason, usage });
}

// ── Prompt Cache Simulation ──────────────────────────────

function computeCacheUsage(current: string, previous: string | null): CacheUsage {
  if (!previous) {
    // First call — everything is a cache write
    return { cacheRead: 0, cacheWrite: Math.ceil(current.length / 4) };
  }
  // Find common prefix length
  const maxLen = Math.min(current.length, previous.length);
  let commonLen = 0;
  for (let i = 0; i < maxLen; i++) {
    if (current[i] !== previous[i]) break;
    commonLen++;
  }
  return {
    cacheRead: Math.ceil(commonLen / 4),
    cacheWrite: Math.ceil((current.length - commonLen) / 4),
  };
}

// ── Model Config ─────────────────────────────────────────

export interface PalsuModelConfig {
  /** Default response for this model when its queue is empty. */
  defaultResponse?: PalsuResponse;
}

interface ModelState {
  responses: PalsuResponse[];
  defaultResponse?: PalsuResponse;
}

// ── Registration Handle ───────────────────────────────────

export interface PalsuModelHandle {
  /** Replace this model's response queue. */
  setResponses(responses: PalsuResponse[]): void;
  /** Append responses to this model's queue. */
  appendResponses(...responses: PalsuResponse[]): void;
  /** Number of unconsumed responses in this model's queue. */
  getPendingResponseCount(): number;
}

export interface PalsuProviderHandle {
  /** Replace the shared response queue entirely. */
  setResponses(responses: PalsuResponse[]): void;
  /** Append responses to the shared queue. */
  appendResponses(...responses: PalsuResponse[]): void;
  /** Number of unconsumed responses in the shared queue. */
  getPendingResponseCount(): number;
  /** Mutable state — tracks call count. */
  state: PalsuProviderState;
  /** Get a handle for a model-specific response queue. */
  getModel(name: string): PalsuModelHandle;
  /** Remove this provider from the registry. */
  unregister(): void;
}

export interface PalsuProviderConfig {
  /** Provider name to register under. Default: "palsu". */
  name?: string;
  /** Response returned when all queues are empty. Default: empty text message. */
  defaultResponse?: PalsuResponse;
  /** Enable prompt cache simulation. Tracks common message prefixes across calls. */
  promptCache?: boolean;
  /** Model-specific configurations with per-model response queues. */
  models?: Record<string, PalsuModelConfig>;
}

// ── Main Registration Function ────────────────────────────

/**
 * Register a palsu (mock) LLM provider for testing.
 * Returns a handle to control responses and inspect state.
 *
 * ```ts
 * const palsu = registerPalsuProvider();
 * palsu.appendResponses(palsuText("Hello!"));
 *
 * const result = await stream({ provider: "palsu", model: "test", messages });
 * console.log(result.message); // { role: "assistant", content: [{ type: "text", text: "Hello!" }] }
 *
 * palsu.unregister(); // cleanup
 * ```
 */
export function registerPalsuProvider(config?: PalsuProviderConfig): PalsuProviderHandle {
  const name = config?.name ?? "palsu";
  const responses: PalsuResponse[] = [];
  const state: PalsuProviderState = { callCount: 0 };
  const defaultResponse = config?.defaultResponse ?? palsuText("");
  const enableCache = config?.promptCache ?? false;
  let lastMessagesSerialized: string | null = null;

  // Initialize model-specific state
  const modelStates = new Map<string, ModelState>();
  if (config?.models) {
    for (const [modelName, modelConfig] of Object.entries(config.models)) {
      modelStates.set(modelName, {
        responses: [],
        defaultResponse: modelConfig.defaultResponse,
      });
    }
  }

  const handle: PalsuProviderHandle = {
    setResponses(r) {
      responses.length = 0;
      responses.push(...r);
    },
    appendResponses(...r) {
      responses.push(...r);
    },
    getPendingResponseCount() {
      return responses.length;
    },
    state,
    getModel(modelName: string): PalsuModelHandle {
      if (!modelStates.has(modelName)) {
        modelStates.set(modelName, { responses: [] });
      }
      const ms = modelStates.get(modelName)!;
      return {
        setResponses(r) {
          ms.responses.length = 0;
          ms.responses.push(...r);
        },
        appendResponses(...r) {
          ms.responses.push(...r);
        },
        getPendingResponseCount() {
          return ms.responses.length;
        },
      };
    },
    unregister() {
      providerRegistry.unregister(name);
    },
  };

  providerRegistry.register(name, {
    stream(options: StreamOptions): StreamResult {
      state.callCount++;

      // Resolve response: model-specific queue → shared queue → model default → shared default
      const ms = modelStates.get(options.model);
      const responseDef =
        (ms && ms.responses.length > 0 ? ms.responses.shift() : undefined) ??
        (responses.length > 0 ? responses.shift() : undefined) ??
        ms?.defaultResponse ??
        defaultResponse;

      const result = new StreamResult();

      // Compute cache usage before streaming (needs messages serialized)
      let cacheUsage: CacheUsage | undefined;
      if (enableCache) {
        const serialized = JSON.stringify(options.messages);
        cacheUsage = computeCacheUsage(serialized, lastMessagesSerialized);
        lastMessagesSerialized = serialized;
      }

      // Resolve factory (sync or async) then stream
      const rawMessage =
        typeof responseDef === "function"
          ? responseDef(options.messages, options, state)
          : responseDef;

      Promise.resolve(rawMessage).then(
        (message) => {
          const hasToolCalls =
            Array.isArray(message.content) && message.content.some((p) => p.type === "tool_call");
          const explicitStop = (message as { _stopReason?: StopReason })._stopReason;
          const stopReason = explicitStop ?? (hasToolCalls ? "tool_use" : "end_turn");
          simulateStream(message, stopReason, result, options.signal, cacheUsage);
        },
        (err) => result.abort(err instanceof Error ? err : new Error(String(err))),
      );

      return result;
    },
  });

  return handle;
}
