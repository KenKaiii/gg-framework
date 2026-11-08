---
"@kleio/agent": patch
---

Model, provider and error changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- `AgentOptions.webSearch` also takes a function, which is evaluated again before every request. A host can turn on provider-native web search mid-run without restarting the loop.
- Agent-loop errors are formatted with `formatChatError`.
