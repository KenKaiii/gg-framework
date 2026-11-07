<h1 align="center">@kenkaiiii/gg-ai</h1>

<p align="center">
  <strong>One <code>stream()</code> call for 12 LLM providers and your local models.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-ai"><img src="https://img.shields.io/npm/v/@kenkaiiii/gg-ai?style=for-the-badge&color=blue" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-ai"><img src="https://img.shields.io/npm/dm/@kenkaiiii/gg-ai?style=for-the-badge&color=2ecc71" alt="npm downloads per month"></a>
  <a href="https://github.com/KenKaiii/gg-framework/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

gg-ai streams chat, tool calls and reasoning from Anthropic, OpenAI, Gemini, xAI, Moonshot, GLM, MiniMax, Xiaomi, DeepSeek, Sakana, OpenRouter, Hugging Face and local servers. To switch provider, change one string. There are no adapters or wrapper classes. It also does embeddings and reranking.

It's the provider layer under [GG Coder](https://github.com/KenKaiii/gg-framework), a desktop coding agent.

## Install

```bash
npm install @kenkaiiii/gg-ai zod
```

Needs Node.js 22 or newer. Ships ESM and CommonJS builds with TypeScript types.

## Quick start

```ts
import { stream } from "@kenkaiiii/gg-ai";

const result = stream({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  apiKey: process.env.ANTHROPIC_API_KEY,
  messages: [{ role: "user", content: "Explain closures in one paragraph." }],
});

// Iterate for live events...
for await (const event of result) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}

// ...and await for the final message, stop reason and token usage.
const { message, stopReason, usage } = await result;
```

`stream()` returns one object that you can iterate (`for await`) and await. You can do either, or both.

## Tools

Tool parameters are [Zod](https://zod.dev) schemas. gg-ai converts them to each provider's JSON Schema format for you.

```ts
import { stream, type Tool } from "@kenkaiiii/gg-ai";
import { z } from "zod";

const getWeather: Tool = {
  name: "get_weather",
  description: "Current weather for a city",
  parameters: z.object({ city: z.string() }),
};

const result = stream({
  provider: "openai",
  model: "gpt-6-luna",
  apiKey,
  messages,
  tools: [getWeather],
});

for await (const event of result) {
  if (event.type === "toolcall_done") console.log(event.name, event.args); // get_weather { city: "Paris" }
}
```

gg-ai makes one model call. To run the tools and send results back until the model is done, use [`@kenkaiiii/gg-agent`](https://www.npmjs.com/package/@kenkaiiii/gg-agent).

## Providers

| Provider      | Built-in models                                                 | Notes                                                                                     |
| ------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `anthropic`   | Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5               | Extended thinking, prompt caching, server-side compaction                                 |
| `openai`      | GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna             | Responses API. API key, or a ChatGPT plan token plus `accountId` (Sign in with ChatGPT)   |
| `gemini`      | Gemini 3.1 Pro (Preview), 3.8 / 3.5 Flash, 3.5 / 3.1 Flash Lite | Google AI Studio key on the public Gemini API. Native video input                         |
| `xai`         | Grok 4.7                                                        | API key                                                                                   |
| `moonshot`    | Kimi K3, K2.8 Preview, K2.7 Code, K2.7 Code HighSpeed           | Moonshot key, or a Kimi Code plan key with its `baseUrl`. Native video input              |
| `glm`         | GLM-5.3, GLM-5.3-Flash                                          | Z.AI standard (pay-per-token) endpoint                                                    |
| `minimax`     | MiniMax M3.1 Flash, M3                                          | Anthropic-compatible endpoint. Native video input                                         |
| `xiaomi`      | MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed        | Native video input                                                                        |
| `deepseek`    | DeepSeek V4 Pro, V4.1 Flash                                     |                                                                                           |
| `sakana`      | Fugu, Fugu Max, Fugu Ultra                                      |                                                                                           |
| `openrouter`  | Qwen3.8 Max, or any OpenRouter model id                         | Gateway to hundreds of models                                                             |
| `huggingface` | Kimi K2.7 Code, DeepSeek V4.1 Flash, GPT-OSS 120B               | Inference Providers router                                                                |
| `local`       | Whatever your server runs                                       | Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible server. `baseUrl` is required |

"Built-in models" are the ones GG Coder lists (from [`@kenkaiiii/gg-core`](https://www.npmjs.com/package/@kenkaiiii/gg-core)). `model` is passed straight to the provider, so any model id the provider accepts works. Every default endpoint can be changed with `baseUrl`, and `providerRegistry.register()` adds your own provider.

## Stream events

| Event               | When                                                         |
| ------------------- | ------------------------------------------------------------ |
| `text_delta`        | New text (`event.text`)                                      |
| `thinking_delta`    | New reasoning text, from providers that stream it            |
| `toolcall_delta`    | Tool call arguments as they stream in                        |
| `toolcall_done`     | A complete tool call with parsed `args`                      |
| `server_toolcall`   | The provider ran a server-side tool (for example web search) |
| `server_toolresult` | Result of that server-side tool                              |
| `keepalive`         | The stream is alive but has nothing new yet                  |
| `done`              | Finished, with `stopReason`                                  |
| `error`             | Something failed                                             |

## Options

| Option            | Type                                                         | What it does                                                        |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `provider`        | `Provider`                                                   | **Required.** Any id from the providers table                       |
| `model`           | `string`                                                     | **Required.**                                                       |
| `messages`        | `Message[]`                                                  | **Required.** `system`, `user`, `assistant` and `tool` messages     |
| `apiKey`          | `string`                                                     | API key or sign-in token                                            |
| `baseUrl`         | `string`                                                     | Use a different endpoint                                            |
| `tools`           | `Tool[]`                                                     | Tools with Zod parameter schemas                                    |
| `toolChoice`      | `"auto" \| "none" \| "required" \| { name }`                 | Whether the model may, must or must not call a tool                 |
| `thinking`        | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"` | Reasoning effort. Each provider maps it to what the model supports  |
| `maxTokens`       | `number`                                                     | Output token limit                                                  |
| `temperature`     | `number`                                                     | Sampling temperature                                                |
| `topP`            | `number`                                                     | Nucleus sampling                                                    |
| `stop`            | `string[]`                                                   | Stop sequences                                                      |
| `signal`          | `AbortSignal`                                                | Cancel the request                                                  |
| `cacheRetention`  | `"none" \| "short" \| "long"`                                | Prompt cache preference                                             |
| `promptCacheKey`  | `string`                                                     | Stable cache routing key (OpenAI, Moonshot, Gemini)                 |
| `webSearch`       | `boolean`                                                    | The provider's own web search, where it has one                     |
| `serverTools`     | `ServerToolDefinition[]`                                     | Other server-side tools                                             |
| `compaction`      | `boolean`                                                    | Server-side context compaction (Anthropic only)                     |
| `clearToolUses`   | `boolean`                                                    | Server-side clearing of old tool results (Anthropic only)           |
| `fetch`           | `typeof fetch`                                               | Your own `fetch`, for example in React Native                       |
| `providerOptions` | `Record<string, unknown>`                                    | Extra provider-specific request fields (see Provider options below) |

The full list, including less common transport settings, is the `StreamOptions` type.

### Provider options

`providerOptions` is merged into the JSON body of `stream()`, `embed()` and `rerank()` requests. It only adds fields gg-ai hasn't set itself. Core fields (`model`, `messages`, `input`, `query`, `documents`, `stream`, `tools`, `system`, `contents`, `requests`, `dimensions`, `encoding_format`, `top_n`) can't be set this way. The main use is OpenRouter's [provider routing](https://openrouter.ai/docs/features/provider-routing):

```ts
import { stream, type OpenRouterProviderPreferences } from "@kenkaiiii/gg-ai";

const result = stream({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  apiKey,
  messages,
  providerOptions: {
    provider: { zdr: true, data_collection: "deny" } satisfies OpenRouterProviderPreferences,
  },
});
```

## Errors

| Failure                                                | Error                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| HTTP 401 / 403                                         | `ProviderError`, `source: "auth"`                                           |
| HTTP 402, or billing text such as `insufficient_quota` | `ProviderError` where `isUsageLimitError(err)` is true                      |
| HTTP 429                                               | `ProviderError`, `statusCode: 429`, `resetsAt` from `Retry-After` when sent |
| Other HTTP errors                                      | `ProviderError` with `statusCode` and `requestId`                           |
| Connection failure                                     | `GGAIError`, `source: "network"`                                            |
| `signal` aborted                                       | `AbortError` (`DOMException`)                                               |

Provider error bodies are trimmed to their message, redacted and truncated, so API keys never end up in an error. `formatError(err)` turns any of these into a plain-English `headline`, `message` and `guidance` you can show a user.

gg-ai doesn't retry; that's up to the caller (`@kenkaiiii/gg-agent` does it for you). If you retry yourself, back off on 429 and 5xx, and never retry auth errors or errors where `isUsageLimitError(err)` is true.

## Embeddings and reranking

`embed()` and `rerank()` use the same providers as `stream()`.

```ts
import { embed, rerank } from "@kenkaiiii/gg-ai";

const { embeddings } = await embed({
  provider: "openai",
  model: "text-embedding-3-small",
  input: chunks, // any length; batched for you
  apiKey,
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
// results: [{ index, score }], best first
```

What you can rely on:

- **Order.** Vectors come back in input order, even if the provider returns them out of order.
- **Batching.** Long inputs are split at the provider's limit (override with `batchSize`). Batches run one at a time.
- **Validation.** Exactly one vector per input, all numbers, all the same length, and `dimensions` long if you asked for that. Otherwise it throws `ProviderError`. Nothing is padded or cut.
- **Normalizing.** `normalize: true` scales every vector to length 1. It's off by default. If you compare vectors with cosine similarity or a dot product and aren't sure your model already returns unit vectors, turn it on.
- **Query vs document.** `inputType: "query" | "document"` maps to Gemini's `taskType` and OpenRouter's `input_type`. Other providers ignore it.
- **Reranking.** Results are sorted best first, at most `topN` come back, and every `index` points into your `documents`.
- **Empty input** returns an empty result without a request.

| Provider     | `embed`                              | Inputs per request | `rerank`                          |
| ------------ | ------------------------------------ | ------------------ | --------------------------------- |
| `openai`     | ✓                                    | 2048               |                                   |
| `openrouter` | ✓                                    | 64                 | ✓                                 |
| `gemini`     | ✓ (AI Studio key, not sign-in)       | 100                |                                   |
| `local`      | ✓ Ollama, LM Studio, llama.cpp, vLLM | 64                 | ✓ llama.cpp (`--rerank`) and vLLM |

Other providers don't offer these endpoints. Calling them throws `GGAIError` with `source: "capability"`; check first with `providerRegistry.supports(provider, "embed")`. OpenAI embeddings need a platform API key; ChatGPT plan tokens can't call them.

### Your own provider

A registered provider can offer `embed` and `rerank` alongside `stream`. Your functions handle one request; gg-ai does the batching, checks, ordering and normalizing.

```ts
import { providerRegistry, embed, type Provider, type ProviderEntry } from "@kenkaiiii/gg-ai";

providerRegistry.register("my-search", {
  stream: () => {
    throw new Error("chat not supported");
  },
  embedBatchSize: 128,
  embed: async ({ model, input, apiKey, signal, fetch = globalThis.fetch }) => {
    const res = await fetch("https://example.com/embed", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, texts: input }),
      signal,
    });
    const json = await res.json();
    return { embeddings: json.vectors, usage: { inputTokens: json.tokens } };
  },
} satisfies ProviderEntry);

// `Provider` lists the built-ins, so custom names need a cast.
await embed({ provider: "my-search" as Provider, model: "v1", input: ["hello"] });
```

## Testing without a network

`registerPalsuProvider()` adds a fake `palsu` provider that replays responses you queue, so tests run offline and give the same result every time.

```ts
import { registerPalsuProvider, palsuText, stream } from "@kenkaiiii/gg-ai";

const palsu = registerPalsuProvider();
palsu.appendResponses(palsuText("Hello!"));

const { message } = await stream({ provider: "palsu", model: "test", messages });
palsu.unregister();
```

`palsuToolCall()`, `palsuThinking()` and friends script other responses. `palsu` also has deterministic `embed` and `rerank`.

## The GG Framework

| Package                                                                  | What it does                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **@kenkaiiii/gg-ai**                                                     | One streaming API for every provider (this package)               |
| [@kenkaiiii/gg-agent](https://www.npmjs.com/package/@kenkaiiii/gg-agent) | The agent loop: runs tools and feeds results back to the model    |
| [@kenkaiiii/gg-core](https://www.npmjs.com/package/@kenkaiiii/gg-core)   | Model list, sign-in and stored credentials, local model discovery |
| [@kenkaiiii/ggcoder](https://www.npmjs.com/package/@kenkaiiii/ggcoder)   | The GG Coder coding agent: CLI, tools and sessions                |

Source, issues and the desktop app: [github.com/KenKaiii/gg-framework](https://github.com/KenKaiii/gg-framework).

## License

[AGPL-3.0-only](https://github.com/KenKaiii/gg-framework/blob/main/LICENSE). You can build on it; if you distribute your changes or run them as a network service, share their source under the same license.
