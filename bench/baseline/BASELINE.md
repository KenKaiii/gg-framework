# Baseline Benchmark Results — 22 July 2026

**Model:** Claude Sonnet 5 (`claude-sonnet-5`) via GG OAuth credentials.
**Method:** every script run twice independently (sub-agent build run + verification re-run); numbers below are the verified re-runs. Raw data: `results/*.json`. Scripts: `bench/baseline/0*.mjs` (run from repo root; `07` needs `node --expose-gc`).

## Headline verdicts per adoption item

| # | Adoption item | Baseline result | Verdict |
|---|---|---|---|
| 1 | EOL-aware edit executor | **0/18 edit failures** on CRLF corpus; CRLF intact every run. `edit.ts` already normalizes `\r\n`→`\n` for matching and converts back on write | ❌ **DROP — already implemented** |
| 2 | Aggregate tool-response budget | Per-turn tool-result aggregates: max 11,187 / mean 1,937 chars. 10k budget would trigger on 9.1% of turns; 25k+ never. **Real finding:** capping mutates the persistent transcript in place while `tool_call_end` events carry the uncapped preview → transcript ≠ model input once a cap triggers | ⚠️ **Reprioritize: the divergence bug is the real work, not the budget** |
| 3 | Registry/compaction sizing | **Severe:** Anthropic models list 1M context but gg-ai never sends the context-1m beta header → compaction triggers at 850K against a route that hard-rejects >200K. Auto-compaction can never fire before the provider 400s | 🔥 **TOP PRIORITY — actively broken** |
| 4 | Truncated-stream retry | **FIXED (Fix A):** `truncate-silent` now **throws** `ProviderError("Stream ended before completion (no stop_reason).", 504)` — no longer a SILENT PARTIAL. 504 routes into the agent-loop retry bucket via `classifyOverload` → `provider_error` (agent-loop.ts:259). `clean` still passes; `truncate-mid` unchanged (throws `terminated`). OpenAI path mirrored (`no finish_reason` → 504). | ✅ **DONE — silent-partial path closed & retryable** |
| 5 | Tool-call ID normalization | **FIXED (Fix F):** `remapToolCallId` now `slice(6)` (was `slice(5)`) → `toolu_01ABC` maps to a clean single-underscore `call_01ABC` (baseline 09 confirms, paired=true). Composite-id collision guard still open (low priority). | ✅ **DONE (double-underscore) — collision guard deferred** |
| 6 | `tool_script` orchestration | Baseline cost: **2.8 LLM round-trips, 4.2 tool calls, ~1.6k tokens, 5.2s wall** per multi-tool task (100% success). Cheapest tasks already hit the 2-call floor | ⚖️ **Marginal on small tasks — evaluate only on fat multi-tool tasks (see 02's write-summary: 4 calls/12 tools/9.6s)** |
| 8 | Sidecar bounds | **FIXED (Fix C):** HTTP bodies now capped at **10 MB** (413) via `readCappedBody` (utils/http-body.ts, backs both readers) — verified by a real-server 413 test. `fs.watch` now **disposed** on shutdown (`progress.dispose()` closes the watcher + clears the debounce). Glob search **stream + 50k scan cap** (bounded retention). | ✅ **DONE — all three bounds closed** |
| 10 | MCP catalog binding | N/A today — MCP connects once at startup (`initialMcpConnectPromise ??=`); catalog cannot change mid-session | ❌ **DROP until MCP hot-reload exists** |
| 12 | Byte-stable prefixes | System prompt **byte-stable** (sha256 × 5 builds); volatile date is a **suffix** after `<!-- uncached -->` — absorbed by prefix caching (100% hit). Prefix volatility proven detectable (0% hit arm) | ❌ **DROP — already done right** |
| 15 | On-demand skill retrieval | Today: skills section = 237 tok (3.0% of prompt) — savings ceiling is tiny. At 10+ installed skills it becomes 23–45% | ⏸️ **DEFER — revisit when skill count grows** |
| 16 | LSP semantic edit tools | Renames: **100%** (12/12 incl. compile pass). **Move-to-new-file: 0/3** — model creates the new file + updates imports but leaves the original definition behind every time | ✅ **Adopt narrowly: an LSP `move_symbol` beats text edits; rename doesn't need it** |
| 20 | Empty-part omission + misc | **FIXED (Fix E):** user `""` (A), user `{text:""}` (B), and settled assistant `""` (D) no longer reach the wire — `toAnthropicMessages` drops the degenerate turn / filters empty text parts. Only case H (active-trajectory empty text before signed thinking) remains, by design. Baseline 10 confirms A/B/D clean. | ✅ **DONE — live 400 modes closed** |

## Detailed results

### 01 — EOL edits (18 runs + diagnostic)
100% success, 0 edit errors, 0 not-found, CRLF intact in all runs. ~3 LLM calls, ~5–7s per edit task.

### 02 — Tool round-trips (15 runs, 100% success)
| task | llm calls | tool calls | total tok | wall |
|---|---|---|---|---|
| count-odd-exports | 3.0 | 2.0 | ~4.5k | 4.9s |
| find-value-42 | 2.3 | 1.3 | ~0.4k | 4.0s |
| sum-three-files | 2.0 | 3.0 | ~0.6k | 3.2s |
| rename-constant | 3.0 | 3.0 | ~1.6k | 6.5s |
| write-summary | 4.0 | 12.0 | ~4.5k | 10.1s |

(avg 2.8 round-trips · 4.2 tool calls · 5.2s; cache metrics: ~6–10k cacheRead/run, fresh cacheWrite per run)

### 03 — Tool-result bytes (6 runs, 58 results, 11 tool-turns)
Per-turn aggregate chars: max 11,187 / mean 1,937 / p95 11,187.
Current session-resolved caps: per-result **1,050,000 chars** (1M × 3.5 × 0.30), per-turn **240,000 chars** (hard ceiling 400k); caps are **off** in the raw Agent/bench harness.
**Transcript divergence:** `capToolResults`/`capTurnToolResults` rewrite `toolResult.content` in place before `messages.push` — the provider sees the capped text but `tool_call_end` subscribers got the uncapped preview.

### 04 — Prefix stability
- 5 × `buildSystemPrompt` builds: sha256 identical (31,151 chars).
- Only volatile content: `Today's date:` **final line** after `<!-- uncached -->` (system-prompt.ts:247) — deliberately placed at the suffix.
- Live cache (Sonnet 5, real GG prompt): control **100.0%** warm-turn hit · volatile-suffix **100.0%** · volatile-prefix **0.0%** (collapse proven; TTFT +50%).

### 05 — Refactor edits (12 runs, tsc-verified)
| task | success | notes |
|---|---|---|
| rename-formatName | 3/3 | compiles clean |
| rename-slugify | 3/3 | 3 transient edit errors, recovered |
| move-slugify | **0/3** | `src/util.ts still defines slugify` every time; project compiles (duplicate export across files) |
| rename-max-retries | 3/3 | 2 transient edit errors/run, recovered |

### 07 — Sidecar bounds
- Glob: 20k files → 60ms glob + 3ms sort, **18.5 MB** retained vs 2.5 MB sliced (0.86–0.93 MB per 1k files).
- HTTP body: linear ~5.5× RSS amplification, no cap: 1 MB→5.6 MB · 10 MB→53 MB · 50 MB→281 MB · 100 MB→550 MB.
- fs.watch: `app-sidecar.ts:1215` — no `watcher.close` anywhere in the file, debounce cleared only on re-arm, no dispose handle returned.

### 08 — Stream truncation (mock Anthropic SSE) — post Fix A
| mode | result |
|---|---|
| clean | works, stop=end_turn (guard does not false-positive) |
| truncate-mid (socket destroyed) | throws `ProviderError("terminated")`, statusCode=null, **unclassified** — no retryable marker (unchanged; deferred) |
| truncate-silent (no `message_stop`) | **FIXED** — throws `ProviderError("Stream ended before completion (no stop_reason).", statusCode=504)`; partial body preserved on `cause`, never returned. 504 → `classifyOverload` `provider_error` retry bucket |

Latent footgun also found: `StreamResult`'s background pump rejects its response promise independently of the iterator — iterator-throw-first + no `.then` handler = process-level unhandled rejection.

### 09 — Provider ID replay
- anthropic→openai: `toolu_01ABC…` → `call__01ABC…` (double underscore; lossy, not identity-reversible). Paired.
- openai→anthropic: `call_*` verbatim. Paired.
- composite `callId|itemId` → char-sanitized, memoized; two ids differing only in illegal chars would silently merge.

### 10 — Empty parts on the wire
Cases A (user `""`), B (user `[{text:""}]`), D (settled assistant `""`) all reach the wire; whitespace never trimmed (C, G). Anthropic rejects empty text blocks with 400 → live failure modes.

### 11 — Registry audit
- Only route-specific limits: 4 OpenAI models (`codexContextWindow` 272K vs 1.05M API), keyed off accountId.
- **No Anthropic route/input distinction**: Sonnet 5 / Opus 4.8 / Fable 5 budget compaction at 850K (0.85 × 1M) on a route that rejects >200K without the 1m beta header.
- Chain: `registry.contextWindow → getContextWindow(provider,accountId) → shouldCompact ceil(window×0.85) → compact() summarizer budget = same window − 4096 − 1000`. No clamping, no provenance, no output reservation.

## Revised priority list (post-baseline)

| Priority | Item | Why |
|---|---|---|
| P0 | **#3 Anthropic route-aware context window** (200K default vs 1M beta) | Compaction can never fire before provider 400 — measured |
| ~~P0~~ ✅ | ~~**#4 Silent partial on clean-truncated streams + retry classification**~~ **DONE (Fix A)** | Silent corruption path — measured; now throws retryable 504 (anthropic + openai) |
| ~~P0~~ ✅ | ~~**#8 Sidecar byte caps + fs.watch dispose**~~ **DONE (Fix C)** | 10 MB body cap (413), fs.watch dispose, 50k glob scan cap |
| P1 | **#2 Transcript/model-input divergence on cap** | Data-integrity bug found by the baseline |
| ~~P1~~ ✅ | ~~**#20 Omit empty text parts**~~ **DONE (Fix E)** | Live 400 failure modes; A/B/D now dropped/filtered |
| P1 | **#16 LSP move-symbol** (narrow scope) | 0/3 measured gap; skip rename |
| P2 (partial ✅) | **#5 ID remap** — `call__` double-underscore **DONE (Fix F)**; collision guard still deferred | Edge cases only |
| P2 | **#6 tool_script** — only if it wins on fat tasks (write-summary class) | Small tasks already at the floor |
| — | ~~#1 EOL edits~~ / ~~#12 byte-stable prefixes~~ / ~~#10 MCP binding~~ / ~~#15 skill retrieval~~ | Already done / N/A / premature — measured |
