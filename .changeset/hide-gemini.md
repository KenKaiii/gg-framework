---
"@kenkaiiii/gg-core": patch
"@kenkaiiii/ggcoder": patch
---

Hide Gemini from login lists, model pickers and startup while Google no longer serves personal accounts over sign-in. Models, transports and stored credentials stay in place; un-hide via `HIDDEN_PROVIDERS` in gg-core (and gg-app's auth.rs).
