# @kenkaiiii/gg-core

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
