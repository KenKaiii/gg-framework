# GG Coder

<p align="center">
  <strong>The fast, lean coding agent. Four providers. Zero bloat.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

I built GG Coder because I got tired of waiting.

Claude Code is great. I use it daily. But it ships ~15,000 tokens of system prompt on every single request. The Claude Agent SDK does the same thing since it's Claude Code under the hood.

So I asked: what if we just... didn't do that?

---

## The system prompt problem

Every token in the system prompt gets processed on **every single turn**. It's not a one-time cost. It's a tax on every request.

| | **Claude Code / Agent SDK** | **GG Coder** |
|---|---|---|
| System prompt size | ~15,000 tokens | **~1,100 tokens** |
| Ratio | baseline | **~13x smaller** |

### Why you should care

- **Slower responses.** More input tokens = longer time-to-first-token. In a 30-turn session, that wait adds up to minutes.
- **Worse instruction following.** More rules = more things the model ignores. "Lost in the middle" is well-documented. A 1,100 token prompt gets read. A 15,000 token one gets skimmed.
- **Context fills up faster.** ~15,000 tokens sitting in your window permanently. That's ~7.5% of a 200K model gone before you say hello. You hit compaction sooner, lose history faster, and the agent forgets what it was doing.
- **Higher cost.** Input tokens aren't free. Every cache miss charges you for the full bloat. Smaller prompt = smaller bill.

GG Coder sends only what the model needs: how to work, what tools it has, and your project context. No walls of rules. No formatting instructions. Just signal.

---

## Four providers, one agent

Switch mid-conversation with `/model`. Not locked to anyone.

| Provider | Models | Auth |
|---|---|---|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | OAuth |
| **OpenAI** | GPT-4.1, o3, o4-mini | OAuth |
| **Z.AI (GLM)** | GLM-5, GLM-4.7 | API key |
| **Moonshot** | Kimi K2.5 | API key |

OAuth for Anthropic and OpenAI (log in once, auto-refresh). API keys for GLM and Moonshot. Up and running in seconds either way.

---

## Slash commands

Everything runs through slash commands inside the session. Not CLI flags.

```bash
/model claude-opus-4-6       # Switch models on the fly
/model kimi-k2.5
/compact                      # Compress context when it gets long

# Built-in workflows
/scan          # Dead code, bugs, security issues (5 parallel agents)
/verify        # Verify against docs and best practices (8 parallel agents)
/research      # Research best tools and patterns for your stack
/init          # Generate CLAUDE.md for your project
/setup-lint    # Generate a /fix command for your stack
/setup-commit  # Generate a /commit command with quality checks
/setup-tests   # Set up testing + generate /test
/setup-update  # Generate an /update command for deps
```

---

## Custom commands

Drop a markdown file in `.gg/commands/` and it becomes a slash command.

```markdown
---
name: deploy
description: Build, test, and deploy to production
---

1. Run the test suite
2. Build for production
3. Deploy using the project's deploy script
4. Verify the deployment is healthy
```

Now `/deploy` works in that project. Your React app gets `/deploy` and `/storybook`. Your API gets `/migrate` and `/seed`. Different projects, different commands.

---

## Skills

Reusable behaviors across projects. Drop `.md` files in:

- `~/.gg/skills/` for global skills (available everywhere)
- `.gg/skills/` for project-specific skills

They get loaded into the system prompt automatically. The agent knows what it can do without you explaining it each session.

---

## Project guidelines

Drop a `CLAUDE.md` or `AGENTS.md` in your repo root (or any parent directory). GG Coder picks it up automatically.

Your rules. Your conventions. The agent follows them.

---

## Getting started

```bash
npm i -g @kenkaiiii/ggcoder
```

1. `ggcoder login`
2. Pick your provider
3. Authenticate
4. `ggcoder`

That's it.

---

## Usage

```bash
ggcoder                                    # Interactive mode
ggcoder "fix the failing tests in src"     # Pass a prompt directly
ggcoder -p moonshot                        # Start with a different provider
```

Type `/help` inside a session to see everything available.

---

## The packages

Three npm packages. Use them together or separately.

| Package | What it does |
|---|---|
| [`@kenkaiiii/gg-ai`](https://www.npmjs.com/package/@kenkaiiii/gg-ai) | Unified streaming API across all four providers |
| [`@kenkaiiii/gg-agent`](https://www.npmjs.com/package/@kenkaiiii/gg-agent) | Agent loop with multi-turn tool execution |
| [`@kenkaiiii/ggcoder`](https://www.npmjs.com/package/@kenkaiiii/ggcoder) | The full CLI |

### Streaming API

```typescript
import { stream } from "@kenkaiiii/gg-ai";

for await (const event of stream({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello!" }],
})) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

### Agent loop

```typescript
import { Agent } from "@kenkaiiii/gg-agent";
import { z } from "zod";

const agent = new Agent({
  provider: "moonshot",
  model: "kimi-k2.5",
  system: "You are a helpful assistant.",
  tools: [{
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: z.object({ city: z.string() }),
    async execute({ city }) {
      return { temperature: 72, condition: "sunny" };
    },
  }],
});

for await (const event of agent.prompt("What's the weather in Tokyo?")) {
  // text_delta, tool_call_start, tool_call_end, agent_done, etc.
}
```

---

## For developers

```bash
git clone https://github.com/KenKaiii/gg-framework.git
cd gg-framework
pnpm install
pnpm build
```

TypeScript 5.9 + pnpm workspaces + Ink 6 + React 19 + Vitest 4 + Zod v4

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Skool community](https://skool.com/kenkai) - come hang out

---

## License

MIT

---

<p align="center">
  <strong>Less bloat. More coding. Four providers. One agent.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40kenkaiiii%2Fggcoder-blue?style=for-the-badge" alt="Install"></a>
</p>
