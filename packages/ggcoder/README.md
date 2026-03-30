# @kenkaiiii/ggcoder

<p align="center">
  <strong>The fast, lean coding agent. Five providers. Zero bloat.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

The CLI that sits on top of the [GG Framework](../../README.md). Built on [`@kenkaiiii/gg-ai`](../gg-ai/README.md) and [`@kenkaiiii/gg-agent`](../gg-agent/README.md).

---

## Install

```bash
npm i -g @kenkaiiii/ggcoder
```

---

## Getting started

```bash
ggcoder login    # Pick provider, authenticate
ggcoder          # Start coding
```

OAuth for Anthropic and OpenAI (log in once, auto-refresh). API keys for GLM, Moonshot, and Venice. Up and running in seconds either way.

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

## The MCP problem

Same philosophy applies to tools. People collect MCPs like Pokemon. Slack MCP, GitHub MCP, Notion MCP, five different file system MCPs. Every single one injects its tool descriptions into the context. The model now has to figure out which of 40+ tools to use for any given task.

This doesn't help. It confuses the agent. More tool descriptions = more noise = worse tool selection. The model spends tokens reasoning about tools it will never call.

GG Coder ships with one MCP: [Grep](https://grep.dev). That's it. It lets the agent search across 1M+ public GitHub repos to verify implementations against real-world code. Correct API usage, library idioms, production patterns. One tool that actually makes the output better.

You can still add your own MCPs if you need them. But start with less. You'll get better results.

---

## Five providers, one agent

Switch mid-conversation with `/model`. Not locked to anyone.

| Provider | Models | Auth |
|---|---|---|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | OAuth |
| **OpenAI** | GPT-4.1, o3, o4-mini | OAuth |
| **Z.AI (GLM)** | GLM-5.1, GLM-4.7 | API key |
| **Moonshot** | Kimi K2.5 | API key |
| **[Venice](https://venice.ai)** | Claude Opus/Sonnet, GPT-5.4, GPT-5.3 Codex, Qwen3 Coder, DeepSeek V3.2, Venice Uncensored + more | API key |

### Why Venice?

> *"Build AI with no data retention, permissionless access, and compute you permanently own."* — venice.ai

Venice proxies top-tier models (Claude, GPT, Qwen, DeepSeek, Grok, Gemini) through privacy-first infrastructure with zero data retention. Use it when you need uncensored models for red-team testing, unfiltered creative work, or when privacy and anonymity matter. OpenAI-compatible API — same tool calling, same streaming, same interface.

### Adding more Venice models

Venice has 50+ models. The most popular are built in. Add any others via `~/.gg/settings.json`:

```json
{
  "customModels": [
    {
      "id": "grok-4-20-beta",
      "name": "Grok 4",
      "provider": "venice",
      "contextWindow": 2000000,
      "maxOutputTokens": 128000,
      "supportsThinking": true,
      "supportsImages": false,
      "costTier": "high"
    }
  ]
}
```

Browse available models: `curl https://api.venice.ai/api/v1/models`

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

Drop a markdown file in `.gg/commands/` and it becomes a slash command. Your React app gets `/deploy` and `/storybook`. Your API gets `/migrate` and `/seed`. Different projects, different commands.

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

## Tools

GG Coder comes with a focused set of tools:

| Tool | What it does |
|---|---|
| `bash` | Run shell commands |
| `read` | Read file contents |
| `write` | Write files |
| `edit` | Surgical string replacements |
| `grep` | Search file contents (regex) |
| `find` | Find files by glob pattern |
| `ls` | List directory contents |
| `web_fetch` | Fetch URL content |
| `subagent` | Spawn parallel sub-agents |

Plus the [Grep MCP](https://grep.dev) for searching across 1M+ public GitHub repos.

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Skool community](https://skool.com/kenkai) - come hang out

---

## License

MIT
