---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

**GLM-5.4 is here, with a GLM Coding Plan key route.** Z.AI now takes two kinds of key: a GLM Coding Plan key (Coding Plan endpoint, `api.z.ai/api/coding/paas/v4`, stored as `glm-coding`) and the existing pay-per-token Z.AI API key. Each endpoint now serves a different flagship: GLM-5.4 runs on the Coding Plan key only (the standard endpoint refuses it), and GLM-5.3 on the pay-per-token key only (the Coding Plan endpoint stopped serving it when 5.4 landed). GLM-5.3-Flash runs on either, plan key first. GLM-5.4 is the new GLM default; the model picker greys out whichever flagship your key can't run.

GLM-5.4 reads images natively (verified live), so its image attachments go inline instead of through the zai_vision MCP server, which GLM-5.3 still uses. It has a 1M context, all five thinking levels (low to max) and a max default. The Z.AI MCP servers (vision, web search, web reader, zread) now start only for GLM models that can't read images (GLM-5.3); GLM-5.4 and 5.3-Flash use GG Coder's own web_search, web_fetch and Steroids tools. Switching between those models reconnects the servers. When they do start, they use whichever GLM key is connected, Coding Plan first.

**GLM-5.3 thinking follows Z.AI's narrower ladder.** The endpoint now accepts only `low`, `high` and `max` for 5.3, and refuses to turn its thinking off. The picker offers those three; a saved `medium` or `xhigh` drops to the rung below; and "thinking off" no longer sends the rejected `disabled` toggle, matching Kimi K2.7.
