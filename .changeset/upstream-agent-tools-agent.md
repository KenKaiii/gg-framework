---
"@kleio/agent": patch
---

Agent-tool and prompt changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- Stream rules: new `AgentOptions.streamRules` matches regex rules against assistant text or tool-call arguments while they stream. On a match the attempt is aborted and discarded (nothing is persisted and no partial tool call runs), the rule's reminder is added as a hidden note, and the step is retried. Each rule fires once per run, and retries are capped (3 by default). A `stream_rule_triggered` event and a silent `retry` with reason `stream_rule` report each hit.
- A tool result can set `endRun` to end the run after it is saved, with no further model call. A sequential tool also stops later calls in its batch, as a submitted plan does.
- New `AgentOptions.resolveTool` loads a tool the model called by name but that isn't in `tools` yet, such as a deferred tool, so the call runs instead of failing as unknown.
- An unknown tool name gets the closest real tool names, and invalid arguments get per-field hints from the tool's schema.
- New `AgentOptions.onContextPrepared`, `responsesLite`, `strictTools` and `providerOptions` are passed through to `stream()`. `onContextPrepared` observes only the primary arm of a hedged request.
- `repairToolPairingAdjacent` is exported.
