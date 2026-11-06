<h1 align="center">@kenkaiiii/gg-agent</h1>

<p align="center">
  <strong>The agent loop: give a model tools, and it works until the job is done.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-agent"><img src="https://img.shields.io/npm/v/@kenkaiiii/gg-agent?style=for-the-badge&color=blue" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-agent"><img src="https://img.shields.io/npm/dm/@kenkaiiii/gg-agent?style=for-the-badge&color=2ecc71" alt="npm downloads per month"></a>
  <a href="https://github.com/KenKaiii/gg-framework/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

gg-agent calls the model, runs the tools it asks for, sends the results back, and repeats until the model stops. It handles retries, cancellation, steering mid-run, and context that grows too long. It works with every provider in [`@kenkaiiii/gg-ai`](https://www.npmjs.com/package/@kenkaiiii/gg-ai).

It's the loop that runs [GG Coder](https://github.com/KenKaiii/gg-framework), a desktop coding agent.

## Install

```bash
npm install @kenkaiiii/gg-agent @kenkaiiii/gg-ai zod
```

Needs Node.js 22 or newer. Ships ESM and CommonJS builds with TypeScript types.

## Quick start

```ts
import { Agent, type AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";

const WeatherParams = z.object({ city: z.string() });

const getWeather: AgentTool<typeof WeatherParams> = {
  name: "get_weather",
  description: "Current weather for a city",
  parameters: WeatherParams,
  async execute({ city }) {
    return `22°C and sunny in ${city}`;
  },
};

const agent = new Agent({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  apiKey: process.env.ANTHROPIC_API_KEY,
  system: "You are a helpful assistant.",
  tools: [getWeather],
});

// Iterate for live events...
const run = agent.prompt("Should I pack an umbrella for Paris?");
for await (const event of run) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "tool_call_start") console.log(`\n→ ${event.name}`, event.args);
}

// ...and await for the result.
const { message, totalTurns, totalUsage } = await run;
```

Each `prompt()` continues the same conversation. `agent.getMessages()` returns the history so you can save it, and `priorMessages` restores it later.

For full control without the class, `agentLoop(messages, options)` is the same loop as a plain async generator.

## Tools

A tool has a `name`, a `description`, a Zod schema for `parameters` and an `execute` function. `execute` gets the parsed arguments and a context with `signal`, `toolCallId` and `onUpdate` (for progress events).

- **Return** a string, or `{ content, details }` when you want to keep structured data alongside what the model sees.
- **Throwing is fine.** The error becomes the tool result and the model can try again or change course.
- **Bad arguments** are caught by the schema and returned to the model to fix.
- **Parallel by default.** Tool calls from one turn run together. Set `executionMode: "sequential"` on a tool that changes state, and that batch runs in order.
- **Timeouts.** Each tool call times out after 5 minutes; set `timeoutMs` on a tool that needs longer.

## While it runs

| Method                       | What it does                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `agent.steer(message)`       | Add a message mid-run. Running tools that can be interrupted stop, and the model sees it next turn |
| `agent.followUp(message)`    | Queue a message for when the agent would otherwise stop                                            |
| `signal` (`AbortController`) | Stop the run. Call `agent.setSignal()` with a fresh signal before the next prompt                  |

## Events

| Event                   | When                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `text_delta`            | New text                                                      |
| `thinking_delta`        | New reasoning text                                            |
| `toolcall_delta`        | Tool call arguments as they stream in                         |
| `tool_call_start`       | A tool started (`name`, `args`)                               |
| `tool_call_update`      | Progress from a running tool                                  |
| `tool_call_end`         | A tool finished (`result`, `isError`, `durationMs`)           |
| `server_tool_call`      | The provider ran a server-side tool                           |
| `server_tool_result`    | Result of that server-side tool                               |
| `steering_message`      | A steering message was added                                  |
| `follow_up_message`     | A follow-up message was added                                 |
| `retry`                 | A failed model call is being retried                          |
| `turn_end`              | One model call finished (`stopReason`, `usage`, `timing`)     |
| `checkpoint`            | A safe point to save the conversation                         |
| `truncated`             | A turn ended early (output limit, refusal, provider error)    |
| `max_turns`             | The turn limit was reached before the model finished          |
| `turn_budget_extended`  | `onTurnBudgetExhausted` granted more turns                    |
| `stream_rule_triggered` | A `streamRules` pattern matched and the step is being retried |
| `agent_done`            | Finished (`totalTurns`, `totalUsage`)                         |
| `error`                 | The run failed                                                |

## Options

Every [`stream()` option from gg-ai](https://www.npmjs.com/package/@kenkaiiii/gg-ai) that makes sense per call (`apiKey`, `baseUrl`, `thinking`, `maxTokens`, `temperature`, `cacheRetention`, `webSearch`, `providerOptions`, `fetch` and so on) is passed through. On top of those:

| Option                  | Type                                   | What it does                                                                                                                  |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `provider`              | `Provider`                             | **Required.** Any gg-ai provider                                                                                              |
| `model`                 | `string`                               | **Required.**                                                                                                                 |
| `system`                | `string`                               | System prompt                                                                                                                 |
| `tools`                 | `AgentTool[]`                          | Your tools                                                                                                                    |
| `priorMessages`         | `Message[]`                            | Conversation to resume from                                                                                                   |
| `maxTurns`              | `number`                               | Model calls per run (default 300)                                                                                             |
| `onTurnBudgetExhausted` | `(ctx) => boolean \| Promise<boolean>` | Return true to grant more turns when the limit is hit mid-task                                                                |
| `transformContext`      | `(messages, options) => Message[]`     | Runs before every model call: trim, summarize or add context. `options.force` means the provider reported the context is full |
| `resolveCredentials`    | `() => Promise<{ apiKey }>`            | Fetch a fresh key or token each turn, so long runs survive token refreshes                                                    |
| `resolveTool`           | `(name) => AgentTool \| undefined`     | Load a tool on demand when the model calls one you haven't passed yet                                                         |
| `maxToolResultChars`    | `number`                               | Cut any single tool result longer than this                                                                                   |
| `streamRules`           | `StreamRulesConfig`                    | Regex rules on streamed output; a match discards the step and retries with a reminder                                         |
| `maxContinuations`      | `number`                               | Limit on back-to-back `pause_turn` continuations (default 5)                                                                  |

The full list is the `AgentOptions` type.

## The GG Framework

| Package                                                                | What it does                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [@kenkaiiii/gg-ai](https://www.npmjs.com/package/@kenkaiiii/gg-ai)     | One streaming API for every provider                              |
| **@kenkaiiii/gg-agent**                                                | The agent loop (this package)                                     |
| [@kenkaiiii/gg-core](https://www.npmjs.com/package/@kenkaiiii/gg-core) | Model list, sign-in and stored credentials, local model discovery |
| [@kenkaiiii/ggcoder](https://www.npmjs.com/package/@kenkaiiii/ggcoder) | The GG Coder coding agent: CLI, tools and sessions                |

Source, issues and the desktop app: [github.com/KenKaiii/gg-framework](https://github.com/KenKaiii/gg-framework).

## License

[AGPL-3.0-only](https://github.com/KenKaiii/gg-framework/blob/main/LICENSE). You can build on it; if you distribute your changes or run them as a network service, share their source under the same license.
