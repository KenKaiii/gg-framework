import type { Provider, ProviderOptions } from "./types.js";

/** What the embedded text will be used for. See `EmbedOptions.inputType`. */
export type EmbedInputType = "query" | "document";

/** Fields shared by every `embed()` / `rerank()` request. */
interface RetrievalRequestOptions {
  /** Registered provider name. Resolved through `providerRegistry`, like `stream()`. */
  provider: Provider;
  model: string;
  /** API key. Sent as the provider expects (Bearer token, or `x-goog-api-key` for Gemini).
   *  Not read from the environment — pass it explicitly. */
  apiKey?: string;
  /** Override the provider's default API base URL (required for `local`). */
  baseUrl?: string;
  /** Aborts the in-flight request and skips any remaining batches. */
  signal?: AbortSignal;
  /** Custom fetch implementation (tests, React Native, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Provider-specific body fields (e.g. OpenRouter's `provider` routing object).
   *  Never overrides fields gg-ai sets; see `ProviderOptions`. */
  providerOptions?: ProviderOptions;
}

export interface EmbedOptions extends RetrievalRequestOptions {
  /** Texts to embed. Any length — gg-ai splits it into provider-sized batches. */
  input: string[];
  /** Requested vector size, for models that support shortened embeddings.
   *  Every returned vector is checked against it; a mismatch throws. */
  dimensions?: number;
  /**
   * Whether the texts are search queries or documents being indexed. Mapped to
   * the provider's native task parameter where one exists (Gemini `taskType`,
   * OpenRouter `input_type`); ignored where it doesn't (OpenAI, local servers,
   * and `gemini-embedding-2`, which takes the task as a text prefix instead).
   */
  inputType?: EmbedInputType;
  /** L2-normalize every vector after validation. Default false. */
  normalize?: boolean;
  /** Inputs per request. Defaults to the provider's documented maximum (see README). */
  batchSize?: number;
}

export interface EmbedUsage {
  /** Input tokens, summed over every batch that reported usage. */
  inputTokens: number;
}

export interface EmbedResult {
  /** One vector per input, in input order. */
  embeddings: number[][];
  /** Model the provider reports having used (falls back to the requested model). */
  model: string;
  /** Present when the provider reported usage for at least one batch. */
  usage?: EmbedUsage;
}

export interface RerankOptions extends RetrievalRequestOptions {
  query: string;
  documents: string[];
  /** Return only the best `topN` results. Default: all documents. */
  topN?: number;
}

export interface RerankResult {
  /** Index into the caller's `documents` array. */
  index: number;
  /** Relevance score; higher is more relevant. Scale depends on the model. */
  score: number;
}

export interface RerankUsage {
  inputTokens?: number;
  /** Billing units for search-unit priced rerankers (e.g. Cohere via OpenRouter). */
  searchUnits?: number;
}

export interface RerankResponse {
  /** Sorted by score, highest first. */
  results: RerankResult[];
  model: string;
  usage?: RerankUsage;
}

// ── Provider-side contract ─────────────────────────────────

/** One embedding request as a provider sees it: a single batch. */
export type ProviderEmbedRequest = Omit<EmbedOptions, "normalize" | "batchSize">;

/** A provider's answer to one batch. `embeddings` must be in input order. */
export interface ProviderEmbedResponse {
  embeddings: number[][];
  model?: string;
  usage?: EmbedUsage;
}

/** Embed one batch. gg-ai handles batching, validation and normalization. */
export type ProviderEmbedFn = (request: ProviderEmbedRequest) => Promise<ProviderEmbedResponse>;

/** A rerank request as a provider sees it. `documents` is never empty. */
export type ProviderRerankRequest = RerankOptions;

/** A provider's rerank answer. Any order; gg-ai validates, sorts and applies `topN`. */
export interface ProviderRerankResponse {
  results: RerankResult[];
  model?: string;
  usage?: RerankUsage;
}

export type ProviderRerankFn = (request: ProviderRerankRequest) => Promise<ProviderRerankResponse>;
