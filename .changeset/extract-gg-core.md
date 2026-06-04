---
"@kenkaiiii/gg-core": minor
"@kenkaiiii/gg-ai": minor
---

Extract `@kenkaiiii/gg-core` — a provider-agnostic, UI-free shared foundation
that owns the model registry, thinking levels, app paths, OAuth + auth storage,
the file-writer logger core, telegram + voice transcription, and the
self-updater. ggcoder, gg-boss, and gg-editor now inherit a single source of
truth for provider-coupled code instead of maintaining duplicates.

Move provider-error classification into `@kenkaiiii/gg-ai` as
`classifyProviderError`, reconciled with `isHardBillingMessage` so billing
wording lives in one place.
