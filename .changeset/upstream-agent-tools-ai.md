---
"@kleio/ai": patch
---

Agent-tool and prompt changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- New `embed()` and `rerank()` resolve through the same provider registry as `stream()`. They support OpenAI, OpenRouter, Gemini (AI Studio key) and local OpenAI-compatible servers, and palsu gets deterministic fakes for tests. `embed()` keeps input order, splits batches at each provider's limit, checks every vector and can L2-normalize. `rerank()` returns results sorted by score. A provider without the capability throws a capability error, and `providerRegistry.supports()` checks first. Failures use `stream()`'s error model: `ProviderError` gains `source: "auth"` for 401 and 403, and error bodies are redacted and truncated.
- New `providerOptions` passes provider-specific body fields (for example OpenRouter's `provider` routing object) to `stream()`, `embed()` and `rerank()`. It only fills fields the library left unset, never core fields such as model, messages or tools.
- New `formatChatError` classifies a failure for display (usage limit, billing, quota, rate limit, model access, auth, network, capability, context, update or provider) and keeps the reset time, provider, status code and request id.
- New `onContextPrepared` stream option observes each request's prepared context (messages, tools and image counts after sanitizing). Observer errors never fail a request.
- When a conversation has more images than the provider accepts, the oldest are dropped in batches of up to 30, so the cached prefix holds still between requests. Dropping one image per new image had re-sent most of the conversation uncached.
- New `prewarm` stream option (Anthropic only) sends the exact request prefix with `max_tokens: 1` to write the prompt cache. With budget thinking, which can't run at one token, no request is sent.
- Codex (ChatGPT login): new `responsesLite` and `strictTools` stream options switch the Responses-Lite request shape and strict tool schemas independently, and `usesResponsesLite()` is exported. `strictTools: false` also applies to OpenAI API-key requests. Ultra sends `xhigh` on GPT-6 Astra and GPT-6.1 Sol, and `max` on other models.
- Codex reasoning summaries get a blank line between sections, so bold headlines no longer run together, and empty deltas no longer stream as thinking text.
- Claude Haiku 5.5 counts as an adaptive-thinking model with the full effort ladder, `xhigh` included. Adaptive thinking requests `display: "summarized"`: these models otherwise stream empty thinking blocks, so no reasoning showed.
- Gemini tool schemas turn `exclusiveMinimum` and `exclusiveMaximum` into the inclusive bounds Gemini accepts, so one such tool no longer makes the whole request fail with a 400.
- Tool-schema conversion drops keywords that cost bytes on every request without guiding the model: `z.number().int()`'s `±MAX_SAFE_INTEGER` bounds and Zod's blanket `additionalProperties: false`. Strict-mode providers still add the latter.
- Codex and OpenAI model-access errors no longer name specific plans or models. They say to choose another available model.
