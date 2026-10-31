---
"@kenkaiiii/gg-core": patch
"@kenkaiiii/ggcoder": patch
---

Local models: read the context window from llama.cpp-style `/v1/models` fields (`context_length`, `meta.n_ctx`) beside vLLM's `max_model_len`, and let a custom endpoint pin a `contextLength` that wins over whatever the server reports.
