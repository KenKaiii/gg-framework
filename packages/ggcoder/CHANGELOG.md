# @kenkaiiii/ggcoder

## 5.22.5

### Patch Changes

- Proactive OAuth token refresh at a lifetime-scaled threshold. Short-lived tokens (e.g. Kimi's 15-minute access token) now refresh at their halfway point instead of riding to the expiry cliff, eliminating the recurring 401s and the misleading "API Key appears invalid" run failures caused by concurrent-session refresh races. Ported from MoonshotAI/kimi-code's OAuthManager: refresh when within max(300s, lifetime × 0.5) of expiry.
  - @kenkaiiii/gg-ai@5.22.5
  - @kenkaiiii/gg-agent@5.22.5
  - @kenkaiiii/gg-core@5.22.5

## 5.22.4

### Patch Changes

- Fix memory tools killing the turn when the model sends content over the 600-character limit (over-limit input is now an ordinary, actionable tool error instead of a fatal "repeatedly issued invalid arguments" failure), make chat agents save durable memories proactively without being asked, fix false stream stalls for silent OpenAI reasoning, and anchor transcript error markers to persisted messages so resumed errors render at the bottom.
  - @kenkaiiii/gg-ai@5.22.4
  - @kenkaiiii/gg-agent@5.22.4
  - @kenkaiiii/gg-core@5.22.4

## 5.22.3

### Patch Changes

- Automatically recover from runaway tool-call streams and restore bundled TypeScript diagnostics and source inspection in the desktop sidecar.
  - @kenkaiiii/gg-ai@5.22.3
  - @kenkaiiii/gg-agent@5.22.3
  - @kenkaiiii/gg-core@5.22.3

## 5.22.2

### Patch Changes

- Keep live sessions responsive while multiple subagents stream in parallel.
  - @kenkaiiii/gg-ai@5.22.2
  - @kenkaiiii/gg-agent@5.22.2
  - @kenkaiiii/gg-core@5.22.2

## 5.22.1

### Patch Changes

- Reliability fixes from the baseline harness (bench/baseline):
  - **Truncated-stream guard (gg-ai):** a clean stream close with no terminal event (no `message_stop` / `finish_reason`) now throws a retryable `ProviderError(504)` instead of silently returning partial text as a phantom-complete `end_turn`. Applies to both the Anthropic and OpenAI-compatible providers.
  - **Sidecar bounds (ggcoder):** inbound HTTP bodies capped at 10 MB (413) via `readCappedBody`; the `~/.gg` progress `fs.watch` handle is now closed on shutdown; the project-file glob search streams and bails after 50k entries. Closes three unbounded-memory/leak paths.
  - **Cap-divergence marker (gg-agent):** `capToolResults`/`capTurnToolResults` now stamp `ToolResult.capped = { originalChars, keptChars, scope }` when they trim, so the event-transcript vs model-input divergence is programmatically visible. Internal metadata only — never serialized to the provider.
  - **Empty-part serializer fix (gg-ai):** `toAnthropicMessages` no longer emits empty text parts (user `""`, user `{text:""}`, settled assistant `""`), eliminating live Anthropic 400 "text content blocks must be non-empty" failures.
  - **Tool-id remap fix (gg-ai):** `remapToolCallId` now strips the full `toolu_` prefix (`slice(6)`), mapping `toolu_01ABC` → clean `call_01ABC` instead of the lossy double-underscore `call__01ABC`.

- Updated dependencies
  - @kenkaiiii/gg-ai@5.22.1
  - @kenkaiiii/gg-agent@5.22.1
  - @kenkaiiii/gg-core@5.22.1

## 5.22.0

### Minor Changes

- Add Kimi (Moonshot) subscription usage tracking — the usage meter now reports Kimi For Coding plan quota (weekly + rate windows) alongside Anthropic and OpenAI.

### Patch Changes

- @kenkaiiii/gg-ai@5.22.0
- @kenkaiiii/gg-agent@5.22.0
- @kenkaiiii/gg-core@5.22.0

## 5.21.0

### Minor Changes

- Kimi K3 gains its full low/high/max thinking ladder with an endpoint-aware default (high on the Kimi For Coding OAuth endpoint, matching the official CLI's plan-usage profile; max on the public API), thinking can now be fully disabled via the nested toggle, and context compaction no longer blows past the model's window on oversized turns.

### Patch Changes

- @kenkaiiii/gg-ai@5.21.0
- @kenkaiiii/gg-agent@5.21.0
- @kenkaiiii/gg-core@5.21.0

## 5.20.5

### Patch Changes

- Require generated UIs to meet WCAG 2.2 Level AA and follow ADA-aligned accessibility practices.
  - @kenkaiiii/gg-ai@5.20.5
  - @kenkaiiii/gg-agent@5.20.5
  - @kenkaiiii/gg-core@5.20.5

## 5.20.4

### Patch Changes

- Teach the bundled UI skill to avoid generic soft semantic tint-on-tint treatments.
  - @kenkaiiii/gg-ai@5.20.4
  - @kenkaiiii/gg-agent@5.20.4
  - @kenkaiiii/gg-core@5.20.4

## 5.20.3

### Patch Changes

- Strengthen the bundled UI skill with consistent content rails, control spacing, and pointer focus guidance.
  - @kenkaiiii/gg-ai@5.20.3
  - @kenkaiiii/gg-agent@5.20.3
  - @kenkaiiii/gg-core@5.20.3

## 5.20.2

### Patch Changes

- 5fb6b62: Automatically enforce session retention across desktop, CLI, and chat-agent stores, compress inactive transcripts after seven days, and cap persisted tool output at 40,000 characters. Media is migrated to deduplicated adjacent assets with backward-compatible hydration and archived sessions remain discoverable and resumable through stale saved paths.
- Updated dependencies [f4b8ec7]
  - @kenkaiiii/gg-core@5.20.2
  - @kenkaiiii/gg-ai@5.20.2
  - @kenkaiiii/gg-agent@5.20.2

## 5.20.1

### Patch Changes

- Show up to 30 recent chat sessions while keeping coding history capped at 5.
  - @kenkaiiii/gg-ai@5.20.1
  - @kenkaiiii/gg-agent@5.20.1
  - @kenkaiiii/gg-core@5.20.1

## 5.20.0

### Minor Changes

- Harden agent completion, loop recovery, workspace writes, project instructions, and subagent concurrency.

### Patch Changes

- @kenkaiiii/gg-ai@5.20.0
- @kenkaiiii/gg-agent@5.20.0
- @kenkaiiii/gg-core@5.20.0

## 5.19.6

### Patch Changes

- Filter expected usage polling, cancellation, and tool validation failures from desktop error reports.
  - @kenkaiiii/gg-ai@5.19.6
  - @kenkaiiii/gg-agent@5.19.6
  - @kenkaiiii/gg-core@5.19.6

## 5.19.5

### Patch Changes

- Report sidecar, provider, tool, and subagent failures through the desktop Error Mom integration.
  - @kenkaiiii/gg-ai@5.19.5
  - @kenkaiiii/gg-agent@5.19.5
  - @kenkaiiii/gg-core@5.19.5

## 5.19.4

### Patch Changes

- Prevent Anthropic many-image requests from failing by resizing new and restored images to provider-safe dimensions.
  - @kenkaiiii/gg-ai@5.19.4
  - @kenkaiiii/gg-agent@5.19.4
  - @kenkaiiii/gg-core@5.19.4

## 5.19.3

### Patch Changes

- Updated dependencies [b6e7562]
  - @kenkaiiii/gg-ai@5.19.3
  - @kenkaiiii/gg-agent@5.19.3
  - @kenkaiiii/gg-core@5.19.3

## 5.19.2

### Patch Changes

- Reduce long-session token usage with calibrated context estimates and preserve full oversized command output for targeted recovery.
  - @kenkaiiii/gg-ai@5.19.2
  - @kenkaiiii/gg-agent@5.19.2
  - @kenkaiiii/gg-core@5.19.2

## 5.19.1

### Patch Changes

- Cut OpenAI token burn: percentage-only compaction thresholds on authoritative provider usage, a per-turn aggregate tool-result budget that trims parallel fan-out context bombs, cheap stale tool-output pruning (superseded reads and old outputs stubbed before compaction), and autopilot now suppresses the redundant Ideal self-review while Ken owns verification.
  - @kenkaiiii/gg-ai@5.19.1
  - @kenkaiiii/gg-agent@5.19.1
  - @kenkaiiii/gg-core@5.19.1

## 5.19.0

### Minor Changes

- Add Grok 4.5 support and make Kimi prefer OAuth with automatic API-key fallback when plan usage is exhausted.

### Patch Changes

- @kenkaiiii/gg-ai@5.19.0
- @kenkaiiii/gg-agent@5.19.0
- @kenkaiiii/gg-core@5.19.0

## 5.18.0

### Minor Changes

- e00de5b: Add Kimi K3 as Moonshot's default model with its 1M-token multimodal registry metadata and endpoint-specific max-effort request handling for both the public API and Kimi Code OAuth. Keep Kimi K2.7 Code available as the dedicated coding alternative.

### Patch Changes

- Updated dependencies [e00de5b]
  - @kenkaiiii/gg-ai@5.18.0
  - @kenkaiiii/gg-core@5.18.0
  - @kenkaiiii/gg-agent@5.18.0

## 5.17.0

### Minor Changes

- a3916ff: Harden provider error handling, cancellation settlement, review evidence, LSP confidence, route-aware context limits, turn metrics, and durable child-agent recovery.

### Patch Changes

- Updated dependencies [a3916ff]
  - @kenkaiiii/gg-ai@5.17.0
  - @kenkaiiii/gg-agent@5.17.0
  - @kenkaiiii/gg-core@5.17.0

## 5.16.0

### Minor Changes

- Add persistent Jiwa behavior instructions for GG Chat, with dedicated curation tools and safer loop detection that avoids interrupting healthy progress.

### Patch Changes

- 25601bd: Bundle the evidence-led UI skill for every GG Coder installation, require models to invoke matching skills before acting, honor explicit exclusions and precedence, and align GG Coder and Ken's UI guidance around evidence-led implementation.
  - @kenkaiiii/gg-ai@5.16.0
  - @kenkaiiii/gg-agent@5.16.0
  - @kenkaiiii/gg-core@5.16.0

## 5.15.1

### Patch Changes

- Restore previous coding sessions in the desktop project picker after switching from Chat.
  - @kenkaiiii/gg-ai@5.15.1
  - @kenkaiiii/gg-agent@5.15.1
  - @kenkaiiii/gg-core@5.15.1

## 5.15.0

### Minor Changes

- Make chat-agent delegation switch the active agent in place while preserving conversation history and restoring handoffs across resumed sessions.

### Patch Changes

- @kenkaiiii/gg-ai@5.15.0
- @kenkaiiii/gg-agent@5.15.0
- @kenkaiiii/gg-core@5.15.0

## 5.14.0

### Minor Changes

- Add specialist chat agents, safer multi-window sessions, hardened web tools, and live provider usage tracking.

### Patch Changes

- @kenkaiiii/gg-ai@5.14.0
- @kenkaiiii/gg-agent@5.14.0
- @kenkaiiii/gg-core@5.14.0

## 5.13.3

### Patch Changes

- Align OpenAI prompt caching with Codex and improve cache-safe sub-agent routing.
  - @kenkaiiii/gg-ai@5.13.3
  - @kenkaiiii/gg-agent@5.13.3
  - @kenkaiiii/gg-core@5.13.3

## 5.13.2

### Patch Changes

- c0553e1: Bound historical tool-call arguments during compaction and stop retrying timed-out summary requests.
  - @kenkaiiii/gg-ai@5.13.2
  - @kenkaiiii/gg-agent@5.13.2
  - @kenkaiiii/gg-core@5.13.2

## 5.13.1

### Patch Changes

- Keep internet radio playback continuous while changing volume.
  - @kenkaiiii/gg-ai@5.13.1
  - @kenkaiiii/gg-agent@5.13.1
  - @kenkaiiii/gg-core@5.13.1

## 5.13.0

### Minor Changes

- Add parallel specialist orchestration and reliable app-exit radio cleanup.

### Patch Changes

- @kenkaiiii/gg-ai@5.13.0
- @kenkaiiii/gg-agent@5.13.0
- @kenkaiiii/gg-core@5.13.0

## 5.12.0

### Minor Changes

- Add concurrent async subagent orchestration with steering, follow-up, interruption, lifecycle tracking, and shared-workspace safeguards.

### Patch Changes

- @kenkaiiii/gg-ai@5.12.0
- @kenkaiiii/gg-agent@5.12.0
- @kenkaiiii/gg-core@5.12.0

## 5.11.0

### Minor Changes

- Add GPT-5.6 Ultra orchestration with proactive parallel subagent delegation.

### Patch Changes

- @kenkaiiii/gg-ai@5.11.0
- @kenkaiiii/gg-agent@5.11.0
- @kenkaiiii/gg-core@5.11.0

## 5.10.1

### Patch Changes

- Fix GPT-5.6 Sol, Terra, and Luna access through the ChatGPT Codex transport.
  - @kenkaiiii/gg-ai@5.10.1
  - @kenkaiiii/gg-agent@5.10.1
  - @kenkaiiii/gg-core@5.10.1

## 5.10.0

### Minor Changes

- Add OAuth subscription usage snapshots for Anthropic and OpenAI Codex.

### Patch Changes

- @kenkaiiii/gg-ai@5.10.0
- @kenkaiiii/gg-agent@5.10.0
- @kenkaiiii/gg-core@5.10.0

## 5.9.7

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-core@5.9.7
  - @kenkaiiii/gg-ai@5.9.7
  - @kenkaiiii/gg-agent@5.9.7

## 5.9.6

### Patch Changes

- Retry read-only sub-agents on the active parent model when the cheaper model is unavailable.
  - @kenkaiiii/gg-ai@5.9.6
  - @kenkaiiii/gg-agent@5.9.6
  - @kenkaiiii/gg-core@5.9.6

## 5.9.5

### Patch Changes

- Add GPT-5.6 Sol, Terra, and Luna models to the registry; remove GPT-5.4, GPT-5.4 Mini, and GPT-5.3 Codex. Fix provider error hints to reference the model selector instead of CLI-only slash commands so they work in both the desktop app and the CLI.
  - @kenkaiiii/gg-ai@5.9.5
  - @kenkaiiii/gg-agent@5.9.5
  - @kenkaiiii/gg-core@5.9.5

## 5.9.4

### Patch Changes

- Auto-recover from context-overflow errors in the desktop app (request_too_large / 413) by wiring force-compaction + retry into AgentSession, add explicit 413 guidance, and rebrand user-facing error text to "GG Coder".
  - @kenkaiiii/gg-ai@5.9.4
  - @kenkaiiii/gg-agent@5.9.4
  - @kenkaiiii/gg-core@5.9.4

## 5.9.3

### Patch Changes

- Fix Gemini models over Code Assist OAuth: use the GA IDs from gemini-cli (`gemini-3.1-flash-lite`, wire name `gemini-3-flash` for Gemini 3.5 Flash), add Gemini 3.1 Pro (Preview) to the registry, and surface account-gated 404s as a clear entitlement message with actionable guidance instead of a raw provider error body.
  - @kenkaiiii/gg-ai@5.9.3
  - @kenkaiiii/gg-agent@5.9.3
  - @kenkaiiii/gg-core@5.9.3

## 5.9.2

### Patch Changes

- Fix retroactive XP seeding so heavy prior users spread across levels 15-25 instead of all clamping onto level 15. Full credit up to level 15, then diminishing returns beyond, hard-capped at level 25.
  - @kenkaiiii/gg-ai@5.9.2
  - @kenkaiiii/gg-agent@5.9.2
  - @kenkaiiii/gg-core@5.9.2

## 5.9.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@5.9.1
  - @kenkaiiii/gg-agent@5.9.1
  - @kenkaiiii/gg-core@5.9.1

## 5.9.0

### Minor Changes

- Hash-anchored span edits and opt-in persistent bash session. The edit tool gains a `{ span, lines }` form: pin a line range by its line+hash anchors from a `read` with `anchors:true` and supply only the replacement lines — no retyping existing code, stale files rejected before any write. Benchmarked on Sonnet 5 at −19% output tokens overall and −76% on repetitive code, with equal correctness. The bash tool gains `persist: true`: commands run in a long-lived session shell where cd, env vars, and shell state survive across calls (~0.3ms vs ~6.4ms per-call overhead).

### Patch Changes

- @kenkaiiii/gg-ai@5.9.0
- @kenkaiiii/gg-agent@5.9.0
- @kenkaiiii/gg-core@5.9.0

## 5.8.8

### Patch Changes

- Fix transient Ken sessions leaking to the session store (compact() and newSession() now respect the transient flag), harden autopilot verdict parsing to recover a buried line-start PROMPT keyword, and tighten Ken's autopilot contract so reasoning prose never precedes the verdict.
  - @kenkaiiii/gg-ai@5.8.8
  - @kenkaiiii/gg-agent@5.8.8
  - @kenkaiiii/gg-core@5.8.8

## 5.8.7

### Patch Changes

- Cut MCP server memory: resolve stdio servers to their real bin (via the npx on-demand cache and sole-bin matching) instead of falling back to the ~90 MB npx wrapper per connection. Covers non-bundled defaults like zai and any user-added MCP.
  - @kenkaiiii/gg-ai@5.8.7
  - @kenkaiiii/gg-agent@5.8.7
  - @kenkaiiii/gg-core@5.8.7

## 5.8.6

### Patch Changes

- Fix autopilot leaking the raw HUMAN verdict reason and teach Ken GG Coder's own capabilities so his guidance is grounded in what the tool can actually do.
  - @kenkaiiii/gg-ai@5.8.6
  - @kenkaiiii/gg-agent@5.8.6
  - @kenkaiiii/gg-core@5.8.6

## 5.8.5

### Patch Changes

- Autopilot now tells GG Coder when no human is watching: injected review prompts carry a situational-awareness preamble so the agent self-verifies its work and stops asking permission for safe, already-implied steps, while the transcript and resumed sessions still show Ken's clean instruction.
  - @kenkaiiii/gg-ai@5.8.5
  - @kenkaiiii/gg-agent@5.8.5
  - @kenkaiiii/gg-core@5.8.5

## 5.8.4

### Patch Changes

- Route read-only scout sub-agents (recon/research) to each provider's fast/cheap model via `costTier`, cutting sub-agent latency and spend with no quality risk. Writers and default sub-agents keep the parent model.
  - @kenkaiiii/gg-ai@5.8.4
  - @kenkaiiii/gg-agent@5.8.4
  - @kenkaiiii/gg-core@5.8.4

## 5.8.3

### Patch Changes

- Fix Anthropic empty-args tool calls and underscore-path project discovery. Truncated tool-input JSON now surfaces as a retryable parse error instead of emitting a phantom `args:{}` call, and eager/fine-grained tool streaming is gated behind a default-off flag. Project discovery reads the real cwd from ggcoder session headers, so projects whose path contains an underscore no longer vanish from the picker.
  - @kenkaiiii/gg-ai@5.8.3
  - @kenkaiiii/gg-agent@5.8.3
  - @kenkaiiii/gg-core@5.8.3

## 5.8.2

### Patch Changes

- Ship deferred MCP tools, leaner prompts, and smoother retry recovery for faster coding-agent turns.
  - @kenkaiiii/gg-ai@5.8.2
  - @kenkaiiii/gg-agent@5.8.2
  - @kenkaiiii/gg-core@5.8.2

## 5.8.1

### Patch Changes

- Session resume now renders 1:1 with the live transcript: stale autopilot all-clear markers are deduped and range-clamped (no more duplicate Ken bubbles bunching at the bottom of reopened sessions), queued steering prompts resume as clean bubbles without the internal wrapper, Ken "Send to GG Coder" labels, enhancer highlights, plan-mode banners, task headers, error rows, and compaction counts all persist and restore, and all-clear wording is deterministic across reopens.
  - @kenkaiiii/gg-ai@5.8.1
  - @kenkaiiii/gg-agent@5.8.1
  - @kenkaiiii/gg-core@5.8.1

## 5.8.0

### Minor Changes

- Autopilot now reviews submitted plans itself, auto-approves sound plans, requests revisions when needed, and starts implementation without a human blocker.

### Patch Changes

- @kenkaiiii/gg-ai@5.8.0
- @kenkaiiii/gg-agent@5.8.0
- @kenkaiiii/gg-core@5.8.0

## 5.7.0

### Minor Changes

- Add XP progression system: rank engine, git-based XP, persistent progress store, and sidecar progress endpoints powering the gg-app rank badge, scorecard, and level-up celebrations.

### Patch Changes

- @kenkaiiii/gg-ai@5.7.0
- @kenkaiiii/gg-agent@5.7.0
- @kenkaiiii/gg-core@5.7.0

## 5.6.3

### Patch Changes

- Fix duplicate session files created on every resume — resuming now appends to the original session file instead of forking a byte-identical copy each time.
  - @kenkaiiii/gg-ai@5.6.3
  - @kenkaiiii/gg-agent@5.6.3
  - @kenkaiiii/gg-core@5.6.3

## 5.6.2

### Patch Changes

- Optimize Ken mentor/autopilot prompt caching: fold static project context (CLAUDE.md/AGENTS.md) into the cached system prompt instead of resending it uncached every turn, and force long cache retention on Ken sessions independent of the user's global speed profile.
  - @kenkaiiii/gg-ai@5.6.2
  - @kenkaiiii/gg-agent@5.6.2
  - @kenkaiiii/gg-core@5.6.2

## 5.6.1

### Patch Changes

- Fix Ken autopilot gating, stranded prompt handling, and Ken model selection in the app sidecar.
  - @kenkaiiii/gg-ai@5.6.1
  - @kenkaiiii/gg-agent@5.6.1
  - @kenkaiiii/gg-core@5.6.1

## 5.6.0

### Minor Changes

- Autopilot Ken now has an IGNORE verdict for turns that were never real work (small talk, answered questions, mechanical git ops like commit/push), so trivial turns no longer produce a pointless "all clear" in the transcript.

### Patch Changes

- @kenkaiiii/gg-ai@5.6.0
- @kenkaiiii/gg-agent@5.6.0
- @kenkaiiii/gg-core@5.6.0

## 5.5.1

### Patch Changes

- Fix subagent tool allow-list crashing in the desktop app: the JSON-mode arg parser in `app-sidecar.ts` was missing the `--tools` flag, so any named agent with a `tools:` allow-list (bee, owl, researcher, worker) failed to spawn with "Unknown option '--tools'".
  - @kenkaiiii/gg-ai@5.5.1
  - @kenkaiiii/gg-agent@5.5.1
  - @kenkaiiii/gg-core@5.5.1

## 5.5.0

### Minor Changes

- Add autopilot Ken auto-review loop: after each turn a separate read-only Ken reviewer judges the work and either sends GG Coder back in with a fresh prompt, calls it all-clear, or flags for a human. Also auto-prune completed tasks from the sidecar task list.

### Patch Changes

- @kenkaiiii/gg-ai@5.5.0
- @kenkaiiii/gg-agent@5.5.0
- @kenkaiiii/gg-core@5.5.0

## 5.4.3

### Patch Changes

- Enforce subagent `tools:` frontmatter as an allowlist, raise the subagent turn cap to 50 with a clear cut-off signal when it's hit, and phrase `/init` and task-handoff notices for the gg-app UI instead of CLI keybinds.
  - @kenkaiiii/gg-ai@5.4.3
  - @kenkaiiii/gg-agent@5.4.3
  - @kenkaiiii/gg-core@5.4.3

## 5.4.2

### Patch Changes

- Auto-continue once when a tool call fails 3x with completely empty arguments (a provider stream glitch, not a model schema mistake), and correctly attribute the resulting error to the provider instead of mislabeling it a ggcoder bug.
  - @kenkaiiii/gg-ai@5.4.2
  - @kenkaiiii/gg-agent@5.4.2
  - @kenkaiiii/gg-core@5.4.2

## 5.4.1

### Patch Changes

- Fix gg-app auto-compaction not reserving headroom for a model's real output budget (e.g. GPT-5.5 over Codex OAuth: 272K window, up to 128K output), which let context grow until the provider rejected the turn with "exceeds the context window"; also fix the app's context-window footer to use the correct transport-specific window (Codex OAuth vs public API).
  - @kenkaiiii/gg-ai@5.4.1
  - @kenkaiiii/gg-agent@5.4.1
  - @kenkaiiii/gg-core@5.4.1

## 5.4.0

### Minor Changes

- Re-enable Claude Fable 5 in the model selector, and show clean, provider-attributed error messages (headline + guidance + reset time for usage limits) instead of raw JSON error blobs from providers like Xiaomi MiMo.

### Patch Changes

- @kenkaiiii/gg-ai@5.4.0
- @kenkaiiii/gg-agent@5.4.0
- @kenkaiiii/gg-core@5.4.0

## 5.3.0

### Minor Changes

- Add Xiaomi MiMo-V2.5-Pro-UltraSpeed, served over a separate API Credits endpoint. Xiaomi auth now supports both the existing Token Plan key and a new API Credits key — `mimo-v2.5-pro`/`mimo-v2.5` prefer the Token Plan and fall back to API Credits when that's all that's configured, while UltraSpeed requires API Credits. `ggcoder login` and the desktop login modal both let you choose which endpoint to authenticate with.

### Patch Changes

- @kenkaiiii/gg-ai@5.3.0
- @kenkaiiii/gg-agent@5.3.0
- @kenkaiiii/gg-core@5.3.0

## 5.2.0

### Minor Changes

- Add Claude Sonnet 5 (`claude-sonnet-5`, 1M context, 128k output, adaptive thinking) replacing Sonnet 4.6, and fix the Anthropic non-streaming fallback so it no longer trips the SDK's "Streaming is required for operations that may take longer than 10 minutes" pre-flight throw on large max_tokens.

### Patch Changes

- @kenkaiiii/gg-ai@5.2.0
- @kenkaiiii/gg-agent@5.2.0
- @kenkaiiii/gg-core@5.2.0

## 5.1.2

### Patch Changes

- Add a tool-steering clause that nudges the model to batch independent read-only calls (read, grep, ls, find) into one turn, cutting round-trips since tool execution is already parallel.
  - @kenkaiiii/gg-ai@5.1.2
  - @kenkaiiii/gg-agent@5.1.2
  - @kenkaiiii/gg-core@5.1.2

## 5.1.1

### Patch Changes

- Fix the gg-app Ken mentor sidecar so it follows model switches after it has been created.
  - @kenkaiiii/gg-ai@5.1.1
  - @kenkaiiii/gg-agent@5.1.1
  - @kenkaiiii/gg-core@5.1.1

## 5.1.0

### Minor Changes

- Add Ken Kai, a read-only mentor agent: a second AgentSession scoped by an `allowedTools` allow-list plus an `allowedMcpServers` whitelist (kencode-search) so it can research real code but never mutate the repo, with its advisory turns persisted alongside the build session as non-LLM custom entries that survive resume and compaction.

### Patch Changes

- @kenkaiiii/gg-ai@5.1.0
- @kenkaiiii/gg-agent@5.1.0
- @kenkaiiii/gg-core@5.1.0

## 5.0.0

### Major Changes

- Remove the `ggcoder pixel` error-tracking command and all gg-pixel SDK packages (breaking CLI change), and add test-drift detection to the ideal-review hook so editing a source file whose sibling test was left untouched now prompts the agent to update the stale test.

### Patch Changes

- @kenkaiiii/gg-ai@5.0.0
- @kenkaiiii/gg-agent@5.0.0
- @kenkaiiii/gg-core@5.0.0

## 4.15.0

### Minor Changes

- Add `code_search` AST-aware tool (TS/JS symbol chunking + BM25 ranking) and opt-in hashline anchors for read/edit (stale-edit rejection via line+hash guard).

### Patch Changes

- @kenkaiiii/gg-ai@4.15.0
- @kenkaiiii/gg-agent@4.15.0
- @kenkaiiii/gg-core@4.15.0

## 4.14.3

### Patch Changes

- Fix queued messages overriding the original task: mid-run steering prompts are now framed as concurrent instructions so the agent folds them into the current work instead of abandoning the original objective.
  - @kenkaiiii/gg-ai@4.14.3
  - @kenkaiiii/gg-agent@4.14.3
  - @kenkaiiii/gg-core@4.14.3

## 4.14.2

### Patch Changes

- Add prompt-enhancer sidecar capability with project-stack-aware terminology, and harden image attachments — malformed/unsupported images (e.g. a bad .ico) now degrade to a file note instead of failing the whole turn.
  - @kenkaiiii/gg-ai@4.14.2
  - @kenkaiiii/gg-agent@4.14.2
  - @kenkaiiii/gg-core@4.14.2

## 4.14.1

### Patch Changes

- Fix Anthropic 1h prompt-cache TTL by sending the extended-cache-ttl beta header on the streaming and prewarm paths, so `cacheRetention: "long"` no longer silently falls back to the 5-minute default.
  - @kenkaiiii/gg-ai@4.14.1
  - @kenkaiiii/gg-agent@4.14.1
  - @kenkaiiii/gg-core@4.14.1

## 4.14.0

### Minor Changes

- Add Sakana Fugu provider (Fugu, Fugu Ultra) with API-key login, high/xhigh reasoning, and a silent-reasoning stream-timeout extension.

### Patch Changes

- @kenkaiiii/gg-ai@4.14.0
- @kenkaiiii/gg-agent@4.14.0
- @kenkaiiii/gg-core@4.14.0

## 4.13.3

### Patch Changes

- Fix orphaned queued messages after an abort — drain the post-abort queue even when the run was interrupted, so a reprompt during async teardown isn't stranded.
  - @kenkaiiii/gg-ai@4.13.3
  - @kenkaiiii/gg-agent@4.13.3
  - @kenkaiiii/gg-core@4.13.3

## 4.13.2

### Patch Changes

- Add tool-call and error logging to the gg-app sidecar event bridge so fatal "invalid tool arguments" aborts leave a forensic trail in `~/.gg/gg-app-sidecar.log` (tool name, isError, result preview, and agent error events) instead of failing silently.
  - @kenkaiiii/gg-ai@4.13.2
  - @kenkaiiii/gg-agent@4.13.2
  - @kenkaiiii/gg-core@4.13.2

## 4.13.1

### Patch Changes

- Spawn dependency-backed stdio MCP servers (e.g. the default kencode-search)
  directly via `node <binScript>` instead of `npx -y <pkg>`, removing the ~100 MB
  `npm exec` wrapper process per MCP connection. Non-dependency / non-npx servers
  pass through unchanged.

  Also ships content-aware compression for bash/task_output truncation (preserves
  errors over blind tail slices) and the gg-app shared-daemon backend refactor.
  - @kenkaiiii/gg-ai@4.13.1
  - @kenkaiiii/gg-agent@4.13.1
  - @kenkaiiii/gg-core@4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.13.0
  - @kenkaiiii/gg-agent@4.13.0
  - @kenkaiiii/gg-core@4.13.0

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.2
  - @kenkaiiii/gg-agent@4.12.2
  - @kenkaiiii/gg-core@4.12.2

## 4.12.1

### Patch Changes

- Add performance benchmarks and optimize streaming, tool execution, and rendering pipeline
  - edit-diff: lazy normalization cache for fuzzy matching (5-7× faster on large files)
  - ls: parallel stat() via Promise.all (3.7-5.5× faster on large dirs)
  - StreamResult: backpressure with high/low-water marks to bound memory (10× reduction)
  - agent-loop: mixed-mode tool execution batches consecutive parallel-safe tools (2-10× faster)
  - agent-loop: per-tool timeout isolation via AbortSignal.any (prevents indefinite hangs)
  - agent-loop: gate diagnostic char-counting behind \_diagFn (eliminates per-turn overhead)
  - Markdown.tsx: block-level memoization via marked.lexer (only active block re-parses)
  - App.tsx: requestAnimationFrame-throttled appendAssistant (5-10× fewer re-renders)
  - benchmarks: full harness with before/after comparison tables (pnpm bench)

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.1
  - @kenkaiiii/gg-agent@4.12.1
  - @kenkaiiii/gg-core@4.12.1

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.0
  - @kenkaiiii/gg-agent@4.12.0
  - @kenkaiiii/gg-core@4.12.0

## 4.11.3

### Patch Changes

- 1c37b11: Persist model + thinking selection per-project (per window) across app restarts.

  Previously every window's sidecar wrote its model choice to a single shared
  `defaultModel`/`defaultProvider` slot in `~/.gg/settings.json`, so switching a
  model in one window clobbered the selection for all others — and on restart
  every window defaulted to the last-written model (or fell back to the provider
  default when that provider wasn't logged in). Model + thinking preferences are
  now stored keyed by project cwd in `~/.gg/gg-app.json` and read first on boot;
  the global slot is kept only as a fallback for never-opened projects.
  - @kenkaiiii/gg-ai@4.11.3
  - @kenkaiiii/gg-agent@4.11.3
  - @kenkaiiii/gg-core@4.11.3

## 4.11.2

### Patch Changes

- a2da1f8: Fix app subagents to inherit the active model at spawn time and render completed plan-step markers cleanly.
  - @kenkaiiii/gg-ai@4.11.2
  - @kenkaiiii/gg-agent@4.11.2
  - @kenkaiiii/gg-core@4.11.2

## 4.11.1

### Patch Changes

- Fix sub-agents hanging until timeout when spawned from a host whose `argv[1]`
  isn't the CLI entry (e.g. the desktop app's sidecar). The subagent tool now
  resolves `dist/cli.js` relative to its own module instead of trusting
  `process.argv[1]`, so sub-agents run and stream NDJSON correctly in every host.
  - @kenkaiiii/gg-ai@4.11.1
  - @kenkaiiii/gg-agent@4.11.1
  - @kenkaiiii/gg-core@4.11.1

## 4.11.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-core@4.11.0
  - @kenkaiiii/gg-ai@4.11.0
  - @kenkaiiii/gg-agent@4.11.0

## 4.10.2

### Patch Changes

- Fix duplicated transcript text and random whitespace in the terminal UI. The
  bottom-pinned shrink-backfill repaint reconstructed the on-screen transcript by
  re-serializing history (markdown re-render + wrapAnsi); when a row's visual
  width diverged from the terminal (wide emoji, bold/italic markdown, CJK) the
  rebuilt row count disagreed with ink's frame math, causing the repaint to
  overlap still-present rows (duplicate lines) or pad short with blank rows
  (injected whitespace). It fired on nearly every turn. The repaint is now
  disabled by default — ink falls back to a cursor-up pad-consume that never
  repaints content — eliminating both failure modes. Opt back in with
  `GG_SHRINK_BACKFILL=1`. Also adds `[scrollback]` debug logging across every
  native-scrollback write path.
  - @kenkaiiii/gg-ai@4.10.2
  - @kenkaiiii/gg-agent@4.10.2
  - @kenkaiiii/gg-core@4.10.2

## 4.10.1

### Patch Changes

- Fix `ggcoder continue` resuming the newest-created session instead of the one you last spoke in (now sorts by last-message activity), and fix inline-image scrollback corruption (base64 spew, duplicated lines, and misaligned images) by bailing the shrink-backfill text repaint when the transcript contains an image.
  - @kenkaiiii/gg-ai@4.10.1
  - @kenkaiiii/gg-agent@4.10.1
  - @kenkaiiii/gg-core@4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.10.0
  - @kenkaiiii/gg-agent@4.10.0
  - @kenkaiiii/gg-core@4.10.0

## 4.9.1

### Patch Changes

- Fix blank rows being reserved above short live content during streaming. The
  live-area height estimate over-counted non-text rows (slash-command info lines,
  tool/step markers), which falsely clamped the live area to its full budget and
  bottom-anchored the content — leaving a block of empty rows above it until the
  rows flushed to history. The estimate is now biased low; Ink's
  clipFrameToTerminalHeight remains the authoritative overflow backstop.
  - @kenkaiiii/gg-ai@4.9.1
  - @kenkaiiii/gg-agent@4.9.1
  - @kenkaiiii/gg-core@4.9.1

## 4.9.0

### Minor Changes

- Add LSP inline diagnostics to the edit/write tools. Successful edits now append
  compiler-grade error diagnostics (`Diagnostics in src/a.ts (informational …):
L42:7 Type 'string' is not assignable …`) so the model self-corrects type errors
  in the same turn. `typescript-language-server` + `typescript` ship bundled, so
  TS/JS diagnostics work for every user with zero setup; Python/Go/Rust/C servers
  are auto-detected from the project or PATH when present. Servers spawn lazily,
  are time-budgeted, and degrade silently — output is byte-identical when no server
  is available. Opt out with `"lspDiagnostics": false` in `~/.gg/settings.json`.

### Patch Changes

- @kenkaiiii/gg-ai@4.9.0
- @kenkaiiii/gg-agent@4.9.0
- @kenkaiiii/gg-core@4.9.0

## 4.8.7

### Patch Changes

- Fix the intermittent blank-row block appearing right before the agent's final response: the patched ink's bottom-anchor pad debt left over from a run-end frame shrink is now reclaimed when the anchor deactivates (ink fork 6.8.0-gg.2). Also: oversized flushed assistant prefixes leave live state immediately, and null-rendering items no longer inflate the live-area clamp estimate.
  - @kenkaiiii/gg-ai@4.8.7
  - @kenkaiiii/gg-agent@4.8.7
  - @kenkaiiii/gg-core@4.8.7

## 4.8.6

### Patch Changes

- Fix message vanish on slash-command submit: queueFlush now mirrors flushed rows into sessionStore.history synchronously so the patched ink's bottom-pinned repaint (menu close, resize) redraws from a current transcript. Also track /theme switches live so closure-level repaint serializers always use the active theme, not the startup theme.
  - @kenkaiiii/gg-ai@4.8.6
  - @kenkaiiii/gg-agent@4.8.6
  - @kenkaiiii/gg-core@4.8.6

## 4.8.5

### Patch Changes

- Ship the patched Ink rendering engine to npm installs. The TUI's footer-anchor and scrollback fixes live in a patched ink build that pnpm's patchedDependencies only applied inside the workspace — npm users silently got vanilla ink. ggcoder's ink dependency is now an npm alias to the published @kenkaiiii/ink fork, so every install (npm, pnpm, yarn, bun) gets the fixed renderer with no install scripts.
  - @kenkaiiii/gg-ai@4.8.5
  - @kenkaiiii/gg-agent@4.8.5
  - @kenkaiiii/gg-core@4.8.5

## 4.8.4

### Patch Changes

- Fix footer jumps and scrollback whitespace/duplication in the scrollback-mode TUI. The patched Ink now folds transcript flushes atomically into frame writes (insertBeforeFrame), anchors the frame bottom with reclaimable pad debt while the agent runs, clips frames to terminal height, and repaints in place (cursor home + eraseDown) for bottom-pinned idle height changes like the slash-command menu — so the footer stays pinned, responses have no phantom gaps, and scrollback receives no duplicate banner/prompt copies.
  - @kenkaiiii/gg-ai@4.8.4
  - @kenkaiiii/gg-agent@4.8.4
  - @kenkaiiii/gg-core@4.8.4

## 4.8.3

### Patch Changes

- Fix oversized pinned assistant items being cut off in the live area: flush tall finalized items (cumulative over the pinned set) to scrollback, and keep the height-clamp slice from starting on a blank line so the ⏺ prefix stays aligned.
  - @kenkaiiii/gg-ai@4.8.3
  - @kenkaiiii/gg-agent@4.8.3
  - @kenkaiiii/gg-core@4.8.3

## 4.8.2

### Patch Changes

- Fix TUI scrollback corruption from streaming markdown tables and inline images: table-aware live-region row estimation, pending-table height clamping and partial-row hold-back in the markdown renderer, and fixed-height inline image blocks so Ink's live-frame erase math stays in sync (no more orphaned ⏺ rows).
  - @kenkaiiii/gg-ai@4.8.2
  - @kenkaiiii/gg-agent@4.8.2
  - @kenkaiiii/gg-core@4.8.2

## 4.8.1

### Patch Changes

- Fix ENOSPC crash when session transcript writes fail (disk full) — persistence now fails soft with a one-time warning instead of killing the live session. Add automatic session transcript pruning via new `sessionRetentionDays` setting (default 30 days, 0 disables).
  - @kenkaiiii/gg-ai@4.8.1
  - @kenkaiiii/gg-agent@4.8.1
  - @kenkaiiii/gg-core@4.8.1

## 4.8.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.8.0
  - @kenkaiiii/gg-core@4.8.0
  - @kenkaiiii/gg-agent@4.8.0

## 4.7.0

### Minor Changes

- Add `task_send` tool for interactive control of background processes. Background processes started with `run_in_background` now spawn with a stdin pipe, and the agent can answer prompts, drive REPLs, and feed scaffolders via `task_send` (with optional Enter/EOF), pairing with the existing `task_output`/`task_stop` tools.

### Patch Changes

- @kenkaiiii/gg-ai@4.7.0
- @kenkaiiii/gg-agent@4.7.0
- @kenkaiiii/gg-core@4.7.0

## 4.6.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.3
  - @kenkaiiii/gg-agent@4.6.3
  - @kenkaiiii/gg-core@4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.
- Updated dependencies
  - @kenkaiiii/gg-core@4.6.2
  - @kenkaiiii/gg-ai@4.6.2
  - @kenkaiiii/gg-agent@4.6.2

## 4.6.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1
  - @kenkaiiii/gg-agent@4.6.1
  - @kenkaiiii/gg-core@4.6.1

## 4.6.0

### Minor Changes

- Add Xiaomi MiMo-V2.5 models with native video analysis. The text-only
  `mimo-v2.5-pro` is now the Xiaomi default, and the omnimodal `mimo-v2.5`
  supports native image and video understanding. Video read through the read
  tool is now delivered to MiMo (and other non-Moonshot OpenAI-compatible video
  models) in a follow-up user message as inline base64 `video_url`, the shape
  the API accepts — fixing the fallback where the model resorted to ffmpeg frame
  extraction. The read tool is also rebuilt on model switch so its video
  capability tracks the active model.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0
  - @kenkaiiii/gg-agent@4.6.0
  - @kenkaiiii/gg-core@4.6.0

## 4.5.0

### Minor Changes

- Add native video analysis for Kimi K2.6, Gemini, and MiniMax. Attached and read videos are sent to the model in its required format (Kimi file-service upload, Gemini inlineData, MiniMax base64), with per-model size caps and automatic ffmpeg compression for oversized clips. Non-video models now show a clean "this model can't analyze video" message instead of an opaque provider error, and Kimi OAuth login was fixed to pass the coding-endpoint client identity.

### Patch Changes

- @kenkaiiii/gg-ai@4.5.0
- @kenkaiiii/gg-agent@4.5.0
- @kenkaiiii/gg-core@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-core@4.4.0
  - @kenkaiiii/gg-ai@4.4.0
  - @kenkaiiii/gg-agent@4.4.0
