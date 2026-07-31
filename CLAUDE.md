# gg-framework

A pnpm monorepo containing reusable LLM/agent libraries, coding and media-agent CLIs, a Tauri coding-agent desktop app, and an Electron local chat UI.

## Workspace map

Workspace membership is defined by `pnpm-workspace.yaml`: `packages/*`, `gg-app`, `Matey`, and `experiments/*`.

- `packages/gg-ai` (`@kenkaiiii/gg-ai`) — provider transports, streaming APIs/types, message transforms, and provider errors.
- `packages/gg-agent` (`@kenkaiiii/gg-agent`) — provider-independent agent loop, tool execution, and agent events.
- `packages/gg-core` (`@kenkaiiii/gg-core`) — UI-free model registry, paths, auth/OAuth, usage, logging, Telegram, transcription, and updates.
- `packages/ggcoder` (`@kenkaiiii/ggcoder`) — coding-agent library and `ggcoder` CLI, including tools, sessions, MCP/LSP support, Ink UI, Agent Home modes, and the internal app sidecar.
- `packages/gg-boss` (`@kenkaiiii/gg-boss`) — multi-project orchestration library and `ggboss` CLI.
- `packages/gg-editor` (`@kenkaiiii/gg-editor`) — Resolve/Premiere video-agent library and `ggeditor` CLI.
- `packages/gg-editor-premiere-panel` — Premiere UXP/CEP panels and installer CLI.
- `packages/gg-voice` — realtime voice providers and ggcoder/ggboss bridges.
- `packages/ggcoder-eyes` — perception-probe library and CLI.
- `gg-app` — private React/Vite frontend with a Tauri 2 Rust shell.
- `Matey` — private Electron/Vite local chat UI.
- `experiments/prompt-bench`, `benchmarks/`, and `bench/` — prompt and runtime benchmark harnesses; only `experiments/*` is a workspace glob.

## Package boundaries

- `gg-agent` and `gg-core` depend on `gg-ai`; `ggcoder` depends on all three.
- `gg-boss` layers on the framework packages; `gg-editor` layers on `gg-ai`, `gg-agent`, and `ggcoder`; `gg-voice` layers on `gg-ai` and `gg-agent`.
- Provider transport and raw provider-error behavior belongs in `gg-ai`.
- Shared model/auth/path/logging behavior belongs in UI-free `gg-core`; ggcoder exposes compatibility entry points for selected model/auth APIs.
- App presentation, windows, and native IPC belong in `gg-app`; reusable agent behavior belongs in framework packages.

## gg-app architecture

- Sidecar-backed agent operations flow `React → Tauri invoke → Rust localhost proxy → shared Node daemon → logical AgentSession`; native window, updater, permissions, file, and app-setting operations terminate in Rust.
- One Node daemon serves isolated logical sessions for all windows and panes. Rust forwards sidecar SSE as window-scoped Tauri events.
- `gg-app/src/agent.ts` is the typed webview IPC boundary; Rust commands are registered in `gg-app/src-tauri/src/lib.rs`.
- The webview does not contact the localhost sidecar directly from the `tauri://` origin.
- The sidecar source is `packages/ggcoder/src/app-sidecar.ts`. `gg-app/scripts/bundle-sidecar.mjs` requires `packages/ggcoder/dist/app-sidecar.js` and writes `gg-app/src-tauri/sidecar/app-sidecar.mjs` plus external runtime dependencies.
- App project preferences live in `~/.gg/gg-app.json`; shared fallback/current model and thinking settings also use `~/.gg/settings.json`.
- `ggcoder` logs use `~/.gg/debug.log`; `ggeditor` uses `~/.gg/ggeditor.log`; the app daemon uses `~/.gg/gg-app-sidecar.log`.

## Commands

CI pins Node 22 and pnpm 10; the repository itself does not declare a `packageManager` field. CI's framework matrix targets `gg-ai`, `gg-agent`, `ggcoder`, and `gg-boss`; its app matrix separately stages/smoke-tests the sidecar and runs app and Rust tests.

```bash
pnpm install --frozen-lockfile
pnpm build                    # recursive workspace build scripts
pnpm check                    # recursive workspace check scripts
pnpm test                     # generated-output audit tests, then recursive workspace tests
pnpm lint                     # package sources, Matey, and gg-app
pnpm format:check             # package sources, Matey, and gg-app
```

Desktop development requires the sidecar build first:

```bash
pnpm --filter @kenkaiiii/ggcoder... build
pnpm --filter gg-app tauri dev
```

Generated-output inspectors are `pnpm audit:generated:web`, `audit:generated:tauri`, `audit:generated:sidecar-deps`, `audit:generated:tauri-schemas`, `audit:generated:cache`, and `audit:generated:packages`.

## Generated and release workflows

- `packages/gg-editor/src/skills.ts` is generated from `packages/gg-editor/src/skills/*.md` by the editor build, check, and test scripts; edit the Markdown sources instead.
- `gg-app/src-tauri/binaries/`, `sidecar/`, `target/`, and `gen/schemas/` are staged/generated outputs.
- The Changesets fixed-version group is `gg-ai`, `gg-agent`, `gg-core`, `ggcoder`, and `gg-boss`; there is no automated npm publish workflow in this repository.
- Use `pnpm --filter gg-app bump <patch|minor|major|x.y.z>` to update the desktop version in `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock` together.
- A pushed `v*` tag runs `.github/workflows/release.yml` for macOS arm64 and Windows. The workflow builds `gg-ai`, `gg-agent`, and `ggcoder`, stages Node, bundles and smoke-tests the sidecar, runs locked Rust tests, and publishes a non-draft GitHub release with updater JSON.
