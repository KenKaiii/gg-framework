import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentPart,
  ServerToolCall,
  ServerToolResult,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ToolCall,
} from "../types.js";
import {
  ProviderError,
  readHeader,
  isHardBillingMessage,
  isRawJsonErrorEcho,
  isRawHtmlErrorEcho,
  emptyProviderErrorMessage,
  providerHtmlErrorMessage,
} from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import {
  downgradeUnsupportedImages,
  normalizeAnthropicStopReason,
  toAnthropicCacheControl,
  toAnthropicMessages,
  downgradeUnsupportedVideos,
  toAnthropicThinking,
  toAnthropicToolChoice,
  toAnthropicTools,
  isAdaptiveThinkingModel,
} from "./transform.js";
import { isJsonObject } from "../utils/json.js";

/**
 * Client cache — avoids re-instantiating the SDK on every stream() call.
 * The SDK constructor parses config, computes auth headers, and sets up the
 * fetch dispatcher. Node's undici pool already reuses TCP connections, but
 * the SDK overhead itself (config parsing, header computation) repeats on
 * every call. Keyed by the identity-relevant fields (apiKey, baseUrl,
 * userAgent) so a mid-session model switch (which may change the UA) gets a
 * fresh client.
 */
const anthropicClientCache = new Map<string, Anthropic>();

/**
 * Upper HTTP timeout for the non-streaming fallback request.
 *
 * The Anthropic SDK refuses any non-streaming `messages.create` whose
 * `max_tokens` implies a >10-minute worst case — it throws "Streaming is
 * required for operations that may take longer than 10 minutes" *client-side*,
 * before any network call (see `calculateNonstreamingTimeout`: the throw fires
 * when `(60*60*max_tokens)/128000 > 600s`, i.e. any `max_tokens > ~21333`).
 * Adaptive-thinking Opus/Sonnet models set `max_tokens` to their full output
 * ceiling (~32K), so the fallback tripped this every time. The SDK only runs
 * that pre-flight check when the *client* carries no explicit `timeout`, so we
 * set one here to bypass it. The agent loop already bounds this call with its
 * own abort signal (NON_STREAMING_HARD_TIMEOUT_MS), so this is just a ceiling.
 */
const NON_STREAMING_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Fine-grained (eager) tool-input streaming is OFF by default.
 *
 * With `eager_input_streaming` + the `fine-grained-tool-streaming-2025-05-14`
 * beta, Anthropic streams tool arguments token-by-token WITHOUT server-side
 * buffering/validation. If the SSE stream is truncated (large `edit` payloads
 * are the usual victim), the accumulated `argsJson` is incomplete and
 * `JSON.parse` throws — historically we swallowed that and emitted a phantom
 * `args:{}` call, which the tool layer rejected with "Invalid arguments".
 * Claude Code itself gates this behind a default-false flag
 * (`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING` / the `tengu_fgts`
 * experiment); we mirror that. Opt in with `GG_FINE_GRAINED_TOOL_STREAMING=1`
 * (or the Claude Code env var, for parity).
 */
export function fineGrainedToolStreamingEnabled(): boolean {
  const raw =
    process.env.GG_FINE_GRAINED_TOOL_STREAMING ??
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function createClient(options: StreamOptions): Anthropic {
  const isOAuth = options.apiKey?.startsWith("sk-ant-oat");
  const userAgent = isOAuth ? (options.userAgent ?? "claude-cli/2.1.75 (external, cli)") : "";
  const cacheKey = `${options.apiKey ?? ""}|${options.baseUrl ?? ""}|${userAgent}`;

  // Skip cache when a custom fetch is provided (tests, React Native, etc.) —
  // the cached client would carry the wrong fetch implementation.
  if (!options.fetch) {
    const cached = anthropicClientCache.get(cacheKey);
    if (cached) return cached;
  }

  const client = new Anthropic({
    ...(isOAuth
      ? { apiKey: null as unknown as string, authToken: options.apiKey }
      : { apiKey: options.apiKey }),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxRetries: 0,
    ...(isOAuth
      ? {
          defaultHeaders: {
            "user-agent": userAgent,
            "x-app": "cli",
          },
        }
      : {}),
  });

  // Only cache production clients (no custom fetch override).
  if (!options.fetch) {
    if (anthropicClientCache.size >= 8) {
      const oldest = anthropicClientCache.keys().next().value;
      if (oldest) anthropicClientCache.delete(oldest);
    }
    anthropicClientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Fire a minimal `max_tokens: 1` request that populates the Anthropic prompt
 * cache with the system prompt + tools prefix, so the first real user turn is
 * a cache read instead of a cold cache write. Best-effort: any error is
 * swallowed so a failed pre-warm never blocks the session.
 *
 * Called by AgentSession when speedProfile is "optimized", before the first
 * real agent-loop turn. The cache TTL follows the `cacheRetention` option —
 * pass "long" (1 h) so the pre-warm survives until the user's first message.
 */
export async function prewarmAnthropicCache(options: {
  apiKey: string;
  model: string;
  system: string;
  tools?: StreamOptions["tools"];
  serverTools?: StreamOptions["serverTools"];
  baseUrl?: string;
  userAgent?: string;
  cacheRetention?: StreamOptions["cacheRetention"];
  signal?: AbortSignal;
}): Promise<void> {
  try {
    const client = createClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      userAgent: options.userAgent,
    } as StreamOptions);
    const cacheControl = toAnthropicCacheControl(options.cacheRetention ?? "long", options.baseUrl);
    const { system, messages } = toAnthropicMessages(
      [
        { role: "system", content: options.system },
        { role: "user", content: "." },
      ],
      cacheControl,
    );
    const isOAuth = options.apiKey.startsWith("sk-ant-oat");
    const fullSystem = isOAuth
      ? [
          {
            type: "text" as const,
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
          ...(system ?? []),
        ]
      : system;
    const tools = options.tools?.length
      ? toAnthropicTools(options.tools, {
          cacheControl,
          // Keep the serialized tool bytes identical to runStream so the
          // prewarmed prompt cache actually hits — both are gated by the flag.
          enableFineGrainedToolStreaming: fineGrainedToolStreamingEnabled(),
        })
      : undefined;
    await client.messages.create(
      {
        model: options.model,
        max_tokens: 1,
        messages,
        ...(fullSystem ? { system: fullSystem as Anthropic.MessageCreateParams["system"] } : {}),
        ...(tools
          ? {
              tools: [
                ...tools,
                ...(options.serverTools ?? []),
              ] as Anthropic.MessageCreateParams["tools"],
            }
          : {}),
      } as Anthropic.MessageCreateParamsNonStreaming,
      {
        signal: options.signal ?? undefined,
        ...(() => {
          // Mirror runStream's beta headers for the parts that affect caching:
          // OAuth identity betas + the extended-cache-ttl beta, without which a
          // 1-h pre-warm silently writes a 5-min cache and expires before the
          // user's first turn.
          const betas = [
            ...(isOAuth ? ["claude-code-20250219", "oauth-2025-04-20"] : []),
            ...(cacheControl?.ttl === "1h" ? ["extended-cache-ttl-2025-04-11"] : []),
          ];
          return betas.length ? { headers: { "anthropic-beta": betas.join(",") } } : {};
        })(),
      },
    );
  } catch {
    // Best-effort — prewarm failure should never block the session.
  }
}

export function streamAnthropic(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const client = createClient(options);
  const isOAuth = options.apiKey?.startsWith("sk-ant-oat");
  const useStreaming = options.streaming !== false;

  const cacheControl = toAnthropicCacheControl(options.cacheRetention, options.baseUrl);
  const supportsFirstPartyToolExtras =
    !options.baseUrl || options.baseUrl.includes("api.anthropic.com");
  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  const downgradedMessages = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  const { system: rawSystem, messages } = toAnthropicMessages(downgradedMessages, cacheControl);

  // OAuth tokens require Claude Code identity in the system prompt
  const system = isOAuth
    ? [
        {
          type: "text" as const,
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        ...(rawSystem ?? []),
      ]
    : rawSystem;

  let maxTokens = options.maxTokens ?? 4096;
  let thinking: Anthropic.ThinkingConfigParam | undefined;
  let outputConfig: Record<string, unknown> | undefined;

  if (options.thinking) {
    const t = toAnthropicThinking(options.thinking, maxTokens, options.model);
    thinking = t.thinking;
    maxTokens = t.maxTokens;
    if (t.outputConfig) {
      outputConfig = t.outputConfig;
    }
  }

  const params: Anthropic.MessageCreateParams = {
    model: options.model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system: system as Anthropic.MessageCreateParams["system"] } : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig
      ? { output_config: outputConfig as unknown as Anthropic.MessageCreateParams["output_config"] }
      : {}),
    ...(options.temperature != null && !thinking ? { temperature: options.temperature } : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop_sequences: options.stop } : {}),
    ...(options.tools?.length || options.serverTools?.length || options.webSearch
      ? (() => {
          // Build the tools array with server-side tools taking precedence over
          // client tools that share their name. Anthropic rejects duplicate tool
          // names with a 400, so when both a client `web_search` (from a non-
          // anthropic provider's tool list left over after a /model switch) and
          // the native server-side web_search are present, drop the client one.
          const reservedServerNames = new Set<string>();
          if (options.webSearch) reservedServerNames.add("web_search");
          for (const t of options.serverTools ?? []) {
            const name = (t as { name?: string }).name;
            if (name) reservedServerNames.add(name);
          }
          const clientTools = options.tools?.length
            ? toAnthropicTools(
                options.tools.filter((t) => !reservedServerNames.has(t.name)),
                {
                  ...(supportsFirstPartyToolExtras && cacheControl ? { cacheControl } : {}),
                  ...(supportsFirstPartyToolExtras && fineGrainedToolStreamingEnabled()
                    ? { enableFineGrainedToolStreaming: true }
                    : {}),
                },
              )
            : [];
          return {
            tools: [
              ...clientTools,
              ...(options.serverTools ?? []),
              ...(options.webSearch ? [{ type: "web_search_20250305", name: "web_search" }] : []),
            ] as Anthropic.MessageCreateParams["tools"],
          };
        })()
      : {}),
    ...(options.toolChoice && options.tools?.length
      ? { tool_choice: toAnthropicToolChoice(options.toolChoice) }
      : {}),
    ...(() => {
      const contextEdits = [
        ...(options.compaction ? [{ type: "compact_20260112" }] : []),
        ...(options.clearToolUses ? [{ type: "clear_tool_uses_20250919" }] : []),
      ];
      return contextEdits.length ? { context_management: { edits: contextEdits } } : {};
    })(),
    stream: useStreaming,
  } as Anthropic.MessageCreateParams;

  // Adaptive thinking models (Opus 5, Opus 4.8/4.7/4.6, Sonnet 5, Fable 5)
  // don't need the interleaved-thinking beta — they have it built in.
  const hasAdaptiveThinking = isAdaptiveThinkingModel(options.model);

  const betaHeaders = [
    ...(isOAuth ? ["claude-code-20250219", "oauth-2025-04-20"] : []),
    ...(options.compaction ? ["compact-2026-01-12"] : []),
    ...(options.clearToolUses ? ["context-management-2025-06-27"] : []),
    // Eager tool-input streaming beta — opt-in only (see
    // fineGrainedToolStreamingEnabled). Off by default: the un-buffered stream
    // truncates large tool payloads into malformed JSON → phantom empty calls.
    ...(fineGrainedToolStreamingEnabled() ? ["fine-grained-tool-streaming-2025-05-14"] : []),
    ...(!hasAdaptiveThinking ? ["interleaved-thinking-2025-05-14"] : []),
    // The 1-h cache TTL (cacheRetention "long") is gated behind this beta. Without
    // it Anthropic silently ignores ttl:"1h" and falls back to the 5-min default,
    // so a pre-warmed cache expires before the user's first turn. cacheControl.ttl
    // is only "1h" on the first-party endpoint (see toAnthropicCacheControl).
    ...(cacheControl?.ttl === "1h" ? ["extended-cache-ttl-2025-04-11"] : []),
  ];

  const requestOptions = {
    signal: options.signal ?? undefined,
    ...(betaHeaders.length ? { headers: { "anthropic-beta": betaHeaders.join(",") } } : {}),
  };

  // Non-streaming fallback: issue a single request/response and synthesize
  // stream events from the final Message. Used by the agent loop after the
  // SSE stream has stalled repeatedly -- broken streaming connections often
  // recover when the request is replayed over a plain HTTP response.
  if (!useStreaming) {
    try {
      // withOptions() clones the client (sharing auth state) with an explicit
      // timeout set, which suppresses the SDK's bogus "Streaming is required…"
      // pre-flight throw for large max_tokens. See NON_STREAMING_REQUEST_TIMEOUT_MS.
      const nonStreamingClient = client.withOptions({
        timeout: NON_STREAMING_REQUEST_TIMEOUT_MS,
      });
      const message = (await nonStreamingClient.messages.create(
        { ...params, stream: false } as Anthropic.MessageCreateParamsNonStreaming,
        requestOptions,
      )) as Anthropic.Message;
      yield* synthesizeEventsFromMessage(message);
      return messageToResponse(message);
    } catch (err) {
      throw toError(err);
    }
  }

  // ── Accumulation state ──────────────────────────────────
  const contentParts: ContentPart[] = [];

  // Per-block accumulators indexed by content_block_start index
  const blocks = new Map<
    number,
    {
      type: string;
      text: string;
      thinking: string;
      signature: string;
      toolId: string;
      toolName: string;
      argsJson: string;
      input: unknown;
      raw: Record<string, unknown> | null;
    }
  >();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let stopReason: string | null = null;

  const keepalive = { type: "keepalive" as const };
  let receivedAnyEvent = false;

  try {
    // Use the low-level streaming request instead of the SDK's `messages.stream()`
    // helper. The helper starts its request immediately; if Anthropic rejects the
    // request before our async iterator attaches listeners, its iterator can miss
    // the already-emitted error/end event and wait forever. That surfaced as the
    // CLI sitting on "Working..." when an OAuth account ran out of usage.
    const stream = (await client.messages.create(
      params as Anthropic.MessageCreateParamsStreaming,
      requestOptions,
    )) as AsyncIterable<Anthropic.MessageStreamEvent>;

    for await (const event of stream) {
      receivedAnyEvent = true;
      switch (event.type) {
        case "message_start": {
          const usage = event.message.usage;
          inputTokens = usage.input_tokens;
          const usageAny = usage as unknown as Record<string, unknown>;
          if (usageAny.cache_read_input_tokens != null) {
            cacheRead = usageAny.cache_read_input_tokens as number;
          }
          if (usageAny.cache_creation_input_tokens != null) {
            cacheWrite = usageAny.cache_creation_input_tokens as number;
          }
          yield keepalive;
          break;
        }

        case "content_block_start": {
          const block = event.content_block;
          const idx = event.index;
          const accum = {
            type: block.type,
            text: "",
            thinking: "",
            signature: "",
            toolId: "",
            toolName: "",
            argsJson: "",
            input: undefined as unknown,
            raw: null as Record<string, unknown> | null,
          };

          if (block.type === "tool_use") {
            accum.toolId = block.id;
            accum.toolName = block.name;
            accum.input = (block as unknown as { input?: unknown }).input;
          } else if (block.type === "server_tool_use") {
            accum.toolId = (block as unknown as { id: string }).id;
            accum.toolName = (block as unknown as { name: string }).name;
            accum.input = (block as unknown as { input: unknown }).input;
          } else if (block.type !== "text" && block.type !== "thinking") {
            // Preserve unknown/encrypted blocks from their start event. We no longer
            // use the SDK MessageStream helper's `currentMessage` snapshot because
            // it can miss early request errors and hang its iterator.
            accum.raw = block as unknown as Record<string, unknown>;
          }

          blocks.set(idx, accum);
          // Surface "reasoning started" as an empty thinking_delta the moment
          // a thinking content block opens, so the UI flips to the thinking
          // phase before the first delta with real content arrives.
          if (block.type === "thinking") {
            yield { type: "thinking_delta", text: "" };
          } else {
            yield keepalive;
          }
          break;
        }

        case "content_block_delta": {
          const accum = blocks.get(event.index);
          if (!accum) break;

          const delta = event.delta as unknown as Record<string, unknown>;
          const deltaType = delta.type as string;

          if (deltaType === "text_delta") {
            const text = delta.text as string;
            accum.text += text;
            yield { type: "text_delta", text };
          } else if (deltaType === "thinking_delta") {
            const text = delta.thinking as string;
            accum.thinking += text;
            yield { type: "thinking_delta", text };
          } else if (deltaType === "input_json_delta") {
            const partialJson = delta.partial_json as string;
            accum.argsJson += partialJson;
            yield {
              type: "toolcall_delta",
              id: accum.toolId,
              name: accum.toolName,
              argsJson: partialJson,
            };
          } else if (deltaType === "signature_delta") {
            accum.signature = delta.signature as string;
          }
          break;
        }

        case "content_block_stop": {
          const accum = blocks.get(event.index);
          if (!accum) break;

          if (accum.type === "text") {
            contentParts.push({ type: "text", text: accum.text });
          } else if (accum.type === "thinking") {
            contentParts.push({
              type: "thinking",
              text: accum.thinking,
              signature: accum.signature,
            });
            yield keepalive;
          } else if (accum.type === "tool_use") {
            let args: Record<string, unknown> = isJsonObject(accum.input) ? accum.input : {};
            if (accum.argsJson) {
              try {
                const parsed = JSON.parse(accum.argsJson) as unknown;
                args = isJsonObject(parsed) ? parsed : {};
              } catch (parseErr) {
                // The streamed tool-input JSON arrived truncated/malformed. Do
                // NOT silently fall back to {} — that emits a phantom empty
                // tool call (e.g. `edit` with no file_path/edits) which the
                // tool layer rejects with "Invalid arguments" and the model
                // then has to guess how to recover from. Instead surface it as
                // a malformed-stream failure.
                //
                // Deliberately NO statusCode: a 5xx would make classifyOverload()
                // treat this as a transient provider error and replay in the
                // SAME streaming mode (which just re-truncates). Leaving it
                // status-less keeps classifyOverload() null, so agent-loop falls
                // through to isMalformedStream() — which walks the SyntaxError
                // `cause` and routes the retry into the non-streaming fallback
                // that returns the complete tool input.
                // Keep the raw partial JSON on the error (bounded so a large
                // truncated `edit` payload can't bloat logs) for debugging.
                const rawPartial = accum.argsJson;
                const snippet =
                  rawPartial.length > 200 ? `${rawPartial.slice(0, 200)}\u2026` : rawPartial;
                throw new ProviderError(
                  "anthropic",
                  `Tool "${accum.toolName}" input JSON was truncated in the stream ` +
                    `(${rawPartial.length} bytes): ${snippet}; ${(parseErr as Error).message}`,
                  { cause: parseErr },
                );
              }
            }
            const tc: ToolCall = {
              type: "tool_call",
              id: accum.toolId,
              name: accum.toolName,
              args,
            };
            contentParts.push(tc);
            yield {
              type: "toolcall_done",
              id: tc.id,
              name: tc.name,
              args: tc.args,
            };
          } else if (accum.type === "server_tool_use") {
            // Server tools (e.g. native web_search) stream their input via
            // input_json_delta the same way client tool_use does. The block-start
            // `input` is empty `{}` and only the accumulated `argsJson` carries
            // the real arguments (e.g. the search query). Prefer the parsed
            // streamed JSON, falling back to the block-start input only when
            // argsJson is absent/malformed -- otherwise the query is dropped and
            // Anthropic rejects the call with `invalid_tool_input`.
            let input: unknown = accum.input;
            if (accum.argsJson) {
              try {
                input = JSON.parse(accum.argsJson);
              } catch {
                // malformed JSON -- keep the block-start input fallback
              }
            }
            const stc: ServerToolCall = {
              type: "server_tool_call",
              id: accum.toolId,
              name: accum.toolName,
              input,
            };
            contentParts.push(stc);
            yield {
              type: "server_toolcall",
              id: stc.id,
              name: stc.name,
              input: stc.input,
            };
          } else if (accum.type === "redacted_thinking" && accum.raw) {
            contentParts.push({ type: "raw", data: accum.raw });
            yield keepalive;
          } else {
            const rawBlock = accum.raw;
            if (rawBlock) {
              const blockType = rawBlock.type as string;
              if (blockType === "web_search_tool_result") {
                const str: ServerToolResult = {
                  type: "server_tool_result",
                  toolUseId: rawBlock.tool_use_id as string,
                  resultType: blockType,
                  data: rawBlock,
                };
                contentParts.push(str);
                yield {
                  type: "server_toolresult",
                  toolUseId: str.toolUseId,
                  resultType: str.resultType,
                  data: str.data,
                };
              } else {
                // Preserve unknown blocks (e.g. compaction) for round-tripping
                contentParts.push({ type: "raw", data: rawBlock });
              }
            }
          }

          blocks.delete(event.index);
          break;
        }

        case "message_delta": {
          const delta = event.delta as unknown as Record<string, unknown>;
          if (delta.stop_reason) {
            stopReason = delta.stop_reason as string;
          }
          const usage = event.usage as unknown as Record<string, unknown> | undefined;
          if (usage?.output_tokens != null) {
            outputTokens = usage.output_tokens as number;
          }
          yield keepalive;
          break;
        }

        // message_stop — loop exits naturally

        default:
          // Unhandled event types (e.g. "ping" heartbeats) — yield keepalive
          // so the idle timer in the agent loop resets on any API activity.
          yield keepalive;
          break;
      }
    }
  } catch (err) {
    throw toError(err);
  }

  // Race-condition safety: if the SDK's stream ended (or error'd) before the
  // first event was yielded, the loop exits silently with an empty response.
  // Treat that as a transport failure so the agent loop retries instead of
  // presenting a phantom empty reply.
  if (!receivedAnyEvent) {
    throw new ProviderError("anthropic", "Stream ended without producing any events.", {
      statusCode: 504,
    });
  }

  // Silent-partial guard: a complete Anthropic stream always emits `message_delta`
  // (carrying stop_reason) *before* `message_stop`. So consuming events but never
  // seeing a stop_reason means the stream was truncated mid-flight — a clean TCP
  // close with no terminal events. Without this guard, normalizeAnthropicStopReason
  // maps the null stop into "end_turn", making a truncated turn indistinguishable
  // from a finished one. Throw a 504 so the agent loop treats it as a retryable
  // transport failure (same bucket as a mid-stream socket destroy). The partial
  // body is surfaced on `cause` for debugging, never silently returned.
  if (stopReason === null) {
    throw new ProviderError("anthropic", "Stream ended before completion (no stop_reason).", {
      statusCode: 504,
      cause: { partialContent: contentParts, outputTokens },
    });
  }

  const normalizedStop = normalizeAnthropicStopReason(stopReason);

  const response: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : "",
    },
    stopReason: normalizedStop,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheRead != null && { cacheRead }),
      ...(cacheWrite != null && { cacheWrite }),
    },
  };

  yield { type: "done", stopReason: normalizedStop };
  return response;
}

/**
 * Walk a non-streaming Anthropic Message and yield the same StreamEvents
 * that the streaming path would produce. Emits one large delta per block
 * rather than token-by-token -- the agent loop consumer doesn't care about
 * granularity, only completeness.
 */
function* synthesizeEventsFromMessage(message: Anthropic.Message): Generator<StreamEvent, void> {
  for (const block of message.content) {
    const blk = block as unknown as Record<string, unknown>;
    const type = blk.type as string;

    if (type === "text") {
      const text = blk.text as string;
      if (text) yield { type: "text_delta", text };
    } else if (type === "thinking") {
      const text = blk.thinking as string;
      if (text) yield { type: "thinking_delta", text };
    } else if (type === "tool_use") {
      const argsJson = JSON.stringify(blk.input ?? {});
      yield {
        type: "toolcall_delta",
        id: blk.id as string,
        name: blk.name as string,
        argsJson,
      };
      yield {
        type: "toolcall_done",
        id: blk.id as string,
        name: blk.name as string,
        args: (blk.input as Record<string, unknown> | undefined) ?? {},
      };
    } else if (type === "server_tool_use") {
      yield {
        type: "server_toolcall",
        id: blk.id as string,
        name: blk.name as string,
        input: blk.input,
      };
    } else if (type === "web_search_tool_result") {
      yield {
        type: "server_toolresult",
        toolUseId: blk.tool_use_id as string,
        resultType: type,
        data: blk,
      };
    }
    // Other block types (redacted_thinking, compaction blocks) are preserved
    // in the response via messageToResponse but don't emit events.
  }
  yield { type: "done", stopReason: normalizeAnthropicStopReason(message.stop_reason) };
}

/** Convert a non-streaming Anthropic Message into our StreamResponse shape. */
function messageToResponse(message: Anthropic.Message): StreamResponse {
  const contentParts: ContentPart[] = [];
  for (const block of message.content) {
    const blk = block as unknown as Record<string, unknown>;
    const type = blk.type as string;

    if (type === "text") {
      contentParts.push({ type: "text", text: blk.text as string });
    } else if (type === "thinking") {
      contentParts.push({
        type: "thinking",
        text: blk.thinking as string,
        signature: (blk.signature as string) ?? "",
      });
    } else if (type === "tool_use") {
      contentParts.push({
        type: "tool_call",
        id: blk.id as string,
        name: blk.name as string,
        args: (blk.input as Record<string, unknown> | undefined) ?? {},
      });
    } else if (type === "server_tool_use") {
      contentParts.push({
        type: "server_tool_call",
        id: blk.id as string,
        name: blk.name as string,
        input: blk.input,
      });
    } else if (type === "web_search_tool_result") {
      contentParts.push({
        type: "server_tool_result",
        toolUseId: blk.tool_use_id as string,
        resultType: type,
        data: blk,
      });
    } else {
      // Preserve unknown blocks (redacted_thinking, compaction) for round-tripping
      contentParts.push({ type: "raw", data: blk });
    }
  }

  const usage = message.usage as unknown as Record<string, unknown>;
  const inputTokens = (usage.input_tokens as number) ?? 0;
  const outputTokens = (usage.output_tokens as number) ?? 0;
  const cacheRead = usage.cache_read_input_tokens as number | undefined;
  const cacheWrite = usage.cache_creation_input_tokens as number | undefined;

  return {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : "",
    },
    stopReason: normalizeAnthropicStopReason(message.stop_reason),
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheRead != null && { cacheRead }),
      ...(cacheWrite != null && { cacheWrite }),
    },
  };
}

/**
 * Read Anthropic's unified rate-limit headers — the subscription (OAuth) quota
 * signal. `anthropic-ratelimit-unified-status: rejected` means the usage window
 * is spent (not a transient per-minute throttle); `-reset` is the unix-seconds
 * reset time. Works against a web `Headers` object or a plain header record.
 */
function readUnifiedRateLimit(headers: unknown): { rejected: boolean; resetsAt?: number } {
  const status = readHeader(headers, "anthropic-ratelimit-unified-status");
  const resetRaw = readHeader(
    headers,
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-unified-5h-reset",
    "anthropic-ratelimit-unified-7d-reset",
  );
  const resetNum = resetRaw != null ? Number(resetRaw) : Number.NaN;
  const resetsAt = Number.isFinite(resetNum) && resetNum > 0 ? resetNum : undefined;
  return { rejected: status === "rejected", ...(resetsAt ? { resetsAt } : {}) };
}

function toError(err: unknown): ProviderError {
  // Already normalized (e.g. the truncated-tool-JSON guard in runStream throws a
  // ProviderError whose cause is the SyntaxError). Pass it through untouched so
  // its statusCode and cause chain survive for agent-loop's retry classifiers
  // (isMalformedStream walks one level of `.cause`).
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIError) {
    // Anthropic exposes request IDs as `requestID` in current SDKs, `request_id`
    // in older/compat shapes, and sometimes inside the streamed error body.
    const errorBody = err.error as Record<string, unknown> | undefined;
    const nestedError = errorBody?.error as Record<string, unknown> | undefined;
    const requestId =
      (err as unknown as { requestID?: string | null }).requestID ??
      (err as unknown as { request_id?: string | null }).request_id ??
      (typeof errorBody?.request_id === "string" ? errorBody.request_id : undefined) ??
      (typeof nestedError?.request_id === "string" ? nestedError.request_id : undefined) ??
      undefined;
    // Guard against an empty-string message (e.g. MiniMax's Anthropic-transport
    // path returning `{ message: "" }`) counting as "usable" — that would win
    // over the raw-JSON-echo fallback below and surface a blank error instead.
    const bodyMessage =
      typeof nestedError?.message === "string" && nestedError.message.trim()
        ? nestedError.message.trim()
        : typeof errorBody?.message === "string" && errorBody.message.trim()
          ? errorBody.message.trim()
          : undefined;
    const bodyType =
      typeof nestedError?.type === "string"
        ? nestedError.type
        : typeof errorBody?.type === "string"
          ? errorBody.type
          : typeof (err as unknown as { type?: unknown }).type === "string"
            ? ((err as unknown as { type: string }).type as string)
            : undefined;
    // The SDK may expose raw JSON or a whole HTML edge/proxy page through either
    // the parsed body or err.message. Preserve the original on `cause`, but never
    // send transport markup to the user.
    const fallbackMessage = isRawJsonErrorEcho(err.message)
      ? emptyProviderErrorMessage(err.status)
      : err.message;
    const messageCandidate = bodyMessage ?? err.message;
    const message = isRawHtmlErrorEcho(messageCandidate)
      ? providerHtmlErrorMessage(err.status)
      : bodyType && bodyMessage
        ? `${bodyType}: ${bodyMessage}`
        : (bodyMessage ?? fallbackMessage);

    // Subscription (OAuth) usage-window exhaustion. Anthropic returns 429 with
    // the unified rate-limit headers; a "rejected" status — or a reset stamp
    // meaningfully in the future — means the plan's usage is spent, not a
    // transient per-minute throttle. Stamp a canonical message so downstream
    // retry logic stops instead of burning minutes retrying.
    if (err.status === 429) {
      const limit = readUnifiedRateLimit(err.headers);
      const farOff = limit.resetsAt != null && limit.resetsAt * 1000 - Date.now() > 60_000;
      if (limit.rejected || farOff) {
        return new ProviderError("anthropic", "Claude usage limit reached", {
          statusCode: 429,
          ...(requestId ? { requestId } : {}),
          ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
          cause: err,
        });
      }
    }

    // Hard billing/quota stop, regardless of status code. MiniMax (Anthropic
    // transport) returns these as HTTP 500 `api_error` "insufficient balance";
    // the Anthropic API key path returns a 400 "credit balance is too low".
    // Both would otherwise be treated as transient and retried — stamp the
    // canonical "usage limit reached" token so the loop surfaces it once.
    if (isHardBillingMessage(message)) {
      const usageMessage = /usage limit reached/i.test(message)
        ? message
        : `usage limit reached: ${message}`;
      return new ProviderError("anthropic", usageMessage, {
        statusCode: err.status,
        ...(requestId ? { requestId } : {}),
        cause: err,
      });
    }

    return new ProviderError("anthropic", message, {
      statusCode: err.status,
      ...(requestId ? { requestId } : {}),
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new ProviderError("anthropic", err.message, { cause: err });
  }
  return new ProviderError("anthropic", String(err));
}
