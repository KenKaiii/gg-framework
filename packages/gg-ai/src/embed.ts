import { GGAIError, ProviderError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import type { ProviderCapability, ProviderEntry } from "./provider-registry.js";
import type {
  EmbedOptions,
  EmbedResult,
  EmbedUsage,
  RerankOptions,
  RerankResponse,
  RerankResult,
} from "./embed-types.js";
import { throwIfAborted } from "./utils/json-post.js";

const CAPABILITY_LABEL: Record<Exclude<ProviderCapability, "stream">, string> = {
  embed: "embeddings",
  rerank: "reranking",
};

function resolveCapability<C extends "embed" | "rerank">(
  provider: string,
  capability: C,
): NonNullable<ProviderEntry[C]> {
  const entry = providerRegistry.get(provider);
  if (!entry) {
    throw new GGAIError(
      `Unknown provider: "${provider}". Registered: ${providerRegistry.list().join(", ")}`,
    );
  }
  const fn = entry[capability];
  if (typeof fn !== "function") {
    const label = CAPABILITY_LABEL[capability];
    const offering = providerRegistry
      .list()
      .filter((name) => providerRegistry.supports(name, capability))
      .sort();
    throw new GGAIError(`Provider "${provider}" doesn't support ${label}.`, {
      source: "capability",
      hint:
        offering.length > 0
          ? `Use a provider that offers ${label}: ${offering.join(", ")}.`
          : `No registered provider offers ${label}.`,
    });
  }
  return fn as NonNullable<ProviderEntry[C]>;
}

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
    throw new GGAIError(`${name} must be a positive integer (got ${String(value)}).`);
  }
}

/**
 * Create embeddings through any registered provider that offers them (see
 * `providerRegistry.supports(name, "embed")`).
 *
 * - `input` may be any length: it's split into provider-sized batches, sent in
 *   order, one at a time. `signal` aborts the in-flight batch and skips the rest.
 * - The result has exactly one vector per input, in input order. A provider
 *   reply with the wrong count, a non-numeric value, mixed vector lengths, or a
 *   length other than `dimensions` throws `ProviderError` — nothing is padded
 *   or truncated.
 * - `normalize: true` L2-normalizes each vector (all-zero vectors stay zero).
 * - No retries: as with `stream()`, retry policy belongs to the caller. 429s
 *   carry `resetsAt` when the provider sends `Retry-After`; auth and billing
 *   failures (`isUsageLimitError`) should never be retried.
 *
 * ```ts
 * const { embeddings } = await embed({
 *   provider: "openai",
 *   model: "text-embedding-3-small",
 *   input: ["first chunk", "second chunk"],
 *   apiKey,
 * });
 * ```
 */
export async function embed(options: EmbedOptions): Promise<EmbedResult> {
  const embedFn = resolveCapability(options.provider, "embed");
  if (!Array.isArray(options.input)) {
    throw new GGAIError("embed() input must be an array of strings.");
  }
  assertPositiveInteger("dimensions", options.dimensions);
  assertPositiveInteger("batchSize", options.batchSize);
  if (options.input.length === 0) return { embeddings: [], model: options.model };

  const entry = providerRegistry.get(options.provider);
  const batchSize = options.batchSize ?? entry?.embedBatchSize ?? options.input.length;
  const { normalize, batchSize: _batchSize, ...request } = options;

  const embeddings: number[][] = [];
  let model = options.model;
  let inputTokens: number | undefined;
  let expectedLength = options.dimensions;

  for (let start = 0; start < options.input.length; start += batchSize) {
    throwIfAborted(options.signal);
    const batch = options.input.slice(start, start + batchSize);
    const response = await embedFn({ ...request, input: batch });
    const invalid = (detail: string): ProviderError =>
      new ProviderError(options.provider, `Invalid embeddings response: ${detail}.`);

    if (!Array.isArray(response.embeddings) || response.embeddings.length !== batch.length) {
      const count = Array.isArray(response.embeddings) ? response.embeddings.length : 0;
      throw invalid(`expected ${batch.length} embeddings, got ${count}`);
    }
    for (const vector of response.embeddings) {
      if (!Array.isArray(vector) || vector.length === 0) throw invalid("received an empty vector");
      if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw invalid("received a vector with non-numeric values");
      }
      if (expectedLength === undefined) {
        expectedLength = vector.length;
      } else if (vector.length !== expectedLength) {
        throw invalid(
          options.dimensions !== undefined
            ? `requested ${options.dimensions} dimensions, got a vector with ${vector.length}`
            : `vectors have different lengths (${expectedLength} and ${vector.length})`,
        );
      }
      embeddings.push(normalize ? l2Normalize(vector) : vector);
    }
    if (response.model) model = response.model;
    if (response.usage) inputTokens = (inputTokens ?? 0) + response.usage.inputTokens;
  }

  return {
    embeddings,
    model,
    ...(inputTokens !== undefined ? { usage: { inputTokens } satisfies EmbedUsage } : {}),
  };
}

/**
 * Rerank `documents` against `query` through any registered provider that
 * offers reranking (see `providerRegistry.supports(name, "rerank")`).
 *
 * Results are sorted by score, highest first (ties keep document order), and
 * `index` points into the caller's `documents`. At most `topN` results are
 * returned. A reply with an out-of-range or duplicate index throws
 * `ProviderError`. No retries — see `embed()`.
 *
 * ```ts
 * const { results } = await rerank({
 *   provider: "openrouter",
 *   model: "cohere/rerank-v3.5",
 *   query: "capital of France",
 *   documents,
 *   topN: 5,
 *   apiKey,
 * });
 * const best = documents[results[0].index];
 * ```
 */
export async function rerank(options: RerankOptions): Promise<RerankResponse> {
  const rerankFn = resolveCapability(options.provider, "rerank");
  if (!Array.isArray(options.documents)) {
    throw new GGAIError("rerank() documents must be an array of strings.");
  }
  assertPositiveInteger("topN", options.topN);
  if (options.documents.length === 0) return { results: [], model: options.model };

  throwIfAborted(options.signal);
  const response = await rerankFn(options);
  const invalid = (detail: string): ProviderError =>
    new ProviderError(options.provider, `Invalid rerank response: ${detail}.`);
  if (!Array.isArray(response.results)) throw invalid("missing results");

  const seen = new Set<number>();
  const results: RerankResult[] = response.results.map(({ index, score }) => {
    if (!Number.isInteger(index) || index < 0 || index >= options.documents.length) {
      throw invalid(
        `index ${String(index)} is out of range for ${options.documents.length} documents`,
      );
    }
    if (seen.has(index)) throw invalid(`index ${index} appears more than once`);
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw invalid(`document ${index} has a non-numeric score`);
    }
    seen.add(index);
    return { index, score };
  });
  results.sort((a, b) => b.score - a.score || a.index - b.index);

  return {
    results: options.topN !== undefined ? results.slice(0, options.topN) : results,
    model: response.model ?? options.model,
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

function l2Normalize(vector: readonly number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  if (sumOfSquares === 0) return [...vector];
  const norm = Math.sqrt(sumOfSquares);
  return vector.map((value) => value / norm);
}
