# GG Coder, the desktop app

The Tauri 2 desktop app. React 19 + Vite webview over the full GG Coder agent. This is the
upstream app imported into this fork, not Kleio Desktop. The CLI shares its engine.
This local integration is uncommitted and unpublished; the upstream-branded app
release workflow is disabled in the fork by a repository guard.

**Download it:** [latest release](https://github.com/KenKaiii/gg-framework/releases/latest)
(macOS Apple Silicon `.dmg`, Windows `.exe`). Feature tour is in the
[root README](../README.md).

## Develop

```bash
pnpm install                              # from the repo root
pnpm --filter @kleio/coder build    # build the sidecar first
pnpm --filter gg-app tauri dev
```

Webview edits hot-reload through Vite. **Restart the app** after Rust or sidecar changes,
and rebuild `@kleio/coder` any time you touch `packages/ggcoder/src/app-sidecar.ts`.
Its route modules in `app-sidecar/` need the same rebuild.

```bash
pnpm --filter gg-app check    # tsc --noEmit
pnpm --filter gg-app test     # vitest
pnpm --filter gg-app lint
```

## Architecture

Each window runs its **own** Node agent sidecar pointed at its **own** project folder.
Separate agents, separate projects, fully isolated. Multiple windows means multiple
projects open at once.

```
React webview ──invoke()──▶ Rust commands ──HTTP──▶ Node sidecar (AgentSession)
     ▲                          │                         │
     └────── emit_to(window) ◀──┴──── SSE /events ◀────────┘
```

- **`src-tauri/src/`** is the Rust shell. `lib.rs` starts the app and registers the
  commands in `commands/`. It owns a sidecar registry keyed by window label (`state.rs`,
  `daemon.rs`), every command resolves the calling window's port, and SSE frames go out
  through `emit_to` (`events.rs`) so windows never see each other's events.
- **`src/agent.ts`** is the only bridge to Rust. All IPC wrappers live here. The webview
  never `fetch`es the sidecar directly, since mixed content is blocked on the `tauri://`
  origin.
- **`packages/ggcoder/src/app-sidecar.ts`** is the HTTP + SSE seam over `AgentSession`.
  Its routes live in `app-sidecar/`.

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

## Remote outputs check (manual)

`scripts/e2e-remote-outputs.mjs` checks that files a Chat or Code session writes on the
Mac mini open on a paired iPhone. It isn't part of CI, because it needs the dev server and
a Playwright Chromium.

```bash
pnpm --filter @kleio/host build
pnpm --filter gg-app dev                  # terminal 1
node gg-app/scripts/e2e-remote-outputs.mjs
```

- **Real:** the `kleio-host` CLI from `packages/kleio-host/dist`. It runs `init` and
  `serve` in a temp folder, with the API and the preview origin on free loopback ports. The
  phone is paired through the real offer and redeem flow. The script also writes a real PDF
  and a two-file site.
- **Faked:** the Tauri shell. The webview runs at the iPhone layout (390×844, iPhone user
  agent). Its file, site and API commands are bridged to real HTTP calls that carry the
  phone's token.
- **Checks:**
  - The cards show the host's size and type.
  - The opened bytes are the PDF on disk.
  - The site's stylesheet loads through the preview origin.
  - The site page can't read the API, has no storage or cookies, and runs on an opaque
    origin.
  - The host logs never contain the preview token.
- **Output:** screenshots go to `.gg/screenshots/remote-outputs/`, which is gitignored. On
  a failure, the script saves `failure.png` there.

Quick Look and Safari can't run in this check. Headless Chromium has no PDF viewer either.
To cover them, run this smoke test on the simulator against the real Mac mini:

1. Run `pnpm ios:sim` and pair the simulator with the mini.
2. In Chat, ask for a PDF and a small site with an `index.html` and a stylesheet.
3. Tap **Open** on the PDF card. Quick Look should show the PDF, with Share and Save to
   Files.
4. Tap **Open site**. Safari should show the styled page.
5. Capture each screen with `xcrun simctl io booted screenshot <file>.png`.
6. On the mini, `tailscale serve status` should list both 8443 and 8444.

## Shipping

Packaging (bundled per-platform Node runtime, single-file esbuild sidecar, externals,
signing/notarization) is in [DISTRIBUTION.md](DISTRIBUTION.md). Releases fire from a `v*`
git tag. Version bumps go through `pnpm --filter gg-app bump`, never by hand.

Debug log: `~/.gg/gg-app-sidecar.log`. Each window's sidecar appends to it, tagged with its
own `sid=`.
