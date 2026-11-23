# AGENTS.md

For Motion-mode work (videos, `ggcoder/src/motion-agent/`, `assets/motion/`),
read the Motion sections of `CLAUDE.md` first — that file is not auto-loaded.

## CI

CI lives in `.github/workflows/` and **must stay green**. `ci.yml` runs
build + typecheck + test + sidecar smoke on Linux/macOS/Windows — the Windows
leg is a blocking gate; never make it pass with `continue-on-error` or skipped
tests. Release automation (`release.yml`) triggers on `v*` tags; see
`.gg/commands/release.md`.

Never commit with `--no-verify`.

<!-- gg:init:start -->

GG Coder: a React+Tauri desktop app (`gg-app`) driving agents in a Node sidecar (`ggcoder`).

- User-facing work must work in `gg-app`; a CLI/Ink-only change is incomplete.
- Read `CONTEXT.md` before naming anything.
- `gg-app` reaches the engine over HTTP only. `gg-core` depends only on `gg-ai` and owns model and auth logic.
- Retired, never re-add to builds or releases: Realtime Voice, Boss, Editor, Premiere Panel, Eyes.

## Build and test

- Packages resolve each other through `dist`: run `pnpm build` before `pnpm check`, `pnpm test` or `pnpm --filter gg-app tauri dev`. After engine or Rust edits, rebuild and restart the app.
- One test file: `pnpm --filter <pkg> test <name>`. Adding `--` runs the whole suite, and the repo root has no vitest config.
- pnpm settings live in `pnpm-workspace.yaml`, not package.json. A new native dep must be added to `onlyBuiltDependencies` or its install script silently doesn't run.
- `patches/ink@6.8.0.patch` is not applied; ggcoder uses the fork `@kenkaiiii/ink`.
- After bumping `@anthropic-ai/claude-agent-sdk`, run `node .github/ci/claude-code-manifest.mjs`; CI fails on a stale manifest.
- Windows CI fails with EBUSY/EPERM when a test removes files a live child still holds: wait for exit first, or reuse `retryWindowsReplace` / `removeWhenReleased`.

## App and sidecar

- A new sidecar feature needs four parts: sidecar handler, Rust `#[tauri::command]` proxy that attaches the session, its `generate_handler!` entry, and a typed `agent.ts` wrapper that awaits `waitForReady()`.
- `~/.gg/gg-app.json` is written by Rust and the sidecar: change its schema on both sides, and merge your own key under the lock instead of overwriting the file.
- App-visible agent errors go through `broadcastError` in `app-sidecar.ts`, never a raw provider string.
- Passing `skills` to `AgentSession` disables skill discovery; Motion relies on this, so keep `assets/motion/skills` out of `assets/skills`.
- Rust: resolve `~/.gg` paths with `paths::home_dir()` and spawn children through `hide_console`; anything else breaks only on Windows.
- The packaged sidecar runs Node 24.22.3, not your dev Node. A new native, WASM, lazily loaded or spawned package must be externalized in `bundle-sidecar.mjs` (peers in `RUNTIME_PEERS`). Both fail only in installed builds.
- App logs are in `~/.gg/gg-app-sidecar.log`, not `debug.log`.

## Prompt cache

- The tool array is append-only: `tool_search` promotion must `push` onto `this.tools`; reordering invalidates the prefix cache.
- Mid-session env changes go in as an appended env-delta message (`core/env-delta.ts`); never re-render the cached system prompt.

## Release and packaging

- Every npm release also needs a desktop release: `pnpm --filter gg-app bump …`, a `gg-app/src/changelog.ts` entry, and the `v<version>` tag pushed last, on `origin/main`.
- Packaging: follow `gg-app/DISTRIBUTION.md`; `tauri build` does not stage Node or bundle the sidecar.

<!-- gg:init:end -->
