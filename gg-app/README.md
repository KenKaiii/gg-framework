# GG Coder, the desktop app

The Tauri 2 desktop app. React 19 + Vite webview over the full GG Coder agent. This is the
thing we ship. The CLI is the same engine without the face.

**Download it:** [latest release](https://github.com/KenKaiii/gg-framework/releases/latest)
(macOS Apple Silicon `.dmg`, Windows `.exe`). Feature tour is in the
[root README](../README.md).

## Develop

```bash
pnpm install                              # from the repo root
pnpm --filter @kenkaiiii/ggcoder build    # build the sidecar first
pnpm --filter gg-app tauri dev
```

Webview edits hot-reload through Vite. **Restart the app** after Rust or sidecar changes,
and rebuild `@kenkaiiii/ggcoder` any time you touch `packages/ggcoder/src/app-sidecar.ts`.

```bash
pnpm --filter gg-app check    # tsc --noEmit
pnpm --filter gg-app test     # vitest
pnpm --filter gg-app lint
```

## Project colour tags

Click the colour button beside an open project's name to choose a personal colour.
**Automatic** restores the generated accent; **None** removes the decoration without
hiding the button. **Show header stripe** adds an app-wide stripe and is off by default.
None suppresses the stripe for that project.

Choices belong to the full project folder path, so same-named folders stay separate.
Native windows share preferences in `~/.gg/gg-app-project-colours.json`, independently
of other app settings. These preferences are personal, survive restarts, and are not
written into the project or shared with teammates. Browser previews use local storage
instead; they do not share the native app's preferences.

## Architecture

Each window runs its **own** Node agent sidecar pointed at its **own** project folder.
Separate agents, separate projects, fully isolated. Multiple windows means multiple
projects open at once.

```
React webview ──invoke()──▶ Rust commands ──HTTP──▶ Node sidecar (AgentSession)
     ▲                          │                         │
     └────── emit_to(window) ◀──┴──── SSE /events ◀────────┘
```

- **`src-tauri/src/lib.rs`** is the Rust shell. It owns a sidecar registry keyed by window
  label, every command resolves the calling window's port, and SSE frames go out through
  `emit_to` so windows never see each other's events.
- **`src/agent.ts`** is the only bridge to Rust. All IPC wrappers live here. The webview
  never `fetch`es the sidecar directly, since mixed content is blocked on the `tauri://`
  origin.
- **`packages/ggcoder/src/app-sidecar.ts`** is the HTTP + SSE seam over `AgentSession`.

New IPC means a Rust `#[tauri::command]` proxying the sidecar, registered in
`invoke_handler!`, plus a typed wrapper in `agent.ts`.

## Rules

- The agent spine (gg-ai → gg-agent → gg-core → `AgentSession`) gets reused **verbatim**.
  Never fork agent logic into the app.
- App-only stuff (windows, IPC, picker, settings) lives here. Anything provider- or
  agent-coupled stays in its package and the app just consumes it.
- One component per file, matching the terminal UI's look.

## README screenshots

`scripts/capture-screenshots.mjs` regenerates `docs/screenshots/*.png` for the root README.

```bash
pnpm --filter gg-app dev                  # terminal 1
node gg-app/scripts/capture-screenshots.mjs
```

It drives the webview in headless Chromium with a **fake `window.__TAURI_INTERNALS__`**, so
every screen renders from the fake demo data at the top of that script. No real sessions,
project paths, chat content, tokens or account names can end up in a committed image. Keep
it that way when you add a shot, and only grab screens worth showing, not a full tour.

`00-many-windows.png` (the hero) is built from one browser context per window, each with
its own project, model and git state, then composed into a grid by a throwaway page of
`<img>` tags so the script keeps its single dependency. Add or remove entries in
`quadrants` and set `GRID_COLS` to reshape it. The tiles get inlined as data URLs, since a
`file://` image is blocked on the `about:blank` origin `setContent` runs on.

Runs that need a live UI state the mock can't click into (Autopilot's toggle is a
controlled input) set `responses: { agent_state: … }` on the shot instead.

The footer model picker is missing on purpose. On macOS it's a native `<select>` popup,
which is an OS-level window Chromium can't capture.

## Shipping

Packaging (bundled per-platform Node runtime, single-file esbuild sidecar, externals,
signing/notarization) is in [DISTRIBUTION.md](DISTRIBUTION.md). Releases fire from a `v*`
git tag. Version bumps go through `pnpm --filter gg-app bump`, never by hand.

Debug log: `~/.gg/gg-app-sidecar.log`. Each window's sidecar appends to it, tagged with its
own `sid=`.
