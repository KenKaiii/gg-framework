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
- **Image tool results**: `ToolResult` has an optional `images?: ImageContent[]` field. The `read` tool returns visual content for image files (.png, .jpg, .gif, .webp, .bmp) via `readImageFile()` in `utils/image.ts`. Anthropic transforms merge images into tool_result content arrays natively. OpenAI/GLM fall back to a text note since they don't support images in tool results. Token estimator counts ~1600 tokens per image. Compaction strips images from old tool results.

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
