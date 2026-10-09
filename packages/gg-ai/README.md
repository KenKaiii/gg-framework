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

---

## License

MIT
