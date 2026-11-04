import { afterEach, describe, expect, it, vi } from "vitest";
import { embed, rerank } from "./embed.js";
import { GGAIError, ProviderError, formatError, isUsageLimitError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import { registerPalsuProvider, palsuEmbedding, palsuRerankScore } from "./providers/palsu.js";
import type { Provider } from "./types.js";
// Registers the built-in providers.
import "./stream.js";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** A fetch fake that records every call and answers from `handler`. */
function fakeFetch(handler: (body: Record<string, unknown>, call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return handler(body, call);
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

function bodyOf(call: FetchCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body ?? "{}")) as Record<string, unknown>;
}

function headersOf(call: FetchCall | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

/** OpenAI-style reply: one vector per input, `[i, i + 1, …]` so order is checkable. */
function openAIEmbeddingReply(body: Record<string, unknown>, dims = 3, reverse = false): Response {
  const input = body.input as string[];
  const data = input.map((_, index) => ({
    object: "embedding",
    index,
    embedding: Array.from({ length: dims }, (__, d) => index + d),
  }));
  return jsonResponse({
    object: "list",
    model: body.model,
    data: reverse ? [...data].reverse() : data,
    usage: { prompt_tokens: input.length * 2, total_tokens: input.length * 2 },
  });
}

const TEST_PROVIDER = "embed-test-provider" as Provider;

afterEach(() => {
  providerRegistry.unregister(TEST_PROVIDER);
});

describe("providerRegistry capabilities", () => {
  it("keeps stream-only registrations working and reports capabilities", () => {
    providerRegistry.register(TEST_PROVIDER, {
      stream: () => {
        throw new Error("unused");
      },
    });
    expect(providerRegistry.supports(TEST_PROVIDER, "stream")).toBe(true);
    expect(providerRegistry.supports(TEST_PROVIDER, "embed")).toBe(false);
    expect(providerRegistry.supports(TEST_PROVIDER, "rerank")).toBe(false);
    expect(providerRegistry.supports("no-such-provider", "stream")).toBe(false);
  });

  it("reports built-in coverage", () => {
    for (const name of ["openai", "openrouter", "gemini", "local"]) {
      expect(providerRegistry.supports(name, "embed")).toBe(true);
    }
    expect(providerRegistry.supports("openrouter", "rerank")).toBe(true);
    expect(providerRegistry.supports("local", "rerank")).toBe(true);
    for (const name of ["anthropic", "glm", "moonshot", "deepseek", "xai", "minimax"]) {
      expect(providerRegistry.supports(name, "embed")).toBe(false);
      expect(providerRegistry.supports(name, "rerank")).toBe(false);
    }
  });
});

describe("embed()", () => {
  it("sends the OpenAI request body and returns vectors with usage", async () => {
    const { fetch, calls } = fakeFetch((body) => openAIEmbeddingReply(body));
    const result = await embed({
      provider: "openai",
      model: "text-embedding-3-small",
      input: ["a", "b"],
      dimensions: 3,
      inputType: "query",
      apiKey: "sk-test-openai-123456",
      fetch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(headersOf(calls[0]).Authorization).toBe("Bearer sk-test-openai-123456");
    // OpenAI has no input-type parameter, so inputType is not sent.
    expect(bodyOf(calls[0])).toEqual({
      model: "text-embedding-3-small",
      input: ["a", "b"],
      encoding_format: "float",
      dimensions: 3,
    });
    expect(result).toEqual({
      embeddings: [
        [0, 1, 2],
        [1, 2, 3],
      ],
      model: "text-embedding-3-small",
      usage: { inputTokens: 4 },
    });
  });

  it("matches the OpenRouter consumer call: body, provider routing and input order", async () => {
    const { fetch, calls } = fakeFetch((body) => openAIEmbeddingReply(body, 2, true));
    const result = await embed({
      provider: "openrouter",
      model: "google/gemini-embedding-2",
      input: ["x", "y", "z"],
      dimensions: 2,
      inputType: "document",
      apiKey: "or-key-1234567890",
      fetch,
      providerOptions: {
        provider: { zdr: true, data_collection: "deny", allow_fallbacks: true },
      },
    });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(bodyOf(calls[0])).toEqual({
      model: "google/gemini-embedding-2",
      input: ["x", "y", "z"],
      encoding_format: "float",
      dimensions: 2,
      input_type: "search_document",
      provider: { zdr: true, data_collection: "deny", allow_fallbacks: true },
    });
    // Reply came back reversed; result is in input order.
    expect(result.embeddings).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("never lets providerOptions override core fields", async () => {
    const { fetch, calls } = fakeFetch((body) => openAIEmbeddingReply(body));
    await embed({
      provider: "openrouter",
      model: "real/model",
      input: ["a"],
      fetch,
      providerOptions: {
        model: "other/model",
        input: ["injected"],
        encoding_format: "base64",
        dimensions: 99,
        input_type: "search_query",
        user: "u-1",
      },
    });
    const body = bodyOf(calls[0]);
    expect(body.model).toBe("real/model");
    expect(body.input).toEqual(["a"]);
    expect(body.encoding_format).toBe("float");
    expect(body).not.toHaveProperty("dimensions");
    // Non-core fields gg-ai didn't set pass through.
    expect(body.input_type).toBe("search_query");
    expect(body.user).toBe("u-1");
  });

  it("calls Gemini's native batchEmbedContents with task type and output dimensionality", async () => {
    const { fetch, calls } = fakeFetch((body) => {
      const requests = body.requests as unknown[];
      return jsonResponse({
        embeddings: requests.map((_, i) => ({ values: [i, 0.5] })),
        usageMetadata: { promptTokenCount: 7 },
      });
    });
    const result = await embed({
      provider: "gemini",
      model: "gemini-embedding-001",
      input: ["q1", "q2"],
      dimensions: 2,
      inputType: "query",
      apiKey: "AIza-test-key-123456",
      fetch,
    });
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect(headersOf(calls[0])["x-goog-api-key"]).toBe("AIza-test-key-123456");
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({
      requests: ["q1", "q2"].map((text) => ({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        embedContentConfig: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 2 },
      })),
    });
    expect(result).toEqual({
      embeddings: [
        [0, 0.5],
        [1, 0.5],
      ],
      model: "gemini-embedding-001",
      usage: { inputTokens: 7 },
    });
  });

  it("ignores inputType for gemini-embedding-2, which takes the task as a text prefix", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ embeddings: [{ values: [1] }] }));
    await embed({
      provider: "gemini",
      model: "gemini-embedding-2",
      input: ["d"],
      inputType: "document",
      apiKey: "AIza-test-key-123456",
      fetch,
    });
    const request = (bodyOf(calls[0]).requests as Record<string, unknown>[])[0];
    expect(request).not.toHaveProperty("embedContentConfig");
  });

  it("requires a Gemini API key", async () => {
    await expect(
      embed({ provider: "gemini", model: "gemini-embedding-001", input: ["a"] }),
    ).rejects.toMatchObject({ source: "auth" });
  });

  it("strips local model prefixes and requires a base URL", async () => {
    const { fetch, calls } = fakeFetch((body) => openAIEmbeddingReply(body));
    await embed({
      provider: "local",
      model: "local/ollama-1/nomic-embed-text",
      input: ["a"],
      inputType: "query",
      baseUrl: "http://127.0.0.1:11434/v1/",
      fetch,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
    expect(bodyOf(calls[0])).toEqual({
      model: "nomic-embed-text",
      input: ["a"],
      encoding_format: "float",
    });

    await expect(embed({ provider: "local", model: "m", input: ["a"], fetch })).rejects.toThrow(
      /requires a baseUrl/,
    );
  });

  it("batches at the provider limit, in order and in sequence", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { fetch, calls } = fakeFetch((body) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const offset = calls.length - 1;
      const input = body.input as string[];
      inFlight--;
      return jsonResponse({
        data: input.map((text, index) => ({ index, embedding: [Number(text), offset] })),
      });
    });
    const input = Array.from({ length: 150 }, (_, i) => String(i));
    const result = await embed({ provider: "openrouter", model: "m", input, fetch });

    // OpenRouter's default batch is 64.
    expect(calls.map((call) => (bodyOf(call).input as string[]).length)).toEqual([64, 64, 22]);
    expect(result.embeddings.map((vector) => vector[0])).toEqual(input.map(Number));
    expect(maxInFlight).toBe(1);
    expect(result.usage).toBeUndefined();

    const custom = await embed({
      provider: "openrouter",
      model: "m",
      input,
      fetch,
      batchSize: 100,
    });
    expect(custom.embeddings).toHaveLength(150);
    expect(calls).toHaveLength(5);
  });

  it("splits Gemini requests at 100", async () => {
    const { fetch, calls } = fakeFetch((body) =>
      jsonResponse({ embeddings: (body.requests as unknown[]).map(() => ({ values: [1] })) }),
    );
    await embed({
      provider: "gemini",
      model: "gemini-embedding-001",
      input: Array.from({ length: 201 }, () => "t"),
      apiKey: "AIza-test-key-123456",
      fetch,
    });
    expect(calls.map((call) => (bodyOf(call).requests as unknown[]).length)).toEqual([100, 100, 1]);
  });

  it("returns [] for empty input without a network call", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    expect(await embed({ provider: "openai", model: "m", input: [], fetch })).toEqual({
      embeddings: [],
      model: "m",
    });
    expect(calls).toHaveLength(0);
  });

  it("throws when the provider returns the wrong number of vectors", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }));
    await expect(
      embed({ provider: "openai", model: "m", input: ["a", "b"], fetch }),
    ).rejects.toThrow(/expected 2 embeddings, got 1/);
  });

  it("throws on duplicate or out-of-range indices", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [2] },
        ],
      }),
    );
    await expect(
      embed({ provider: "openai", model: "m", input: ["a", "b"], fetch }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws on a dimension mismatch instead of padding or truncating", async () => {
    const { fetch } = fakeFetch((body) => openAIEmbeddingReply(body, 4));
    await expect(
      embed({ provider: "openai", model: "m", input: ["a"], dimensions: 3, fetch }),
    ).rejects.toThrow(/requested 3 dimensions, got a vector with 4/);
  });

  it("throws when vectors in one result have different lengths", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 1, embedding: [1, 2, 3] },
        ],
      }),
    );
    await expect(
      embed({ provider: "openai", model: "m", input: ["a", "b"], fetch }),
    ).rejects.toThrow(/different lengths/);
  });

  it("throws on non-numeric values", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, "x"] }] }));
    await expect(embed({ provider: "openai", model: "m", input: ["a"], fetch })).rejects.toThrow(
      /non-numeric/,
    );
  });

  it("L2-normalizes only when asked", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: [3, 4] },
          { index: 1, embedding: [0, 0] },
        ],
      }),
    );
    const raw = await embed({ provider: "openai", model: "m", input: ["a", "b"], fetch });
    expect(raw.embeddings[0]).toEqual([3, 4]);
    const unit = await embed({
      provider: "openai",
      model: "m",
      input: ["a", "b"],
      fetch,
      normalize: true,
    });
    expect(unit.embeddings).toEqual([
      [0.6, 0.8],
      [0, 0],
    ]);
  });

  it("rejects invalid dimensions and batchSize before any request", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    await expect(
      embed({ provider: "openai", model: "m", input: ["a"], dimensions: 0, fetch }),
    ).rejects.toThrow(/dimensions must be a positive integer/);
    await expect(
      embed({ provider: "openai", model: "m", input: ["a"], batchSize: 1.5, fetch }),
    ).rejects.toThrow(/batchSize must be a positive integer/);
    expect(calls).toHaveLength(0);
  });

  it("throws a capability error for providers without embeddings", async () => {
    const error = await embed({ provider: "anthropic", model: "m", input: ["a"] }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GGAIError);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ source: "capability" });
    expect((error as Error).message).toBe(`Provider "anthropic" doesn't support embeddings.`);
    expect(formatError(error).guidance).toMatch(/openai/);
  });

  it("throws for unknown providers", async () => {
    await expect(embed({ provider: "nope" as Provider, model: "m", input: ["a"] })).rejects.toThrow(
      /Unknown provider: "nope"/,
    );
  });

  it("uses a custom provider registered with embed and embedBatchSize", async () => {
    const embedFn = vi.fn(async ({ input }: { input: string[] }) => ({
      embeddings: input.map((text) => [text.length]),
    }));
    providerRegistry.register(TEST_PROVIDER, {
      stream: () => {
        throw new Error("unused");
      },
      embed: embedFn,
      embedBatchSize: 2,
    });
    const result = await embed({ provider: TEST_PROVIDER, model: "m", input: ["a", "bb", "ccc"] });
    expect(result.embeddings).toEqual([[1], [2], [3]]);
    expect(embedFn).toHaveBeenCalledTimes(2);
  });
});

describe("embed() and rerank() errors", () => {
  const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";

  it("maps 401 to an auth ProviderError with the request id and a redacted message", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        { error: { message: `Invalid API key ${SECRET}`, code: 401 } },
        { status: 401, headers: { "x-request-id": "req_123" } },
      ),
    );
    const error = await embed({
      provider: "openrouter",
      model: "m",
      input: ["a"],
      apiKey: SECRET,
      fetch,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ source: "auth", statusCode: 401, requestId: "req_123" });
    expect((error as Error).message).not.toContain(SECRET);
    expect(formatError(error).message).not.toContain(SECRET);
  });

  it("maps 402 and billing messages to a hard usage-limit stop", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: { message: "Insufficient credits" } }, { status: 402 }),
    );
    const error = await rerank({
      provider: "openrouter",
      model: "m",
      query: "q",
      documents: ["d"],
      fetch,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({ source: "provider", statusCode: 402 });
    expect(isUsageLimitError(error)).toBe(true);

    const { fetch: billing } = fakeFetch(() =>
      jsonResponse({ error: { message: "Your credit balance is too low" } }, { status: 400 }),
    );
    const billingError = await embed({
      provider: "openai",
      model: "m",
      input: ["a"],
      fetch: billing,
    }).catch((err: unknown) => err);
    expect(isUsageLimitError(billingError)).toBe(true);
  });

  it("maps 429 to a transient ProviderError with resetsAt from Retry-After", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        { error: { message: "Rate limit exceeded" } },
        { status: 429, headers: { "retry-after": "12" } },
      ),
    );
    const before = Math.floor(Date.now() / 1000);
    const error = await embed({ provider: "openai", model: "m", input: ["a"], fetch }).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ statusCode: 429, message: "Rate limit exceeded" });
    expect(isUsageLimitError(error)).toBe(false);
    expect((error as ProviderError).resetsAt).toBeGreaterThanOrEqual(before + 12);
  });

  it("maps 5xx (including HTML pages) to a provider error without markup", async () => {
    const { fetch } = fakeFetch(
      () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    );
    const error = await embed({ provider: "openai", model: "m", input: ["a"], fetch }).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ source: "provider", statusCode: 502 });
    expect((error as Error).message).not.toContain("<html>");
  });

  it("truncates long plain-text error bodies", async () => {
    const { fetch } = fakeFetch(() => new Response("x".repeat(5000), { status: 500 }));
    const error = await embed({ provider: "openai", model: "m", input: ["a"], fetch }).catch(
      (err: unknown) => err,
    );
    expect((error as Error).message.length).toBeLessThan(300);
  });

  it("maps fetch rejections to network errors without leaking the key", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for Bearer ${SECRET}`);
    }) as unknown as typeof globalThis.fetch;
    const error = await embed({
      provider: "openai",
      model: "m",
      input: ["a"],
      apiKey: SECRET,
      fetch,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GGAIError);
    expect(error).toMatchObject({ source: "network" });
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("aborts the in-flight request and skips remaining batches", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push("call");
      controller.abort();
      init?.signal?.throwIfAborted();
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    const error = await embed({
      provider: "openrouter",
      model: "m",
      input: Array.from({ length: 200 }, () => "t"),
      signal: controller.signal,
      fetch,
    }).catch((err: unknown) => err);
    expect((error as Error).name).toBe("AbortError");
    expect(calls).toHaveLength(1);
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    await expect(
      rerank({
        provider: "openrouter",
        model: "m",
        query: "q",
        documents: ["d"],
        signal: controller.signal,
        fetch,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});

describe("rerank()", () => {
  it("matches the OpenRouter consumer call and sorts by score", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        id: "gen-rerank-1",
        model: "qwen/qwen3-reranker-8b",
        results: [
          { index: 0, relevance_score: 0.2, document: { text: "a" } },
          { index: 2, relevance_score: 0.9, document: { text: "c" } },
          { index: 1, relevance_score: 0.5, document: { text: "b" } },
        ],
        usage: { search_units: 1, total_tokens: 150 },
      }),
    );
    const documents = ["a", "b", "c"];
    const result = await rerank({
      provider: "openrouter",
      model: "qwen/qwen3-reranker-8b",
      query: "q",
      documents,
      topN: documents.length,
      apiKey: "or-key-1234567890",
      fetch,
      providerOptions: { provider: { zdr: true, data_collection: "deny" }, top_n: 1, query: "x" },
    });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(headersOf(calls[0]).Authorization).toBe("Bearer or-key-1234567890");
    expect(bodyOf(calls[0])).toEqual({
      model: "qwen/qwen3-reranker-8b",
      query: "q",
      documents,
      top_n: 3,
      provider: { zdr: true, data_collection: "deny" },
    });
    expect(result).toEqual({
      results: [
        { index: 2, score: 0.9 },
        { index: 1, score: 0.5 },
        { index: 0, score: 0.2 },
      ],
      model: "qwen/qwen3-reranker-8b",
      usage: { inputTokens: 150, searchUnits: 1 },
    });
  });

  it("applies topN even when the server returns every document", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        results: [
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.7 },
        ],
      }),
    );
    const result = await rerank({
      provider: "local",
      model: "bge-reranker",
      query: "q",
      documents: ["a", "b"],
      topN: 1,
      baseUrl: "http://127.0.0.1:8012/v1",
      fetch,
    });
    expect(result.results).toEqual([{ index: 1, score: 0.7 }]);
    expect(result.model).toBe("bge-reranker");
  });

  it("throws on out-of-range or duplicate indices", async () => {
    for (const results of [
      [{ index: 2, relevance_score: 1 }],
      [{ index: -1, relevance_score: 1 }],
      [
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 0.5 },
      ],
    ]) {
      const { fetch } = fakeFetch(() => jsonResponse({ results }));
      await expect(
        rerank({ provider: "openrouter", model: "m", query: "q", documents: ["a", "b"], fetch }),
      ).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it("returns [] for empty documents without a network call", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    expect(
      await rerank({ provider: "openrouter", model: "m", query: "q", documents: [], fetch }),
    ).toEqual({ results: [], model: "m" });
    expect(calls).toHaveLength(0);
  });

  it("throws a capability error for providers without reranking", async () => {
    await expect(
      rerank({ provider: "openai", model: "m", query: "q", documents: ["a"] }),
    ).rejects.toMatchObject({
      source: "capability",
      message: `Provider "openai" doesn't support reranking.`,
    });
  });
});

describe("palsu embed and rerank fakes", () => {
  it("returns deterministic unit vectors and counts batches", async () => {
    const palsu = registerPalsuProvider({ embedBatchSize: 2 });
    try {
      const input = ["the cat sat", "the cat sat", "quantum physics", ""];
      const first = await embed({ provider: "palsu", model: "fake", input });
      const second = await embed({ provider: "palsu", model: "fake", input });
      expect(first.embeddings).toEqual(second.embeddings);
      expect(first.embeddings[0]).toHaveLength(64);
      expect(first.embeddings[0]).toEqual(first.embeddings[1]);
      expect(first.embeddings[0]).toEqual(palsuEmbedding("the cat sat"));
      for (const vector of first.embeddings) {
        expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
      }
      expect(palsu.state.embedCallCount).toBe(4);

      const sized = await embed({ provider: "palsu", model: "fake", input: ["a"], dimensions: 8 });
      expect(sized.embeddings[0]).toHaveLength(8);
    } finally {
      palsu.unregister();
    }
  });

  it("ranks documents by query-word overlap", async () => {
    const palsu = registerPalsuProvider();
    try {
      const result = await rerank({
        provider: "palsu",
        model: "fake",
        query: "red apple",
        documents: ["blue sky", "a red apple", "red car"],
      });
      expect(result.results).toEqual([
        { index: 1, score: 1 },
        { index: 2, score: 0.5 },
        { index: 0, score: 0 },
      ]);
      expect(palsuRerankScore("red apple", "red car")).toBe(0.5);
      expect(palsu.state.rerankCallCount).toBe(1);
    } finally {
      palsu.unregister();
    }
  });
});
