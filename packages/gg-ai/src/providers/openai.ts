import OpenAI from "openai";
import type {
  ContentPart,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ToolCall,
} from "../types.js";
import { ProviderError, readHeader, isHardBillingMessage } from "../errors.js";
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
} {
  let cacheRead = 0;
  const details = usage.prompt_tokens_details;
  if (details?.cached_tokens) {
    cacheRead = details.cached_tokens;
  }
  const usageAny = usage as unknown as Record<string, unknown>;
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
    inputTokens: usage.prompt_tokens - cacheRead,
    outputTokens: usage.completion_tokens,
    cacheRead,
  };
}

function createClient(options: StreamOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
  });
}

export function streamOpenAI(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const providerName = options.provider ?? "openai";
  const useStreaming = options.streaming !== false;

  const client = createClient(options);

  // GLM and Moonshot use a custom `thinking` body param instead of `reasoning_effort`
  const usesThinkingParam =
    options.provider === "glm" || options.provider === "moonshot" || options.provider === "xiaomi";

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
    thinking: !!options.thinking,
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
    ...(effectiveTemp != null && !options.thinking ? { temperature: effectiveTemp } : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.thinking && !usesThinkingParam
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

    // Map cacheRetention to OpenAI's prompt_cache_retention param.
    // "long" → "24h" keeps cached prefixes active up to 24 hours (OpenAI feature).
    const retention = options.cacheRetention ?? "short";
    if (retention === "long") {
      paramsAny.prompt_cache_retention = "24h";
    }
  }

  if (options.provider === "openai" && options.serviceTier) {
    (params as unknown as Record<string, unknown>).service_tier = options.serviceTier;
  }

  // Inject custom thinking param for GLM/Moonshot/Xiaomi (not part of OpenAI spec)
  if (usesThinkingParam) {
    if (options.thinking) {
      (params as unknown as Record<string, unknown>).thinking = { type: "enabled" };
    } else {
      // All providers (GLM, Moonshot, Xiaomi MiMo) support explicit disabled.
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
  let finishReason: string | null = null;
  let receivedAnyChunk = false;

  try {
    for await (const chunk of stream) {
      receivedAnyChunk = true;
      const choice = chunk.choices?.[0];

      if (chunk.usage) {
        ({ inputTokens, outputTokens, cacheRead } = extractOpenAIUsage(chunk.usage));
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
    usage: { inputTokens, outputTokens, ...(cacheRead > 0 && { cacheRead }) },
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
  if (completion.usage) {
    ({ inputTokens, outputTokens, cacheRead } = extractOpenAIUsage(completion.usage));
  }

  const stopReason = normalizeOpenAIStopReason(choice?.finish_reason ?? null);

  return {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum,
    },
    stopReason,
    usage: { inputTokens, outputTokens, ...(cacheRead > 0 && { cacheRead }) },
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
    const cleanMessage = bodyMessage ?? err.message;

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
