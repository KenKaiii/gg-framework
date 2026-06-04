# @kenkaiiii/gg-ai

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
