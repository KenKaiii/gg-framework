---
"@kenkaiiii/ggcoder": patch
---

On a Claude subscription, a tool loaded with `tool_search` (such as `web_search`, `web_fetch`, `screenshot` or `subagent`) now works on its first call. GG Coder used to answer `tool_search` before Claude Code had re-read the tool list, so the next call failed with "No such tool available" and had to be retried; it now waits (up to 3 seconds) for Claude Code to pick up the new tool first.
