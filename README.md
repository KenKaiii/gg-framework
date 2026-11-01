<p align="center">
  <img src="gg-app/icon-source.png" alt="GG Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="GG Coder desktop home screen">
</p>

<p align="center">
  <strong>Cause the other agents piss me off.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=Download&color=b0b6ff" alt="GG Coder desktop release"></a>
  <a href="https://github.com/KenKaiii/gg-framework/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="Star GG Coder on GitHub"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI&color=blue" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-b0b6ff?style=for-the-badge" alt="Skool"></a>
</p>

GG Coder is a desktop coding agent built to get the most out of the AI subscription you already pay for. It does the same work faster and with less usage than every other agent I've tested, looks up real working code instead of guessing, and keeps going until the work is actually checked.

## Why GG Coder over the others

Every coding agent can edit files and run tests. Claude Code does. So do the other dozens. What matters is how much of your plan an agent burns to get there, and how often it guesses.

### 1. More work out of your plan

**The leanest coding agent I've tested.** I raced GG Coder against 19 other coding agents on the same model, all in one race. GG was the fastest and used the least of all 20.

| Agent              | Time for the full suite | Usage per suite | GG Coder compared          |
| ------------------ | ----------------------- | --------------- | -------------------------- |
| **GG Coder**       | **99 s**                | **$0.015**      |                            |
| Codewhale          | 110 s                   | $0.022          | 10% faster, 32% less usage |
| Kimi Code          | 120 s                   | $0.029          | 18% faster, 47% less usage |
| GitHub Copilot CLI | 125 s                   | $0.027          | 21% faster, 44% less usage |
| Goose              | 126 s                   | $0.021          | 22% faster, 27% less usage |
| ForgeCode          | 138 s                   | $0.042          | 28% faster, 63% less usage |
| Claude Code        | 141 s                   | $0.039          | 30% faster, 60% less usage |
| Factory Droid      | 144 s                   | $0.026          | 32% faster, 40% less usage |
| Crush              | 153 s                   | $0.038          | 36% faster, 59% less usage |
| Dirac              | 154 s                   | $0.030          | 36% faster, 48% less usage |
| Mistral Vibe       | 155 s                   | $0.037          | 36% faster, 58% less usage |
| DeepSeek-Reasonix  | 157 s                   | $0.026          | 37% faster, 40% less usage |
| Oh My Pi           | 167 s                   | $0.031          | 41% faster, 50% less usage |
| Xum                | 172 s                   | $0.047          | 43% faster, 68% less usage |
| Prime Agent        | 176 s                   | $0.031          | 44% faster, 51% less usage |
| Docker Agent       | 176 s                   | $0.023          | 44% faster, 33% less usage |
| Deep Agents        | 189 s                   | $0.041          | 48% faster, 62% less usage |
| Hermes Agent       | 191 s                   | $0.040          | 48% faster, 61% less usage |
| Qwen Code          | 212 s                   | $0.063          | 54% faster, 76% less usage |
| jcode              | 236 s                   | $0.058          | 58% faster, 74% less usage |

On a subscription, less usage means more work out of your plan. The same allowance covers about **2.5x** the coding it would in Claude Code, and about **2.0x** what it would in Oh My Pi.

<sub>Every agent on Claude Haiku 5.5, across more than 3,000 test runs. The table is one race on 25 October 2026: 7 tasks, 5 runs each, every agent on a current version.</sub>

How it uses less:

- **A small toolset up front.** Every tool an agent carries costs tokens on every single request. GG carries only the few it uses most and loads the rest the moment it needs them, at about 20 tokens each instead of 300 to 500.
- **The cache stays warm.** Text your provider has already seen is much cheaper and faster to process again. GG never rewrites the start of a conversation partway through; changes get added at the end, so the cache keeps hitting.
- **Signal, not noise.** A 10,000-line log gets cut down to the errors and the lines around them, not just the first and last hundred lines. Routine output like `git status`, `git log` and all-green test runs gets condensed. The full output is saved, so the agent never re-runs a command just to see it again.
- **No double reads.** If the agent has already seen a file, it doesn't read it again before editing it.

### 2. Real code, not guesses

Models only know what they were trained on, and that's often out of date. **Agent Steroids** gives your agent a local library of real, current open-source code it can search in an instant: how a working project calls that API, what a real config looks like, how someone else fixed the same bug.

Other agents get this from MCP servers that call a hosted service, so you hit rate limits right when the agent needs answers most. Steroids runs on your own machine: search as much as you like, offline, with no limits. If a project isn't in the library yet, the agent can find it and add it.

### 3. Done means checked

**Ken Autopilot** reviews the coding work and keeps it going until it's actually done and checked, so you don't have to babysit it. When the agent finishes, it tells you straight what it verified and what it couldn't.

### 4. Every subscription you already pay for

Sign in with Claude, ChatGPT, Gemini, Grok or Kimi subscriptions, use API keys for OpenAI, Anthropic, DeepSeek, GLM, MiniMax, OpenRouter and more, or run local models. A usage meter shows how much of your plan you've used.

## What else you get

- **Code:** plan mode lets you review the plan before anything changes. Open as many windows as you need, one project each.
- **GG Goals:** hand over a whole goal and walk away. It agrees the approach with you, then does the work, splitting big independent parts across a team of workers that run side by side, and keeps you posted until the goal is met. It works on any folder, not just code: research, documents, plans.
- **Chat:** conversations that remember context.
- **GG Motion:** turns your ideas into videos.
- **Plugs into your workflow:** connect MCP servers, and drive GG from Telegram, voice notes included.

## Get started

1. Install GG Coder:

   **macOS (Apple Silicon):** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and open the `.dmg`.

   **Windows:** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and run the `.exe` installer.

   **Linux (x86_64):** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and install the `.deb` (`sudo apt install ./GG*.deb`) or `.rpm` (`sudo dnf install ./GG*.rpm`).

   **Development:** With Node.js, pnpm, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. Open the app, connect your AI provider, and pick Code, Chat, or Motion.

## Build with the framework

Want the engine without the desktop app? Use the same packages in your own apps. Install just what you need.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): Model selection, authentication, and local model discovery.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): The coding agent, sessions, and tools behind the app and CLI.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. MIT licensed, so you can build on it.

## Learn with me

Come build with me in my [Skool community](https://skool.com/kenkai). Get help, share what you're making, and learn how to get more out of AI.
