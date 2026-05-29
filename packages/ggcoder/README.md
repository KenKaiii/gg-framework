![ggcoder](screenshots/ggcoder.png)

<p align="center">
  <strong>The fast, lean coding agent. Eight providers. Zero bloat.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
  <a href="https://github.com/KenKaiii"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"></a>
</p>

A coding agent that ships only what the model needs to work — a tiny system prompt, one carefully-chosen MCP, and a focused tool set. Switch between Anthropic, OpenAI, GLM, Moonshot, MiniMax, Xiaomi, DeepSeek, and OpenRouter mid-conversation. Run it on its own, or let [`@kenkaiiii/gg-boss`](../gg-boss/README.md) drive a fleet of `ggcoder` workers across many projects from a single chat.

Built on [`@kenkaiiii/gg-ai`](../gg-ai/README.md) and [`@kenkaiiii/gg-agent`](../gg-agent/README.md). Part of the [GG Framework](../../README.md) monorepo.

---

## 🚀 Run It

```bash
npm i -g @kenkaiiii/ggcoder

ggcoder login    # Pick provider, authenticate
ggcoder          # Start coding
```

OAuth for Anthropic and OpenAI (log in once, auto-refresh, no key to leak). API keys for the rest. Up and running in seconds either way. Auth lives in `~/.gg/auth.json` and is shared with `gg-boss`.

---

## 🪶 The system prompt problem

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

## 🧩 The MCP problem

Same philosophy applies to tools. People collect MCPs like Pokemon. Slack MCP, GitHub MCP, Notion MCP, five different file system MCPs. Every single one injects its tool descriptions into the context. The model now has to figure out which of 40+ tools to use for any given task.

This doesn't help. It confuses the agent. More tool descriptions = more noise = worse tool selection. The model spends tokens reasoning about tools it will never call.

GG Coder ships with one MCP: [Grep](https://grep.dev). That's it. It lets the agent search across 1M+ public GitHub repos to verify implementations against real-world code. Correct API usage, library idioms, production patterns. One tool that actually makes the output better.

You can still add your own MCPs if you need them. But start with less. You'll get better results.

---

## 🎛 Eight providers, one agent

Switch mid-conversation with `/model`. Not locked to anyone.

| Provider | Models | Auth |
|---|---|---|
| **Anthropic** | Claude Opus 4.8, Sonnet 4.6, Haiku 4.5 | OAuth |
| **OpenAI** | GPT-5.5, GPT-5.5 Pro, GPT-5.4, GPT-5.3 Codex | OAuth |
| **Moonshot** | Kimi K2.6 | API key |
| **Z.AI (GLM)** | GLM-5.1, GLM-4.7, GLM-4.7 Flash | API key |
| **MiniMax** | MiniMax M2.7, M2.7 Highspeed | API key |
| **Xiaomi (MiMo)** | MiMo-V2-Pro | API key |
| **DeepSeek** | DeepSeek V4 Pro, V4 Flash | API key |
| **OpenRouter** | Qwen3.6-Plus + multi-provider gateway | API key |

The same conversation, the same tools, the same project context — only the model changes. Use a strong reasoning model when you need it, swap to a fast cheap one for grunt work, never restart your session.

---

## 🤝 Pair it with gg-boss

`ggcoder` is the unit of work. [`gg-boss`](../gg-boss/README.md) is the orchestrator that drives many of them at once.

```bash
npm i -g @kenkaiiii/gg-boss
ggboss link    # pick which projects to drive
ggboss         # one chat, N parallel ggcoder workers
```

Inside `gg-boss`, every project gets its own `ggcoder` `AgentSession` running in that project's directory. The boss dispatches work — `prompt_worker(project, "...")` — and each worker uses the **same** focused tool set (read, write, edit, bash, grep, find, ls, web fetch, sub-agents) you'd get running `ggcoder` solo. Workers reply with a tight `Changed / Skipped / Verified / Notes / Status` summary the boss reads, cross-checks, and routes off.

Why this works: ggcoder's lean prompt and tight tool set keep each worker cheap and predictable, so the boss can run six or more in parallel without context blow-up. Anything you can do in a single `ggcoder` session — slash commands, skills, MCPs, custom commands, project `CLAUDE.md` rules — works inside the boss too.

Run `ggcoder` directly when you're heads-down on one project. Switch to `ggboss` when you want a coordinator on top.

---

## ⌨️ Keybindings

| Key | What it does |
|---|---|
| <kbd>Ctrl+G</kbd> | Open the Goal pane |
| <kbd>Ctrl+S</kbd> | Open the Skills pane |
| <kbd>Shift+Tab</kbd> | Cycle extended thinking (off / low / medium / high / max) |
| <kbd>Esc</kbd> | Interrupt the agent mid-turn |
| <kbd>Ctrl+C</kbd> ×2 | Exit |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Recall previous prompts (when input is empty) |
| <kbd>Enter</kbd> | Send · <kbd>Shift+Enter</kbd> newline · `/` opens the slash menu |

---

## 💬 Slash commands

Everything runs through slash commands inside the session. Not CLI flags.

| Command | What it does |
|---|---|
| `/model` (`/m`) | Switch model on the fly |
| `/compact` (`/c`) | Compress context when it gets long |
| `/new` (`/n`) | Start a fresh session in this project |
| `/session` (`/s`) | Resume a prior session |
| `/branch` (`/b`) | Branch the current conversation |
| `/branches` | List branches of the current session |
| `/rewind` | Restore files and/or conversation to an earlier checkpoint |
| `/buddy` | Spin up a second model to review the current chat |
| `/settings` (`/config`) | Open settings |
| `/help` (`/h`, `/?`) | Show all commands |
| `/quit` (`/q`, `/exit`) | Exit |

Plus built-in workflows that ship with the binary:

```bash
/goal          # Set up a durable Goal run
/expand        # Compare against current alternatives and report gaps
/bullet-proof  # Run a defensive security review
/init          # Generate CLAUDE.md for your project
/setup-commit  # Generate a /commit command with quality checks
/setup-skills  # Audit and recommend reusable skills
```

---

## 🛠 Tools

GG Coder comes with a focused set of tools. Each one is small, well-described, and earns its place in the prompt.

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
| `screenshot` | Open a URL / dev server in a headless browser and capture a PNG so the agent can see the rendered page |
| `subagent` | Spawn parallel sub-agents |

The `screenshot` tool needs the optional `playwright` dependency plus a one-time `npx playwright install chromium`. Without it the tool returns an install hint instead of failing the turn. Captured images render inline in graphics-capable terminals (kitty, Ghostty, WezTerm, iTerm2); other terminals show a text line.

Plus the [Grep MCP](https://grep.dev) for searching across 1M+ public GitHub repos. Add your own MCPs in settings if you need more — but start lean.

---

## 🪄 Custom commands

Drop a markdown file in `.gg/commands/` and it becomes a slash command. Your React app gets `/deploy` and `/storybook`. Your API gets `/migrate` and `/seed`. Different projects, different commands.

---

## ⏪ Checkpoints & `/rewind`

Before every file the agent writes or edits, GG Coder snapshots the prior on-disk content into a per-session checkpoint (stored under `~/.gg/checkpoints/`, never in your repo). Run `/rewind` to pick an earlier checkpoint and restore **code only**, **conversation only**, or **both**.

Only edits made through ggcoder's `write`/`edit` tools are tracked — changes made by `bash` (e.g. `sed`, `rm`, codegen) are **not** captured.

---

## 🎒 Skills

Reusable behaviors across projects. Drop `.md` files in:

- `~/.gg/skills/` for global skills (available everywhere)
- `.gg/skills/` for project-specific skills

They get loaded into the system prompt automatically. The agent knows what it can do without you explaining it each session. <kbd>Ctrl+S</kbd> opens a pane to browse and toggle them.

---

## 📋 Project guidelines

Drop a `CLAUDE.md` or `AGENTS.md` in your repo root (or any parent directory). GG Coder picks it up automatically.

Your rules. Your conventions. The agent follows them.

---

## 👥 Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) — tutorials and demos
- [Skool community](https://skool.com/kenkai) — come hang out
- [GitHub @KenKaiii](https://github.com/KenKaiii)

---

## 📄 License

MIT

---

<p align="center">
  <strong>Lean prompt. Sharp tools. Real results.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40kenkaiiii%2Fggcoder-blue?style=for-the-badge" alt="Install"></a>
</p>
