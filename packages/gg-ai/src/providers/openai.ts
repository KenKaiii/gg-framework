import OpenAI from "openai";
import type {
  ContentPart,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ThinkingLevel,
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
  downgradeUnsupportedVideos,
  normalizeOpenAIStopReason,
  toOpenAIMessages,
  toOpenAIReasoningEffort,
  toOpenAIToolChoice,
  toOpenAITools,
} from "./transform.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";
import { uploadMoonshotVideos } from "./moonshot-video.js";
import { parseToolArguments } from "../utils/json.js";
import { getEnvironment } from "../utils/env.js";

// Kimi K3's declared effort rungs (server-validated; anything else 400s).
// Official alias mapping from Moonshot's K3 third-party-tools docs:
// ultra/max/xhigh → max, high/medium → high, low → low.
type KimiK3Effort = "low" | "high" | "max";
function toKimiK3Effort(level: ThinkingLevel): KimiK3Effort {
  switch (level) {
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    default: // "xhigh" | "max" | "ultra"
      return "max";
  }
}

// Normalize OpenAI completion usage to the framework convention where
// inputTokens excludes cache hits (matching Anthropic). Handles vendor-specific
// cache reporting fields:
// - Kimi K2/K2.5 / StepFun: top-level `cached_tokens`
// - DeepSeek / SiliconFlow: `prompt_cache_hit_tokens`
// - OpenAI / Zhipu (GLM) / MiniMax / Qwen / Mistral / xAI: standard
//   `prompt_tokens_details.cached_tokens`
function extractOpenAIUsage(usage: OpenAI.CompletionUsage): {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
} {
  let cacheRead = 0;
  let cacheWrite = 0;
  const details = usage.prompt_tokens_details;
  if (details?.cached_tokens) {
    cacheRead = details.cached_tokens;
  }
  const usageAny = usage as unknown as Record<string, unknown>;
  const detailsAny = details as unknown as Record<string, unknown> | undefined;
  if (typeof detailsAny?.cache_write_tokens === "number") {
    cacheWrite = detailsAny.cache_write_tokens;
  }
  if (!cacheRead && typeof usageAny.cached_tokens === "number" && usageAny.cached_tokens > 0) {
    cacheRead = usageAny.cached_tokens as number;
  }
  if (
    !cacheRead &&
    typeof usageAny.prompt_cache_hit_tokens === "number" &&
    usageAny.prompt_cache_hit_tokens > 0
  ) {
    cacheRead = usageAny.prompt_cache_hit_tokens as number;
  }
  // OpenAI's prompt_tokens includes cached tokens; subtract to match
  // Anthropic's convention where inputTokens excludes cache hits.
  return {
    inputTokens: usage.prompt_tokens - cacheRead - cacheWrite,
    outputTokens: usage.completion_tokens,
    cacheRead,
    cacheWrite,
  };
}

/** Client cache — avoids re-instantiating the OpenAI SDK on every call.
 *  See anthropic.ts for rationale. Keyed by identity-relevant fields. */
const openaiClientCache = new Map<string, OpenAI>();

function createClient(options: StreamOptions): OpenAI {
  const cacheKey = `${options.apiKey ?? ""}|${options.baseUrl ?? ""}|${JSON.stringify(options.defaultHeaders ?? {})}`;

  // Skip cache when a custom fetch is provided (tests, React Native, etc.).
  if (!options.fetch) {
    const cached = openaiClientCache.get(cacheKey);
    if (cached) return cached;
  }

  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
  });

  if (!options.fetch) {
    if (openaiClientCache.size >= 8) {
      const oldest = openaiClientCache.keys().next().value;
      if (oldest) openaiClientCache.delete(oldest);
    }
    openaiClientCache.set(cacheKey, client);
  }
  return client;
}

export function streamOpenAI(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const providerName = options.provider ?? "openai";
  const useStreaming = options.streaming !== false;

  const client = createClient(options);

  // Kimi K3's effort ladder is server-declared as low/high/max on both the
  // public API (default max) and the Kimi For Coding OAuth endpoint (default
  // high); unlisted efforts are rejected with a 400, and thinking can be fully
  // disabled via the nested toggle on either endpoint. The public API takes
  // top-level `reasoning_effort`; the managed endpoint keeps the official
  // CLI's nested shape.
  const isKimiK3 = options.provider === "moonshot" && options.model === "kimi-k3";
  const isManagedKimiK3 =
    isKimiK3 && options.baseUrl?.replace(/\/+$/, "").endsWith("/coding/v1") === true;
  // Clamp out-of-ladder levels to the official alias rungs — the session
  // layer already restricts choices via getSupportedThinkingLevels, this is a
  // safety net for stale saved settings.
  const k3Effort = options.thinking ? toKimiK3Effort(options.thinking) : undefined;
  const isKimiK27 = options.provider === "moonshot" && options.model.startsWith("kimi-k2.7-code");
  const hasFixedKimiSampling = isKimiK3 || isKimiK27;
  const usesThinkingParam =
    options.provider === "glm" ||
    (options.provider === "moonshot" && !isKimiK3 && !isKimiK27) ||
    options.provider === "xiaomi";

  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  const downgradedMessages = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  // Moonshot/Kimi requires video uploaded to the file service and referenced by
  // `ms://<id>` — inline base64 is rejected. Kimi's endpoint also only accepts
  // the resulting `video_url` part inside a tool result (not user content), so
  // ggcoder routes attached video through the read tool. This uploads every
  // video part (in user OR tool-result content) and caches the id so multi-turn
  // sessions don't re-upload. Done in-place before the transform.
  if (options.provider === "moonshot") {
    try {
      await uploadMoonshotVideos(client, downgradedMessages, options.signal);
    } catch (err) {
      // Surface upload failures through the same provider-error classification
      // as the chat call (this runs before the stream try/catch below).
      throw toError(err, providerName);
    }
  }
  const messages = toOpenAIMessages(downgradedMessages, {
    provider: options.provider,
    // K2.7 preserves reasoning even when the user hides thinking in the UI;
    // keep assistant tool-call history wire-valid in that display mode. A
    // disabled K3 must NOT carry placeholder reasoning_content (mirrors the
    // official CLI: reasoning is preserved only while thinking is enabled).
    thinking: isKimiK27 || !!options.thinking,
    supportsImages: options.supportsImages,
  });

  // GLM models default to 0.6 temperature when not in thinking mode
  const defaultTemp = options.provider === "glm" ? 0.6 : undefined;
  const effectiveTemp = options.temperature ?? defaultTemp;

  const params: OpenAI.ChatCompletionCreateParams = {
    model: options.model,
    messages,
    stream: useStreaming,
    ...(options.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
    ...(effectiveTemp != null && !options.thinking && !hasFixedKimiSampling
      ? { temperature: effectiveTemp }
      : {}),
    ...(options.topP != null && !hasFixedKimiSampling ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.thinking && !usesThinkingParam && !isKimiK3 && !isKimiK27
      ? { reasoning_effort: toOpenAIReasoningEffort(options.thinking, options.model) }
      : {}),
    ...(options.tools?.length ? { tools: toOpenAITools(options.tools) } : {}),
    ...(options.toolChoice && options.tools?.length
      ? { tool_choice: toOpenAIToolChoice(options.toolChoice) }
      : {}),
    ...(useStreaming ? { stream_options: { include_usage: true } } : {}),
  };

  // Native web search is disabled for OpenAI-compatible providers — ggcoder
  // provides its own web_search/web_fetch tools which handle results properly.
  // Moonshot's $web_search was previously injected here but it returns opaque
  // results and triggers reasoning_content validation errors with thinking mode.

  // prompt_cache_key helps bucket similar requests for better cache hit rates.
  // Only send to providers known to support it (OpenAI, Moonshot/Kimi) — unknown
  // params may cause errors on other OpenAI-compatible providers like GLM or Xiaomi.
  if (options.provider === "openai" || options.provider === "moonshot") {
    const paramsAny = params as unknown as Record<string, unknown>;
    paramsAny.prompt_cache_key = normalizePromptCacheKey(options.promptCacheKey ?? "ggcoder");

    // GPT-5.6 replaced prompt_cache_retention with prompt_cache_options.
    // Its only supported TTL is 30m; implicit mode preserves automatic latest-
    // message breakpoints while enabling the newer reliable key+prefix matching.
    if (options.provider === "openai" && options.model.startsWith("gpt-5.6")) {
      paramsAny.prompt_cache_options = { mode: "implicit", ttl: "30m" };
    } else if (!isKimiK3 && (options.cacheRetention ?? "short") === "long") {
      // K3 caching is automatic and its request schema does not expose a TTL.
      paramsAny.prompt_cache_retention = "24h";
    }
  }

  if (options.provider === "openai" && options.serviceTier) {
    (params as unknown as Record<string, unknown>).service_tier = options.serviceTier;
  }

  if (isKimiK3) {
    const paramsAny = params as unknown as Record<string, unknown>;
    if (isManagedKimiK3) {
      // Kimi Code's managed OAuth endpoint keeps the official CLI's Kimi wire
      // shape: nested effort plus preserved reasoning, or an explicit disabled
      // toggle when thinking is off.
      paramsAny.thinking = k3Effort
        ? { type: "enabled", effort: k3Effort, keep: "all" }
        : { type: "disabled" };
    } else if (k3Effort) {
      // The public K3 API uses top-level reasoning_effort. The OpenAI SDK's
      // effort union does not know Kimi's `max` value yet.
      paramsAny.reasoning_effort = k3Effort;
    } else {
      // Public K3 has no reasoning_effort "off" — disable via the nested
      // toggle, the shape the official CLI uses on this endpoint too.
      paramsAny.thinking = { type: "disabled" };
    }
  }

  // Inject the custom toggle for K2.6-era Kimi, GLM, and Xiaomi. Public K3 uses
  // reasoning_effort, managed K3 has its endpoint-specific block above, and
  // K2.7 is always-thinking and rejects an explicit disabled toggle.
  if (usesThinkingParam) {
    if (options.thinking) {
      (params as unknown as Record<string, unknown>).thinking = { type: "enabled" };
    } else {
      // The providers/models routed through this block support explicit disabled.
      // MiMo is an always-on reasoning model — without { type: "disabled" } it
      // returns reasoning_content and may produce thinking-only responses with
      // no actionable output, causing the agent loop to silently end.
      (params as unknown as Record<string, unknown>).thinking = { type: "disabled" };
    }
  }

  // Dump request body for stall diagnosis when GGAI_DUMP_REQUEST is set
  if (getEnvironment()?.GGAI_DUMP_REQUEST) {
    const fs = await import("fs");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpPath = `/tmp/ggai-request-${ts}.json`;
    fs.writeFileSync(dumpPath, JSON.stringify(params, null, 2));
    fs.appendFileSync(
      "/tmp/ggai-requests.log",
      `[${ts}] ${dumpPath} messages=${params.messages.length}\n`,
    );
  }

  // Non-streaming fallback: issue a single request/response and synthesize
  // stream events from the final ChatCompletion. Used by the agent loop after
  // the streaming transport has stalled repeatedly -- flipping to a plain
  // request/response often recovers from broken SSE connections.
  if (!useStreaming) {
    try {
      const completion = (await client.chat.completions.create(params, {
        signal: options.signal ?? undefined,
      })) as OpenAI.ChatCompletion;
      yield* synthesizeEventsFromCompletion(completion, !!options.thinking);
      return completionToResponse(completion);
    } catch (err) {
      throw toError(err, providerName);
    }
  }

  let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
  try {
    stream = (await client.chat.completions.create(params, {
      signal: options.signal ?? undefined,
    })) as AsyncIterable<OpenAI.ChatCompletionChunk>;
  } catch (err) {
    throw toError(err, providerName);
  }

  const contentParts: ContentPart[] = [];
  const toolCallAccum = new Map<number, { id: string; name: string; argsJson: string }>();
  let textAccum = "";
  let thinkingAccum = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let finishReason: string | null = null;
  let receivedAnyChunk = false;

  try {
    for await (const chunk of stream) {
      receivedAnyChunk = true;
      const choice = chunk.choices?.[0];

      if (chunk.usage) {
        ({ inputTokens, outputTokens, cacheRead, cacheWrite } = extractOpenAIUsage(chunk.usage));
      }

      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;

      // Reasoning/thinking delta (GLM, Moonshot, Xiaomi MiMo, DeepSeek)
      // Always accumulate reasoning_content for round-tripping in multi-turn
      // conversations (models like DeepSeek Reasoner require it on assistant
      // messages).  Only yield thinking_delta to the UI when thinking is enabled
      // — reasoning models like MiMo always return reasoning_content even when
      // thinking is "off", which would cause a permanent "Thinking" indicator.
      const reasoningContent = (delta as Record<string, unknown>).reasoning_content;
      if (typeof reasoningContent === "string" && reasoningContent) {
        thinkingAccum += reasoningContent;
        if (options.thinking) {
          yield { type: "thinking_delta", text: reasoningContent };
        }
      }

      // Text delta
      if (delta.content) {
        textAccum += delta.content;
        yield { type: "text_delta", text: delta.content };
      }

      // Tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let accum = toolCallAccum.get(tc.index);
          if (!accum) {
            accum = {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              argsJson: "",
            };
            toolCallAccum.set(tc.index, accum);
          }
          if (tc.id) accum.id = tc.id;
          if (tc.function?.name) accum.name = tc.function.name;
          if (tc.function?.arguments) {
            accum.argsJson += tc.function.arguments;
            yield {
              type: "toolcall_delta",
              id: accum.id,
              name: accum.name,
              argsJson: tc.function.arguments,
            };
          }
        }
      }
    }
  } catch (err) {
    throw toError(err, providerName);
  }

  if (!receivedAnyChunk) {
    throw new ProviderError(providerName, "Stream ended without producing any chunks.", {
      statusCode: 504,
    });
  }

  // Finalize thinking content (GLM, Moonshot, Xiaomi reasoning_content)
  // Always include in response for multi-turn round-tripping, even when
  // thinking display is off — toOpenAIMessages sends it as reasoning_content.
  if (thinkingAccum) {
    contentParts.push({ type: "thinking", text: thinkingAccum });
  }

  // Finalize text content
  if (textAccum) {
    contentParts.push({ type: "text", text: textAccum });
  }

  // Finalize tool calls
  for (const [, tc] of toolCallAccum) {
    const args = parseToolArguments(tc.argsJson);
    const toolCall: ToolCall = {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      args,
    };
    contentParts.push(toolCall);
    yield {
      type: "toolcall_done",
      id: tc.id,
      name: tc.name,
      args,
    };
  }

  const stopReason = normalizeOpenAIStopReason(finishReason);

  const response: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum || "",
    },
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheRead > 0 && { cacheRead }),
      ...(cacheWrite > 0 && { cacheWrite }),
    },
  };

  yield { type: "done", stopReason };
  return response;
}

/**
 * Walk a non-streaming OpenAI ChatCompletion and yield the same StreamEvents
 * that the streaming path would produce. Emits one large delta per field so
 * the agent loop consumer observes identical behaviour to streaming mode.
 */
function* synthesizeEventsFromCompletion(
  completion: OpenAI.ChatCompletion,
  thinkingEnabled: boolean,
): Generator<StreamEvent, void> {
  const choice = completion.choices?.[0];
  if (!choice) {
    yield { type: "done", stopReason: normalizeOpenAIStopReason(null) };
    return;
  }

  const msg = choice.message as unknown as Record<string, unknown>;

  // Reasoning / thinking content (GLM, Moonshot, DeepSeek)
  const reasoning = msg.reasoning_content;
  if (typeof reasoning === "string" && reasoning && thinkingEnabled) {
    yield { type: "thinking_delta", text: reasoning };
  }

  // Text content
  if (typeof msg.content === "string" && msg.content) {
    yield { type: "text_delta", text: msg.content };
  }

  // Tool calls
  const toolCalls = msg.tool_calls as
    | Array<{ id: string; function: { name: string; arguments: string } }>
    | undefined;
  if (toolCalls) {
    for (const tc of toolCalls) {
      const argsJson = tc.function?.arguments ?? "";
      if (argsJson) {
        yield {
          type: "toolcall_delta",
          id: tc.id,
          name: tc.function?.name ?? "",
          argsJson,
        };
      }
      const args = parseToolArguments(argsJson);
      yield {
        type: "toolcall_done",
        id: tc.id,
        name: tc.function?.name ?? "",
        args,
      };
    }
  }

  yield { type: "done", stopReason: normalizeOpenAIStopReason(choice.finish_reason ?? null) };
}

/** Convert a non-streaming OpenAI ChatCompletion into our StreamResponse shape. */
function completionToResponse(completion: OpenAI.ChatCompletion): StreamResponse {
  const choice = completion.choices?.[0];
  const contentParts: ContentPart[] = [];
  let textAccum = "";

  if (choice) {
    const msg = choice.message as unknown as Record<string, unknown>;

    // Reasoning content -- always included for multi-turn round-tripping
    const reasoning = msg.reasoning_content;
    if (typeof reasoning === "string" && reasoning) {
      contentParts.push({ type: "thinking", text: reasoning });
    }

    if (typeof msg.content === "string" && msg.content) {
      textAccum = msg.content;
      contentParts.push({ type: "text", text: msg.content });
    }

    const toolCalls = msg.tool_calls as
      | Array<{ id: string; function: { name: string; arguments: string } }>
      | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const args = parseToolArguments(tc.function?.arguments ?? "");
        const toolCall: ToolCall = {
          type: "tool_call",
          id: tc.id,
          name: tc.function?.name ?? "",
          args,
        };
        contentParts.push(toolCall);
      }
    }
  }

  // Usage -- match streaming path accounting (inputTokens excludes cache hits).
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  if (completion.usage) {
    ({ inputTokens, outputTokens, cacheRead, cacheWrite } = extractOpenAIUsage(completion.usage));
  }

  const stopReason = normalizeOpenAIStopReason(choice?.finish_reason ?? null);

  return {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum,
    },
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheRead > 0 && { cacheRead }),
      ...(cacheWrite > 0 && { cacheWrite }),
    },
  };
}

/**
 * Classify an OpenAI-compatible error as a hard usage/quota stop, a transient
 * throttle, or neither. "hard" stops must NOT be retried (credit/balance/quota
 * exhaustion); "transient" 429s are retriable (per-minute throttle).
 */
function classifyOpenAICompatLimit(args: {
  status: number | undefined;
  code: string | undefined;
  type: string | undefined;
  message: string;
}): "hard" | "transient" | null {
  const { status, code, type, message } = args;
  const codeType = `${code ?? ""} ${type ?? ""}`.toLowerCase();
  const isHard =
    status === 402 || codeType.includes("insufficient_quota") || isHardBillingMessage(message);
  if (isHard) return "hard";
  if (
    status === 429 ||
    codeType.includes("rate_limit_exceeded") ||
    codeType.includes("too_many_requests")
  ) {
    return "transient";
  }
  return null;
}

function toError(err: unknown, provider: string = "openai"): ProviderError {
  if (err instanceof OpenAI.APIError) {
    const body = err.error as Record<string, unknown> | undefined;
    const bodyMessage =
      typeof body?.message === "string" && body.message.trim() ? body.message.trim() : undefined;
    const modelName = typeof body?.model === "string" ? body.model : "";
    // The SDK may expose a whole HTML edge/proxy page either as the parsed body
    // message or as err.message. Preserve the original on `cause`, but never send
    // transport markup to the user.
    const messageCandidate = bodyMessage ?? err.message;
    const cleanMessage = isRawHtmlErrorEcho(messageCandidate)
      ? providerHtmlErrorMessage(err.status)
      : bodyMessage
        ? bodyMessage
        : isRawJsonErrorEcho(err.message)
          ? emptyProviderErrorMessage(err.status)
          : err.message;

    let hint: string | undefined;
    if (modelName === "codex-mini-latest" || cleanMessage.includes("codex-mini-latest")) {
      hint =
        "codex-mini-latest requires an OpenAI Pro or Max subscription. " +
        "Your account currently has access to GPT-5.4 and GPT-5.4 Mini.";
    }

    const requestId =
      (err as unknown as { request_id?: string }).request_id ??
      (typeof body?.request_id === "string" ? body.request_id : undefined);

    const code = typeof err.code === "string" ? err.code : undefined;
    const type = typeof err.type === "string" ? err.type : undefined;
    const limit = classifyOpenAICompatLimit({
      status: err.status,
      code,
      type,
      message: cleanMessage,
    });

    if (limit === "hard") {
      // Stamp the canonical "usage limit reached" token so downstream retry
      // logic surfaces it once instead of burning quota on doomed retries.
      const message = /usage limit reached/i.test(cleanMessage)
        ? cleanMessage
        : `usage limit reached: ${cleanMessage}`;
      return new ProviderError(provider, message, {
        statusCode: err.status,
        ...(requestId ? { requestId } : {}),
        ...(hint ? { hint } : {}),
        cause: err,
      });
    }

    if (limit === "transient") {
      // Honor a server-stated Retry-After (seconds) so the loop waits the right
      // amount through the existing serverResetDelayMs() path.
      const retryAfterRaw = readHeader(err.headers, "retry-after");
      const retryAfterSec = retryAfterRaw != null ? Number(retryAfterRaw) : Number.NaN;
      const resetsAt =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.floor(Date.now() / 1000) + retryAfterSec
          : undefined;
      return new ProviderError(provider, cleanMessage, {
        statusCode: err.status,
        ...(requestId ? { requestId } : {}),
        ...(hint ? { hint } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        cause: err,
      });
    }

    return new ProviderError(provider, cleanMessage, {
      statusCode: err.status,
      ...(requestId ? { requestId } : {}),
      ...(hint ? { hint } : {}),
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new ProviderError(provider, err.message, { cause: err });
  }
  return new ProviderError(provider, String(err));
}
