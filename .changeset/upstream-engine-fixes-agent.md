---
"@kleio/agent": patch
---

Fixes imported selectively from upstream engine releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- A steering message sent while tools run interrupts them at once. Interruptible tools are aborted and get an "Interrupted" result, and the message reaches the model on its next call. File mutators (`edit`, `write`, `multi_edit`, `apply_patch`, `notebook_edit`) always finish, and any tool can set `interruptible`. New `AgentOptions.onSteeringAvailable` subscribes the loop to new steering messages.
- New `AgentOptions.transformToolResult` post-processes a successful tool result after redaction, before the `tool_call_end` event and the provider context. If it throws, the original result is kept.
- A first event that is late on a warm, cached prompt is hedged: one identical request starts while the first keeps running, the first to produce an event wins, and the other is aborted. It runs only on the plain remote streaming path, and only after a response in the same run had at least half its prompt cached and arrived under 4 minutes ago. A slow healthy request is never cut off, and the `hedge_started` and `hedge_settled` diagnostics record each hedge.
