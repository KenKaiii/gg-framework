# gg-framework

A modular TypeScript framework for building LLM-powered apps — from raw streaming to full coding agent.

## npm Packages

| Package | npm Name | Description |
|---|---|---|
| `packages/gg-ai` | `@kenkaiiii/gg-ai` | Unified LLM streaming API |
| `packages/gg-agent` | `@kenkaiiii/gg-agent` | Agent loop with tool execution |
| `packages/ggcoder` | `@kenkaiiii/ggcoder` | CLI coding agent |

**Install**: `npm i -g @kenkaiiii/ggcoder`

## Project Structure

```
packages/
  ├── gg-ai/                 # @kenkaiiii/gg-ai — Unified LLM streaming API
  │   └── src/
  │       ├── types.ts       # Core types (StreamOptions, ContentBlock, events)
  │       ├── errors.ts      # GGAIError, ProviderError
  │       ├── stream.ts      # Main stream() dispatch function
  │       ├── providers/     # Anthropic, OpenAI streaming implementations
  │       └── utils/         # EventStream, Zod-to-JSON-Schema
  │
  ├── gg-agent/              # @kenkaiiii/gg-agent — Agent loop with tool execution
  │   └── src/
  │       ├── types.ts       # AgentTool, AgentEvent, AgentOptions
  │       ├── agent.ts       # Agent class + AgentStream
  │       └── agent-loop.ts  # Pure async generator loop
  │
  └── ggcoder/               # @kenkaiiii/ggcoder — CLI (ggcoder)
      └── src/
          ├── cli.ts         # CLI entry point
          ├── config.ts      # Configuration constants
          ├── session.ts     # Session management
          ├── system-prompt.ts # System prompt generation
          ├── core/          # Auth, OAuth, settings, sessions, extensions
          │   ├── oauth/     # PKCE OAuth flows (anthropic, openai)
          │   ├── compaction/ # Context compaction & token estimation
          │   ├── mcp/       # Model Context Protocol client
          │   └── extensions/ # Extension system
          ├── tools/         # Agentic tools (bash, read, write, edit, grep, find, ls, web-fetch, subagent)
          ├── ui/            # Ink/React terminal UI components & hooks
          │   ├── components/ # 25+ UI components (one per file)
          │   ├── hooks/     # useAgentLoop, useSessionManager, useSlashCommands, etc.
          │   └── theme/     # dark.json, light.json
          ├── modes/         # Execution modes (interactive, print, json)
          └── utils/         # Error handling, git, shell, formatting, image
```

## Package Dependencies

`@kenkaiiii/gg-ai` (standalone) → `@kenkaiiii/gg-agent` (depends on ai) → `@kenkaiiii/ggcoder` (depends on both)

## Tech Stack

- **Language**: TypeScript 5.9 (strict, ES2022, ESM)
- **Package Manager**: pnpm workspaces
- **Build**: tsc
- **Test**: Vitest 4.0
- **Lint**: ESLint 10 + typescript-eslint (flat config)
- **Format**: Prettier 3.8
- **CLI UI**: Ink 6 + React 19
- **Key deps**: `@anthropic-ai/sdk`, `openai`, `zod` (v4)

## Commands

```bash
# Build & typecheck all packages
pnpm build                          # tsc across all packages
pnpm check                          # tsc --noEmit across all packages

# Per-package
pnpm --filter @kenkaiiii/gg-ai build
pnpm --filter @kenkaiiii/gg-agent build
pnpm --filter @kenkaiiii/ggcoder build
```

## Publishing to npm

Must use `pnpm publish` (not `npm publish`) so `workspace:*` references resolve to real versions.

### Steps

1. Bump version in all 3 `package.json` files (keep them in sync)
2. Build all packages: `pnpm build`
3. Publish in dependency order:

```bash
pnpm --filter @kenkaiiii/gg-ai publish --no-git-checks
pnpm --filter @kenkaiiii/gg-agent publish --no-git-checks
pnpm --filter @kenkaiiii/ggcoder publish --no-git-checks
```

### Auth

- npm granular access token must be set: `npm set //registry.npmjs.org/:_authToken=<token>`
- All packages use `"publishConfig": { "access": "public" }` (required for scoped packages)
- `--no-git-checks` skips git dirty/tag checks (needed since we don't tag releases)

### Verify

```bash
npm view @kenkaiiii/ggcoder versions --json   # check published versions
npm i -g @kenkaiiii/ggcoder@<version>         # test install
ggcoder --help                                # verify CLI works
```

If `npm i` gets ETARGET after publishing, clear cache: `npm cache clean --force`

## Fork Workflow (dao-du/gg-framework)

This is a fork of `KenKaiii/gg-framework`. We added **Venice as a fifth provider** for privacy, anonymity, and uncensored model access. The upstream npm package doesn't have our changes, so we install globally from this local build — not from npm.

### Remotes

| Remote | Repo | Purpose |
|---|---|---|
| `upstream` | `KenKaiii/gg-framework` | Original repo — pull updates from here |
| `fork` | `dao-du/gg-framework` | Our fork — push our merged changes here |

### Our Custom Features (not in upstream)

| Feature | Branch | Key Files |
|---|---|---|
| **Venice provider** | `main` | config.ts, cli.ts, model-registry.ts, agent-session.ts, login.tsx, stream.ts, types.ts |
| **Remote Control (RC)** | `feat/remote-control` (merge into main) | remote-control.ts, event-bus.ts, App.tsx, cli.ts, useAgentLoop.ts, RemoteControlBanner.tsx |

### Syncing upstream updates while keeping our features

```bash
cd ~/gg-framework-rc
git checkout main

# Make sure RC is merged into main first (one-time)
# git merge feat/remote-control

# Pull upstream
git fetch upstream
git merge upstream/main
# Resolve conflicts if any
# Venice touched: config.ts, cli.ts, model-registry.ts,
#   agent-session.ts, auth-storage.ts, auto-update.ts, serve-mode.ts,
#   ModelSelector.tsx, login.tsx, stream.ts, types.ts
# RC touched: cli.ts, App.tsx, useAgentLoop.ts, render.ts, agent-session.ts
#   (new files like remote-control.ts, event-bus.ts won't conflict)

# Rebuild and reinstall globally
pnpm install && pnpm build
cd packages/ggcoder && npm install -g .

# Push to our fork
cd ~/gg-framework-rc && git push fork main
```

### Why not just `npm i -g @kenkaiiii/ggcoder`?

ggcoder auto-updates from npm on launch. That pulls the upstream version which **does not have Venice or RC**, wiping our changes. Installing from the local build (`npm install -g .`) symlinks to our source, and the `auto-update.ts` change skips auto-update for local installs.

### ⚠️ If the global install gets wiped (auto-update or accidental npm install)

This WILL happen when ggcoder auto-updates. Quick recovery:

```bash
# One command to get our features back:
cd ~/gg-framework-rc/packages/ggcoder && npm install -g .
```

To check if you have the right version:
```bash
ls -la $(which ggcoder)
# Should symlink to gg-framework-rc, NOT to @kenkaiiii/ggcoder
ggcoder --version
# Should be 4.2.84 (our version), not a higher upstream version
```

### If you need to rebuild from scratch (after upstream merge)

```bash
cd ~/gg-framework-rc
pnpm install && pnpm build
cd packages/ggcoder && npm install -g .
ggcoder --version  # verify
ggcoder --rc       # verify RC works (should show socket banner)
```

## Organization Rules

- Types → `types.ts` in each package
- Providers → `providers/` directory in @kenkaiiii/gg-ai
- Tools → `tools/` directory in @kenkaiiii/ggcoder, one file per tool
- UI components → `ui/components/`, one component per file
- OAuth flows → `core/oauth/`, one file per provider
- Tests → co-located with source files

## Code Quality — Zero Tolerance

After editing ANY file, run:

```bash
pnpm check && pnpm lint && pnpm format:check
```

Fix ALL errors before continuing. Quick fixes:
- `pnpm lint:fix` — auto-fix ESLint issues
- `pnpm format` — auto-fix Prettier formatting
- Use `/fix` to run all checks and spawn parallel agents to fix issues

## Key Patterns

- **StreamResult/AgentStream**: dual-nature objects — async iterable (`for await`) + thenable (`await`)
- **EventStream**: push-based async iterable in `@kenkaiiii/gg-ai/utils/event-stream.ts`
- **agentLoop**: pure async generator — call LLM, yield deltas, execute tools, loop on tool_use
- **OAuth-only auth**: no API keys, PKCE OAuth flows, tokens in `~/.gg/auth.json`
- **Zod schemas**: tool parameters defined with Zod, converted to JSON Schema at provider boundary
- **Debug logging**: `~/.gg/debug.log` — timestamped log of startup, auth, tool calls, turn completions, errors. Truncated on each CLI restart. Singleton logger in `src/core/logger.ts`

## Slash Commands

There are two kinds of slash commands:

### 1. UI-handled commands (in `App.tsx`)

Commands that need direct access to React state (UI, overlays, token counters) are handled inline in `handleSubmit` in `src/ui/App.tsx`. These short-circuit before the slash command registry.

**Current UI commands:** `/model` (`/m`), `/compact` (`/c`), `/quit` (`/q`, `/exit`), `/clear`

To add a new UI command:
1. Add a condition in `handleSubmit` after the existing checks:
   ```tsx
   if (trimmed === "/mycommand") {
     // manipulate React state directly
     setLiveItems([{ kind: "info", text: "Done.", id: getId() }]);
     return;
   }
   ```
2. If the command needs to reset agent state, call `agentLoop.reset()`.

### 2. Registry commands (in `core/slash-commands.ts`)

Commands that don't need React state live in `createBuiltinCommands()` in `src/core/slash-commands.ts`. They receive a `SlashCommandContext` with methods like `switchModel`, `compact`, `newSession`, `quit`, etc.

**Current registry commands:** `/model` (`/m`), `/compact` (`/c`), `/help` (`/h`, `/?`), `/settings` (`/config`), `/session` (`/s`), `/new` (`/n`), `/quit` (`/q`, `/exit`)

Note: `/model`, `/compact`, and `/quit` exist in both — the UI handlers in `App.tsx` take precedence since they're checked first.

To add a new registry command:
1. Add an entry to the array in `createBuiltinCommands()`:
   ```ts
   {
     name: "mycommand",
     aliases: ["mc"],
     description: "Does something useful",
     usage: "/mycommand [args]",
     execute(args, ctx) {
       // Use ctx methods or return a string to display
       return "Result text";
     },
   },
   ```
2. If the command needs new capabilities, add the method to `SlashCommandContext` interface and wire it up in `AgentSession.createSlashCommandContext()`.

### When to use which

| Need | Where |
|---|---|
| Modify UI state (history, overlays, live items) | `App.tsx` |
| Reset token counters | `App.tsx` (call `agentLoop.reset()`) |
| Access agent session (messages, auth, settings) | `slash-commands.ts` registry |
| Both UI + session access | `App.tsx` (can call session methods via props) |

There is also support for **prompt-template commands** (built-in from `core/prompt-commands.ts` and custom from `.gg/commands/` directory).
