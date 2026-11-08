import type OpenAI from "openai";
import type { StreamEvent, StreamOptions, StreamResponse, Tool, ToolChoice } from "../types.js";
import { StreamResult } from "../utils/event-stream.js";
import { providerDiag } from "../utils/diag.js";
import { mergeProviderOptions } from "../utils/provider-options.js";
import { PROVIDER_TRANSPORT_TIMEOUT_MS } from "../utils/provider-fetch.js";
import { resolveToolSchema } from "../utils/zod-to-json-schema.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";
import { createClient, toError } from "./openai.js";
import {
  consumeResponsesEvents,
  isEncryptedReasoning,
  toResponsesInput,
} from "./responses-stream.js";
import {
  downgradeUnsupportedImages,
  downgradeUnsupportedVideos,
  toOpenAIReasoningEffort,
} from "./transform.js";

/**
 * xAI (Grok) over the Responses API — both the `api.x.ai` key route and the
 * subscription Grok CLI proxy, which serves the same `/v1/responses` surface.
 *
 * xAI deprecates Chat Completions for its reasoning models: Chat has no field
 * for the encrypted reasoning, so every tool round discarded Grok's earlier
 * thinking (degrading long agent loops) and missed the prompt cache. Here each
 * reply's encrypted reasoning item is captured, stamped with its model, and
 * replayed verbatim on later turns with `store: false`.
 *
 * Rides the shared OpenAI SDK client (headers, transport timeouts and error
 * mapping identical to the Chat path) and the shared Responses event consumer.
 */
export function streamXaiResponses(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

/**
 * Encrypted reasoning is only replayed to the model that produced it; a model
 * switch (or another transport's reasoning in history) must not reach xAI.
 */
export function xaiReasoningOrigin(model: string): string {
  return `xai:${model}`;
}

async function* runStream(
  options: StreamOptions,
  dropReasoning = false,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const providerName = options.provider ?? "xai";
  const client = createClient(options);
  const origin = xaiReasoningOrigin(options.model);
  const useStreaming = options.streaming !== false;

  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  const downgraded = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  const { system, input } = toResponsesInput(downgraded, {
    supportsImages: options.supportsImages,
    keepReasoning: (part) => !dropReasoning && part.origin === origin,
    minimalAssistantItems: true,
  });
  const replaysReasoning = input.some(isReasoningItem);

  const params: Record<string, unknown> = {
    model: options.model,
    input: system ? [{ role: "system", content: system }, ...input] : input,
    store: false,
    stream: useStreaming,
    include: ["reasoning.encrypted_content"],
    // Responses' cache-routing key (Chat used the x-grok-conv-id header).
    prompt_cache_key: normalizePromptCacheKey(options.promptCacheKey ?? "ggcoder"),
    ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
    // Grok reasoning can't be disabled; with thinking off the server default
    // (high on Grok 4.7) applies, exactly as on the Chat path.
    ...(options.thinking
      ? { reasoning: { effort: toOpenAIReasoningEffort(options.thinking, options.model) } }
      : {}),
    ...(options.temperature != null && !options.thinking
      ? { temperature: options.temperature }
      : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.tools?.length ? { tools: toXaiTools(options.tools) } : {}),
    ...(options.toolChoice && options.tools?.length
      ? { tool_choice: toXaiToolChoice(options.toolChoice) }
      : {}),
  };
  const body = mergeProviderOptions(params, options.providerOptions);
  const requestOptions = {
    signal: options.signal ?? undefined,
    // A non-streamed reply arrives in one response; never undercut the agent
    // loop's own (up to 15min) cap with the SDK's 10min default.
    timeout: PROVIDER_TRANSPORT_TIMEOUT_MS,
    headers: {
      "x-grok-conv-id": normalizePromptCacheKey(options.promptCacheKey ?? "ggcoder"),
    },
  };

  let events: AsyncIterable<Record<string, unknown>>;
  try {
    if (useStreaming) {
      const stream = await client.responses.create(
        body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
        requestOptions,
      );
      events = stream as unknown as AsyncIterable<Record<string, unknown>>;
    } else {
      const response = await client.responses.create(
        body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
        requestOptions,
      );
      events = synthesizeResponseEvents(response as unknown as Record<string, unknown>);
    }
  } catch (err) {
    // A 400 before any output, on a request that replayed encrypted reasoning,
    // is most likely that reasoning being refused (expired, or produced under
    // other conditions). Every retry would fail the same way, so replay once
    // with visible history only. Saved messages are never altered.
    if (
      replaysReasoning &&
      !dropReasoning &&
      !options.signal?.aborted &&
      (err as { status?: unknown }).status === 400
    ) {
      providerDiag("xai_retry_without_encrypted_reasoning", { status: 400 });
      return yield* runStream(options, true);
    }
    throw toError(err, providerName);
  }

  try {
    return yield* consumeResponsesEvents(events, {
      provider: providerName,
      label: "Grok",
      diagPrefix: "xai",
      thinking: !!options.thinking,
      reasoningOrigin: origin,
    });
  } catch (err) {
    throw toError(err, providerName);
  }
}

function isReasoningItem(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    isEncryptedReasoning(item as Record<string, unknown>)
  );
}

function toXaiTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: resolveToolSchema(tool),
  }));
}

function toXaiToolChoice(choice: ToolChoice): unknown {
  return typeof choice === "object" ? { type: "function", name: choice.name } : choice;
}

/**
 * Replay a complete non-streamed Response through the same consumer as a live
 * stream, so the agent loop's non-streaming fallback gets identical parsing,
 * reasoning capture and stop-reason handling.
 */
async function* synthesizeResponseEvents(
  response: Record<string, unknown>,
): AsyncGenerator<Record<string, unknown>> {
  const output = Array.isArray(response.output) ? (response.output as unknown[]) : [];
  for (const [index, raw] of output.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    // The consumer pairs text and arguments with their item by id.
    const withId: Record<string, unknown> =
      typeof item.id === "string" ? item : { ...item, id: `item_${index}` };
    yield { type: "response.output_item.added", item: withId };
    if (withId.type === "message" && Array.isArray(withId.content)) {
      for (const [contentIndex, content] of (withId.content as unknown[]).entries()) {
        const part = content as Record<string, unknown> | null;
        if (part?.type === "output_text" && typeof part.text === "string") {
          yield {
            type: "response.output_text.done",
            item_id: withId.id,
            content_index: contentIndex,
            text: part.text,
          };
        }
      }
    }
    if (withId.type === "function_call") {
      yield {
        type: "response.function_call_arguments.done",
        item_id: withId.id,
        arguments: typeof withId.arguments === "string" ? withId.arguments : "",
      };
    }
    yield { type: "response.output_item.done", item: withId };
  }
  yield {
    type: response.status === "incomplete" ? "response.incomplete" : "response.completed",
    response,
  };
}
