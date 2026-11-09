---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Add Claude Fable 5.2 (`claude-fable-5-2`, released 2026-11-09) to the model registry — 1M context, 128k output, image input, always-on adaptive thinking, now $8/$40 MTok (down from $10/$50) with cache reads at $0.20/MTok. It replaces Fable 5.1, which is retired from the registry, model picker and login copy — a session still pinned to it falls back to the provider default on next start. The API surface matches 5.1 (no forced tool use, no prefill, no sampling params), so no call path changes.

Add Claude Fable 5.2 Fast (`claude-fable-5-2-fast`): the same model in fast mode at up to 2.5x output speed, billed to Claude usage credits at $16/$80 MTok, with the same paid-model confirmation as Opus 5.5 Fast. The thinking picker now offers `xhigh` on the Fable line, which Anthropic supports on all five effort levels. Fast-mode refusals now point back to "the same model without Fast" instead of always naming Opus 5.5.
