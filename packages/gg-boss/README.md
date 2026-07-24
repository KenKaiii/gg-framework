![gg-boss](screenshots/ggboss.png)

<p align="center">
  <strong>One chat. Many ggcoder workers. The boss runs the room.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-boss"><img src="https://img.shields.io/npm/v/@kenkaiiii/gg-boss?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
  <a href="https://github.com/KenKaiii"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"></a>
</p>

You talk to the boss. The boss drives the workers — one per project — in parallel. Dispatch work, watch them finish, keep a backlog, swap models on the fly. All from one terminal.

Built on [`@kenkaiiii/ggcoder`](../ggcoder/README.md), [`@kenkaiiii/gg-agent`](../gg-agent/README.md) and [`@kenkaiiii/gg-ai`](../gg-ai/README.md). Part of the [GG Framework](../../README.md) monorepo.

---

## 🚀 Run It

```bash
# Sign in once with ggcoder — gg-boss reuses the same auth
npm i -g @kenkaiiii/ggcoder
ggcoder login

# Install the boss
npm i -g @kenkaiiii/gg-boss

# Pick which projects the boss should drive (interactive picker —
# scans your ggcoder, Claude Code, and Codex session history)
ggboss link

# Start the orchestrator
ggboss
```

Already linked? `ggboss continue` resumes the most recent session. `ggboss --resume <id>` resumes a specific one.

---

## 🪄 How it works

You type one prompt. The boss decides which workers to dispatch, in parallel or serial, with `prompt_worker` (fire-and-forget) or by adding to the task plan and calling `dispatch_pending`. Each worker is a full `ggcoder` agent — read, write, edit, bash, grep, find, ls, web fetch, sub-agents — running in its own project directory.

When a worker finishes, you get a tight summary back: **Changed**, **Skipped**, **Verified**, **Notes**, and a single-letter **Status** (`DONE` / `UNVERIFIED` / `PARTIAL` / `BLOCKED` / `INFO`). The boss reads that, cross-checks it against the worker's actual tool calls, and either reports back to you or re-prompts to verify, finish, or unblock.

A few things make it feel like one conversation instead of N:

- **Live worker state** is appended to every event the boss receives. It can never forget that "B is still working" while it's reading "A finished".
- **Auto-chain.** If the boss leaves a project parked while pending tasks remain, the orchestrator dispatches the next task itself and tells the boss it did so.
- **Auto-compact.** When the boss's context crosses 80%, it compacts and starts a fresh session file so `ggboss continue` resumes the trimmed history.
- **Crash-resistant.** Six workers in one process can't take the boss down — uncaught throws and unhandled rejections are logged to `~/.gg/boss/debug.log` and the run loop keeps going.
- **Audio chimes.** A done sound on each worker finish, an all-clear chime when every worker is idle and the queue is empty.

---

## 🎛 Models

Boss and workers run on **different models, on purpose**. Use a strong reasoning model (Opus, GPT-5) up top and a fast cheap model (Sonnet, Haiku) for the workers — or whatever combination fits the work.

Defaults: `claude-opus-5` for the boss, `claude-sonnet-5` for the workers. Anthropic, OpenAI, GLM, and Moonshot are all supported (anything `ggcoder` supports). Swap mid-session with `/model-boss` and `/model-workers` — your choice persists across restarts.

```bash
ggboss --boss-model claude-opus-5 --worker-model claude-sonnet-5
ggboss --project ../api --project ../web   # explicit project list
```

---

## ⌨️ Keybindings

| Key | What it does |
|---|---|
| <kbd>Tab</kbd> | Cycle the project scope pill (All / per-project) on your next message |
| <kbd>Shift+Tab</kbd> | Cycle the boss's thinking level (Anthropic/OpenAI tiers, then off) |
| <kbd>Esc</kbd> | Interrupt the boss mid-turn (workers keep running) |
| <kbd>Ctrl+T</kbd> | Open the Tasks pane |
| <kbd>Ctrl+C</kbd> ×2 | Exit gg-boss |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Recall previous prompts (when input is empty) |
| <kbd>Enter</kbd> | Send · <kbd>Shift+Enter</kbd> newline · `/` opens the slash menu |

Inside the **Tasks pane** (<kbd>Ctrl+T</kbd>):

| Key | What it does |
|---|---|
| <kbd>↑</kbd> / <kbd>↓</kbd> (or <kbd>k</kbd> / <kbd>j</kbd>) | Navigate tasks |
| <kbd>Enter</kbd> | Dispatch the selected task to its worker |
| <kbd>r</kbd> | Run all pending and blocked tasks across idle workers |
| <kbd>d</kbd> | Delete the selected task |
| <kbd>Esc</kbd> | Close the pane |

---

## 💬 Slash commands

| Command | What it does |
|---|---|
| `/help` (`/?`) | Show all commands and keybindings |
| `/model-boss` | Switch the orchestrator's model |
| `/model-workers` | Switch every worker's model |
| `/compact` | Compact the boss's context now |
| `/clear` | Clear chat history and terminal |
| `/radio` | Stream a free internet radio station while you work |
| `/quit` (`/q`, `/exit`) | Exit gg-boss |

---

## 📋 The task plan

The boss isn't just a dispatcher — it keeps a persistent backlog. Use it for tracked, reviewable, resumable work.

- The boss adds tasks via `add_task(project, title, description, fresh?)`.
- Tasks live in `~/.gg/boss/tasks.json` and survive restarts.
- Press <kbd>Ctrl+T</kbd> any time to see the plan, dispatch an item, or delete it.
- Worker self-reported status (`DONE` / `UNVERIFIED` / `PARTIAL` / `BLOCKED` / `INFO`) auto-updates the task, with the boss free to override based on cross-check.
- When a project goes idle with pending work in the plan, **auto-chain** picks up the next task without the boss having to remember.

Direct dispatch (`prompt_worker`) is for one-shot work. The plan is for batches you want to curate, review, and resume.

---

## 📻 Radio

`/radio` streams long-running, royalty-free internet radio while you work — SomaFM Groove Salad, Drone Zone, Radio Paradise Mellow Mix, lofi beats. Pick a station or `Off`. Requires one of `mpv` (recommended), `ffplay`, `mpg123`, or `vlc/cvlc` on your `PATH`.

---

## 🗂 Project discovery

`ggboss link` is interactive. It scans:

- `~/.gg/sessions/` — your existing **ggcoder** projects
- `~/.claude/projects/` — your **Claude Code** projects (cwds extracted from the JSONL events themselves, not the lossy dir-name encoding)
- `~/.codex/sessions/` — your **Codex** projects (cwds pulled from session metadata)

Sorted most-recent first. Pick a few, save the list, and the boss starts a worker for each one.

---

## 🛟 Auto-update

On every launch the boss installs any pending update from the prior run (effective next launch) and schedules a fresh registry check in the background. No prompts, no interruption — you just stay current.

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
  <strong>Talk to the boss. The workers do the rest.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-boss"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40kenkaiiii%2Fgg--boss-blue?style=for-the-badge" alt="Install"></a>
</p>
