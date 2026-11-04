---
"@kenkaiiii/ggcoder": patch
"@kenkaiiii/gg-core": patch
"@kenkaiiii/gg-ai": patch
"@kenkaiiii/gg-agent": patch
---

Radio no longer keeps playing after the app crashes or is force-quit: the next start stops the leftover player, but only when it is still playing that station, so an unrelated process that reused the ID is never touched. On Windows, stopping a station now stops the real player behind a launcher too. Custom local endpoints can pin a context length (a new field in Local models), and llama.cpp-style servers that report `meta.n_ctx` get their real window. OpenRouter keys can point at a compatible gateway with an optional base URL, changeable without pasting the key again, and "Sync models" replaces the built-in OpenRouter list with what that endpoint actually serves (tool-capable models only, with their context, output cap, image support and effort levels). A model that lists its own effort levels gets exactly those in the picker, and the chosen one is sent as-is, so `max` is no longer sent as `xhigh`.
