---
"@kleio/ai": patch
---

Fixes imported selectively from upstream engine releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- First-party Anthropic API requests opt into server-side refusal fallback (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta). When a config rejects it with HTTP 400, the request is retried once without it and that config is not asked again in the same process. Usage adds up every attempt in `usage.iterations`, and replayed assistant turns follow the API's rules for `fallback` blocks.
- A tool call whose name or id the provider would reject is dropped from the request, with its result, instead of failing the turn. New exports: `dropInvalidToolCalls`, `isValidToolCallName`, `toolCallNameRuleFor`, `TOOL_CALL_NAME_RULES` and the `ToolCallNameRule` type.
- `resolveToolSchema` gives an object schema without `properties` an empty one, which OpenAI requires.
- A user-role runtime notice, such as a finished worker or an exited background process, is marked as continuing the turn. The Anthropic encoder no longer starts a new turn for it, so the run keeps its thinking and its 1-hour cache anchor. New exports: `continuesTurn` and `opensTurn`.
