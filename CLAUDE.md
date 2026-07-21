# gg-framework

A modular TypeScript framework for building LLM-powered apps — from raw streaming to full coding agent.

## npm Packages

| Package | npm Name | Description |
|---|---|---|
| `packages/gg-ai` | `@kenkaiiii/gg-ai` | Unified LLM streaming API |
| `packages/gg-agent` | `@kenkaiiii/gg-agent` | Agent loop with tool execution |
| `packages/gg-core` | `@kenkaiiii/gg-core` | Provider-agnostic, UI-free shared foundation: model registry, thinking levels, app paths, OAuth + auth storage, file-writer logger core, telegram + voice transcription, self-updater |
| `packages/ggcoder` | `@kenkaiiii/ggcoder` | CLI coding agent + `app-sidecar` (the gg-app backend) |
| `gg-app` | (private — Tauri desktop app) | **The desktop app — primary product we ship to users** |

**Install CLI**: `npm i -g @kenkaiiii/ggcoder` · **Desktop app**: `cd gg-app && pnpm tauri dev`

## Models & Multimodal

The MiniMax provider defaults to **MiniMax M3** (1M context, image + video). Video-capable
models are Gemini 3.x, Kimi K3/K2.7 Code, MiniMax M3, and Xiaomi **MiMo-V2.5** (the omnimodal model;
the coding-focused MiMo-V2.5-Pro is text-only) — these accept native video blocks (gg-ai's
`VideoContent`). MiMo-V2.5 rides the OpenAI-compatible transport: video/image are sent as
base64 data URLs (`video_url`/`image_url`), and its base64 payload cap is 50 MB (so the
registry's `maxVideoBytes` is ~36 MB raw to stay under it after base64 inflation). Video
attachments are supported in the chat input (drag, paste, or type a path);
for non-video models the video is saved to a temp file and the model is told to inspect it with
ffmpeg/its tools (mirrors the GLM image fallback). The `supportsVideo` capability flag lives in
`packages/ggcoder/src/core/model-registry.ts`.

## gg-app — Desktop App (primary product)

`gg-app/` is the **Tauri 2 desktop app** — a React 19 + Vite webview shell over the full
ggcoder agent. This is the main product we ship to users now; the CLI is the engine, the
app is the face. Reuse the agent spine unchanged — never fork agent logic into the app.

**Run**: `cd gg-app && pnpm tauri dev` (rebuild `@kenkaiiii/ggcoder` first if you touched the
sidecar: `pnpm --filter @kenkaiiii/ggcoder build`). Restart the app after Rust/sidecar
changes; pure webview edits hot-reload via Vite HMR.

### Architecture: per-window sidecar

Each window runs its **own** Node agent sidecar (`packages/ggcoder/src/app-sidecar.ts`) bound
to its **own project cwd** — separate agents, separate projects, fully isolated. This is the
core model: multiple windows = multiple projects open at once (one could be gg-coder, another
Claude Code, another Codex).

```
React webview ──invoke()──▶ Rust commands ──HTTP──▶ Node sidecar (AgentSession)
     ▲                          │                         │
     └────── emit_to(window) ◀──┴──── SSE /events ◀────────┘
```

- **`gg-app/src-tauri/src/lib.rs`** — Rust shell. Owns a `Sidecars` registry keyed by window
  label (`main`, `project-1`, …). Each command (`agent_prompt`, `agent_state`, `select_project`,
  …) resolves the calling window's sidecar port via `port_for(&webview)`. SSE frames are
  re-emitted with `emit_to(webview_window(label))` so **windows never see each other's events**.
  Window background is painted `#111317` before first frame (no white flash). New windows are
  tiled like macOS fill&arrange (`setup_windows` → `arrange_windows`, 2-up halves / 4-up quads).
- **`gg-app/src/agent.ts`** — the ONLY bridge to Rust. Listens on the **current** webview target
  (`getCurrentWebviewWindow().listen`) — a global `listen` would miss window-scoped events. All
  IPC wrappers (`sendPrompt`, `listProjects`, `selectProject`, `createProject`, …) live here.
- **`app-sidecar.ts`** — HTTP+SSE seam over `AgentSession`. Endpoints: `/state`, `/events`,
  `/prompt`, `/cancel`, `/thinking`, `/model(s)`, `/commands`, `/projects`, `/sessions`,
  `/settings`, `/create-project`. Slash-command expansion is delegated to `AgentSession.prompt()`
  (single source of truth — built-in + `.gg/commands` custom). Env: `GG_APP_CWD` (project root),
  `GG_APP_PORT` (0 = ephemeral), `GG_APP_SESSION_ID` (resume a session file).

### UI components (`gg-app/src/`)

One component per file; mirror the TUI's look. Reusable primitives: `Modal`, `BackButton`
(chevron), `Badge` + `sourceStyle` (gg-coder=blue, Claude Code=clay `#d97757`, Codex=green
`#10a37f`). Key screens/controls: `ProjectPicker` (shown per window on load — lists discovered
projects + their recent 5 sessions, New Project, Settings), `NewProjectModal`,
`SettingsModal` (projects-root folder), `ModelMenu`, `SlashMenu`, `LiveToolPanel`,
`ActivityBar` (spinner + thinking timer + tokens), `PlanModeLogo` (amber ASCII banner),
`WindowLayoutButton` (2/4 tiling), `Markdown`. Theme mirrors `ui/theme/dark.json` in `theme.ts`.

### Error display (gg-app)

gg-app never shows a raw provider string (e.g. `400 {"code":"400",...}`) — every error is run
through gg-ai's `formatError` server-side before it reaches the webview, mirroring the TUI's
headline/message/guidance split ("is this me or them", and — for usage-limit stops — when it
resets).

- **Root cause of the raw-JSON blob**: the OpenAI and Anthropic SDKs both build `err.message` by
  `JSON.stringify`-ing the whole error body whenever the provider's response has no usable string
  `message` (e.g. Xiaomi MiMo returning `{"code":"400","message":"","param":"","type":""}`) — so
  the blob was baked into `err.message` before it ever reached gg-ai's formatting layer.
  `isRawJsonErrorEcho` / `emptyProviderErrorMessage` in `packages/gg-ai/src/errors.ts` detect that
  shape and swap in a clean "provider returned an empty error response" fallback; both provider
  `toError()`s (`providers/openai.ts`, `providers/anthropic.ts`) apply it before constructing the
  `ProviderError`. The raw body is never lost — the original thrown error is kept on `cause` for
  any in-process debugging/rethrow, even though the log line and the UI only ever show the clean
  fallback.

- **`app-sidecar.ts`** has one chokepoint, `broadcastError(type, logLabel, err)`, used by every
  catch site that used to hand-roll `{ message: err.message }` (the session/Ken event-bus `error`
  handlers, `runAgent`'s catch, Ken's turn runner). It calls `formatError`, logs the full
  structured detail to `gg-app-sidecar.log`, and broadcasts `{ headline, message?, guidance,
  provider?, statusCode?, resetsAt? }` under the `"error"` / `"ken_error"` SSE type. Add new
  error catch sites through this helper — never broadcast a bare message again.
- **Webview**: the `Item` union's `error` variant carries `headline` / `message` / `guidance`
  (a legacy `text` fallback remains for any older flat-string frame). `useAgentEvents.ts` and
  `useKenMentor.ts` map the SSE payload onto it; `TranscriptRow` in `App.tsx` renders headline
  (bold, error color) + message + guidance as stacked dim sub-lines — no new CSS, reuses the
  existing `.line.error` row and `theme.error`/`theme.textDim` tokens.

### Project discovery + app settings

- **Discovery** lives in `packages/ggcoder/src/core/project-discovery.ts` (one home — gg-boss
  re-exports it). `discoverProjects()` scans ggcoder + Claude Code + Codex session stores;
  `listRecentSessions(cwd)` fast-paths the newest 5 ggcoder sessions (mtime sort → single-pass
  parse, no full-store scan). Decoded ggcoder paths are `path.resolve`d so traversal segments
  don't surface as a stray `..` project.
- **App settings** are app-specific in `~/.gg/gg-app.json` (separate from the CLI's
  `~/.gg/settings.json`). Currently `projectsRoot` — the folder new projects are created inside
  (default `~/gg-projects`). New projects: name validated to `^[a-z0-9]+(?:-[a-z0-9]+)*$`, folder
  created under the root, then the window re-points at it via `select_project`.

### Rules

- The agent spine (gg-ai → gg-agent → gg-core → ggcoder `AgentSession`) is reused **verbatim**.
  App-only concerns (windows, IPC, picker, settings) live in `gg-app/`; anything provider- or
  agent-coupled stays in its existing home and the app consumes it.
- New IPC = add a Rust `#[tauri::command]` that proxies the sidecar + register it in
  `invoke_handler!`, expose a typed wrapper in `agent.ts`, never `fetch` the sidecar from the
  webview (mixed-content blocked on the `tauri://` origin).
- Webview calls that hit the sidecar must `await waitForReady()` first (startup/respawn race).

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

## Releasing

There are **two independent release tracks**. The `/release` command (project-local,
lives in `.gg/commands/release.md`) orchestrates both in the correct order — prefer it
over running the steps by hand.

- **Track A — npm framework packages** (`@kenkaiiii/gg-ai`, `gg-agent`, `gg-core`,
  `ggcoder`, `gg-boss`, + dependents) via **Changesets**. This is the CLI engine.
- **Track B — gg-app desktop** (`gg-app`, the `0.1.x` line, `private: true`, never on
  npm). Released by pushing a `v*` git tag, which fires
  `.github/workflows/release.yml` to build/sign/notarize installers and publish a
  **non-draft** GitHub release + updater `latest.json`.

### How gg-app consumes the packages

gg-app does **not** depend on the published npm versions. Its CI runs
`pnpm install --frozen-lockfile` (resolving `workspace:*` locally), builds gg-ai →
gg-agent → ggcoder **from source**, then bundles `packages/ggcoder/dist/app-sidecar.js`
into the Tauri app. So a desktop release ships whatever is in the workspace at tag time —
npm need not be published first for the app to build. Still, publish npm first (Track A
then Track B) so the shipped CLI and app stay in lockstep.

### Track A — npm packages (Changesets)

Manual multi-package version bumping is gone — do **not** hand-edit package `version`
fields. The framework spine — `@kenkaiiii/gg-ai`, `@kenkaiiii/gg-agent`,
`@kenkaiiii/gg-core`, `@kenkaiiii/ggcoder`, `@kenkaiiii/gg-boss` — is a **fixed group**
in `.changeset/config.json`: a changeset touching any one bumps them all to the same
version together (this is what kept drifting before). Dependents like gg-editor /
gg-voice get an automatic patch bump.

```bash
pnpm changeset            # describe the change; pick bump level (patch/minor/major)
pnpm changeset version    # apply bumps + update internal deps + write changelogs
pnpm build                # rebuild with the new versions
git commit -am "Version packages"   # COMMIT BEFORE PUBLISH — publish tags HEAD
pnpm changeset publish    # publishes in topological order + creates git tags
git push --follow-tags    # push the version commit + the new tags
```

Commit the version bump **before** `pnpm changeset publish` — publish creates git tags
at `HEAD`, so an uncommitted bump tags the wrong commit and publishes from a dirty tree.
`pnpm changeset status` shows the pending release graph at any time.

### Track B — gg-app desktop (tag-triggered)

The desktop version lives in **four files that must stay in lockstep**:
`gg-app/package.json`, `gg-app/src-tauri/tauri.conf.json`, `gg-app/src-tauri/Cargo.toml`,
and `gg-app/src-tauri/Cargo.lock`. **Never hand-edit them** — use the helper, which
bumps all four at once and prints the new version:

```bash
pnpm --filter gg-app bump <patch|minor|major|x.y.z>   # scripts/bump-version.mjs
git add gg-app/package.json gg-app/src-tauri/tauri.conf.json \
        gg-app/src-tauri/Cargo.toml gg-app/src-tauri/Cargo.lock
git commit -m "Update gg-app to v<NEW>"
git push
git tag v<NEW> && git push origin v<NEW>   # fires release.yml
gh run list --workflow=release.yml --limit 1   # confirm the build kicked off
```

The workflow has `releaseDraft: false` — it publishes a **live, non-draft** release
automatically when the build finishes; there is no manual publish step. It builds for
macOS (arm64) + Windows only (Linux/Intel-mac legs are intentionally omitted — see the
comments in `release.yml`).

### npm auth (Track A)

- npm granular access token must be set: `npm set //registry.npmjs.org/:_authToken=<token>`
- `access: public` is set in `.changeset/config.json` (and each package's `publishConfig`), required for scoped packages.
- `workspace:*` references resolve to real versions at publish time because changesets publishes via pnpm.

### Verify a published npm release (Track A)

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


## Key Patterns

- **StreamResult/AgentStream**: dual-nature objects — async iterable (`for await`) + thenable (`await`)
- **EventStream**: push-based async iterable in `@kenkaiiii/gg-ai/utils/event-stream.ts`
- **agentLoop**: pure async generator — call LLM, yield deltas, execute tools, loop on tool_use
- **OAuth-only auth**: no API keys, PKCE OAuth flows, tokens in `~/.gg/auth.json`
- **Zod schemas**: tool parameters defined with Zod, converted to JSON Schema at provider boundary
- **Debug logging**: the CLI and the app sidecar log to **different files** — always check the right one.
  - CLI (`ggcoder` in a terminal): `~/.gg/debug.log` — truncated on each CLI restart.
  - **gg-app (desktop app) — the one we actually use now**: `~/.gg/gg-app-sidecar.log`. Each window's
    sidecar process appends here (not truncated per-window), tagged with its own `sid=`. Same format:
    timestamped, category-tagged (`[app-sidecar]`, `[tool]`, `[cache]`, `[compaction]`, `[subagent]`,
    `[lsp]`, `[mcp]`, `[auth]`, …). Agent/provider errors land as `[ERROR] [app-sidecar] run failed
    message=…` or `[ERROR] [app-sidecar] agent error message=…`. Both files share the core file-writer
    logger (`openLog`/`log` in `@kenkaiiii/gg-core`, rotated at 10MB to a single `.1` generation);
    ggcoder's thin wrapper is `src/core/logger.ts` (`initLogger`, `attachToEventBus`). The sidecar wires
    its own bus listeners directly in `app-sidecar.ts` instead of calling `attachToEventBus`.

## LSP Inline Edit Diagnostics

Successful `edit`/`write` tool results get compiler-grade error diagnostics appended
(`Diagnostics in src/a.ts (informational …): L42:7 Type 'string' is not assignable …`)
so the model self-corrects type errors in the same turn it creates them. Code lives in
`packages/ggcoder/src/core/lsp/` (`jsonrpc.ts` zero-dep Content-Length framing,
`servers.ts` catalog + root detection, `client.ts` document sync + push/pull race,
`manager.ts` lazy pool, `format.ts` rendering).

Hard rules:

- **TS/JS works for every user out of the box.** `typescript-language-server` + `typescript`
  ship as ggcoder dependencies (~26MB unpacked) — no postinstall, no downloads, no runtime
  `npx -y`. Resolution order: project's `node_modules` (walking up, its own TS version wins) →
  ggcoder's bundled copy → PATH. Node-based servers spawn via `process.execPath` + the real
  bin script (never `.bin` shims, which need `node` on PATH). Other servers
  (`pyright-langserver`, `gopls`, `rust-analyzer`, `clangd`) resolve from project/PATH only —
  they ship with their language toolchains.
- **Silent graceful degradation.** Missing/crashed/slow server ⇒ tool output is byte-identical
  to before (debug-log only). A failed spawn marks `(server, root)` broken for the session.
- **Lazy + budgeted.** Nothing spawns until the first edit of a matching file; diagnostics are
  capped at 3s warm / 8s first-touch — overruns return nothing and leave the server warm.
- **Errors only, capped at 5**, framed as informational so multi-file sequences aren't derailed.
- Opt out with `"lspDiagnostics": false` in `~/.gg/settings.json`. Exit handlers call
  `lspManager.shutdownAll()` alongside `processManager`.
- Tests: `src/core/lsp/*.test.ts` run against a fake stdio server fixture
  (`src/tools/__fixtures__/fake-lsp-server.mjs`) — CI never needs real language servers.
  Opt-in real-tsserver test: `GG_LSP_INTEGRATION=1 npx vitest run src/core/lsp/integration.test.ts`.

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
- **WebSocket transport** is parsed but rejected (no WS client today).
- **Env var expansion** (`${VAR}`) in `.mcp.json` is NOT expanded in v1 — values pass through literally.

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
