# Cache diagnostics

Kleio Coder logs two content-free records per successful model request under the `cache`
category: `Prepared context` and `Context cache outcome`. Both include a session ID;
their JSON `data` field carries a request number. Failed attempts can have a prepared
record without an outcome. No prompt text, image data, tool arguments, signatures,
credentials, route/account identifiers or content hashes are logged.

## Reading the records

- `changes`: observed edits, not a proven explanation for a provider cache miss.
  `tool_prune` and `compaction` come from the actual operations; `history`,
  `request_settings`, `route_or_model` and `image_budget` come from comparisons.
- `unchangedMessages`: the unchanged **logical-message** prefix after generic
  sanitization/image limiting, before provider-specific encoding. This is not a
  token boundary or an exact HTTP-payload comparison. System/tool configuration
  changes can invalidate caching even when this count is unchanged.
- `imagesBefore`, `imagesAfter`, `imagesDropped`: current image-budget effects.
- `pruneFreedTokensEstimate`: the pruner's estimated savings, not measured billing.
- `cacheRead`, `cacheWrite`, `promptTokens`: provider-reported usage, using Kleio's
  normalized usage contract. New input can contribute to cache writes; not every
  cache write is wasted work.
- `reprocessedPromptTokensEstimate`: when comparable, the smaller of the current
  and previous successful prompt sizes minus current cache reads, floored at zero.
  It is an upper-bound proxy for repeated uncached input, **not avoidable waste**.
  First requests, compaction, route/model changes and unreported caches have no
  estimate. Failed attempts do not replace the successful baseline.
- `sincePreviousRequestMs`: time between request starts (not purely idle time).
  `requestedTtlExceeded`: possible expiry using the requested five-minute/one-hour
  retention. Provider behavior, eviction, prewarming and actual cache creation
  time can differ; this does not establish expiry as the cause.
- `ttftMs` and `providerDurationMs`: existing turn timing, including existing retry
  accounting. `fingerprintMs` measures diagnostic hashing overhead separately.
- `costStatus: unavailable`: effective-dated authoritative pricing is unavailable
  in Kleio's turn metrics. Do not convert these counts into dollar savings without it.

State lasts for the live session, including consecutive user requests. Loading,
branching or starting a conversation resets it. A resumed session starts with no
historical cache baseline rather than guessing from old log timestamps.

## Claude compatibility

`thinkingPrefixRiskBlocks` and a warning flag signed reasoning after a known earlier
history edit (including image removal on a resumed session). This is a conservative
**client-side risk check**, not confirmation that the provider will reject a request.
It does not identify all provider-specific mutations or model/account rules.

Diagnostics do not introduce reasoning stripping, loosen signature checks, enable beta
features, or change the existing pruning/compaction policies. The existing Anthropic
encoder **already strips reasoning from settled turns** and retains it during active
tool sequences. `settledThinkingBlocks` counts signed blocks subject to that existing
policy. SDK-payload tests cover both paths without changing them. This policy needs a
separate review for models that enforce preserved-thinking prefix binding; this work
does not certify compatibility with those models.

Tests do not verify server acceptance: that needs an explicitly authorized live test against the relevant
model/account, including resumed sessions and tool/schema changes.

Anthropic's preserved-thinking documentation describes prefix binding on applicable
models/accounts. Native server-side context management is one supported way to
edit history there, but switching Kleio to it needs separate compatibility work.
Server-side tool clearing can still invalidate prompt caching.

References (checked 2026-10-02):

- https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
- https://platform.claude.com/docs/en/build-with-claude/context-editing

## Before changing pruning policy

Compare the next several turns after a prune, not only the immediate rewrite:
subsequent smaller requests may repay its one-time cost. Separate compulsory cleanup
near a context limit from optional cleanup, and separate model switches, idle periods
and compaction from comparable turns. Use authoritative input/cache-read/cache-write
prices and retained-information checks before claiming net savings.
