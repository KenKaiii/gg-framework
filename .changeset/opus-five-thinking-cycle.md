---
"@kenkaiiii/ggcoder": patch
---

Fix Claude Opus 5's thinking-level cycle and retire Claude Opus 4.8. `thinking-level.ts` kept its own hardcoded Anthropic regexes, so Opus 5 was not recognised as adaptive and collapsed to a single non-cycling `max` level; it now exposes the full low → medium → high → xhigh → max ladder. Opus 4.8 is removed from the model registry, footers, provider descriptions, and the hardcoded JSON/RPC/sidecar/CLI defaults (all now `claude-opus-5`); gg-ai keeps wire-format support for the `claude-opus-4-8` ID since Anthropic still serves it. Also gave the Sol/Terra policy tests real timeouts so they stop flaking at vitest's 5s default.
