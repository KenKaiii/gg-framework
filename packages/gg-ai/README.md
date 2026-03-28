# @kenkaiiii/gg-ai

<p align="center">
  <strong>Unified LLM streaming API. Four providers. One interface.</strong>
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
| `anthropic` | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | Extended thinking, prompt caching, server-side compaction |
| `openai` | GPT-4.1, o3, o4-mini | Supports OAuth (codex endpoint) and API keys |
| `glm` | GLM-5.1, GLM-4.7 | Z.AI platform, OpenAI-compatible |
| `moonshot` | Kimi K2.5 | Moonshot platform, OpenAI-compatible |

---

## Stream events

| Event | Description |
|---|---|
| `text_delta` | Incremental text output |
| `thinking_delta` | Extended thinking output (Anthropic) |
| `toolcall_delta` | Streaming tool call arguments |
| `toolcall_done` | Completed tool call with parsed args |
| `server_toolcall` | Server-side tool invocation |
| `server_toolresult` | Server-side tool result |
| `done` | Stream finished, includes stop reason |
| `error` | Error occurred |

---

## Options

| Option | Type | Description |
|---|---|---|
| `provider` | `"anthropic" \| "openai" \| "glm" \| "moonshot"` | Required |
| `model` | `string` | Required |
| `messages` | `Message[]` | Required |
| `tools` | `Tool[]` | Tool definitions with Zod schemas |
| `toolChoice` | `"auto" \| "none" \| "required" \| { name }` | Tool selection strategy |
| `serverTools` | `ServerToolDefinition[]` | Server-side tool definitions |
| `maxTokens` | `number` | Max output tokens |
| `temperature` | `number` | Sampling temperature |
| `topP` | `number` | Nucleus sampling |
| `stop` | `string[]` | Stop sequences |
| `thinking` | `"low" \| "medium" \| "high" \| "max"` | Extended thinking (Anthropic) |
| `apiKey` | `string` | Provider API key |
| `baseUrl` | `string` | Custom endpoint |
| `signal` | `AbortSignal` | Cancellation |
| `cacheRetention` | `"none" \| "short" \| "long"` | Prompt cache preference |
| `compaction` | `boolean` | Server-side compaction (Anthropic only) |

---

## License

MIT
