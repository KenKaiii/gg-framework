---
"@kenkaiiii/gg-core": patch
"@kenkaiiii/ggcoder": patch
---

Fix radio players surviving a hard kill, and let OpenRouter point at a custom base URL.

**Radio: orphans kept streaming.** Players were tracked only in module singletons, so a daemon killed with `taskkill /F` (or a crash) left its `ffplay`/`mpv` running with nothing to stop it. The next daemon had `currentChild === null`, spawned another stream on top, and every restart added one more. Players are now recorded by PID in the temp dir, reaped on daemon boot and again before each play, and strays are also found by scanning command lines for the app's own station URLs (a user's unrelated player is never touched). `terminateChild` uses a forced tree-kill on Windows, which `child.kill()` alone does not guarantee.

**OpenRouter: optional base URL.** `AuthProviderMeta.allowCustomBaseUrl` lets the API-key form offer a base-URL override, stored on the credential in `~/.gg/auth.json` and picked up by `AgentSession` (`creds.baseUrl`), so OpenRouter can route through a compatible gateway instead of `openrouter.ai`. Empty input keeps the provider default. Rust validates the override (`http(s)` only, trailing slashes stripped) and rejects anything else with a user-facing message; the sidecar route applies the same rule so the CLI and app agree.
