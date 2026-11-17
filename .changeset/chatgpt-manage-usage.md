---
"@kenkaiiii/gg-ai": patch
"@kenkaiiii/ggcoder": patch
---

When OpenAI stops ChatGPT plan requests with `subscription_sharing_usage_limit_exceeded`, the desktop error now says the limit can be the plan's or the one ChatGPT sets for GG Coder, and offers a Manage usage button that opens chatgpt.com/settings/usage. It used to say "Wait for the reset, or use another provider", which left users thinking GG Coder was broken. A `subscription_sharing_usage_unavailable` reply (OpenAI couldn't check usage) no longer shows as "usage limit reached".
