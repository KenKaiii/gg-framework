# @kleio/ai

<p align="center">
  <strong>Unified LLM streaming API. Four providers. One interface.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kleio/ai"><img src="https://img.shields.io/npm/v/@kleio/ai?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

One function. Flat options. Switch providers by changing a string. No adapters, no plugins, no wrapper classes.

Part of the [Kleio Framework](../../README.md) monorepo.

---

## Install

```bash
npm i @kleio/ai
```

---

## How it works

Call `stream()` with a provider, model, and messages. That's the entire API.

- **`for await`** gives you streaming events (`text_delta`, `thinking_delta`, `toolcall_done`, etc.)
- **`await`** gives you the final response (`message`, `stopReason`, `usage`)

Same function, same call. Dual-nature `StreamResult` — async iterable and thenable.

Tool parameters are Zod schemas. Converted to JSON Schema at the provider boundary automatically.

---

## Providers

| Provider | Models | Notes |
|---|---|---|
| `anthropic` | Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 | Extended thinking, prompt caching, server-side compaction |
| `openai` | GPT-4.1, o3, o4-mini | Supports OAuth (codex endpoint) and API keys |
| `glm` | GLM-5.3 | Z.AI platform, OpenAI-compatible |
| `moonshot` | Kimi K3, Kimi K2.8 Preview, Kimi K2.7 Code | Moonshot platform, OpenAI-compatible |

---

## Stream events

| Event               | Description                           |
| ------------------- | ------------------------------------- |
| `text_delta`        | Incremental text output               |
| `thinking_delta`    | Extended thinking output (Anthropic)  |
| `toolcall_delta`    | Streaming tool call arguments         |
| `toolcall_done`     | Completed tool call with parsed args  |
| `server_toolcall`   | Server-side tool invocation           |
| `server_toolresult` | Server-side tool result               |
| `done`              | Stream finished, includes stop reason |
| `error`             | Error occurred                        |

---

## Options

| Option            | Type                                             | Description                              |
| ----------------- | ------------------------------------------------ | ---------------------------------------- |
| `provider`        | `"anthropic" \| "openai" \| "glm" \| "moonshot"` | Required                                 |
| `model`           | `string`                                         | Required                                 |
| `messages`        | `Message[]`                                      | Required                                 |
| `tools`           | `Tool[]`                                         | Tool definitions with Zod schemas        |
| `toolChoice`      | `"auto" \| "none" \| "required" \| { name }`     | Tool selection strategy                  |
| `serverTools`     | `ServerToolDefinition[]`                         | Server-side tool definitions             |
| `maxTokens`       | `number`                                         | Max output tokens                        |
| `temperature`     | `number`                                         | Sampling temperature                     |
| `topP`            | `number`                                         | Nucleus sampling                         |
| `stop`            | `string[]`                                       | Stop sequences                           |
| `thinking`        | `"low" \| "medium" \| "high" \| "max"`           | Extended thinking (Anthropic)            |
| `apiKey`          | `string`                                         | Provider API key                         |
| `baseUrl`         | `string`                                         | Custom endpoint                          |
| `signal`          | `AbortSignal`                                    | Cancellation                             |
| `cacheRetention`  | `"none" \| "short" \| "long"`                    | Prompt cache preference                  |
| `compaction`      | `boolean`                                        | Server-side compaction (Anthropic only)  |
| `providerOptions` | `Record<string, unknown>`                        | Provider-specific body fields; see below |

### Provider-specific body fields

`providerOptions` is merged into the JSON body of `stream()`, `embed()` and `rerank()` requests. It only adds fields `@kleio/ai` hasn't set. Core fields (`model`, `messages`, `input`, `query`, `documents`, `stream`, `tools`, `system`, `contents`, `requests`, `dimensions`, `encoding_format`, `top_n`) can't be set this way, even when `@kleio/ai` left them out. The main use is OpenRouter's [provider routing](https://openrouter.ai/docs/features/provider-routing):

```ts
import { stream, type OpenRouterProviderPreferences } from "@kleio/ai";

const result = stream({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  messages,
  apiKey,
  providerOptions: {
    provider: { zdr: true, data_collection: "deny" } satisfies OpenRouterProviderPreferences,
  },
});
```

`@kleio/agent` passes `providerOptions` and `fetch` through to every `stream()` call it makes.

---

## Embeddings and reranking

`embed()` and `rerank()` use the same provider registry as `stream()`.

```ts
import { embed, rerank } from "@kleio/ai";

const { embeddings, usage } = await embed({
  provider: "openrouter",
  model: "google/gemini-embedding-2",
  input: chunks, // any length; split into batches for you
  dimensions: 1536,
  normalize: true,
  apiKey,
  providerOptions: { provider: { zdr: true, data_collection: "deny", allow_fallbacks: true } },
});
// embeddings[i] is the vector for chunks[i]

const { results } = await rerank({
  provider: "openrouter",
  model: "cohere/rerank-v3.5",
  query: "capital of France",
  documents,
  topN: 5,
  apiKey,
});
// results: [{ index, score }], best first; documents[results[0].index] is the top hit
```

**What `embed()` guarantees**
- Vectors come back in input order, even when the provider returns them out of order (`@kleio/ai` sorts by `index`).
- Long inputs are split at the provider's per-request limit (table below; override with `batchSize`). Batches run one at a time, in order.
- The response is checked: exactly one vector per input, all numbers, all the same length, and `dimensions` long when you asked for that. If any check fails it throws `ProviderError`. Nothing is padded or truncated.
- `normalize: true` L2-normalizes every vector. It's off by default. OpenAI embeddings come back unit-length already, and so does Gemini at full 3072 dimensions. `gemini-embedding-2` also normalizes shortened vectors, but `gemini-embedding-001` doesn't: at reduced `dimensions` its vectors are not unit-length, so pass `normalize: true`. Through OpenRouter or a local server, it depends on the upstream model. If you compare with cosine similarity or a dot product and aren't sure, normalize.
- `inputType: "query" | "document"` maps to the provider's native task parameter: Gemini `taskType` (`RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`) and OpenRouter `input_type` (`search_query` / `search_document`). It's ignored by OpenAI and local servers, which have no such parameter. It's also ignored for `gemini-embedding-2`, where Google wants the task written into the text instead (`task: search result | query: …`).
- An empty `input` returns `{ embeddings: [] }` without making a request.

**What `rerank()` guarantees**: results are sorted by score, highest first, and each `index` points into your `documents`. At most `topN` results come back, and every index is checked. An empty `documents` returns `{ results: [] }` without making a request.

### Provider support

| Provider | `embed` | Max inputs per request | `inputType` | `rerank` |
|---|---|---|---|---|
| `openai` | ✓ `/v1/embeddings` | 2048 | ignored | — |
| `openrouter` | ✓ `/api/v1/embeddings` | 64 (`@kleio/ai` default; OpenRouter documents no limit) | `input_type` | ✓ `/api/v1/rerank` |
| `gemini` | ✓ native `batchEmbedContents` | 100 | `taskType` | — |
| `local` | ✓ `{baseUrl}/embeddings` (Ollama, LM Studio, llama.cpp, vLLM) | 64 (`@kleio/ai` default) | ignored | ✓ `{baseUrl}/rerank` (llama.cpp `--rerank`, vLLM; Ollama and LM Studio have none and return 404) |
| `palsu` | ✓ deterministic fake | all | ignored | ✓ deterministic fake |
| `anthropic`, `xiaomi`, `glm`, `moonshot`, `minimax`, `deepseek`, `sakana`, `xai`, `huggingface` | — | | | — |

Calling `embed()` or `rerank()` on a provider without that capability throws `GGAIError` with `source: "capability"`. Check first with `providerRegistry.supports(name, "embed")`.

Notes:
- **Gemini** embeddings use the Gemini API with an AI Studio key, sent as `x-goog-api-key`. The Code Assist sign-in that `stream()` uses for Gemini chat has no embeddings endpoint.
- **OpenAI** embeddings need a platform API key. ChatGPT-subscription (Codex) tokens can't call `/embeddings`.
- Anthropic has no embeddings API (it points to Voyage AI). The other providers in the last row don't document an embeddings or rerank endpoint on the API `@kleio/ai` talks to, so none is registered for them.
- Document parsing and OCR are out of scope for now. That would be a separate API (file in, pages out), and providers disagree on it much more than on embeddings.

### Errors, retries and cancellation

Failures use the same error model as `stream()`:

| Failure | Error |
|---|---|
| HTTP 401 / 403 | `ProviderError`, `source: "auth"` |
| HTTP 402, or billing text such as `insufficient_quota` | `ProviderError` with "usage limit reached" (`isUsageLimitError()` is true) |
| HTTP 429 | `ProviderError`, `statusCode: 429`, `resetsAt` from `Retry-After` when sent |
| Other HTTP errors | `ProviderError` with `statusCode` and `requestId` |
| Connection failure | `GGAIError`, `source: "network"` |
| `signal` aborted | `AbortError` (`DOMException`); remaining batches are skipped |

Provider error bodies are trimmed to their message, then redacted and truncated, so API keys never end up in an error message.

`@kleio/ai` doesn't retry. `stream()` doesn't either: retry policy lives in the caller, which for chat is `@kleio/agent`. Retry 429s and 5xx with backoff if you need to. Never retry auth errors or anything where `isUsageLimitError(err)` is true.

### Custom providers

A provider registered at runtime can offer embeddings and reranking too. `stream` is still required, and the other two are optional. `@kleio/ai` splits input into batches of `embedBatchSize`, validates and orders the results, normalizes, and sorts. Your functions only handle one request.

```ts
import { providerRegistry, embed, type Provider, type ProviderEntry } from "@kleio/ai";

providerRegistry.register("my-search", {
  stream: () => { throw new Error("chat not supported"); },
  embedBatchSize: 128,
  embed: async ({ model, input, dimensions, apiKey, signal, fetch = globalThis.fetch }) => {
    const res = await fetch("https://example.com/embed", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, texts: input, dimensions }),
      signal,
    });
    const json = await res.json();
    return { embeddings: json.vectors, usage: { inputTokens: json.tokens } };
  },
  rerank: async ({ query, documents }) => ({
    results: documents.map((doc, index) => ({ index, score: doc.includes(query) ? 1 : 0 })),
  }),
} satisfies ProviderEntry);

// `Provider` lists the built-ins, so custom names need a cast (same as for stream()).
await embed({ provider: "my-search" as Provider, model: "v1", input: ["hello"] });
```

### Testing without a network

`registerPalsuProvider()` gives `palsu` deterministic `embed` and `rerank` fakes. Embeddings are hashed bag-of-words unit vectors (64 dimensions by default, or `dimensions`), so texts that share words score closer together. Rerank scores are the fraction of query words found in each document. `embedDimensions` and `embedBatchSize` in the config change the defaults, and `state.embedCallCount` / `state.rerankCallCount` count requests.

---

## License

MIT
