# @kenkaiiii/ggcoder

## 4.14.2

### Patch Changes

- Add prompt-enhancer sidecar capability with project-stack-aware terminology, and harden image attachments — malformed/unsupported images (e.g. a bad .ico) now degrade to a file note instead of failing the whole turn.
  - @kenkaiiii/gg-ai@4.14.2
  - @kenkaiiii/gg-agent@4.14.2
  - @kenkaiiii/gg-core@4.14.2

## 4.14.1

### Patch Changes

- Fix Anthropic 1h prompt-cache TTL by sending the extended-cache-ttl beta header on the streaming and prewarm paths, so `cacheRetention: "long"` no longer silently falls back to the 5-minute default.
  - @kenkaiiii/gg-ai@4.14.1
  - @kenkaiiii/gg-agent@4.14.1
  - @kenkaiiii/gg-core@4.14.1

## 4.14.0

### Minor Changes

- Add Sakana Fugu provider (Fugu, Fugu Ultra) with API-key login, high/xhigh reasoning, and a silent-reasoning stream-timeout extension.

### Patch Changes

- @kenkaiiii/gg-ai@4.14.0
- @kenkaiiii/gg-agent@4.14.0
- @kenkaiiii/gg-core@4.14.0

## 4.13.3

### Patch Changes

- Fix orphaned queued messages after an abort — drain the post-abort queue even when the run was interrupted, so a reprompt during async teardown isn't stranded.
  - @kenkaiiii/gg-ai@4.13.3
  - @kenkaiiii/gg-agent@4.13.3
  - @kenkaiiii/gg-core@4.13.3

## 4.13.2

### Patch Changes

- Add tool-call and error logging to the gg-app sidecar event bridge so fatal "invalid tool arguments" aborts leave a forensic trail in `~/.gg/gg-app-sidecar.log` (tool name, isError, result preview, and agent error events) instead of failing silently.
  - @kenkaiiii/gg-ai@4.13.2
  - @kenkaiiii/gg-agent@4.13.2
  - @kenkaiiii/gg-core@4.13.2

## 4.13.1

### Patch Changes

- Spawn dependency-backed stdio MCP servers (e.g. the default kencode-search)
  directly via `node <binScript>` instead of `npx -y <pkg>`, removing the ~100 MB
  `npm exec` wrapper process per MCP connection. Non-dependency / non-npx servers
  pass through unchanged.

  Also ships content-aware compression for bash/task_output truncation (preserves
  errors over blind tail slices) and the gg-app shared-daemon backend refactor.
  - @kenkaiiii/gg-ai@4.13.1
  - @kenkaiiii/gg-agent@4.13.1
  - @kenkaiiii/gg-core@4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.13.0
  - @kenkaiiii/gg-agent@4.13.0
  - @kenkaiiii/gg-core@4.13.0

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.2
  - @kenkaiiii/gg-agent@4.12.2
  - @kenkaiiii/gg-core@4.12.2

## 4.12.1

### Patch Changes

- Add performance benchmarks and optimize streaming, tool execution, and rendering pipeline
  - edit-diff: lazy normalization cache for fuzzy matching (5-7× faster on large files)
  - ls: parallel stat() via Promise.all (3.7-5.5× faster on large dirs)
  - StreamResult: backpressure with high/low-water marks to bound memory (10× reduction)
  - agent-loop: mixed-mode tool execution batches consecutive parallel-safe tools (2-10× faster)
  - agent-loop: per-tool timeout isolation via AbortSignal.any (prevents indefinite hangs)
  - agent-loop: gate diagnostic char-counting behind \_diagFn (eliminates per-turn overhead)
  - Markdown.tsx: block-level memoization via marked.lexer (only active block re-parses)
  - App.tsx: requestAnimationFrame-throttled appendAssistant (5-10× fewer re-renders)
  - benchmarks: full harness with before/after comparison tables (pnpm bench)

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.1
  - @kenkaiiii/gg-agent@4.12.1
  - @kenkaiiii/gg-core@4.12.1

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.0
  - @kenkaiiii/gg-agent@4.12.0
  - @kenkaiiii/gg-core@4.12.0

## 4.11.3

### Patch Changes

- 1c37b11: Persist model + thinking selection per-project (per window) across app restarts.

  Previously every window's sidecar wrote its model choice to a single shared
  `defaultModel`/`defaultProvider` slot in `~/.gg/settings.json`, so switching a
  model in one window clobbered the selection for all others — and on restart
  every window defaulted to the last-written model (or fell back to the provider
  default when that provider wasn't logged in). Model + thinking preferences are
  now stored keyed by project cwd in `~/.gg/gg-app.json` and read first on boot;
  the global slot is kept only as a fallback for never-opened projects.
  - @kenkaiiii/gg-ai@4.11.3
  - @kenkaiiii/gg-agent@4.11.3
  - @kenkaiiii/gg-core@4.11.3

## 4.11.2

### Patch Changes

- a2da1f8: Fix app subagents to inherit the active model at spawn time and render completed plan-step markers cleanly.
  - @kenkaiiii/gg-ai@4.11.2
  - @kenkaiiii/gg-agent@4.11.2
  - @kenkaiiii/gg-core@4.11.2

## 4.11.1

### Patch Changes

- Fix sub-agents hanging until timeout when spawned from a host whose `argv[1]`
  isn't the CLI entry (e.g. the desktop app's sidecar). The subagent tool now
  resolves `dist/cli.js` relative to its own module instead of trusting
  `process.argv[1]`, so sub-agents run and stream NDJSON correctly in every host.
  - @kenkaiiii/gg-ai@4.11.1
  - @kenkaiiii/gg-agent@4.11.1
  - @kenkaiiii/gg-core@4.11.1

## 4.11.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-core@4.11.0
  - @kenkaiiii/gg-ai@4.11.0
  - @kenkaiiii/gg-agent@4.11.0

## 4.10.2

### Patch Changes

- Fix duplicated transcript text and random whitespace in the terminal UI. The
  bottom-pinned shrink-backfill repaint reconstructed the on-screen transcript by
  re-serializing history (markdown re-render + wrapAnsi); when a row's visual
  width diverged from the terminal (wide emoji, bold/italic markdown, CJK) the
  rebuilt row count disagreed with ink's frame math, causing the repaint to
  overlap still-present rows (duplicate lines) or pad short with blank rows
  (injected whitespace). It fired on nearly every turn. The repaint is now
  disabled by default — ink falls back to a cursor-up pad-consume that never
  repaints content — eliminating both failure modes. Opt back in with
  `GG_SHRINK_BACKFILL=1`. Also adds `[scrollback]` debug logging across every
  native-scrollback write path.
  - @kenkaiiii/gg-ai@4.10.2
  - @kenkaiiii/gg-agent@4.10.2
  - @kenkaiiii/gg-core@4.10.2

## 4.10.1

### Patch Changes

- Fix `ggcoder continue` resuming the newest-created session instead of the one you last spoke in (now sorts by last-message activity), and fix inline-image scrollback corruption (base64 spew, duplicated lines, and misaligned images) by bailing the shrink-backfill text repaint when the transcript contains an image.
  - @kenkaiiii/gg-ai@4.10.1
  - @kenkaiiii/gg-agent@4.10.1
  - @kenkaiiii/gg-core@4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.10.0
  - @kenkaiiii/gg-agent@4.10.0
  - @kenkaiiii/gg-core@4.10.0

## 4.9.1

### Patch Changes

- Fix blank rows being reserved above short live content during streaming. The
  live-area height estimate over-counted non-text rows (slash-command info lines,
  tool/step markers), which falsely clamped the live area to its full budget and
  bottom-anchored the content — leaving a block of empty rows above it until the
  rows flushed to history. The estimate is now biased low; Ink's
  clipFrameToTerminalHeight remains the authoritative overflow backstop.
  - @kenkaiiii/gg-ai@4.9.1
  - @kenkaiiii/gg-agent@4.9.1
  - @kenkaiiii/gg-core@4.9.1

## 4.9.0

### Minor Changes

- Add LSP inline diagnostics to the edit/write tools. Successful edits now append
  compiler-grade error diagnostics (`Diagnostics in src/a.ts (informational …):
L42:7 Type 'string' is not assignable …`) so the model self-corrects type errors
  in the same turn. `typescript-language-server` + `typescript` ship bundled, so
  TS/JS diagnostics work for every user with zero setup; Python/Go/Rust/C servers
  are auto-detected from the project or PATH when present. Servers spawn lazily,
  are time-budgeted, and degrade silently — output is byte-identical when no server
  is available. Opt out with `"lspDiagnostics": false` in `~/.gg/settings.json`.

### Patch Changes

- @kenkaiiii/gg-ai@4.9.0
- @kenkaiiii/gg-agent@4.9.0
- @kenkaiiii/gg-core@4.9.0

## 4.8.7

### Patch Changes

- Fix the intermittent blank-row block appearing right before the agent's final response: the patched ink's bottom-anchor pad debt left over from a run-end frame shrink is now reclaimed when the anchor deactivates (ink fork 6.8.0-gg.2). Also: oversized flushed assistant prefixes leave live state immediately, and null-rendering items no longer inflate the live-area clamp estimate.
  - @kenkaiiii/gg-ai@4.8.7
  - @kenkaiiii/gg-agent@4.8.7
  - @kenkaiiii/gg-core@4.8.7

## 4.8.6

### Patch Changes

- Fix message vanish on slash-command submit: queueFlush now mirrors flushed rows into sessionStore.history synchronously so the patched ink's bottom-pinned repaint (menu close, resize) redraws from a current transcript. Also track /theme switches live so closure-level repaint serializers always use the active theme, not the startup theme.
  - @kenkaiiii/gg-ai@4.8.6
  - @kenkaiiii/gg-agent@4.8.6
  - @kenkaiiii/gg-core@4.8.6

## 4.8.5

### Patch Changes

- Ship the patched Ink rendering engine to npm installs. The TUI's footer-anchor and scrollback fixes live in a patched ink build that pnpm's patchedDependencies only applied inside the workspace — npm users silently got vanilla ink. ggcoder's ink dependency is now an npm alias to the published @kenkaiiii/ink fork, so every install (npm, pnpm, yarn, bun) gets the fixed renderer with no install scripts.
  - @kenkaiiii/gg-ai@4.8.5
  - @kenkaiiii/gg-agent@4.8.5
  - @kenkaiiii/gg-core@4.8.5

## 4.8.4

### Patch Changes

- Fix footer jumps and scrollback whitespace/duplication in the scrollback-mode TUI. The patched Ink now folds transcript flushes atomically into frame writes (insertBeforeFrame), anchors the frame bottom with reclaimable pad debt while the agent runs, clips frames to terminal height, and repaints in place (cursor home + eraseDown) for bottom-pinned idle height changes like the slash-command menu — so the footer stays pinned, responses have no phantom gaps, and scrollback receives no duplicate banner/prompt copies.
  - @kenkaiiii/gg-ai@4.8.4
  - @kenkaiiii/gg-agent@4.8.4
  - @kenkaiiii/gg-core@4.8.4

## 4.8.3

### Patch Changes

- Fix oversized pinned assistant items being cut off in the live area: flush tall finalized items (cumulative over the pinned set) to scrollback, and keep the height-clamp slice from starting on a blank line so the ⏺ prefix stays aligned.
  - @kenkaiiii/gg-ai@4.8.3
  - @kenkaiiii/gg-agent@4.8.3
  - @kenkaiiii/gg-core@4.8.3

## 4.8.2

### Patch Changes

- Fix TUI scrollback corruption from streaming markdown tables and inline images: table-aware live-region row estimation, pending-table height clamping and partial-row hold-back in the markdown renderer, and fixed-height inline image blocks so Ink's live-frame erase math stays in sync (no more orphaned ⏺ rows).
  - @kenkaiiii/gg-ai@4.8.2
  - @kenkaiiii/gg-agent@4.8.2
  - @kenkaiiii/gg-core@4.8.2

## 4.8.1

### Patch Changes

- Fix ENOSPC crash when session transcript writes fail (disk full) — persistence now fails soft with a one-time warning instead of killing the live session. Add automatic session transcript pruning via new `sessionRetentionDays` setting (default 30 days, 0 disables).
  - @kenkaiiii/gg-ai@4.8.1
  - @kenkaiiii/gg-agent@4.8.1
  - @kenkaiiii/gg-core@4.8.1

## 4.8.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.8.0
  - @kenkaiiii/gg-core@4.8.0
  - @kenkaiiii/gg-agent@4.8.0

## 4.7.0

### Minor Changes

- Add `task_send` tool for interactive control of background processes. Background processes started with `run_in_background` now spawn with a stdin pipe, and the agent can answer prompts, drive REPLs, and feed scaffolders via `task_send` (with optional Enter/EOF), pairing with the existing `task_output`/`task_stop` tools.

### Patch Changes

- @kenkaiiii/gg-ai@4.7.0
- @kenkaiiii/gg-agent@4.7.0
- @kenkaiiii/gg-core@4.7.0

## 4.6.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.3
  - @kenkaiiii/gg-agent@4.6.3
  - @kenkaiiii/gg-core@4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.
- Updated dependencies
  - @kenkaiiii/gg-core@4.6.2
  - @kenkaiiii/gg-ai@4.6.2
  - @kenkaiiii/gg-agent@4.6.2

## 4.6.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1
  - @kenkaiiii/gg-agent@4.6.1
  - @kenkaiiii/gg-core@4.6.1

## 4.6.0

### Minor Changes

- Add Xiaomi MiMo-V2.5 models with native video analysis. The text-only
  `mimo-v2.5-pro` is now the Xiaomi default, and the omnimodal `mimo-v2.5`
  supports native image and video understanding. Video read through the read
  tool is now delivered to MiMo (and other non-Moonshot OpenAI-compatible video
  models) in a follow-up user message as inline base64 `video_url`, the shape
  the API accepts — fixing the fallback where the model resorted to ffmpeg frame
  extraction. The read tool is also rebuilt on model switch so its video
  capability tracks the active model.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0
  - @kenkaiiii/gg-agent@4.6.0
  - @kenkaiiii/gg-core@4.6.0

## 4.5.0

### Minor Changes

- Add native video analysis for Kimi K2.6, Gemini, and MiniMax. Attached and read videos are sent to the model in its required format (Kimi file-service upload, Gemini inlineData, MiniMax base64), with per-model size caps and automatic ffmpeg compression for oversized clips. Non-video models now show a clean "this model can't analyze video" message instead of an opaque provider error, and Kimi OAuth login was fixed to pass the coding-endpoint client identity.

### Patch Changes

- @kenkaiiii/gg-ai@4.5.0
- @kenkaiiii/gg-agent@4.5.0
- @kenkaiiii/gg-core@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-core@4.4.0
  - @kenkaiiii/gg-ai@4.4.0
  - @kenkaiiii/gg-agent@4.4.0
