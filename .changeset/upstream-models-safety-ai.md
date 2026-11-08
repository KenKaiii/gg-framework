---
"@kleio/ai": patch
---

Model, provider and error changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- New models: Claude Opus 5.5 fast and Codex GPT-6 fast, and MiniMax M3.1 Flash. M3.1 Flash is the only text model MiniMax's plan keys cover, so it becomes MiniMax's default. MiniMax M3 stays.
- MiniMax thinking uses adaptive thinking with effort levels, because MiniMax rejects disabled thinking. Ultra maps to max.
- Grok uses xAI's Responses API and replays encrypted reasoning. Requests no longer fail with HTTP 426.
- Gemini can log in with an API key. Gemini model settings follow the vendor's documented limits.
- Anthropic web search loads only when needed. A conversation that already used native web search keeps it declared, so a resumed or compacted Anthropic session no longer fails with HTTP 400. Unresolved deferred web_search calls are no longer replayed to Anthropic.
- An `is_error` tool result that carries images or video keeps only its text. Its media follows as ordinary user content, because Anthropic rejects media in an error result.
- A local endpoint added without a key sends no bearer token (`LOCAL_NO_API_KEY`). Embed and rerank calls follow the same rule.
- Errors from the Anthropic transport carry the calling provider, so a MiniMax problem no longer reads as an Anthropic usage limit. MiniMax's documented error codes get their own headline and guidance. Guidance names a product only when the caller passes a display profile.
