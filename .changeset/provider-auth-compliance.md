---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-agent": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Every provider now connects only in a way its owner allows, and GG Coder no longer poses as Codex CLI, Kimi Code CLI, Grok CLI or Gemini CLI anywhere (#139).

- **OpenAI:** "Continue with ChatGPT" uses OpenAI's official Sign in with ChatGPT for open-source apps: GG Coder registers itself once per ChatGPT account, checks the ID token against OpenAI's keys, needs the "Use your ChatGPT plan" permission, and revokes the session on sign-out. Requests go to the public Responses API (`api.openai.com/v1/responses`) with GG Coder's own User-Agent. An OpenAI API key is new and rides the same Responses transport, so GPT-6 models can call tools on a key; it takes over while the plan's usage is out. The ChatGPT usage meter is replaced by a "Using ChatGPT plan · Manage usage" link, and plan usage-limit errors point to chatgpt.com/settings/usage.
- **Models your plan or keys can't run** are greyed out in the app's model picker with the reason ("Not in your ChatGPT plan", read from the account's own model list; "Needs a Kimi Code plan key"; "Needs an API Credits key"). Requests that still hit those limits say so: "gpt-6.1-sol isn't included in your ChatGPT plan", "Fast mode isn't included in your ChatGPT plan".
- **Kimi:** the Kimi sign-in is gone. Paste a Kimi Code plan key (from the Kimi Code Console; `api.kimi.com` or `api.kimi.ai` is detected) or a Moonshot API key. K2.8 Preview needs the plan key.
- **xAI:** API key only (xAI offers SuperGrok and X Premium usage only in apps it partners with).
- **Gemini:** the Google sign-in and Code Assist route are gone; Gemini is back in the provider list with a Google AI Studio key.
- **GLM:** keys use Z.AI's standard pay-per-token endpoint, because the GLM Coding Plan is limited to the tools Z.AI lists.
- **MiniMax and Xiaomi:** each key type now says what it bills (plan or pay-per-token).
- Old sign-ins (Codex, Kimi, Grok, Google) are never used and never read as API keys. The app and CLI ask once to reconnect, and connecting again or dismissing removes them.
- gg-agent: the per-turn credential refresh now drops the ChatGPT account when the credential switches to an API key, so a key never rides the plan route.
- `generate_image` moves to OpenAI's public Image API (GPT Image 2.6) and needs an OpenAI API key; with only the ChatGPT plan it explains that.
- gg-core: `loginOpenAI`/`refreshOpenAIToken` become `loginChatGPT`/`refreshChatGPTToken`/`revokeChatGPTSignIn`; `loginKimi`, `loginXai`, `loginGemini` and their helpers are removed; new `KIMI_CODE_KEY`, `OPENAI_CHATGPT_KEY`, `RETIRED_SIGN_INS`, `AuthStorage.legacySignIns()`/`takeLegacySignIn()`/`hasApiKey()`/`resolveApiKey()` and `detectKimiCodeBaseUrl`. gg-ai: `streamOpenAICodex` becomes `streamOpenAIResponses`, `CODEX_CLIENT_VERSION` and the `responsesLite`/`projectId` stream options are removed, and `GG_CODER_USER_AGENT` is exported. The `codexResponsesLite` setting is removed.
