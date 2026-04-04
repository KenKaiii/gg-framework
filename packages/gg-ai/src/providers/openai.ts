import OpenAI from "openai";
import type {
  ContentPart,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  ToolCall,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import {
  normalizeOpenAIStopReason,
  toOpenAIMessages,
  toOpenAIReasoningEffort,
  toOpenAIToolChoice,
  toOpenAITools,
} from "./transform.js";

// Cache OpenAI clients by config fingerprint (same rationale as Anthropic —
// avoid polluting the global HTTP connection pool with per-turn clients).
const clientCache = new Map<string, OpenAI>();

function getOrCreateClient(options: StreamOptions): OpenAI {
  const key = `${options.apiKey ?? ""}|${options.baseUrl ?? ""}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    clientCache.set(key, client);
  }
  return client;
}

export function streamOpenAI(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options));
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const providerName = options.provider ?? "openai";

  const client = getOrCreateClient(options);

  // GLM and Moonshot use a custom `thinking` body param instead of `reasoning_effort`
  const usesThinkingParam =
    options.provider === "glm" || options.provider === "moonshot" || options.provider === "xiaomi";

  const messages = toOpenAIMessages(options.messages, { provider: options.provider });

  // GLM models default to 0.6 temperature when not in thinking mode
  const defaultTemp = options.provider === "glm" ? 0.6 : undefined;
  const effectiveTemp = options.temperature ?? defaultTemp;

  const params: OpenAI.ChatCompletionCreateParams = {
    model: options.model,
    messages,
    stream: true,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(effectiveTemp != null && !options.thinking ? { temperature: effectiveTemp } : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.thinking && !usesThinkingParam
      ? { reasoning_effort: toOpenAIReasoningEffort(options.thinking) }
      : {}),
    ...(options.tools?.length ? { tools: toOpenAITools(options.tools) } : {}),
    ...(options.toolChoice && options.tools?.length
      ? { tool_choice: toOpenAIToolChoice(options.toolChoice) }
      : {}),
    stream_options: { include_usage: true },
  };

  // Inject provider-native web search tools (non-standard, bypass SDK types)
  if (options.webSearch) {
    if (options.provider === "moonshot") {
      const raw = params as unknown as Record<string, unknown>;
      const tools = ((raw.tools as unknown[]) ?? []).slice();
      tools.push({ type: "builtin_function", function: { name: "$web_search" } });
      raw.tools = tools;
    }
    // Xiaomi: web search requires account-level webSearchEnabled flag
    // GLM (Z.AI): web search is provided via MCP servers, not inline tools
    // OpenAI: Chat Completions API does not support web search
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
  if (
    (globalThis as Record<string, unknown>).process &&
    ((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env
      ?.GGAI_DUMP_REQUEST
  ) {
    const fs = await import("fs");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpPath = `/tmp/ggai-request-${ts}.json`;
    fs.writeFileSync(dumpPath, JSON.stringify(params, null, 2));
    fs.appendFileSync(
      "/tmp/ggai-requests.log",
      `[${ts}] ${dumpPath} messages=${params.messages.length}\n`,
    );
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

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];

    if (chunk.usage) {
      outputTokens = chunk.usage.completion_tokens;
      const details = chunk.usage.prompt_tokens_details;
      if (details?.cached_tokens) {
        cacheRead = details.cached_tokens;
      }
      // OpenAI's prompt_tokens includes cached tokens; subtract to match
      // Anthropic's convention where inputTokens excludes cache hits.
      inputTokens = chunk.usage.prompt_tokens - cacheRead;
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
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.argsJson) as Record<string, unknown>;
    } catch {
      // malformed JSON — keep empty
    }
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

function toError(err: unknown, provider: string = "openai"): ProviderError {
  if (err instanceof OpenAI.APIError) {
    // Include full error body for debugging — GLM/Moonshot use non-standard error shapes
    let msg = err.message;
    const body = err.error as Record<string, unknown> | undefined;
    if (body) {
      // Append raw error body so debug logs capture the exact API response
      msg += ` | body: ${JSON.stringify(body)}`;
    }
    return new ProviderError(provider, msg, {
      statusCode: err.status,
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new ProviderError(provider, err.message, { cause: err });
  }
  return new ProviderError(provider, String(err));
}
