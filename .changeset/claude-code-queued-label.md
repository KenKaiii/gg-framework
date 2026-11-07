---
"@kenkaiiii/ggcoder": patch
---

On a Claude subscription, a message you send while the agent is working no longer stays labelled "Queued" after Claude has already picked it up. GG Coder handed the message to Claude Code before reporting it as queued, so the app never saw it pending and never cleared the label; the message is now taken a moment later, after the app has been told.
