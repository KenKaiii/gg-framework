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

Claude Code is a fantastic product. But every single request starts with a ~15,000 token system prompt. The Claude Agent SDK has the same problem — it's Claude Code under the hood. That's thousands of tokens of instructions the model has to wade through before it even looks at your code.

That matters more than people realize.

---

## The system prompt problem

Every token in the system prompt gets processed on **every single turn**. A bloated system prompt doesn't just cost more — it actively makes the agent worse.

| | **Claude Code / Agent SDK** | **GG Coder** |
|---|---|---|
| System prompt size | ~15,000 tokens | **~1,100 tokens** |
| Ratio | baseline | **~13x smaller** |

### Why this matters

**Slower responses.** More input tokens = longer time-to-first-token. You're waiting for the model to re-read instructions it's already seen a hundred times. Every turn. Every request. That delay adds up fast during a multi-turn coding session.

**Worse instruction following.** LLMs have a well-documented problem: the more text you put in the system prompt, the worse they follow any individual instruction. It's called "lost in the middle" — models pay attention to the beginning and end of context but lose track of what's in between. A 15,000 token system prompt is a wall of rules fighting for attention. A 1,100 token prompt is clear and focused.

**Context limits hit faster.** That ~15,000 tokens sits in your context window permanently. On a 200K context model, you've already burned ~7.5% before you've even said hello. In a long session with lots of file reads and tool calls, that overhead compounds. You hit compaction sooner, lose conversation history earlier, and the agent starts forgetting what it was doing.

**Higher cost per turn.** Input tokens aren't free. Even with prompt caching, you're paying for that bloat on every cache miss — and cache misses happen more often than you'd think (context changes, tool results, new files). Leaner prompt = lower bill.

GG Coder keeps only what the model actually needs: how to work, what tools it has, and project context. No pages of edge-case rules. No redundant formatting instructions. No paragraphs about what not to do. Just the signal.

---

## Four providers, one agent

Not locked to a single provider. GG Coder supports four, and you switch between them mid-conversation with slash commands.

| Provider | Models | Auth |
|---|---|---|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | OAuth |
| **OpenAI** | GPT-4.1, o3, o4-mini | OAuth |
| **Z.AI (GLM)** | GLM-5, GLM-4.7 | API key |
| **Moonshot** | Kimi K2.5 | API key |

OAuth for Anthropic and OpenAI — log in once, tokens refresh automatically. GLM and Moonshot use straightforward API keys. Either way, you're coding in under 30 seconds.

---

## Slash commands and custom workflows

GG Coder is driven by slash commands, not CLI flags. Everything happens inside the session.

```bash
# Switch models on the fly
/model claude-opus-4-6
/model kimi-k2.5

# Compact context when it gets long
/compact

# Session management
/session list
/session load my-feature
/new

# Built-in workflows
/scan        # Find dead code, bugs, security issues (spawns 5 parallel agents)
/verify      # Verify code against docs and best practices (8 parallel agents)
/research    # Research best tools and patterns for your project
/init        # Generate or update CLAUDE.md for your project
/setup-lint  # Generate a /fix command tailored to your project
/setup-commit # Generate a /commit command with quality checks
/setup-tests # Set up testing infrastructure and generate /test
/setup-update # Generate an /update command for dependency management
```

### Custom commands per project

Drop a markdown file in `.gg/commands/` and it becomes a slash command. Frontmatter defines the name and description, the body becomes the prompt.

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

Now `/deploy` works in that project. Different projects, different commands. The agent adapts to your workflow, not the other way around.

### Skills (global and per-project)

Same idea, but for reusable behaviors. Drop `.md` files in `~/.gg/skills/` (global) or `.gg/skills/` (per-project) and they get injected into the system prompt as available capabilities. The agent knows what it can do without you having to explain it every session.

---

## Getting started

```bash
npm i -g @kenkaiiii/ggcoder
```

1. Run `ggcoder login`
2. Pick your provider
3. Authenticate
4. Start coding with `ggcoder`

That's it.

---

## Usage

```bash
# Interactive mode
ggcoder

# Ask a question directly
ggcoder "fix the failing tests in src/utils"

# Use a different provider
ggcoder -p moonshot
```

Everything else happens inside the session via slash commands. Type `/help` to see what's available.

---

## The packages

The whole stack is open-source and composable. Three npm packages, each usable on its own.

| Package | What it does |
|---|---|
| [`@kenkaiiii/gg-ai`](https://www.npmjs.com/package/@kenkaiiii/gg-ai) | Unified streaming API across all four providers. One interface, provider differences handled internally. |
| [`@kenkaiiii/gg-agent`](https://www.npmjs.com/package/@kenkaiiii/gg-agent) | Agent loop with multi-turn tool execution, Zod-validated parameters, error recovery. |
| [`@kenkaiiii/ggcoder`](https://www.npmjs.com/package/@kenkaiiii/ggcoder) | Full CLI — tools, sessions, UI, OAuth, the works. |

### Quick example — streaming API

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

### Quick example — agent loop

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

Stack: TypeScript 5.9 + pnpm workspaces + Ink 6 + React 19 + Vitest 4 + Zod v4

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) — tutorials and demos
- [Skool community](https://skool.com/kenkai) — come hang out

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
