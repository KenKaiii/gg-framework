---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Replace GPT-6 Astra with GPT-6.2 Astra (`gpt-6.2-astra`) and GPT-6.1 Sol with GPT-6.2 Sol (`gpt-6.2-sol`), plus their Fast variants. Both have 1.05M context on the public Responses API (922K max input), 128K output and text+image input. Astra costs $8/$40 per MTok (cached input $0.40) and Sol $2/$10 (cached input $0.10). The 272K ChatGPT-plan window, the `low` default effort and the full ladder up to `ultra` carry over from the models they replace.

GPT-6.2 Sol is the new OpenAI default (registry, CLI, benchmarks). The login hub, footer names, READMEs, Fast mode, Ultra delegation and subagent policy now use the 6.2 ids. `gpt-6-astra` and `gpt-6.1-sol` are retired, so a saved session still on one falls back to the provider default on next start.
