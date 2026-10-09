/**
 * Shared embeddings + rerank transports for HTTP APIs that follow the de-facto
 * standards:
 *
 * - `POST {baseUrl}/embeddings` — OpenAI's embeddings API (OpenAI, OpenRouter,
 *   Ollama, LM Studio, llama.cpp, vLLM). Request `{ model, input: string[],
 *   encoding_format, dimensions? }`; reply `{ data: [{ index, embedding }],
 *   model, usage: { prompt_tokens } }`.
 * - `POST {baseUrl}/rerank` — the Cohere/Jina rerank shape (OpenRouter,
 *   llama.cpp, vLLM). Request `{ model, query, documents, top_n? }`; reply
 *   `{ results: [{ index, relevance_score }], usage? }`.
 */
import { ProviderError } from "../errors.js";
import type {
  EmbedInputType,
  EmbedUsage,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderRerankRequest,
  ProviderRerankResponse,
  RerankResult,
  RerankUsage,
} from "../embed-types.js";
import { isRecord, joinUrl, postJson } from "../utils/json-post.js";
import { mergeProviderOptions } from "../utils/provider-options.js";

export interface OpenAICompatRetrievalConfig {
  /** Provider name for errors. */
  provider: string;
  baseUrl: string;
  /** Model id to send on the wire (defaults to the request's model). */
  wireModel?: string;
  /** Body fields expressing `inputType`, for APIs with a native task parameter.
   *  Omit when the API has none — `inputType` is then ignored. */
  inputTypeFields?: (inputType: EmbedInputType) => Record<string, unknown>;
}

function jsonHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export async function embedOpenAICompatible(
  request: ProviderEmbedRequest,
  config: OpenAICompatRetrievalConfig,
): Promise<ProviderEmbedResponse> {
  const body = mergeProviderOptions(
    {
      model: config.wireModel ?? request.model,
      input: request.input,
      // gg-ai parses float arrays only; never let a server default to base64.
      encoding_format: "float",
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      ...(request.inputType && config.inputTypeFields
        ? config.inputTypeFields(request.inputType)
        : {}),
    },
    request.providerOptions,
  );
  const { json, requestId } = await postJson({
    provider: config.provider,
    url: joinUrl(config.baseUrl, "embeddings"),
    headers: jsonHeaders(request.apiKey),
    body,
    fetch: request.fetch,
    signal: request.signal,
    secrets: [request.apiKey],
  });

  const invalid = (detail: string): ProviderError =>
    new ProviderError(config.provider, `Invalid embeddings response: ${detail}.`, {
      ...(requestId ? { requestId } : {}),
    });

  if (!isRecord(json) || !Array.isArray(json.data)) throw invalid("missing `data` array");
  const items = json.data.map((item: unknown) => {
    if (!isRecord(item)) throw invalid("an entry in `data` is not an object");
    const index = item.index;
    if (index !== undefined && !(typeof index === "number" && Number.isInteger(index))) {
      throw invalid("an entry has a non-integer `index`");
    }
    // Element types are validated centrally by embed(); only the container here.
    if (!Array.isArray(item.embedding)) {
      throw invalid("an entry's `embedding` is not an array of numbers");
    }
    return { index, embedding: item.embedding as number[] };
  });

  // Providers may return entries out of order; `index` is authoritative. A
  // reply without any indices is taken positionally; a partial set is broken.
  const withIndex = items.filter((item) => item.index !== undefined).length;
  let embeddings: number[][];
  if (withIndex === 0) {
    embeddings = items.map((item) => item.embedding);
  } else if (withIndex !== items.length) {
    throw invalid("some entries have an `index` and some don't");
  } else {
    const slots: (number[] | undefined)[] = new Array(items.length);
    for (const item of items) {
      const index = item.index as number;
      if (index < 0 || index >= items.length || slots[index] !== undefined) {
        throw invalid(`unexpected or duplicate index ${index}`);
      }
      slots[index] = item.embedding;
    }
    embeddings = slots as number[][];
  }

  const usage = json.usage;
  const promptTokens = isRecord(usage) ? usage.prompt_tokens : undefined;
  return {
    embeddings,
    ...(typeof json.model === "string" && json.model ? { model: json.model } : {}),
    ...(typeof promptTokens === "number" && Number.isFinite(promptTokens)
      ? { usage: { inputTokens: promptTokens } satisfies EmbedUsage }
      : {}),
  };
}

export async function rerankCohereCompatible(
  request: ProviderRerankRequest,
  config: OpenAICompatRetrievalConfig,
): Promise<ProviderRerankResponse> {
  const body = mergeProviderOptions(
    {
      model: config.wireModel ?? request.model,
      query: request.query,
      documents: request.documents,
      ...(request.topN !== undefined ? { top_n: request.topN } : {}),
    },
    request.providerOptions,
  );
  const { json, requestId } = await postJson({
    provider: config.provider,
    url: joinUrl(config.baseUrl, "rerank"),
    headers: jsonHeaders(request.apiKey),
    body,
    fetch: request.fetch,
    signal: request.signal,
    secrets: [request.apiKey],
  });

  const invalid = (detail: string): ProviderError =>
    new ProviderError(config.provider, `Invalid rerank response: ${detail}.`, {
      ...(requestId ? { requestId } : {}),
    });

  if (!isRecord(json) || !Array.isArray(json.results)) throw invalid("missing `results` array");
  const results = json.results.map((item: unknown): RerankResult => {
    if (!isRecord(item)) throw invalid("an entry in `results` is not an object");
    const { index, relevance_score: score } = item;
    if (typeof index !== "number" || typeof score !== "number") {
      throw invalid("an entry is missing a numeric `index` or `relevance_score`");
    }
    return { index, score };
  });

  const usage = json.usage;
  const tokens = isRecord(usage) ? (usage.prompt_tokens ?? usage.total_tokens) : undefined;
  const searchUnits = isRecord(usage) ? usage.search_units : undefined;
  const rerankUsage: RerankUsage = {
    ...(typeof tokens === "number" && Number.isFinite(tokens) ? { inputTokens: tokens } : {}),
    ...(typeof searchUnits === "number" && Number.isFinite(searchUnits) ? { searchUnits } : {}),
  };
  return {
    results,
    ...(typeof json.model === "string" && json.model ? { model: json.model } : {}),
    ...(Object.keys(rerankUsage).length > 0 ? { usage: rerankUsage } : {}),
  };
}
