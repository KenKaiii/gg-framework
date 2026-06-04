# gg-framework

A modular TypeScript framework for building LLM-powered apps — from raw streaming to full coding agent.

## npm Packages

| Package | npm Name | Description |
|---|---|---|
| `packages/gg-ai` | `@kenkaiiii/gg-ai` | Unified LLM streaming API |
| `packages/gg-agent` | `@kenkaiiii/gg-agent` | Agent loop with tool execution |
| `packages/gg-core` | `@kenkaiiii/gg-core` | Provider-agnostic, UI-free shared foundation: model registry, thinking levels, app paths, OAuth + auth storage, file-writer logger core, telegram + voice transcription, self-updater |
| `packages/ggcoder` | `@kenkaiiii/ggcoder` | CLI coding agent |
| `packages/gg-pixel` | `@kenkaiiii/gg-pixel` | Universal error tracking SDK (Node + Browser + Deno + Workers) |
| `packages/gg-pixel-server` | (private — Cloudflare Worker) | Ingest backend (Workers + D1) |

**Install**: `npm i -g @kenkaiiii/ggcoder`

## Models & Multimodal

The MiniMax provider defaults to **MiniMax M3** (1M context, image + video). Video-capable
models are Gemini 3.x, Kimi K2.6, and MiniMax M3 — these accept native video blocks (gg-ai's
`VideoContent`). Video attachments are supported in the chat input (drag, paste, or type a path);
for non-video models the video is saved to a temp file and the model is told to inspect it with
ffmpeg/its tools (mirrors the GLM image fallback). The `supportsVideo` capability flag lives in
`packages/ggcoder/src/core/model-registry.ts`.

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

```
gg-ai → gg-agent → gg-core → { ggcoder, gg-boss, gg-editor, gg-voice }
```

- `@kenkaiiii/gg-ai` — standalone unified streaming API. Owns raw provider wording (`formatError`, `isHardBillingMessage`, `classifyProviderError`).
- `@kenkaiiii/gg-agent` — agent loop; depends on gg-ai.
- `@kenkaiiii/gg-core` — provider-agnostic, **UI-free** shared foundation; depends only on gg-ai (for `Provider` / `ThinkingLevel` types). Must NOT import gg-agent or React/Ink — it sits below every app. (The logger's `attachToEventBus` bridge, which needs the gg-agent `EventBus` type, stays in the apps; only the pure file-writer logger core lives in gg-core.)
- Apps (ggcoder, gg-boss, gg-editor, gg-voice) keep only **UI + orchestration** and depend on gg-core.

### One home for provider-coupled code

Anything coupled to provider behavior — model registry, context windows, thinking
levels, app paths, auth/OAuth — has exactly **one home in gg-core**. Raw provider
error *wording* lives in **gg-ai** (`classifyProviderError`, `isHardBillingMessage`).
Fix a model entry or an error string once and ggcoder, gg-boss, gg-editor, and
gg-voice all inherit it on their next build. Do not re-add per-app copies; import
from `@kenkaiiii/gg-core` (or `@kenkaiiii/gg-ai`) instead.

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

## Publishing to npm (Changesets)

Versioning + publishing is managed by [Changesets](https://github.com/changesets/changesets).
Manual multi-package version bumping is gone — do **not** hand-edit `version` fields.

The framework spine — `@kenkaiiii/gg-ai`, `@kenkaiiii/gg-agent`, `@kenkaiiii/gg-core`,
`@kenkaiiii/ggcoder`, `@kenkaiiii/gg-boss` — is a **fixed group** in
`.changeset/config.json`: a changeset touching any one bumps them all to the same
version together (this is what kept drifting before). Dependents like gg-editor /
gg-voice get an automatic patch bump.

### Flow

```bash
pnpm changeset            # describe the change; pick bump level (patch/minor/major)
pnpm changeset version    # apply bumps + update internal deps + write changelogs
pnpm build                # rebuild with the new versions
pnpm changeset publish    # publishes in topological order (uses pnpm under the hood)
```

`pnpm changeset status` shows the pending release graph at any time.

### Auth

- npm granular access token must be set: `npm set //registry.npmjs.org/:_authToken=<token>`
- `access: public` is set in `.changeset/config.json` (and each package's `publishConfig`), required for scoped packages.
- `workspace:*` references resolve to real versions at publish time because changesets publishes via pnpm.

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
- OAuth flows, auth storage, model registry, app paths, logger core → `@kenkaiiii/gg-core` (`packages/gg-core/src/`), one file per provider under `oauth/`. ggcoder keeps thin re-export shims at `core/oauth/*`, `core/auth-storage.ts`, etc. so existing relative imports + subpath exports (`@kenkaiiii/ggcoder/auth`, `/models`) keep resolving.
- Provider error classification → `@kenkaiiii/gg-ai` (`classifyProviderError` in `error-classification.ts`).
- Tests → co-located with source files

## Code Quality

Run targeted verification that is appropriate to the change before calling work complete. Do not run the full quality suite after every edit by default; reserve it for broad code changes, release work, or when explicitly requested.

For full verification, use:

```bash
pnpm check && pnpm lint && pnpm format:check
```

After code changes that need compiled outputs, also run `pnpm build`.

Fix errors from checks you do run before continuing. Quick fixes:
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

## MCP Servers

`ggcoder mcp` adds and manages Model Context Protocol servers. Configs are stored in the same `{ "mcpServers": { … } }` shape Claude Code uses, so they're portable both directions.

### Scopes & file locations

- **Global** → `~/.gg/mcp.json` — available in all GG Coder sessions.
- **Project** → `./.gg/mcp.json` — only the current project root.
- On a name collision, **project wins**. Provider defaults (e.g. `kencode-search`) stay authoritative — a user server can only add a new name, never override a default.

### Commands

```bash
ggcoder mcp                              # interactive dashboard (🟢/🔴 status, tool counts, scope)
ggcoder mcp list                         # list servers with live connection status
ggcoder mcp get <name>                   # show one server's config (secrets masked)
ggcoder mcp add <args…>                  # add a server (claude-compatible grammar)
ggcoder mcp remove <name> [--scope s]    # remove a server
```

The `add` grammar mirrors `claude mcp add` 1:1 — you can paste a `claude mcp add …` (or `ggcoder mcp add …`) line and the prefix is stripped automatically:

```bash
ggcoder mcp add --transport http notion https://mcp.notion.com/mcp
ggcoder mcp add --transport sse asana https://mcp.asana.com/sse
ggcoder mcp add --env AIRTABLE_API_KEY=key airtable -- npx -y airtable-mcp-server
```

`--scope user` maps to global; `local`/`project` map to project. Code lives in `core/mcp/` (`store.ts` persistence, `parse-add-command.ts` parser, `client.ts` `connectAllDetailed`/`probe`) and `cli/mcp.ts` + `ui/mcp.tsx`.

### Caveats

- **Connection is startup-only.** MCP connects once at launch (`connectInitialMcpTools` in `cli.ts`). Adding a server via `ggcoder mcp` mid-session won't hot-load it — restart ggcoder.
- **Pixel chdir flow.** Project-scoped servers load relative to `process.cwd()` at startup. The Pixel fix flow swaps cwd mid-session (`process.chdir` + `rebuildToolsForCwd`); project MCP servers won't follow that swap.
- **WebSocket transport** is parsed but rejected (no WS client today).
- **Env var expansion** (`${VAR}`) in `.mcp.json` is NOT expanded in v1 — values pass through literally.

## Pixel — error tracking + auto-fix queue

`@kenkaiiii/gg-pixel` is a drop-in error tracking SDK. Errors flow to a Cloudflare Worker (`gg-pixel-server`) backed by D1. `ggcoder pixel` opens an in-Ink overlay that lists open errors per project and hands each one off to the existing agent loop — same UX as the Task pane.

### CLI

```bash
ggcoder pixel install          # Detect framework, wire up SDK + .env, register project key
ggcoder pixel                  # Open the in-Ink overlay (also: Ctrl+E inside running ggcoder)
ggcoder pixel fix <error_id>   # Fix one error end-to-end (subprocess flow, for non-TTY use)
ggcoder pixel run              # Auto-fix every open error (non-interactive)
```

### In-Ink fix flow (the main path)

`Ctrl+E` from inside ggcoder, or `ggcoder pixel`, opens `PixelOverlay`. Keys: `↑↓ navigate · Enter fix one · f fix all · d delete · Esc close`.

When a fix starts, `startPixelFix(errorId)` in `App.tsx` swaps **four** things in lockstep before calling `agentLoop.run(prep.prompt)`:

1. `process.chdir(prep.projectPath)` — for code reading `process.cwd()` directly.
2. `setCurrentTools(rebuildToolsForCwd(prep.projectPath))` — read/write/edit/bash/find/grep/ls/tasks/sub-agent are all baked with `cwd` at creation, so they MUST be rebuilt; chdir alone is not enough.
3. System prompt is rebuilt with the new project root (`buildSystemPrompt(prep.projectPath, …)`) and swapped into `messagesRef.current[0]` — this is the only place the model itself learns "where it is".
4. `setDisplayedCwd(prep.projectPath)` — Banner + Footer read this. Because Banner lives inside Ink's `<Static>`, also bump `staticKey` so Static remounts and re-renders the banner with the new path.

Reset chat state (`setHistory`, `setLiveItems`, `setStaticKey`, screen clear) **AFTER** the chdir is committed — otherwise the old-cwd banner gets written first and you see two banners stacked.

`onDone` in `useAgentLoop` finalizes the fix: `finalizePixelFix(prep)` observes the `fix/pixel-{id}` branch + commits and patches the D1 status to `awaiting_review` or `failed`. Run-all picks up the next open error via the same path.

### Backend

`packages/gg-pixel-server/` — Hono on Workers + D1. Routes:
- `POST /ingest` — SDK posts events; server dedupes by `(project_id, fingerprint)`. Validated + size-capped + per-project unique-fingerprint cap (10K). CORS-open since the publishable `project_key` is the auth boundary for ingest only.
- `POST /api/projects` — globally rate-limited (100/hr). Returns `{ id, key, secret }` once on creation; the `secret` is the bearer token for every other `/api/*` call from that project's owner.
- `GET /api/projects/:id/errors` — bearer-authed (`Authorization: Bearer sk_live_…`); 403 if the secret doesn't own the project.
- `GET /api/errors/:id` — bearer-authed + cross-project scoped (403 if the bearer's project doesn't own the row).
- `PATCH /api/errors/:id` — bearer-authed + scoped. Drives `open → in_progress → awaiting_review → merged` (or `failed`).
- `DELETE /api/errors/:id` — bearer-authed + scoped (used by `d` in the overlay).

`~/.gg/projects.json` stores `{ name, path, secret }` per project. The CLI reads the secret on every management call. Re-run `ggcoder pixel install` to refresh the secret if a mapping is legacy (no `secret` field).

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
