# @kenkaiiii/gg-core

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
