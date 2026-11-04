---
"@kleio/core": patch
---

Agent-tool and prompt changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- Claude Haiku 5.5 replaces Claude Haiku 4.5 in the model registry, with a 1M context window, 128K output, image input and the full thinking ladder (`low` to `max`, `xhigh` included). A session that still has Haiku 4.5 saved falls back to the provider default on its next start.
- `getSummaryModel` picks each provider's compaction model by cost tier instead of by model id: the Sonnet tier for Anthropic, and the low tier for OpenAI, GLM, DeepSeek and Hugging Face. Other providers summarize on the active model.
- `getFastModel` is removed. Sub-agents run on the parent's model.
- New `getLowestThinkingLevel` returns the lowest effort a model accepts, for background work that runs on the active model.
