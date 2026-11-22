---
"@kenkaiiii/ggcoder": minor
---

Skills follow the Agent Skills standard more closely. GG Coder now also loads skills from the shared `~/.agents/skills` and project `.agents/skills` folders that other coding agents use (GG's own `.gg/skills` folders win a name clash). A skill marked `disable-model-invocation: true` no longer loads on its own; ask for it by name. The built-in skills carry a version and have refreshed facts as of 22 November 2026. After `/init`, the app now points at the real **New session** key.
