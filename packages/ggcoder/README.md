<p align="center">
  <img src="https://raw.githubusercontent.com/KenKaiii/gg-framework/main/gg-app/icon-source.png" alt="GG Coder icon" width="96">
</p>

<h1 align="center">GG Coder CLI</h1>

<p align="center">
  <strong>A fast, lean coding agent for your terminal. Use the AI subscription you already pay for.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&color=blue" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/dm/@kenkaiiii/ggcoder?style=for-the-badge&color=2ecc71" alt="npm downloads per month"></a>
  <a href="https://github.com/KenKaiii/gg-framework"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="GitHub stars"></a>
  <a href="https://github.com/KenKaiii/gg-framework/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

`ggcoder` is the command-line version of [GG Coder](https://github.com/KenKaiii/gg-framework). It reads your code, edits files, runs commands and checks its own work, with your Claude, ChatGPT or Kimi Code plan, an API key or a model on your own machine.

> **GG Coder is now an app first.** All new features and design work go into the [GG Coder desktop app](https://github.com/KenKaiii/gg-framework/releases/latest) for macOS, Windows and Linux. It runs the same engine as this CLI and adds GG Goals, Chat, GG Motion and one-click project checks.
>
> The CLI still works and gets every engine update (providers, models, tools, fixes), but the terminal interface itself isn't being actively developed. Keeping the focus on one interface is what keeps GG Coder manageable. For the best experience, [download the app](https://github.com/KenKaiii/gg-framework/releases/latest).

## Why GG Coder

- **More work per plan.** In a race of 20 coding agents on the same model, GG Coder was the fastest and used the least. Claude Code used 169% more for the same work. [See the results.](https://github.com/KenKaiii/gg-framework#why-gg-coder)
- **A small prompt.** Every request carries the system prompt and tool list. GG Coder keeps both short, and loads rarely used tools only when the agent asks for them.
- **No MCP pile-up.** None are installed by default. Checking against real-world code is a built-in tool (`steroids`) that costs nothing until it's used.
- **Your subscriptions.** Switch provider or model mid-conversation without losing anything.

## Get started

```bash
npm install -g @kenkaiiii/ggcoder

ggcoder login   # pick a provider and sign in
ggcoder         # start coding in the current folder
```

Needs Node.js 22 or newer. Sign-ins are saved in `~/.gg/auth.json`, shared with the desktop app, and refreshed automatically.

## Providers

Switch any time with `/model`.

| Provider         | Models                                                                             | Sign-in                                |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| **Anthropic**    | Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5                                  | Claude or API key                      |
| **OpenAI**       | GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna                                | Continue with ChatGPT or API key       |
| **Gemini**       | Gemini 3.8 Flash, 3.5 Flash Lite, 3.1 Flash Lite, 3.5 Flash, 3.1 Pro (Preview)     | API key (Google AI Studio)             |
| **xAI**          | Grok 4.7                                                                           | API key                                |
| **Kimi**         | Kimi K3, K2.8 Preview, K2.7 Code, K2.7 Code HighSpeed                              | Kimi Code plan key or Moonshot API key |
| **Z.AI**         | GLM-5.3, GLM-5.3-Flash                                                             | API key (pay-per-token)                |
| **MiniMax**      | MiniMax M3.1 Flash, M3                                                             | M Plan key or API key                  |
| **Xiaomi**       | MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed                           | Token Plan key or API Credits key      |
| **DeepSeek**     | DeepSeek V4 Pro, V4.1 Flash                                                        | API key                                |
| **Sakana**       | Fugu, Fugu Max, Fugu Ultra                                                         | API key                                |
| **OpenRouter**   | Qwen3.8 Max                                                                        | API key                                |
| **Hugging Face** | Kimi K2.7 Code, DeepSeek V4.1 Flash, GPT-OSS 120B                                  | API key                                |
| **Local**        | Anything on Ollama, LM Studio, llama.cpp, vLLM or another OpenAI-compatible server | None                                   |

Every model above except GLM-5.3, DeepSeek V4 Pro and GPT-OSS 120B accepts images. Paste, drag or type a path to attach images or video. Models that can't watch video get it as a file to inspect with their own tools.

Signing in with a Claude Pro or Max plan goes through Anthropic's official Claude Code. GG Coder downloads it (about 200 MB, checked against a pinned hash) into `~/.gg/claude-code` the first time you pick "Sign in with Claude", and keeps its own Claude login there, separate from any Claude Code you already use. On this route Claude Code runs each turn with GG Coder's prompt and tools. Without a plan, use an Anthropic API key.

Each provider connects only the way its owner allows. "Continue with ChatGPT" is OpenAI's official sign-in for open-source apps; manage what GG Coder may use at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage). Kimi Code, MiniMax M Plan and MiMo Token Plan keys use your plan. xAI, Gemini and Z.AI take pay-per-token keys: their plans are limited to their own or partner apps. Image generation (`generate_image`) needs an OpenAI API key.

## Using it

| Key                     | What it does                                 |
| ----------------------- | -------------------------------------------- |
| <kbd>Enter</kbd>        | Send (<kbd>Shift+Enter</kbd> for a new line) |
| <kbd>Esc</kbd>          | Stop the agent mid-turn                      |
| <kbd>Shift+Tab</kbd>    | Change thinking level                        |
| <kbd>Ctrl+T</kbd>       | Tasks                                        |
| <kbd>Ctrl+S</kbd>       | Skills                                       |
| <kbd>Ctrl+R</kbd>       | Search earlier prompts                       |
| <kbd>Ctrl+V</kbd>       | Paste an image                               |
| <kbd>Ctrl+C</kbd> twice | Quit                                         |

| Command           | What it does                                           |
| ----------------- | ------------------------------------------------------ |
| `/model` (`/m`)   | Switch model                                           |
| `/compact` (`/c`) | Shrink a long conversation                             |
| `/new` (`/n`)     | Start a new session                                    |
| `/session` (`/s`) | Resume an earlier session                              |
| `/branch` (`/b`)  | Fork the conversation from an earlier point            |
| `/rewind`         | Undo the agent's file edits, the conversation, or both |
| `/add-dir`        | Add another project folder to this session             |
| `/settings`       | Settings                                               |
| `/help`           | Every command                                          |

Built-in workflows:

| Command         | What it does                                            |
| --------------- | ------------------------------------------------------- |
| `/init`         | Write or update the project's `AGENTS.md` / `CLAUDE.md` |
| `/setup-commit` | Create a `/commit` command with your project's checks   |
| `/setup-ci`     | Set up or harden CI for any stack                       |
| `/compare`      | Compare your code against real-world code               |
| `/steroids`     | Index real repos similar to this project                |
| `/expand`       | Suggest new features worth building                     |

## Tools

The agent always has `read`, `write`, `edit`, `bash`, `grep`, `skill`, `ask_user` and `tool_search`. Everything else costs one short line in the prompt until the agent loads it:

- **Files and search:** `find`, `ls`, `source_path` (the source of an installed dependency)
- **Web:** `web_search`, `web_fetch`, `steroids` (current open-source code similar to yours)
- **Checking work:** `screenshot` (opens a page in a headless browser), `debug` (Node debugger)
- **Planning:** `enter_plan` / `exit_plan`, `tasks`
- **Helpers:** `subagent` for one focused job, or `spawn_agent` to run several in parallel
- **Extras:** `generate_image`, `checklist`, UI component browsing

`screenshot` needs Playwright: `npx playwright install chromium`. Without it, the tool explains how to install it.

## Make it yours

- **Project instructions.** Put an `AGENTS.md` or `CLAUDE.md` in your repo (or a parent folder) and it's loaded automatically. Per folder, the first match wins: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `CONVENTIONS.md`.
- **Custom commands.** Each Markdown file in `.gg/commands/` becomes a slash command for that project.
- **Skills.** Reusable instructions in `~/.gg/skills/` (everywhere) or `.gg/skills/` (one project), as `name.md` or `name/SKILL.md`. The agent loads one when the work matches. Two ship built in: `compliance-guard` (legal exposure such as personal data, payments or marketing) and `durable` (not losing stored data).
- **MCP servers.** `ggcoder mcp add` uses the same syntax and `mcpServers` format as Claude Code. Servers go in `~/.gg/mcp.json` (everywhere) or `.gg/mcp.json` (one project). Project servers only connect after you trust them in settings.

`/rewind` restores files the agent changed with `write` and `edit`. Changes made through `bash` (for example `rm` or code generators) aren't tracked. Checkpoints live in `~/.gg/checkpoints/`, never in your repo.

## More commands

| Command            | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `ggcoder continue` | Resume the most recent session                                                                    |
| `ggcoder sessions` | Browse and resume earlier sessions                                                                |
| `ggcoder logout`   | Remove saved sign-ins                                                                             |
| `ggcoder doctor`   | Find and fix sign-in and config problems                                                          |
| `ggcoder mcp`      | Add and manage MCP servers                                                                        |
| `ggcoder acp`      | Run as an [Agent Client Protocol](https://agentclientprotocol.com) agent, for editors such as Zed |
| `ggcoder serve`    | Start an HTTP/WebSocket API server                                                                |
| `ggcoder telegram` | Talk to the agent from Telegram                                                                   |

Flags: `--provider`, `--model`, `--thinking <level>` and `--resume <id>`. Run `ggcoder --help` for all of them.

## Use it as a library

The engine behind the CLI and the desktop app is exported too: `AgentSession`, the built-in tools (`createTools`), sessions, compaction, skills and the system prompt builder. For your own agent, start lower with [`@kenkaiiii/gg-agent`](https://www.npmjs.com/package/@kenkaiiii/gg-agent).

| Package                                                                  | What it does                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [@kenkaiiii/gg-ai](https://www.npmjs.com/package/@kenkaiiii/gg-ai)       | One streaming API for every provider                              |
| [@kenkaiiii/gg-agent](https://www.npmjs.com/package/@kenkaiiii/gg-agent) | The agent loop: runs tools and feeds results back to the model    |
| [@kenkaiiii/gg-core](https://www.npmjs.com/package/@kenkaiiii/gg-core)   | Model list, sign-in and stored credentials, local model discovery |
| **@kenkaiiii/ggcoder**                                                   | The GG Coder coding agent: CLI, tools and sessions (this package) |

## Community

- [Skool community](https://skool.com/kenkai): get help and share what you build
- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai): tutorials and demos
- [GitHub](https://github.com/KenKaiii/gg-framework): source, issues and the desktop app. If GG Coder saves you time, ⭐ star it so more people find it.

## License

[AGPL-3.0-only](https://github.com/KenKaiii/gg-framework/blob/main/LICENSE). You can build on it; if you distribute your changes or run them as a network service, share their source under the same license.
