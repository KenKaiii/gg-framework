# Kleio Coder

<p align="center">
  <strong>The fast, lean coding agent. Eight providers. Zero bloat.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kleio/coder"><img src="https://img.shields.io/npm/v/@kleio/coder?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/fmckie/gg-framework/tree/main/packages/ggcoder"><img src="https://img.shields.io/badge/Source-GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="Source on GitHub"></a>
</p>

Kleio Coder ships only what the model needs to work: a tiny system prompt, one carefully chosen MCP, and a focused tool set. Switch between Anthropic, OpenAI, GLM, Moonshot, MiniMax, Xiaomi, DeepSeek, and OpenRouter mid-conversation. Run it on its own, or let [`@kleio/manager`](../gg-boss/README.md) drive a fleet of Kleio Coder workers across many projects from a single chat.

Built on [`@kleio/ai`](../gg-ai/README.md) and [`@kleio/agent`](../gg-agent/README.md). Part of the [Kleio Framework](../../README.md) monorepo.

---

## 🚀 Run It

```bash
npm i -g @kleio/coder

kleio-coder login    # Pick provider, authenticate
kleio-coder          # Start coding
```

OAuth for Anthropic and OpenAI (log in once, auto-refresh, no key to leak). API keys for the rest. Up and running in seconds either way. Auth lives in `~/.gg/auth.json` and is shared with Kleio Manager.

---

## Command compatibility

`ggcoder` remains a compatibility alias for `kleio-coder`, and `ggboss` remains a compatibility alias for `kleio-manager`. Existing scripts can continue to use the legacy executables; new documentation and automation should use the Kleio commands. Both names use the same `.gg` credentials, settings, and sessions.

---

## 🪶 The system prompt problem

Every token in the system prompt gets processed on **every single turn**. It's not a one-time cost. It's a tax on every request.

|                    | **Claude Code / Agent SDK** | **Kleio Coder**   |
| ------------------ | --------------------------- | ----------------- |
| System prompt size | ~15,000 tokens              | **~1,100 tokens** |
| Ratio              | baseline                    | **~13x smaller**  |

### Why you should care

- **Slower responses.** More input tokens = longer time-to-first-token. In a 30-turn session, that wait adds up to minutes.
- **Worse instruction following.** More rules = more things the model ignores. "Lost in the middle" is well-documented. A 1,100 token prompt gets read. A 15,000 token one gets skimmed.
- **Context fills up faster.** ~15,000 tokens sitting in your window permanently. That's ~7.5% of a 200K model gone before you say hello. You hit compaction sooner, lose history faster, and the agent forgets what it was doing.
- **Higher cost.** Input tokens aren't free. Every cache miss charges you for the full bloat. Smaller prompt = smaller bill.

Kleio Coder sends only what the model needs: how to work, what tools it has, and your project context. No walls of rules. No formatting instructions. Just signal.

---

## 🧩 The MCP problem

Same philosophy applies to tools. People collect MCPs like Pokemon. Slack MCP, GitHub MCP, Notion MCP, five different file system MCPs. Every single one injects its tool descriptions into the context. The model now has to figure out which of 40+ tools to use for any given task.

This doesn't help. It confuses the agent. More tool descriptions = more noise = worse tool selection. The model spends tokens reasoning about tools it will never call.

Kleio Coder ships with one MCP: [Grep](https://grep.dev). That's it. It lets the agent search across 1M+ public GitHub repos to verify implementations against real-world code. Correct API usage, library idioms, production patterns. One tool that actually makes the output better.

You can still add your own MCPs if you need them. But start with less. You'll get better results.

---

## 🎛 Eight providers, one agent

Switch mid-conversation with `/model`. Not locked to anyone.

| Provider          | Models                                                             | Auth             |
| ----------------- | ------------------------------------------------------------------ | ---------------- |
| **Anthropic**     | Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5                    | OAuth            |
| **OpenAI**        | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna                               | OAuth            |
| **Moonshot**      | Kimi K3, K2.8 Preview (Kimi sign-in), K2.7 Code                    | OAuth or API key |
| **Z.AI (GLM)**    | GLM-5.3, GLM-5.3-Flash (image)                                     | API key          |
| **MiniMax**       | MiniMax M3 (image + video)                                         | API key          |
| **Xiaomi (MiMo)** | MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed           | API key          |
| **DeepSeek**      | DeepSeek V4 Pro, V4.1 Flash (image)                                | API key          |
| **Sakana (Fugu)** | Fugu, Fugu Max, Fugu Ultra (image)                                 | API key          |
| **OpenRouter**    | Qwen3.8 Max (image + video) + multi-provider gateway               | API key          |

The same conversation, the same tools, the same project context — only the model changes. Use a strong reasoning model when you need it, swap to a fast cheap one for grunt work, never restart your session.

**Attachments.** Drag, paste, or type a path to attach images and video in the chat input. Video is sent natively to models that support it (Gemini 3.x, Kimi K3/K2.8 Preview/K2.7 Code, MiniMax M3, MiMo-V2.6, Qwen3.8 Max); for other models the video is saved to a temp file and the model is told to inspect it with ffmpeg or its own tools.

---

## 🤝 Pair it with Kleio Manager

Kleio Coder is the unit of work. [Kleio Manager](../gg-boss/README.md) is the orchestrator that drives many of them at once.

```bash
npm i -g @kleio/manager
kleio-manager link    # Pick which projects to drive
kleio-manager         # One chat, N parallel Kleio Coder workers
```

Inside Kleio Manager, every project gets its own Kleio Coder `AgentSession` running in that project's directory. The manager dispatches work—`prompt_worker(project, "...")`—and each worker uses the **same** focused tool set (read, write, edit, bash, grep, find, ls, web fetch, sub-agents) you'd get when running Kleio Coder solo. Workers reply with a tight `Changed / Skipped / Verified / Notes / Status` summary that the manager reads, cross-checks, and routes.

Kleio Coder's lean prompt and tight tool set keep each worker cheap and predictable, so the manager can run six or more in parallel without context blow-up. Anything you can do in a single Kleio Coder session—slash commands, skills, MCPs, custom commands, project `CLAUDE.md` rules—works inside Kleio Manager too.

Run `kleio-coder` directly when you're heads-down on one project. Switch to `kleio-manager` when you want a coordinator on top.

---

## ⌨️ Keybindings

| Key                         | What it does                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| <kbd>Ctrl+T</kbd>           | Open the Task pane                                               |
| <kbd>Ctrl+S</kbd>           | Open the Skills pane                                             |
| <kbd>Shift+Tab</kbd>        | Cycle extended thinking (off / low / medium / high / max)        |
| <kbd>Esc</kbd>              | Interrupt the agent mid-turn                                     |
| <kbd>Ctrl+C</kbd> ×2        | Exit                                                             |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Recall previous prompts (when input is empty)                    |
| <kbd>Enter</kbd>            | Send · <kbd>Shift+Enter</kbd> newline · `/` opens the slash menu |

---

## 💬 Slash commands

Everything runs through slash commands inside the session. Not CLI flags.

| Command                 | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `/model` (`/m`)         | Switch model on the fly                                    |
| `/compact` (`/c`)       | Compress context when it gets long                         |
| `/new` (`/n`)           | Start a fresh session in this project                      |
| `/session` (`/s`)       | Resume a prior session                                     |
| `/branch` (`/b`)        | Branch the current conversation                            |
| `/branches`             | List branches of the current session                       |
| `/rewind`               | Restore files and/or conversation to an earlier checkpoint |
| `/buddy`                | Spin up a second model to review the current chat          |
| `/settings` (`/config`) | Open settings                                              |
| `/help` (`/h`, `/?`)    | Show all commands                                          |
| `/quit` (`/q`, `/exit`) | Exit                                                       |

Plus built-in workflows that ship with the binary:

```bash
/expand        # Compare against current alternatives and report gaps
/init          # Generate CLAUDE.md for your project
/setup-commit  # Generate a /commit command with quality checks
/setup-skills  # Audit and recommend reusable skills
```

---

## 🛠 Tools

Kleio Coder comes with a focused set of tools. Each one is small, well-described, and earns its place in the prompt.

| Tool                              | What it does                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bash`                            | Run shell commands                                                                                     |
| `read`                            | Read file contents                                                                                     |
| `write`                           | Write files                                                                                            |
| `edit`                            | Surgical string replacements                                                                           |
| `grep`                            | Search file contents (regex)                                                                           |
| `find`                            | Find files by glob pattern                                                                             |
| `ls`                              | List directory contents                                                                                |
| `web_fetch`                       | Fetch URL content                                                                                      |
| `screenshot`                      | Open a URL / dev server in a headless browser and capture a PNG so the agent can see the rendered page |
| `subagent`                        | Run one blocking, isolated child task (backward-compatible)                                            |
| `spawn_agent` / `wait_agent`      | Launch persistent child turns concurrently and collect results                                         |
| `send_message` / `followup_task`  | Steer a running child or reuse an idle child's context                                                 |
| `list_agents` / `interrupt_agent` | Inspect or interrupt persistent children                                                               |

The `screenshot` tool needs the optional `playwright` dependency plus a one-time `npx playwright install chromium`. Without it the tool returns an install hint instead of failing the turn. Captured images render inline in graphics-capable terminals (kitty, Ghostty, WezTerm, iTerm2); other terminals show a text line.

Plus the [Grep MCP](https://grep.dev) for searching across 1M+ public GitHub repos. Add your own MCPs in settings if you need more — but start lean.

### Async subagent lifecycle

`subagent` remains blocking. The async suite launches persistent NDJSON worker processes, so a parent can start up to four active child turns, keep working, steer them, and wait for any or all results. Up to eight idle workers remain available for follow-up; bounded snapshots retain the latest 20 agents.

Only GPT-6 Astra and GPT-6.1 Sol at **Ultra** delegate proactively. Lower Astra/Sol levels use async agents only when the user or project/skill instructions request delegation; other models receive no proactive policy.

Children share the parent working directory, not isolated worktrees. Parallel writes must target disjoint files or subsystems. Async fan-out is one level deep, child output is bounded, idle workers reap after 10 minutes, and workers are not resumable after a CLI/app restart.

Parent cancellation interrupts active children. Session disposal shuts down every worker process alongside background commands, LSP servers, and MCP connections.

---

## 🪄 Custom commands

Drop a markdown file in `.gg/commands/` and it becomes a slash command. Your React app gets `/deploy` and `/storybook`. Your API gets `/migrate` and `/seed`. Different projects, different commands.

---

## ⏪ Checkpoints & `/rewind`

Before every file the agent writes or edits, Kleio Coder snapshots the prior on-disk content into a per-session checkpoint (stored under `~/.gg/checkpoints/`, never in your repo). Run `/rewind` to pick an earlier checkpoint and restore **code only**, **conversation only**, or **both**.

Only edits made through Kleio Coder's `write`/`edit` tools are tracked—changes made by `bash` (for example, `sed`, `rm`, or code generation) are **not** captured.

---

## 🎒 Skills

Reusable behaviors across projects. Drop `.md` files in:

- `~/.gg/skills/` for global skills (available everywhere)
- `.gg/skills/` for project-specific skills

They get loaded into the system prompt automatically. The agent knows what it can do without you explaining it each session. <kbd>Ctrl+S</kbd> opens a pane to browse and toggle them.

Eleven ship built in, and route themselves when the work matches:

| Skill              | Fires on                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bulletproof`      | Code an attacker will reach — auth, untrusted input, secrets, dependencies, CI/release, agent/MCP tool surfaces — and "is this safe to ship" reviews. Works on any target: web, API, CLI, desktop, mobile, embedded, contracts, ML.                                                                                                 |
| `clarify`          | Requirements or a design genuinely unsettled — interrogating or stress-testing a plan before building, or a mid-build decision that materially changes the result.                                                                                                                                                                  |
| `code-review`      | Reviewing written work — a diff, PR, or branch — on both what was asked for and how well it is built.                                                                                                                                                                                                                               |
| `compliance-guard` | Legal exposure — personal data, payments, UGC, email/SMS, minors, or a licensed/regulated feature.                                                                                                                                                                                                                                  |
| `durable`          | User data must not be lost — first database/table, migrations, backfills/imports, destructive operations, backups and recovery; any store (Postgres, MySQL, SQLite, Mongo, serverless).                                                                                                                                             |
| `evidence-led-ui`  | Broad or design-sensitive UI work — new screens, redesigns, design systems, accessibility passes.                                                                                                                                                                                                                                   |
| `lean`             | Speed and resource efficiency — slow loading/startup, jank, high CPU, memory leaks and hogging, zombie/orphan processes, bundle bloat, dead code/styles, Core Web Vitals; while building anything that should stay fast, or a perf pass on an existing project. Any stack: web, backend, Electron, Tauri, mobile, native, game, ML. |
| `refactoring`      | Restructuring existing code without changing behavior — "refactor", "clean up", "reduce tech debt", "modernize" or migrate legacy code; test-guarded steps, revert-on-red, characterization tests for untested code.                                                                                                                |
| `root-cause`       | A bug that resists the obvious fix, makes no sense, or keeps coming back — gated diagnosis from red repro to ranked hypotheses to regression test.                                                                                                                                                                                  |
| `shared-language`  | Fuzzy or drifting domain vocabulary, recurring naming decisions, and hard-to-reverse decisions worth recording (glossary + decision records).                                                                                                                                                                                       |
| `tdd`              | Test-driven development — red-green-refactor with pre-agreed seams, when the user asks for test-first work.                                                                                                                                                                                                                         |

---

## 📋 Project guidelines

Drop a `CLAUDE.md` or `AGENTS.md` in your repo root (or any parent directory). Kleio Coder picks it up automatically.

Your rules. Your conventions. The agent follows them.

---

## Support

- [Source](https://github.com/fmckie/gg-framework/tree/main/packages/ggcoder)
- [Issues](https://github.com/fmckie/gg-framework/issues)
- [Fork lineage and upstream policy](../../UPSTREAM.md)

---

## 📄 License

MIT

---

<p align="center">
  <strong>Lean prompt. Sharp tools. Real results.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kleio/coder"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40kleio%2Fcoder-blue?style=for-the-badge" alt="Install"></a>
</p>
