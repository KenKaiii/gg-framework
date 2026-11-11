---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Add OpenCode as two providers: **OpenCode Go** (the subscription) and **OpenCode** (pay-as-you-go), each connected with an OpenCode Console API key (#142). Every request carries GG Coder's own User-Agent and a stable `x-opencode-session` per conversation, which Go requires; calls made outside a conversation (summaries, the prompt enhancer) share one fallback id. Models are listed as `opencode-go/<id>` and `opencode/<id>` and run over the gateway's Chat Completions API, so only the models OpenCode serves on that API are offered (19 of Go's 30 today); models whose own API is Responses, Anthropic Messages or Gemini are left out for now. Requests cap output with `max_tokens` and return earlier thinking as `reasoning_content`, which the gateway's backends require. The desktop app reads each connected plan's public model list (context, output cap, image input, effort levels) and refreshes it every six hours; pay-as-you-go leaves out the free tier, which only runs inside OpenCode. Kimi K3, GLM-5.3 and GLM-5.3-Flash are built in for the CLI and offline starts.

- gg-ai: new `opencode` and `opencode-go` providers.
- gg-core: `parseOpenCodeCatalog`, `OPENCODE_CATALOG_URLS`, `OPENCODE_PROVIDERS`, `formatOpenCodeModelId`.
