---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Add GPT-6.1 Terra (`gpt-6.1-terra`, released 2026-10-26) and its Fast mode (`gpt-6.1-terra-fast`, 1.5x speed). It has a 1.05M context window on the public Responses API, 500K on the ChatGPT OAuth/Codex route, 128K output and text+image input, and costs $1/$5 per MTok (cached input $0.05). It starts at `low` effort and runs the full ladder up to `ultra`, which maps to xhigh plus the async-subagent orchestration prompt, the same as Sol and Astra. GPT-6.1 Sol stays the OpenAI default.
