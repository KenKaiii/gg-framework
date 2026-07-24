# @kenkaiiii/gg-ai

## 5.23.0

### Minor Changes

- a6a78c2: Add Claude Opus 5 (`claude-opus-5`, released 2026-07-24) to the model registry — 1M context, 128k output, image input, adaptive thinking with the full effort ladder (low→max, xhigh included), $5/$25 MTok (same price as Opus 4.8). gg-ai treats it as an adaptive-thinking model (no interleaved-thinking beta, xhigh passes through), footers short-name it "Opus" (Opus 4.8 becomes "Opus 4.8"), login/provider descriptions mention it, and gg-boss's default boss model moves from `claude-opus-4-8` to `claude-opus-5`. Opus 4.8 stays registered as a legacy option.

## 5.22.6

## 5.22.5

## 5.22.4

## 5.22.3

## 5.22.2

## 5.22.1

### Patch Changes

- Reliability fixes from the baseline harness (bench/baseline):
  - **Truncated-stream guard (gg-ai):** a clean stream close with no terminal event (no `message_stop` / `finish_reason`) now throws a retryable `ProviderError(504)` instead of silently returning partial text as a phantom-complete `end_turn`. Applies to both the Anthropic and OpenAI-compatible providers.
  - **Sidecar bounds (ggcoder):** inbound HTTP bodies capped at 10 MB (413) via `readCappedBody`; the `~/.gg` progress `fs.watch` handle is now closed on shutdown; the project-file glob search streams and bails after 50k entries. Closes three unbounded-memory/leak paths.
  - **Cap-divergence marker (gg-agent):** `capToolResults`/`capTurnToolResults` now stamp `ToolResult.capped = { originalChars, keptChars, scope }` when they trim, so the event-transcript vs model-input divergence is programmatically visible. Internal metadata only — never serialized to the provider.
  - **Empty-part serializer fix (gg-ai):** `toAnthropicMessages` no longer emits empty text parts (user `""`, user `{text:""}`, settled assistant `""`), eliminating live Anthropic 400 "text content blocks must be non-empty" failures.
  - **Tool-id remap fix (gg-ai):** `remapToolCallId` now strips the full `toolu_` prefix (`slice(6)`), mapping `toolu_01ABC` → clean `call_01ABC` instead of the lossy double-underscore `call__01ABC`.

## 5.22.0

## 5.21.0

## 5.20.5

## 5.20.4

## 5.20.3

## 5.20.2

## 5.20.1

## 5.20.0

## 5.19.6

## 5.19.5

## 5.19.4

## 5.19.3

### Patch Changes

- b6e7562: Compress large OpenAI Codex request bodies with zstd and automatically retry HTTP 507 upstream retry-buffer failures.

## 5.19.2

## 5.19.1

## 5.19.0

## 5.18.0

### Minor Changes

- e00de5b: Add Kimi K3 as Moonshot's default model with its 1M-token multimodal registry metadata and endpoint-specific max-effort request handling for both the public API and Kimi Code OAuth. Keep Kimi K2.7 Code available as the dedicated coding alternative.

## 5.17.0

### Minor Changes

- a3916ff: Harden provider error handling, cancellation settlement, review evidence, LSP confidence, route-aware context limits, turn metrics, and durable child-agent recovery.

## 5.16.0

## 5.15.1

## 5.15.0

## 5.14.0

## 5.13.3

## 5.13.2

## 5.13.1

## 5.13.0

## 5.12.0

## 5.11.0

## 5.10.1

## 5.10.0

## 5.9.7

## 5.9.6

## 5.9.5

## 5.9.4

## 5.9.3

## 5.9.2

## 5.9.1

### Patch Changes

- Fix error guidance to use desktop-app UI actions instead of CLI commands in the gg-app

## 5.9.0

## 5.8.8

## 5.8.7

## 5.8.6

## 5.8.5

## 5.8.4

## 5.8.3

## 5.8.2

## 5.8.1

## 5.8.0

## 5.7.0

## 5.6.3

## 5.6.2

## 5.6.1

## 5.6.0

## 5.5.1

## 5.5.0

## 5.4.3

## 5.4.2

## 5.4.1

## 5.4.0

## 5.3.0

## 5.2.0

## 5.1.2

## 5.1.1

## 5.1.0

## 5.0.0

## 4.15.0

## 4.14.3

## 4.14.2

## 4.14.1

## 4.14.0

## 4.13.3

## 4.13.2

## 4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.

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

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

## 4.11.3

## 4.11.2

## 4.11.1

## 4.11.0

## 4.10.2

## 4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

## 4.9.1

## 4.9.0

## 4.8.7

## 4.8.6

## 4.8.5

## 4.8.4

## 4.8.3

## 4.8.2

## 4.8.1

## 4.8.0

### Minor Changes

- Add Claude Fable 5 (`claude-fable-5`) and Claude Mythos 5 (`claude-mythos-5`) to the model registry with adaptive thinking (low→max), correct beta-header handling in the Anthropic provider, footer short names, and a clear invite-only (Project Glasswing) error for Mythos instead of the raw `not_found_error`.

## 4.7.0

## 4.6.3

### Patch Changes

- Fix Anthropic rejecting foreign `raw` content blocks (e.g. OpenAI Codex encrypted reasoning items) when switching a session to an Anthropic model. Raw blocks whose wire type isn't a valid Anthropic input content block are now dropped on the way out.

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.

## 4.6.1

### Patch Changes

- Fix provider stream cancellation and usage-limit handling, and sanitize Codex tool-call IDs when continuing sessions across model transports.

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

## 4.5.0

## 4.4.0

### Minor Changes

- 9e381ad: Extract `@kenkaiiii/gg-core` — a provider-agnostic, UI-free shared foundation
  that owns the model registry, thinking levels, app paths, OAuth + auth storage,
  the file-writer logger core, telegram + voice transcription, and the
  self-updater. ggcoder, gg-boss, and gg-editor now inherit a single source of
  truth for provider-coupled code instead of maintaining duplicates.

  Move provider-error classification into `@kenkaiiii/gg-ai` as
  `classifyProviderError`, reconciled with `isHardBillingMessage` so billing
  wording lives in one place.
