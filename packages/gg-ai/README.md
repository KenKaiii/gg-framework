# @kenkaiiii/gg-ai

<p align="center">
  <strong>Unified LLM streaming API. Twelve providers plus local models. One interface.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-ai"><img src="https://img.shields.io/npm/v/@kenkaiiii/gg-ai?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

One function. Flat options. Switch providers by changing a string. No adapters, no plugins, no wrapper classes.

Part of the [GG Framework](../../README.md) monorepo.

---

## Install

```bash
npm i @kenkaiiii/gg-ai
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
| `anthropic` | Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 | Extended thinking, prompt caching, server-side compaction |
| `openai` | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | OAuth (Codex endpoint) or API key |
| `gemini` | Gemini 3.1 Pro (Preview), 3.8 / 3.7 / 3.5 Flash, 3.5 / 3.1 Flash Lite | OAuth (Code Assist); native video input |
| `xai` | Grok 4.7 | OpenAI-compatible, `https://api.x.ai/v1` |
| `moonshot` | Kimi K3, K2.8 Preview, K2.7 Code, K2.7 Code HighSpeed | OpenAI-compatible; native video input |
| `glm` | GLM-5.3, GLM-5.3-Flash | Z.AI coding endpoint, OpenAI-compatible |
| `minimax` | MiniMax M3 | Anthropic-compatible endpoint |
| `xiaomi` | MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed | OpenAI-compatible |
| `deepseek` | DeepSeek V4 Pro, V4.1 Flash | OpenAI-compatible |
| `sakana` | Fugu, Fugu Max, Fugu Ultra | OpenAI-compatible |
| `openrouter` | Qwen3.8 Max, or any OpenRouter model id | OpenAI-compatible gateway |
| `huggingface` | Kimi K2.7 Code, DeepSeek V4.1 Flash, GPT-OSS 120B | Inference Providers router, OpenAI-compatible |
| `local` | Any model your server exposes | Ollama, LM Studio, llama.cpp, vLLM; `baseUrl` is required |

The model lists are the ones GG Coder ships in its registry (`@kenkaiiii/gg-core`). `stream()` passes `model` straight through, so any id the provider accepts works. Every provider's default endpoint can be overridden with `baseUrl`, and `providerRegistry.register()` adds your own.

---

## Stream events

| Event | Description |
|---|---|
| `text_delta` | Incremental text output |
| `thinking_delta` | Reasoning output, from any provider that streams it |
| `toolcall_delta` | Streaming tool call arguments |
| `toolcall_done` | Completed tool call with parsed args |
| `server_toolcall` | Server-side tool invocation |
| `server_toolresult` | Server-side tool result |
| `keepalive` | Provider heartbeat: the stream is alive but has no new content yet |
| `done` | Stream finished, includes stop reason |
| `error` | Error occurred |

---

## Options

| Option | Type | Description |
|---|---|---|
| `provider` | `Provider` (any id in the table above) | Required |
| `model` | `string` | Required |
| `messages` | `Message[]` | Required |
| `tools` | `Tool[]` | Tool definitions with Zod schemas |
| `toolChoice` | `"auto" \| "none" \| "required" \| { name }` | Tool selection strategy |
| `serverTools` | `ServerToolDefinition[]` | Server-side tool definitions |
| `maxTokens` | `number` | Max output tokens |
| `temperature` | `number` | Sampling temperature |
| `topP` | `number` | Nucleus sampling |
| `stop` | `string[]` | Stop sequences |
| `thinking` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"` | Reasoning effort; each provider maps it to what the model supports |
| `apiKey` | `string` | Provider API key |
| `baseUrl` | `string` | Custom endpoint |
| `signal` | `AbortSignal` | Cancellation |
| `cacheRetention` | `"none" \| "short" \| "long"` | Prompt cache preference |
| `promptCacheKey` | `string` | Stable cache routing key (OpenAI, Moonshot, Gemini) |
| `webSearch` | `boolean` | Provider-native web search where supported |
| `compaction` | `boolean` | Server-side compaction (Anthropic only) |
| `clearToolUses` | `boolean` | Server-side clearing of old tool results (Anthropic only) |
| `fetch` | `typeof fetch` | Custom fetch, e.g. for React Native |
| `providerOptions` | `Record<string, unknown>` | Provider-specific body fields; see below |

### Provider-specific body fields

`providerOptions` is merged into the JSON body of `stream()`, `embed()` and `rerank()` requests. It only adds fields gg-ai hasn't set. Core fields (`model`, `messages`, `input`, `query`, `documents`, `stream`, `tools`, `system`, `contents`, `requests`, `dimensions`, `encoding_format`, `top_n`) can't be set this way, even when gg-ai left them out. The main use is OpenRouter's [provider routing](https://openrouter.ai/docs/features/provider-routing):

```ts
import { stream, type OpenRouterProviderPreferences } from "@kenkaiiii/gg-ai";

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

`@kenkaiiii/gg-agent` passes `providerOptions` and `fetch` through to every `stream()` call it makes.

---

## Embeddings and reranking

`embed()` and `rerank()` use the same provider registry as `stream()`.

```ts
import { embed, rerank } from "@kenkaiiii/gg-ai";

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
- Vectors come back in input order, even when the provider returns them out of order (gg-ai sorts by `index`).
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
| `openrouter` | ✓ `/api/v1/embeddings` | 64 (gg-ai default; OpenRouter documents no limit) | `input_type` | ✓ `/api/v1/rerank` |
| `gemini` | ✓ native `batchEmbedContents` | 100 | `taskType` | — |
| `local` | ✓ `{baseUrl}/embeddings` (Ollama, LM Studio, llama.cpp, vLLM) | 64 (gg-ai default) | ignored | ✓ `{baseUrl}/rerank` (llama.cpp `--rerank`, vLLM; Ollama and LM Studio have none and return 404) |
| `palsu` | ✓ deterministic fake | all | ignored | ✓ deterministic fake |
| `anthropic`, `xiaomi`, `glm`, `moonshot`, `minimax`, `deepseek`, `sakana`, `xai`, `huggingface` | — | | | — |

Calling `embed()` or `rerank()` on a provider without that capability throws `GGAIError` with `source: "capability"`. Check first with `providerRegistry.supports(name, "embed")`.

Notes:
- **Gemini** embeddings use the Gemini API with an AI Studio key, sent as `x-goog-api-key`. The Code Assist sign-in that `stream()` uses for Gemini chat has no embeddings endpoint.
- **OpenAI** embeddings need a platform API key. ChatGPT-subscription (Codex) tokens can't call `/embeddings`.
- Anthropic has no embeddings API (it points to Voyage AI). The other providers in the last row don't document an embeddings or rerank endpoint on the API gg-ai talks to, so none is registered for them.
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

gg-ai doesn't retry. `stream()` doesn't either: retry policy lives in the caller, which for chat is `@kenkaiiii/gg-agent`. Retry 429s and 5xx with backoff if you need to. Never retry auth errors or anything where `isUsageLimitError(err)` is true.

### Custom providers

A provider registered at runtime can offer embeddings and reranking too. `stream` is still required, and the other two are optional. gg-ai splits input into batches of `embedBatchSize`, validates and orders the results, normalizes, and sorts. Your functions only handle one request.

```ts
import { providerRegistry, embed, type Provider, type ProviderEntry } from "@kenkaiiii/gg-ai";

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
