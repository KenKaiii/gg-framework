# @kenkaiiii/gg-core

## 5.60.0

### Patch Changes

- @kenkaiiii/gg-ai@5.60.0

## 5.59.4

### Patch Changes

- @kenkaiiii/gg-ai@5.59.4

## 5.59.3

### Patch Changes

- @kenkaiiii/gg-ai@5.59.3

## 5.59.2

### Patch Changes

- @kenkaiiii/gg-ai@5.59.2

## 5.59.1

### Patch Changes

- @kenkaiiii/gg-ai@5.59.1

## 5.59.0

### Patch Changes

- @kenkaiiii/gg-ai@5.59.0

## 5.58.1

### Patch Changes

- @kenkaiiii/gg-ai@5.58.1

## 5.58.0

### Patch Changes

- @kenkaiiii/gg-ai@5.58.0

## 5.57.2

### Patch Changes

- @kenkaiiii/gg-ai@5.57.2

## 5.57.1

### Patch Changes

- @kenkaiiii/gg-ai@5.57.1

## 5.57.0

### Patch Changes

- @kenkaiiii/gg-ai@5.57.0

## 5.56.1

### Patch Changes

- @kenkaiiii/gg-ai@5.56.1

## 5.56.0

### Patch Changes

- @kenkaiiii/gg-ai@5.56.0

## 5.55.1

### Patch Changes

- @kenkaiiii/gg-ai@5.55.1

## 5.55.0

### Minor Changes

- 7ade77f: Fix GPT-6 Astra on the ChatGPT OAuth route. OpenAI gates Astra on the Codex client version (`minimal_client_version: 0.153.0`) and rejected our `0.144.1` header with "requires a newer version of Codex"; we now advertise `0.153.4`, the current openai/codex release. When a future model is gated the same way, the error guidance says plainly that GG Coder needs updating and to switch model meanwhile, instead of echoing OpenAI's "upgrade the app or CLI" as if it were the user's problem.

  Remove GPT-5.5 from the model registry, footers, login hub, README, and CLI defaults (OpenAI now defaults to GPT-5.6 Sol everywhere, matching the registry). Sync the desktop login hub descriptions with the registry for every provider (Claude Fable 5.1, GPT-6 Astra, GLM-5.3-Flash, OpenRouter Qwen3.6-Plus). Drop the last slash-command reference from a generic error hint so guidance reads correctly in the app.

### Patch Changes

- Updated dependencies [7ade77f]
  - @kenkaiiii/gg-ai@5.55.0

## 5.54.1

### Patch Changes

- @kenkaiiii/gg-ai@5.54.1

## 5.54.0

### Minor Changes

- 7ad7339: Add GPT-6 Astra (`gpt-6-astra`, released 2026-09-03) to the model registry — 1.05M context on the public Responses API, 272K on the ChatGPT OAuth/Codex route, 128k output, text+image input, $10/$50 MTok with cache reads at $1/MTok. It takes the full six-rung Codex effort ladder (low → medium → high → xhigh → max → ultra) and uses the same responses-lite transport and `prompt_cache_options` cache shape as the GPT-5.6 family; at `ultra` it receives the proactive async-subagent orchestration prompt, matching its `multi_agent v2` catalog entry.

  Astra is still rolling out (`visibility: hide` in OpenAI's Codex catalog), so accounts without access get the existing "not in the current Codex catalog" hint, which now names Astra among the alternatives. Through a plain OpenAI API key, OpenAI requires the Responses API for tool calling on Astra, so the Chat Completions path stays text-only — the OAuth Codex route is the supported way to run it as an agent.

### Patch Changes

- Updated dependencies [7ad7339]
  - @kenkaiiii/gg-ai@5.54.0

## 5.53.3

### Patch Changes

- @kenkaiiii/gg-ai@5.53.3

## 5.53.2

### Patch Changes

- @kenkaiiii/gg-ai@5.53.2

## 5.53.1

### Patch Changes

- @kenkaiiii/gg-ai@5.53.1

## 5.53.0

### Patch Changes

- @kenkaiiii/gg-ai@5.53.0

## 5.52.0

### Minor Changes

- 17ca096: Add Claude Fable 5.1 (`claude-fable-5-1`, released 2026-09-01) to the model registry — 1M context, 128k output, image input, always-on adaptive thinking on the low→max ladder (no xhigh), $10/$50 MTok with cache reads at $0.25/MTok. It replaces Fable 5, which is retired from the registry and the model picker — a session still pinned to it falls back to the provider default on next start. Fable 5.1 rejects forced tool use (`tool_choice` `any`/`tool`) with a 400; gg-coder only ever sends `auto`/`none`, so no call path changes.

  The login screen now derives its provider rows from `AUTH_PROVIDERS` instead of keeping a second hardcoded copy, and a new test pins every provider description to the model registry — which caught two stale ones: Z.AI now lists GLM-5.3-Flash alongside GLM-5.3, and OpenRouter names Qwen3.6-Plus rather than just "multi-provider gateway".

### Patch Changes

- Updated dependencies [17ca096]
  - @kenkaiiii/gg-ai@5.52.0

## 5.51.4

### Patch Changes

- @kenkaiiii/gg-ai@5.51.4

## 5.51.3

### Patch Changes

- @kenkaiiii/gg-ai@5.51.3

## 5.51.2

### Patch Changes

- @kenkaiiii/gg-ai@5.51.2

## 5.51.1

### Patch Changes

- @kenkaiiii/gg-ai@5.51.1

## 5.51.0

### Patch Changes

- @kenkaiiii/gg-ai@5.51.0

## 5.50.0

### Minor Changes

- 10138dd: **Add GLM-5.3-Flash.** Z.AI's 320B-A18B natively multimodal sibling of GLM-5.3 (released 2026-08-26) is live on the coding endpoint and now selectable. It carries the same 1M context and `max` thinking ceiling, but is natively multimodal — images go inline instead of taking the `zai_vision` MCP detour — and at ~1/20th of 5.3's price with 3× the coding-plan quota it becomes the GLM provider's low-cost tier, so scout sub-agents and compaction summaries route to it instead of paying GLM-5.3 rates.

### Patch Changes

- @kenkaiiii/gg-ai@5.50.0

## 5.49.11

### Patch Changes

- @kenkaiiii/gg-ai@5.49.11

## 5.49.10

### Patch Changes

- @kenkaiiii/gg-ai@5.49.10

## 5.49.9

### Patch Changes

- @kenkaiiii/gg-ai@5.49.9

## 5.49.8

### Patch Changes

- @kenkaiiii/gg-ai@5.49.8

## 5.49.7

### Patch Changes

- @kenkaiiii/gg-ai@5.49.7

## 5.49.6

### Patch Changes

- @kenkaiiii/gg-ai@5.49.6

## 5.49.5

### Patch Changes

- @kenkaiiii/gg-ai@5.49.5

## 5.49.4

### Patch Changes

- @kenkaiiii/gg-ai@5.49.4

## 5.49.3

### Patch Changes

- @kenkaiiii/gg-ai@5.49.3

## 5.49.2

### Patch Changes

- @kenkaiiii/gg-ai@5.49.2

## 5.49.1

### Patch Changes

- @kenkaiiii/gg-ai@5.49.1

## 5.49.0

### Minor Changes

- 05685fe: Add Gemini 3.7 Flash (`gemini-3.7-flash`, released 2026-08-13) and retarget `deepseek-v4-pro` to DeepSeek-V4-Pro-0813 under the same API id. 3.7 Flash is Google's most capable Flash for coding and agents — 1M context, 64K output, thinking low/medium/high, video input (20 MB inline cap) — listed as a selectable option for Gemini but kept non-default because it ships on our Code Assist transport ahead of gemini-cli (issue #28802 tracks upstream); free/personal accounts get the existing account-gated 404 guidance while entitled Code Assist Standard/Enterprise accounts can use it. DeepSeek's `deepseek-v4-pro` alias now serves the first stable V4 Pro (0813, supersedes the April preview, calling name unchanged): max output corrected to 393,216 and costTier dropped to `medium` to match the ~$0.43/$0.87 per-MTok pricing; saved sessions keep working since the id is unchanged.
- 05685fe: Add Grok 4.6 (`grok-4.6`, released 2026-08-12) to the model registry and make it the xAI default — 500K context, image input, $2/$6 MTok (under 200K prompt tokens), and a `reasoning_effort` ladder that adds a new `xhigh` top rung (`low`/`medium`/`high` default/`xhigh`), which `XAI_THINKING_LEVELS` now exposes; thinking starts at `xhigh`. Grok 4.5 stays registered as a legacy option, still capped at `high` since it rejects `xhigh`. The OpenAI-compatible transport needs no changes — `xhigh` passes through `toOpenAIReasoningEffort` unchanged — so both the public API and the Grok CLI OAuth proxy serve the new model; CLI/app login defaults point at `grok-4.6`.
- 05685fe: Add a first-class `huggingface` provider backed by Hugging Face's Inference Providers router (`https://router.huggingface.co/v1`, OpenAI-compatible Chat Completions, one HF token with "Make calls to Inference Providers" permission). Model ids are Hub repo paths: `Qwen/Qwen3-Coder-480B-A35B-Instruct` (default; 262K context, tool-native, non-thinking Coder line) and `openai/gpt-oss-120b` (low-tier sibling for summaries and scout sub-agents; reasoning effort low/medium/high). Auth is a static API key wired through the existing apikey login flow in both TUI and desktop app, with label/logo/order entries everywhere providers are enumerated (`config`/`settings-manager`/`app-sidecar`/`auth-providers`/`ModelSelector`/`login`/`provider-labels`/`provider-logos`). Local-weight users keep the existing routes: Ollama `hf.co/...` pulls and any self-hosted OpenAI-compatible server via local endpoints.
- 05685fe: Simplify local models to Ollama. The Connect AI Providers tile and its modal are renamed "Ollama", the tile carries Ollama's official mark, and `DEFAULT_LOCAL_ENDPOINTS` drops the LM Studio, llama.cpp, and vLLM auto-probes — the modal showed four rows when usually only Ollama exists. Those servers still work: "Add endpoint" adds any OpenAI-compatible URL as a custom endpoint (removable, as before), and the model picker's "Local" group is unchanged. Empty-state and scan copy now points at Ollama and the new "Add from Hugging Face" download flow. Login copy is also refreshed across both UIs: provider descriptions now match the model registry (Grok 4.6, Gemini 3.7 Flash), and the dual-auth guidance and priority notes are cut to one line each.

### Patch Changes

- Updated dependencies [05685fe]
- Updated dependencies [05685fe]
- Updated dependencies [05685fe]
  - @kenkaiiii/gg-ai@5.49.0

## 5.48.0

### Patch Changes

- @kenkaiiii/gg-ai@5.48.0

## 5.47.0

### Patch Changes

- @kenkaiiii/gg-ai@5.47.0

## 5.46.2

### Patch Changes

- @kenkaiiii/gg-ai@5.46.2

## 5.46.1

### Patch Changes

- @kenkaiiii/gg-ai@5.46.1

## 5.46.0

### Patch Changes

- @kenkaiiii/gg-ai@5.46.0

## 5.45.0

### Patch Changes

- @kenkaiiii/gg-ai@5.45.0

## 5.44.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@5.44.3

## 5.44.2

### Patch Changes

- @kenkaiiii/gg-ai@5.44.2

## 5.44.1

### Patch Changes

- @kenkaiiii/gg-ai@5.44.1

## 5.44.0

### Minor Changes

- bc99e74: **GLM-5.3 is now the only GLM model.** Z.AI's new coding-first flagship (released 2026-08-14) replaces GLM-5.2, and GLM-5.1 / GLM-4.7 / GLM-4.7 Flash are retired from the registry — they routed to strictly worse coding for the same plan quota, and the coding endpoint already answers `glm-5.2` requests as glm-5.3. Sessions saved on any retired id fall back to the provider default.

  Same GLM-5 base as 5.2 with every gain from post-training: Z.AI reports ~50% better coding and open-source SOTA on Terminal-Bench 3.0 and Agent's Last Exam. Context window (1M) and max output (131K) are unchanged, so compaction budgeting is untouched.

  **GLM thinking is now a real effort ladder, not an on/off toggle.** ggcoder previously sent only `thinking: { type: "enabled" }`, which silently ran Z.AI's `max` default at every setting. The endpoint in fact declares `none, minimal, low, medium, high, xhigh, max` (an unknown value 400s with that list), so `low / medium / high / xhigh / max` are now selectable and sent as `reasoning_effort` alongside the toggle. Measured end-to-end on one hard reasoning prompt: `low` → 0.8K reasoning chars in 15s, `high` → 3.2K in 28s, `max` → 24.9K in 129s. The default stays `max`, matching what the server was already doing, so existing behaviour is unchanged — but dialing effort _down_ is now possible for the first time.

  Note `max` is kept as `max` on the wire for GLM rather than remapped to `xhigh` the way OpenAI-compatible efforts are: GLM spells its own top rung `max`.

  With no low-cost GLM sibling left, compaction-summary and scout sub-agent routing keep GLM-5.3 instead of downshifting — the existing graceful fallback, no crash and no cross-provider jump.

### Patch Changes

- Updated dependencies [bc99e74]
  - @kenkaiiii/gg-ai@5.44.0

## 5.43.0

### Patch Changes

- @kenkaiiii/gg-ai@5.43.0

## 5.42.0

### Patch Changes

- @kenkaiiii/gg-ai@5.42.0

## 5.41.1

### Patch Changes

- @kenkaiiii/gg-ai@5.41.1

## 5.41.0

### Patch Changes

- @kenkaiiii/gg-ai@5.41.0

## 5.40.1

### Patch Changes

- @kenkaiiii/gg-ai@5.40.1

## 5.40.0

### Patch Changes

- @kenkaiiii/gg-ai@5.40.0

## 5.39.4

### Patch Changes

- @kenkaiiii/gg-ai@5.39.4

## 5.39.3

### Patch Changes

- @kenkaiiii/gg-ai@5.39.3

## 5.39.2

### Patch Changes

- @kenkaiiii/gg-ai@5.39.2

## 5.39.1

### Patch Changes

- @kenkaiiii/gg-ai@5.39.1

## 5.39.0

### Patch Changes

- @kenkaiiii/gg-ai@5.39.0

## 5.38.0

### Patch Changes

- @kenkaiiii/gg-ai@5.38.0

## 5.37.0

### Patch Changes

- @kenkaiiii/gg-ai@5.37.0

## 5.36.0

### Patch Changes

- @kenkaiiii/gg-ai@5.36.0

## 5.35.1

### Patch Changes

- Updated dependencies [8e124fd]
  - @kenkaiiii/gg-ai@5.35.1

## 5.35.0

### Patch Changes

- @kenkaiiii/gg-ai@5.35.0

## 5.34.3

### Patch Changes

- @kenkaiiii/gg-ai@5.34.3

## 5.34.2

### Patch Changes

- @kenkaiiii/gg-ai@5.34.2

## 5.34.1

### Patch Changes

- @kenkaiiii/gg-ai@5.34.1

## 5.34.0

### Patch Changes

- @kenkaiiii/gg-ai@5.34.0

## 5.33.0

### Patch Changes

- @kenkaiiii/gg-ai@5.33.0

## 5.32.0

### Patch Changes

- @kenkaiiii/gg-ai@5.32.0

## 5.31.0

### Patch Changes

- @kenkaiiii/gg-ai@5.31.0

## 5.30.3

### Patch Changes

- @kenkaiiii/gg-ai@5.30.3

## 5.30.2

### Patch Changes

- @kenkaiiii/gg-ai@5.30.2

## 5.30.1

### Patch Changes

- @kenkaiiii/gg-ai@5.30.1

## 5.30.0

### Patch Changes

- @kenkaiiii/gg-ai@5.30.0

## 5.29.1

### Patch Changes

- @kenkaiiii/gg-ai@5.29.1

## 5.29.0

### Patch Changes

- @kenkaiiii/gg-ai@5.29.0

## 5.28.0

### Patch Changes

- @kenkaiiii/gg-ai@5.28.0

## 5.27.0

### Patch Changes

- @kenkaiiii/gg-ai@5.27.0

## 5.26.3

### Patch Changes

- @kenkaiiii/gg-ai@5.26.3

## 5.26.2

### Patch Changes

- @kenkaiiii/gg-ai@5.26.2

## 5.26.1

### Patch Changes

- @kenkaiiii/gg-ai@5.26.1

## 5.26.0

### Patch Changes

- @kenkaiiii/gg-ai@5.26.0

## 5.25.0

### Patch Changes

- @kenkaiiii/gg-ai@5.25.0

## 5.24.0

### Patch Changes

- @kenkaiiii/gg-ai@5.24.0

## 5.23.3

### Patch Changes

- @kenkaiiii/gg-ai@5.23.3

## 5.23.2

### Patch Changes

- @kenkaiiii/gg-ai@5.23.2

## 5.23.1

### Patch Changes

- @kenkaiiii/gg-ai@5.23.1

## 5.23.0

### Minor Changes

- a6a78c2: Add Claude Opus 5 (`claude-opus-5`, released 2026-07-24) to the model registry — 1M context, 128k output, image input, adaptive thinking with the full effort ladder (low→max, xhigh included), $5/$25 MTok (same price as Opus 4.8). gg-ai treats it as an adaptive-thinking model (no interleaved-thinking beta, xhigh passes through), footers short-name it "Opus" (Opus 4.8 becomes "Opus 4.8"), login/provider descriptions mention it, and gg-boss's default boss model moves from `claude-opus-4-8` to `claude-opus-5`. Opus 4.8 stays registered as a legacy option.

### Patch Changes

- Updated dependencies [a6a78c2]
  - @kenkaiiii/gg-ai@5.23.0

## 5.22.6

### Patch Changes

- @kenkaiiii/gg-ai@5.22.6

## 5.22.5

### Patch Changes

- @kenkaiiii/gg-ai@5.22.5

## 5.22.4

### Patch Changes

- @kenkaiiii/gg-ai@5.22.4

## 5.22.3

### Patch Changes

- @kenkaiiii/gg-ai@5.22.3

## 5.22.2

### Patch Changes

- @kenkaiiii/gg-ai@5.22.2

## 5.22.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@5.22.1

## 5.22.0

### Patch Changes

- @kenkaiiii/gg-ai@5.22.0

## 5.21.0

### Patch Changes

- @kenkaiiii/gg-ai@5.21.0

## 5.20.5

### Patch Changes

- @kenkaiiii/gg-ai@5.20.5

## 5.20.4

### Patch Changes

- @kenkaiiii/gg-ai@5.20.4

## 5.20.3

### Patch Changes

- @kenkaiiii/gg-ai@5.20.3

## 5.20.2

### Patch Changes

- f4b8ec7: Cap each long-lived process at 10 MB of debug-log writes so noisy production paths cannot grow the active log without bound.
  - @kenkaiiii/gg-ai@5.20.2

## 5.20.1

### Patch Changes

- @kenkaiiii/gg-ai@5.20.1

## 5.20.0

### Patch Changes

- @kenkaiiii/gg-ai@5.20.0

## 5.19.6

### Patch Changes

- @kenkaiiii/gg-ai@5.19.6

## 5.19.5

### Patch Changes

- @kenkaiiii/gg-ai@5.19.5

## 5.19.4

### Patch Changes

- @kenkaiiii/gg-ai@5.19.4

## 5.19.3

### Patch Changes

- Updated dependencies [b6e7562]
  - @kenkaiiii/gg-ai@5.19.3

## 5.19.2

### Patch Changes

- @kenkaiiii/gg-ai@5.19.2

## 5.19.1

### Patch Changes

- @kenkaiiii/gg-ai@5.19.1

## 5.19.0

### Patch Changes

- @kenkaiiii/gg-ai@5.19.0

## 5.18.0

### Minor Changes

- e00de5b: Add Kimi K3 as Moonshot's default model with its 1M-token multimodal registry metadata and endpoint-specific max-effort request handling for both the public API and Kimi Code OAuth. Keep Kimi K2.7 Code available as the dedicated coding alternative.

### Patch Changes

- Updated dependencies [e00de5b]
  - @kenkaiiii/gg-ai@5.18.0

## 5.17.0

### Minor Changes

- a3916ff: Harden provider error handling, cancellation settlement, review evidence, LSP confidence, route-aware context limits, turn metrics, and durable child-agent recovery.

### Patch Changes

- Updated dependencies [a3916ff]
  - @kenkaiiii/gg-ai@5.17.0

## 5.16.0

### Patch Changes

- @kenkaiiii/gg-ai@5.16.0

## 5.15.1

### Patch Changes

- @kenkaiiii/gg-ai@5.15.1

## 5.15.0

### Patch Changes

- @kenkaiiii/gg-ai@5.15.0

## 5.14.0

### Patch Changes

- @kenkaiiii/gg-ai@5.14.0

## 5.13.3

### Patch Changes

- @kenkaiiii/gg-ai@5.13.3

## 5.13.2

### Patch Changes

- @kenkaiiii/gg-ai@5.13.2

## 5.13.1

### Patch Changes

- @kenkaiiii/gg-ai@5.13.1

## 5.13.0

### Patch Changes

- @kenkaiiii/gg-ai@5.13.0

## 5.12.0

### Patch Changes

- @kenkaiiii/gg-ai@5.12.0

## 5.11.0

### Patch Changes

- @kenkaiiii/gg-ai@5.11.0

## 5.10.1

### Patch Changes

- @kenkaiiii/gg-ai@5.10.1

## 5.10.0

### Patch Changes

- @kenkaiiii/gg-ai@5.10.0

## 5.9.7

### Patch Changes

- Expose low, medium, high, xhigh, and max reasoning selections for every GPT-5.6 model.
  - @kenkaiiii/gg-ai@5.9.7

## 5.9.6

### Patch Changes

- @kenkaiiii/gg-ai@5.9.6

## 5.9.5

### Patch Changes

- @kenkaiiii/gg-ai@5.9.5

## 5.9.4

### Patch Changes

- @kenkaiiii/gg-ai@5.9.4

## 5.9.3

### Patch Changes

- @kenkaiiii/gg-ai@5.9.3

## 5.9.2

### Patch Changes

- @kenkaiiii/gg-ai@5.9.2

## 5.9.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@5.9.1

## 5.9.0

### Patch Changes

- @kenkaiiii/gg-ai@5.9.0

## 5.8.8

### Patch Changes

- @kenkaiiii/gg-ai@5.8.8

## 5.8.7

### Patch Changes

- @kenkaiiii/gg-ai@5.8.7

## 5.8.6

### Patch Changes

- @kenkaiiii/gg-ai@5.8.6

## 5.8.5

### Patch Changes

- @kenkaiiii/gg-ai@5.8.5

## 5.8.4

### Patch Changes

- @kenkaiiii/gg-ai@5.8.4

## 5.8.3

### Patch Changes

- @kenkaiiii/gg-ai@5.8.3

## 5.8.2

### Patch Changes

- @kenkaiiii/gg-ai@5.8.2

## 5.8.1

### Patch Changes

- @kenkaiiii/gg-ai@5.8.1

## 5.8.0

### Patch Changes

- @kenkaiiii/gg-ai@5.8.0

## 5.7.0

### Patch Changes

- @kenkaiiii/gg-ai@5.7.0

## 5.6.3

### Patch Changes

- @kenkaiiii/gg-ai@5.6.3

## 5.6.2

### Patch Changes

- @kenkaiiii/gg-ai@5.6.2

## 5.6.1

### Patch Changes

- @kenkaiiii/gg-ai@5.6.1

## 5.6.0

### Patch Changes

- @kenkaiiii/gg-ai@5.6.0

## 5.5.1

### Patch Changes

- @kenkaiiii/gg-ai@5.5.1

## 5.5.0

### Patch Changes

- @kenkaiiii/gg-ai@5.5.0

## 5.4.3

### Patch Changes

- @kenkaiiii/gg-ai@5.4.3

## 5.4.2

### Patch Changes

- @kenkaiiii/gg-ai@5.4.2

## 5.4.1

### Patch Changes

- @kenkaiiii/gg-ai@5.4.1

## 5.4.0

### Patch Changes

- @kenkaiiii/gg-ai@5.4.0

## 5.3.0

### Patch Changes

- @kenkaiiii/gg-ai@5.3.0

## 5.2.0

### Patch Changes

- @kenkaiiii/gg-ai@5.2.0

## 5.1.2

### Patch Changes

- @kenkaiiii/gg-ai@5.1.2

## 5.1.1

### Patch Changes

- @kenkaiiii/gg-ai@5.1.1

## 5.1.0

### Patch Changes

- @kenkaiiii/gg-ai@5.1.0

## 5.0.0

### Patch Changes

- @kenkaiiii/gg-ai@5.0.0

## 4.15.0

### Patch Changes

- @kenkaiiii/gg-ai@4.15.0

## 4.14.3

### Patch Changes

- @kenkaiiii/gg-ai@4.14.3

## 4.14.2

### Patch Changes

- @kenkaiiii/gg-ai@4.14.2

## 4.14.1

### Patch Changes

- @kenkaiiii/gg-ai@4.14.1

## 4.14.0

### Patch Changes

- @kenkaiiii/gg-ai@4.14.0

## 4.13.3

### Patch Changes

- @kenkaiiii/gg-ai@4.13.3

## 4.13.2

### Patch Changes

- @kenkaiiii/gg-ai@4.13.2

## 4.13.1

### Patch Changes

- @kenkaiiii/gg-ai@4.13.1

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

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.2

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

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.0

## 4.11.3

### Patch Changes

- @kenkaiiii/gg-ai@4.11.3

## 4.11.2

### Patch Changes

- @kenkaiiii/gg-ai@4.11.2

## 4.11.1

### Patch Changes

- @kenkaiiii/gg-ai@4.11.1

## 4.11.0

### Minor Changes

- Add GLM-5.2 as a new model — Z.ai's coding-first flagship with a usable 1M-token
  context window and 131K max output. It is now the default model for the `glm`
  provider (registry + CLI defaults updated; app sidecar rebundled).

### Patch Changes

- @kenkaiiii/gg-ai@4.11.0

## 4.10.2

### Patch Changes

- @kenkaiiii/gg-ai@4.10.2

## 4.10.1

### Patch Changes

- @kenkaiiii/gg-ai@4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.10.0

## 4.9.1

### Patch Changes

- @kenkaiiii/gg-ai@4.9.1

## 4.9.0

### Patch Changes

- @kenkaiiii/gg-ai@4.9.0

## 4.8.7

### Patch Changes

- @kenkaiiii/gg-ai@4.8.7

## 4.8.6

### Patch Changes

- @kenkaiiii/gg-ai@4.8.6

## 4.8.5

### Patch Changes

- @kenkaiiii/gg-ai@4.8.5

## 4.8.4

### Patch Changes

- @kenkaiiii/gg-ai@4.8.4

## 4.8.3

### Patch Changes

- @kenkaiiii/gg-ai@4.8.3

## 4.8.2

### Patch Changes

- @kenkaiiii/gg-ai@4.8.2

## 4.8.1

### Patch Changes

- @kenkaiiii/gg-ai@4.8.1

## 4.8.0

### Minor Changes

- Add Claude Fable 5 (`claude-fable-5`) and Claude Mythos 5 (`claude-mythos-5`) to the model registry with adaptive thinking (low→max), correct beta-header handling in the Anthropic provider, footer short names, and a clear invite-only (Project Glasswing) error for Mythos instead of the raw `not_found_error`.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.8.0

## 4.7.0

### Patch Changes

- @kenkaiiii/gg-ai@4.7.0

## 4.6.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.2

## 4.6.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1

## 4.6.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0

## 4.5.0

### Patch Changes

- @kenkaiiii/gg-ai@4.5.0

## 4.4.0

### Minor Changes

- 9e381ad: Extract `@kenkaiiii/gg-core` — a provider-agnostic, UI-free shared foundation
  that owns the model registry, thinking levels, app paths, OAuth + auth storage,
  the file-writer logger core, telegram + voice transcription, and the
  self-updater. ggcoder, gg-boss, and gg-editor now inherit a single source of
  truth for provider-coupled code instead of maintaining duplicates.

  Move provider-error classification into `@kenkaiiii/gg-ai` as
  `classifyProviderError`, reconciled with `isHardBillingMessage` so billing
  wording lives in one place.

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-ai@4.4.0
