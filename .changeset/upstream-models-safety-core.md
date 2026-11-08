---
"@kleio/core": patch
---

Model, provider and error changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- Auth providers live in `@kleio/core` (`auth-providers.ts`), shared by the CLI and the desktop app.
- The model registry adds Claude Opus 5.5 fast, Codex GPT-6 fast and MiniMax M3.1 Flash, which becomes MiniMax's default. `getListedModels()` leaves out hidden providers.
- Models that spend real money are marked paid (`isPaidModel`): Claude fast mode and MiMo UltraSpeed. Each names a standard model to use wherever a paid tier must not be, and a fallback never moves onto a paid model.
- Gemini is hidden (`HIDDEN_PROVIDERS`), because using Gemini through third-party tools risks Google flagging or banning the account. Existing Gemini logins stop working. To re-enable Gemini, remove `"gemini"` from `HIDDEN_PROVIDERS` in `hidden-providers.ts`, and from the matching list in the desktop app's `auth.rs`.
- MiniMax and Xiaomi Token Plan keys go to the region that issued them. The first time a MiniMax key saved without an endpoint is used, its region is detected and saved with the key. A Xiaomi key rejected with a 401 is retried on the other Token Plan clusters before it is deleted.
- Local models: a custom endpoint's models take their context size from the server where it reports one. Ollama's served context can overlay the probe (`ollamaServedContext`). A 401 no longer deletes a local endpoint's key.
