# @kenkaiiii/gg-agent

<p align="center">
  <strong>Agent loop with multi-turn tool execution. Build agents that think, act, and loop.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-agent"><img src="https://img.shields.io/npm/v/@kenkaiiii/gg-agent?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

Give an LLM tools. It calls them. Results go back in. It loops until it's done. That's it.

Built on top of [`@kenkaiiii/gg-ai`](../gg-ai/README.md). Part of the [GG Framework](../../README.md) monorepo.

---

## Install

```bash
npm i @kenkaiiii/gg-agent
```

---

## How it works

Create an `Agent` with a provider, model, and tools. Call `agent.prompt()` to start a conversation.

- **`for await`** gives you streaming events (`text_delta`, `tool_call_start`, `tool_call_end`, `agent_done`, etc.)
- **`await`** gives you the final result (`message`, `totalTurns`, `totalUsage`)

Same dual-nature pattern as `@kenkaiiii/gg-ai`. The `Agent` class maintains conversation history — each `prompt()` call continues the conversation.

For full control, use `agentLoop()` directly — a pure async generator that takes a messages array and options.

### Tools

Define tools with a name, description, Zod schema for parameters, and an `execute` function. The execute function receives typed args and a `ToolContext` with `signal`, `toolCallId`, and `onUpdate`.

Return a string, or a `{ content, details }` object for structured results. If `execute` throws, the error becomes a tool result (not a crash). The agent sees the error and can retry or adjust.

### Safety

- `maxTurns` (default: 100) prevents runaway loops
- `AbortSignal` support for cancellation
- Zod validation on tool args
- `maxContinuations` (default: 5) caps consecutive `pause_turn` continuations

---

## Events

| Event                | Description                                   |
| -------------------- | --------------------------------------------- |
| `text_delta`         | Incremental text output                       |
| `thinking_delta`     | Extended thinking output                      |
| `tool_call_start`    | Tool invocation started (name, args)          |
| `tool_call_update`   | Progress update from a running tool           |
| `tool_call_end`      | Tool finished (result, duration, isError)     |
| `server_tool_call`   | Server-side tool invocation                   |
| `server_tool_result` | Server-side tool result                       |
| `turn_end`           | One LLM call completed (stop reason, usage)   |
| `agent_done`         | All turns finished (total turns, total usage) |
| `error`              | Fatal error                                   |

---

## Options

| Option             | Type                                             | Description                                  |
| ------------------ | ------------------------------------------------ | -------------------------------------------- |
| `provider`         | `"anthropic" \| "openai" \| "glm" \| "moonshot"` | Required                                     |
| `model`            | `string`                                         | Required                                     |
| `system`           | `string`                                         | System prompt                                |
| `tools`            | `AgentTool[]`                                    | Tools with Zod schemas and execute functions |
| `serverTools`      | `ServerToolDefinition[]`                         | Server-side tool definitions                 |
| `maxTurns`         | `number`                                         | Max LLM calls (default: 100)                 |
| `maxTokens`        | `number`                                         | Max output tokens per turn                   |
| `temperature`      | `number`                                         | Sampling temperature                         |
| `thinking`         | `"low" \| "medium" \| "high" \| "max"`           | Extended thinking                            |
| `apiKey`           | `string`                                         | Provider API key                             |
| `baseUrl`          | `string`                                         | Custom endpoint                              |
| `signal`           | `AbortSignal`                                    | Cancellation                                 |
| `cacheRetention`   | `"none" \| "short" \| "long"`                    | Prompt cache preference                      |
| `compaction`       | `boolean`                                        | Server-side compaction (Anthropic only)      |
| `maxContinuations` | `number`                                         | Max pause_turn continuations (default: 5)    |
| `transformContext` | `(messages) => messages`                         | Transform messages before each LLM call      |

`transformContext` is called before each LLM call. Use it for compaction, truncation, or injecting dynamic context.

---

## License

AGPL-3.0-only. See [LICENSE](../../LICENSE).
