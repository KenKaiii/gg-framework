# @kenkaiiii/gg-core

## 5.1.1

### Patch Changes

- @kenkaiiii/gg-ai@5.1.1

## 5.1.0

### Patch Changes

- @kenkaiiii/gg-ai@5.1.0

## 5.0.0

### Patch Changes

- @kenkaiiii/gg-ai@5.0.0

## 4.15.0

### Patch Changes

- @kenkaiiii/gg-ai@4.15.0

## 4.14.3

### Patch Changes

- @kenkaiiii/gg-ai@4.14.3

## 4.14.2

### Patch Changes

- @kenkaiiii/gg-ai@4.14.2

## 4.14.1

### Patch Changes

- @kenkaiiii/gg-ai@4.14.1

## 4.14.0

### Patch Changes

- @kenkaiiii/gg-ai@4.14.0

## 4.13.3

### Patch Changes

- @kenkaiiii/gg-ai@4.13.3

## 4.13.2

### Patch Changes

- @kenkaiiii/gg-ai@4.13.2

## 4.13.1

### Patch Changes

- @kenkaiiii/gg-ai@4.13.1

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

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.2

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

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.0

## 4.11.3

### Patch Changes

- @kenkaiiii/gg-ai@4.11.3

## 4.11.2

### Patch Changes

- @kenkaiiii/gg-ai@4.11.2

## 4.11.1

### Patch Changes

- @kenkaiiii/gg-ai@4.11.1

## 4.11.0

### Minor Changes

- Add GLM-5.2 as a new model — Z.ai's coding-first flagship with a usable 1M-token
  context window and 131K max output. It is now the default model for the `glm`
  provider (registry + CLI defaults updated; app sidecar rebundled).

### Patch Changes

- @kenkaiiii/gg-ai@4.11.0

## 4.10.2

### Patch Changes

- @kenkaiiii/gg-ai@4.10.2

## 4.10.1

### Patch Changes

- @kenkaiiii/gg-ai@4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.10.0

## 4.9.1

### Patch Changes

- @kenkaiiii/gg-ai@4.9.1

## 4.9.0

### Patch Changes

- @kenkaiiii/gg-ai@4.9.0

## 4.8.7

### Patch Changes

- @kenkaiiii/gg-ai@4.8.7

## 4.8.6

### Patch Changes

- @kenkaiiii/gg-ai@4.8.6

## 4.8.5

### Patch Changes

- @kenkaiiii/gg-ai@4.8.5

## 4.8.4

### Patch Changes

- @kenkaiiii/gg-ai@4.8.4

## 4.8.3

### Patch Changes

- @kenkaiiii/gg-ai@4.8.3

## 4.8.2

### Patch Changes

- @kenkaiiii/gg-ai@4.8.2

## 4.8.1

### Patch Changes

- @kenkaiiii/gg-ai@4.8.1

## 4.8.0

### Minor Changes

- Add Claude Fable 5 (`claude-fable-5`) and Claude Mythos 5 (`claude-mythos-5`) to the model registry with adaptive thinking (low→max), correct beta-header handling in the Anthropic provider, footer short names, and a clear invite-only (Project Glasswing) error for Mythos instead of the raw `not_found_error`.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.8.0

## 4.7.0

### Patch Changes

- @kenkaiiii/gg-ai@4.7.0

## 4.6.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.2

## 4.6.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1

## 4.6.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0

## 4.5.0

### Patch Changes

- @kenkaiiii/gg-ai@4.5.0

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

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-ai@4.4.0
