import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { isKimiCodingEndpoint } from "./oauth/kimi.js";
import { MOONSHOT_OAUTH_KEY, XIAOMI_CREDITS_KEY } from "./auth-storage.js";

export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
  contextWindow: number;
  /**
   * ChatGPT Codex transport uses product-specific windows that can differ from
   * the public API model window. OpenAI OAuth requests include an accountId and
   * route through `/codex/responses`; API-key requests do not.
   */
  codexContextWindow?: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  /**
   * Vendor-declared default reasoning level (Codex models.json
   * `default_reasoning_level`). When present, fresh sessions start here rather
   * than at the ceiling: the deep-reasoning models (Astra and GPT-6.1 Sol ship
   * "low", GPT-6 Luna "medium") think dramatically longer per rung, so defaulting to
   * `maxThinkingLevel` made new sessions pathologically slow.
   */
  defaultThinkingLevel?: ThinkingLevel;
  supportsImages: boolean;
  supportsVideo: boolean;
  /**
   * Max video payload (bytes) this model's transport accepts, used to decide
   * when an attached/read video must be compressed before sending. Differs by
   * provider delivery mechanism:
   *   - Moonshot/Kimi: 100 MB (file-service upload cap)
   *   - MiniMax: 50 MB (Anthropic-compatible base64 inline cap)
   *   - Gemini: 20 MB (inlineData per-request cap)
   *   - Xiaomi (MiMo): ~36 MB raw — the API caps the base64 STRING at 50 MB,
   *     and base64 inflates bytes by ~4/3, so 36 MB raw ≈ 48 MB encoded.
   * Only meaningful when `supportsVideo` is true.
   */
  maxVideoBytes?: number;
  costTier: "low" | "medium" | "high";
  /**
   * The top reasoning tier this model genuinely uses. Used when thinking is
   * enabled to pick the strongest setting per model:
   *   - OpenAI GPT-6 Astra / GPT-6.1 Sol: `ultra` (Codex orchestration preset above `max`)
   *   - OpenAI GPT-6 Luna: `max`
   *   - OpenAI Pro/Codex/old: clamped to what the model accepts
   *   - Claude Fable 5.1 / Fable 5 / Mythos 5, Opus 5.5, Sonnet 5.5 and
   *     Haiku 5.5: `max` (the Fable / Mythos line uses always-on adaptive
   *     thinking, low→max)
   *   - Kimi K3: `max` (always-on reasoning; currently the only API effort)
   *   - xAI Grok 4.6: `xhigh` (new top rung; 4.5 caps at `high`)
   *   - GLM / Kimi K2.x / Xiaomi / MiniMax / Qwen: `high` — binary-thinking
   *     providers ignore the level on the wire, so the value is cosmetic
   *   - DeepSeek V4: `xhigh` (DeepSeek maps `xhigh` → its internal `max`)
   */
  maxThinkingLevel: ThinkingLevel;
  /**
   * Ordered preference of auth-storage keys this model resolves credentials
   * from, for providers that split auth across multiple distinct
   * endpoints/keys (currently only Xiaomi: the Token Plan endpoint vs. the
   * API Credits endpoint). The first key with stored credentials wins, so a
   * model can both prefer one endpoint AND fall back to another the user has
   * configured instead:
   *   - `mimo-v2.6-pro` / `mimo-v2.6-flash`: `["xiaomi", XIAOMI_CREDITS_KEY]` —
   *     prefer the Token Plan, fall back to API Credits (API Credits serves
   *     every MiMo model, so a Credits-only user still reaches these).
   *   - `mimo-v2.6-pro-ultraspeed`: `[XIAOMI_CREDITS_KEY]` only — not served
   *     over the Token Plan endpoint, so there's no fallback to it.
   * Falls back to `[provider]` — the normal single-credential case — when
   * unset. Read via `getAuthStorageKeys()` / `getAuthStorageKey()`.
   */
  authStorageKeys?: string[];
}

// Provider display order — mirrors `PROVIDERS` in ui/login.tsx so the
// /model selector and login selector sort models identically.
export const MODELS: ModelInfo[] = [
  // ── Anthropic ──────────────────────────────────────────
  // NOTE: Claude Mythos 5.1 (`claude-mythos-5-1`, 2026-09-01) is kept commented
  // out — it's a Project Glasswing model, still "Active (invite only)" in
  // Anthropic's docs and unavailable to most users. Re-enable once it's
  // generally available.
  {
    // Released 2026-09-01 — replaces Fable 5 at the same $10/$50 MTok (cache
    // reads drop to $0.25). Always-on adaptive thinking steered by effort;
    // forced tool use is rejected with a 400, which gg-ai never sends on the
    // Anthropic path. Fable 5 is retired here — a session that still has it
    // saved falls back to the provider default on next start.
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "max",
  },
  // {
  //   // Mythos-class model offered through Project Glasswing (limited
  //   // availability, invitation-only). Same underlying model as Fable 5.1 with
  //   // some safeguards lifted; kept here so approved accounts can select it.
  //   id: "claude-mythos-5-1",
  //   name: "Claude Mythos 5.1",
  //   provider: "anthropic",
  //   contextWindow: 1_000_000,
  //   maxOutputTokens: 128_000,
  //   supportsThinking: true,
  //   supportsImages: true,
  //   supportsVideo: false,
  //   costTier: "high",
  //   maxThinkingLevel: "max",
  // },
  {
    // Released 2026-09-22 — "built for long-running agentic coding and knowledge
    // work". Fable-5.1-class output at $4/$20 MTok (40% below Opus 5), 1M
    // context, 128K output, image input. Same always-on adaptive thinking with
    // the full effort ladder (low→max, xhigh included; the API-side default
    // effort is `medium`) and the same Fable 5.1 constraints gg-ai already
    // handles (no forced tool use, thinking can't be disabled). Also eligible
    // for the gated `speed: "fast"` research preview (waitlist-only, premium
    // $8/$40 pricing — not wired up). Opus 5 is retired here — a session that
    // still has it saved falls back to the provider default on next start.
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "max",
  },
  {
    // Released 2026-09-28 — replaces Sonnet 5 at $2/$10 MTok, with the same
    // 1M context / 128K output and adaptive thinking, now including xhigh.
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "max",
  },
  {
    // Released 2026-10-07 — replaces Haiku 4.5 at $0.10/$0.50 MTok (prompts
    // up to 100K tokens; $0.50/$2.50 above). 1M context, 128K output, image
    // input. Adaptive thinking with the full effort ladder (low→max, xhigh
    // included; API default `medium`) — manual budget_tokens, non-default
    // sampling params and assistant prefill all 400. No server-side refusal
    // fallback: `fallbacks: "default"` is accepted but a refusal stays a
    // refusal. Haiku 4.5 is retired here — a session that still has it saved
    // falls back to the provider default on next start.
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "max",
  },
  // ── OpenAI (Codex) ─────────────────────────────────────
  {
    // GPT-6 Astra — "Our most capable model for complex, demanding work."
    // (Codex catalog priority 2, listed for every ChatGPT plan, requires a
    // Codex client >= 0.153.0 — see CODEX_CLIENT_VERSION). Same split as 5.6:
    // 1.05M on the public Responses API, 272K on the ChatGPT OAuth route
    // (openai/codex models.json, `gpt-6-astra`). Reasoning ladder low → medium
    // → high → xhigh → max → ultra; `ultra` is the Codex orchestration preset
    // (multi_agent v2) and is Codex-only — the public API tops out at `max`.
    // Note: through a plain API key OpenAI requires the Responses API for tool
    // calling on Astra, so the Chat Completions path is text-only; the OAuth
    // Codex route is the supported way to use it as an agent.
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    defaultThinkingLevel: "low",
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "ultra",
  },
  // GPT-6 Sol + Luna — released 2026-09-22 below Astra, replacing the whole
  // GPT-5.6 family (Sol/Terra/Luna; there is no GPT-6 Terra — OpenAI's Codex
  // catalog upgrades 5.6 Terra to 6 Sol). GPT-6.1 Sol (2026-09-29) then replaced
  // GPT-6 Sol. Same window split as Astra: 1.05M on the public Responses API,
  // 272K on the Codex route; 128K output, text+image input, freeform
  // apply_patch, responses-lite transport. The GPT-5.6 ids and `gpt-6-sol` are
  // retired — a saved session on one falls back to the provider default on
  // next start.
  {
    // GPT-6.1 Sol — "Latest workhorse model for coding and everyday work."
    // (Codex priority 1, default low). The catalog says Codex client >= 0.153.0,
    // but the ChatGPT backend only serves it from 0.159.0 (see
    // CODEX_CLIENT_VERSION). $2/$10 MTok, cached input $0.10. Ladder low →
    // medium → high → xhigh → max → ultra; ultra is the Codex orchestration
    // preset (xhigh effort on the wire + proactive local subagent delegation).
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    defaultThinkingLevel: "low",
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "ultra",
  },
  {
    // Luna — "Fast and affordable model for easier tasks." (Codex priority 4,
    // default medium, needs a Codex client >= 0.155.0). $0.10/$0.50 MTok.
    // Reasoning tops out at `max`.
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    defaultThinkingLevel: "medium",
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "max",
  },
  // ── Sakana (Fugu) ──────────────────────────────────────
  // Sakana Fugu is a multi-agent system surfaced as a standard LLM via the
  // OpenAI-compatible Sakana API (https://api.sakana.ai/v1). All three take
  // text + image input (verified against the live /models list, 2026-09-28).
  // `fugu` balances latency and quality; `fugu-max` (v1.0, 2026-09-11) is the
  // cost tier over the largest open-weight pool ($2/$6 per 1M); `fugu-ultra`
  // is the heavier quality tier (may need larger client timeouts). Plain Fugu
  // and Fugu Max stop at xhigh — Sakana documents max as the same effort there.
  {
    id: "fugu",
    name: "Fugu",
    provider: "sakana",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "xhigh",
  },
  {
    id: "fugu-max",
    name: "Fugu Max",
    provider: "sakana",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "xhigh",
  },
  {
    id: "fugu-ultra",
    name: "Fugu Ultra",
    provider: "sakana",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    // The rolling alias now serves v2.0 (2026-09-11), which keeps max effort.
    maxThinkingLevel: "max",
  },
  // ── xAI (Grok) ─────────────────────────────────────────
  // Grok 4.7 (released 2026-09-21) — xAI's flagship for coding, agentic tasks,
  // and knowledge work: a new, larger base model with a longer RL run weighted
  // toward hours-long tasks, plus stronger self-verification and long-context
  // management. 500K context, text+image input, and a `reasoning_effort`
  // ladder of low/medium/high default/xhigh (reasoning still can't be fully
  // disabled). $2/$6 per MTok under 200K prompt tokens ($4/$12 at or above),
  // and it's the default model of the Grok Build coding agent. xAI advertises
  // "no fixed text output limit"; we keep the 131K practical cap for budget
  // predictability and input headroom. (A faster "Grok 4.7 Fast" variant
  // exists but is Cursor/Grok Build-only — not on the public API — so it isn't
  // registered.) Only the newest Grok ships — 4.6/4.5 are superseded and
  // retired; saved sessions on them fall back to this default.
  {
    id: "grok-4.7",
    name: "Grok 4.7",
    provider: "xai",
    contextWindow: 500_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "xhigh",
  },
  // ── Gemini ─────────────────────────────────────────
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  // Keep 3.1 Flash Lite first for the working OAuth default and fast-model routing.
  // New GA models are opt-in; Code Assist access varies by account.
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  {
    // Gemini 3.7 Flash (released 2026-08-13) — Google's most capable Flash for
    // coding, agents, and multi-step execution; GA-stable on the Gemini API as
    // `gemini-3.7-flash`. 1M context, 64K output, thinking low/medium/high.
    // Sent over our Code Assist (OAuth) transport ahead of gemini-cli — upstream
    // hasn't listed 3.7 yet (google-gemini/gemini-cli#28802, still open) — so
    // free/personal accounts 404 (entitlement-gated) while Code Assist
    // Standard/Enterprise accounts get it.
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  {
    // Wire name `gemini-3-flash` — the Code Assist (OAuth) backend rejects the
    // display string `gemini-3.5-flash` with a 404, so gemini-cli keeps this
    // alternative name (SECONDARY_GEMINI_3_5_FLASH_MODEL) for that endpoint.
    id: "gemini-3-flash",
    name: "Gemini 3.5 Flash",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  {
    // Gemini 3.1 Pro is public preview — gated behind Code Assist preview
    // enablement, so free/personal OAuth accounts 404 on it (see
    // ACCOUNT_GATED_MODELS in gg-ai's gemini provider).
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro (Preview)",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "high",
    maxThinkingLevel: "high",
  },
  // ── Moonshot (Kimi) ────────────────────────────────────
  // K3 is Kimi's 2.8T-parameter flagship for long-horizon coding, knowledge
  // work, and deep reasoning. Its effort ladder is server-declared as
  // low/high/max on both the public API (default max) and the Kimi For Coding
  // OAuth endpoint (default high); thinking can also be fully disabled.
  {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "moonshot",
    contextWindow: 1_048_576,
    // The API can be raised as high as the full context window, but 131K is the
    // documented default and keeps room for input in AgentSession's fixed cap.
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 100 * 1024 * 1024,
    costTier: "high",
    maxThinkingLevel: "max",
  },
  // K2.8 Preview (2026-09-11) is served only on the Kimi For Coding OAuth
  // endpoint, under its rolling `kimi-for-coding` id (live /models, 2026-09-28:
  // display_name "K2.8 Preview", 1M context, image + video input, efforts
  // low/high/max default max). The public API-key endpoint does not serve it,
  // so it resolves from the Kimi sign-in credential only.
  {
    id: "kimi-for-coding",
    name: "Kimi K2.8 Preview",
    provider: "moonshot",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 100 * 1024 * 1024,
    costTier: "medium",
    maxThinkingLevel: "max",
    authStorageKeys: [MOONSHOT_OAUTH_KEY],
  },
  // K2.7 Code is requested by its pinned id (not the `kimi-for-coding` alias
  // that moved to K2.8), so it stays the real K2.7 on both endpoints.
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    provider: "moonshot",
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 100 * 1024 * 1024,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  // K2.7 Code HighSpeed — the same model as K2.7 Code served at ~180 tok/s
  // (up to ~260 on short contexts), 256K context (platform.kimi.ai model list,
  // 2026-10-08). The `kimi-k2.7-code` prefix gives it K2.7's always-thinking
  // wire handling in gg-ai. The Kimi For Coding endpoint lists this model as
  // `kimi-for-coding-highspeed`; like `kimi-k2.7-code` and `kimi-k3`, we send
  // the public id there too.
  {
    id: "kimi-k2.7-code-highspeed",
    name: "Kimi K2.7 Code HighSpeed",
    provider: "moonshot",
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 100 * 1024 * 1024,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  // ── Z.AI (GLM) ─────────────────────────────────────────
  // Two GLM entries, both live on the coding endpoint (verified against its
  // /models list). The pre-5.3 ids stay retired: they routed to strictly worse
  // coding for the same plan quota, and the endpoint already answers `glm-5.2`
  // requests as glm-5.3.
  // `max` is both the ceiling and Z.AI's own default — the rungs below it live
  // in thinking-level.ts.
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    provider: "glm",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "max",
  },
  // GLM-5.3-Flash (released 2026-08-26): 320B-A18B natively multimodal sibling
  // at ~1/20th of 5.3's API price with 3× the coding-plan quota, so it is the
  // provider's `low` tier — scout sub-agents and compaction summaries route
  // here instead of paying 5.3 rates.
  // Images are native on the coding endpoint (verified: base64 data URL in an
  // `image_url` block answers correctly), which also means GLM image
  // attachments go inline for this model rather than through the zai_vision MCP
  // detour that `supportsImages: false` triggers.
  // Video/file input is documented but unverified on this transport, so it
  // stays off until measured. Thinking cannot be disabled server-side (Z.AI
  // maps a `disabled` toggle to the `low` rung and answers 200), and unlike
  // 5.3 it accepts any reasoning_effort string without a 400.
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    provider: "glm",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "max",
  },
  // ── MiniMax ────────────────────────────────────────────
  {
    id: "MiniMax-M3",
    name: "MiniMax M3",
    provider: "minimax",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 50 * 1024 * 1024,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  // ── Xiaomi (MiMo) ──────────────────────────────────────
  // MiMo-V2.6 series (released 2026-09-22, open-weight: Pro 1.02T/42B-A,
  // Flash 309B/15B-A, plus a 9B Qwen distill not served over the API). Every
  // V2.6 text model is natively full-modal (image + audio + video
  // understanding), so the whole series takes image/video input over the same
  // OpenAI-compatible base64 transport the old omni model used. API prices are
  // unchanged from V2.5. The V2.5 ids (`mimo-v2.5-pro`/`mimo-v2.5`) deprecate
  // on the platform 2026-10-21 and are retired here — saved sessions fall back
  // to the provider default on next start.
  {
    // Coding/agentic flagship — highest open-weight score on Artificial
    // Analysis at launch (46, tied with Grok 4.7).
    id: "mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    provider: "xiaomi",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 36 * 1024 * 1024,
    costTier: "medium",
    maxThinkingLevel: "high",
    authStorageKeys: ["xiaomi", XIAOMI_CREDITS_KEY],
  },
  {
    // Low-cost full-modal sibling (~10% of Pro's price class) — the provider's
    // `low` tier, so scout sub-agents and fast routing land here.
    id: "mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    provider: "xiaomi",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 36 * 1024 * 1024,
    costTier: "low",
    maxThinkingLevel: "high",
    authStorageKeys: ["xiaomi", XIAOMI_CREDITS_KEY],
  },
  // UltraSpeed: lower-latency sibling of the Pro flagship, same full-modal
  // capability surface, premium-priced for the throughput gain. API-only —
  // not served over the Token Plan endpoint, so credentials resolve from the
  // distinct API Credits key only (see authStorageKeys doc).
  {
    id: "mimo-v2.6-pro-ultraspeed",
    name: "MiMo-V2.6-Pro-UltraSpeed",
    provider: "xiaomi",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    maxVideoBytes: 36 * 1024 * 1024,
    costTier: "high",
    maxThinkingLevel: "high",
    authStorageKeys: [XIAOMI_CREDITS_KEY],
  },
  // ── DeepSeek ───────────────────────────────────────────
  // The live /models list (2026-09-28) serves exactly `deepseek-flash` and
  // `deepseek-v4-pro`. V4 Flash and V4 Flash Vision Exp are retired; their old
  // ids only temporarily route to V4.1 Flash, so they are retired here too.
  {
    // `deepseek-v4-pro` now serves DeepSeek-V4-Pro-0813 (released 2026-08-13,
    // first STABLE V4 Pro — supersedes the April preview; calling name
    // unchanged, same 1.6T/49B MoE). 1M context, text-only, low/high/max effort.
    // DeepSeek reversed its planned 2026-09-14 retirement, so it stays served.
    // Docs abbreviate output as 384K; use the same conservative 384,000-token
    // application cap across V4 models rather than mixing decimal/binary units.
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "max",
  },
  {
    // `deepseek-flash` is the rolling alias for the latest Flash — currently
    // V4.1 Flash (2026-09-10): native image input, 1M context, 384K output.
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "max",
  },
  // ── OpenRouter ─────────────────────────────────────────
  {
    // Qwen3.8 Max — Alibaba's flagship (live /endpoints, 2026-09-28): 1M
    // context, 131,072 output, text + image + video input, reasoning on.
    id: "qwen/qwen3.8-max",
    name: "Qwen3.8 Max",
    provider: "openrouter",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: true,
    // Practical inline-payload cap, not an asserted provider maximum.
    maxVideoBytes: 20 * 1024 * 1024,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  // ── Hugging Face (Inference Providers router) ────────
  // One HF token (hf.co/settings/tokens, "Make calls to Inference Providers"
  // permission) routes to whichever hosted backend serves each open model;
  // billing follows each backend's rates on the HF account (small free tier).
  // Model ids are Hub repo paths, so they intentionally contain a slash — the
  // same shape local/ vLLM ids already use (`local/vllm/Qwen/Qwen3-32B`).
  // Live GET /v1/models (2026-10-08) is the source for hosts, context and
  // modalities. Qwen3 Coder 480B is retired here: only one tool-calling host
  // (Novita) still served it. We keep bare repo ids (no :auto suffix) so the
  // picker matches what GET /v1/models reports.
  {
    // Moonshot's open coding model. Served with tool calling by Novita and
    // DeepInfra at 262K context, with image input (video is a Moonshot-API-only
    // upload path). It always thinks, but the router has no documented effort
    // control for it, so we register it as non-thinking: we never send a
    // reasoning_effort that a host might reject. Output is capped at half the
    // window so the input keeps room.
    id: "moonshotai/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code",
    provider: "huggingface",
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    supportsThinking: false,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "low",
  },
  {
    // DeepSeek V4.1 Flash open weights: 1M context and image input on four
    // tool-calling hosts (Novita, Fireworks, Baseten, DeepInfra; $0.20–0.30 in /
    // $0.60–1.20 out per MTok). It is listed before gpt-oss so it becomes the
    // low-tier summary model, because its 1M window can take a full long
    // session. Thinking control over the router is unverified, so it is
    // registered as non-thinking. Output is a conservative 131K: hosts don't
    // publish the 384K first-party cap.
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    name: "DeepSeek V4.1 Flash",
    provider: "huggingface",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportsThinking: false,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "low",
  },
  {
    // OpenAI's open-weight 120B MoE (5.1B active) — general-purpose, tool-calling
    // native, adjustable reasoning effort (low/medium/high, default medium) over
    // the router's Chat Completions API. Cheap enough to be the low-tier sibling
    // for summaries and fast sub-agents.
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    provider: "huggingface",
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "high",
  },
];

/**
 * Models discovered at runtime rather than shipped in `MODELS` — today only
 * locally hosted ones (Ollama/LM Studio/llama.cpp/vLLM), whose ids and context
 * windows depend on what the user has installed. Kept in a separate map so
 * `MODELS` stays a static, reviewable table.
 */
const runtimeModels = new Map<string, ModelInfo>();

/** Add (or replace) runtime-discovered models. Later registrations win by id. */
export function registerRuntimeModels(models: readonly ModelInfo[]): void {
  for (const model of models) runtimeModels.set(model.id, model);
}

/**
 * Remove runtime models matching `predicate` (all of them when omitted) — e.g.
 * every model from an endpoint the user just deleted.
 */
export function clearRuntimeModels(predicate?: (model: ModelInfo) => boolean): void {
  if (!predicate) {
    runtimeModels.clear();
    return;
  }
  for (const [id, model] of runtimeModels) {
    if (predicate(model)) runtimeModels.delete(id);
  }
}

/** Static table plus everything discovered at runtime. */
export function getAllModels(): ModelInfo[] {
  return [...MODELS, ...runtimeModels.values()];
}

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id) ?? runtimeModels.get(id);
}

export function getModelsForProvider(provider: Provider): ModelInfo[] {
  return getAllModels().filter((m) => m.provider === provider);
}

/**
 * Ordered auth-storage keys to try resolving credentials from for
 * `(provider, model)`, first match wins. Almost every model just uses its
 * provider id (one credential per provider). Models with `authStorageKeys`
 * set (currently only Xiaomi) can prefer one endpoint and fall back to
 * another — e.g. `mimo-v2.6-pro` prefers the Token Plan but falls back to API
 * Credits, while the API-only `mimo-v2.6-pro-ultraspeed` has no fallback.
 */
export function getAuthStorageKeys(provider: Provider, modelId: string): string[] {
  const model = getAllModels().find((m) => m.id === modelId && m.provider === provider);
  return model?.authStorageKeys ?? [provider];
}

/** The preferred (first) auth-storage key for `(provider, model)` — see `getAuthStorageKeys()`. */
export function getAuthStorageKey(provider: Provider, modelId: string): string {
  return getAuthStorageKeys(provider, modelId)[0]!;
}

/** Default video payload cap (bytes) when a video model doesn't declare one. */
export const DEFAULT_MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/**
 * Max video payload (bytes) the given model's transport accepts before the clip
 * must be compressed. Returns `undefined` for models without video support, so
 * callers can skip the native-video path entirely.
 */
export function getVideoByteLimit(modelId: string): number | undefined {
  const model = getModel(modelId);
  if (!model?.supportsVideo) return undefined;
  return model.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
}

/** Default model per hosted provider. Providers not listed default to Anthropic's. */
const DEFAULT_MODEL_IDS: Partial<Record<Provider, string>> = {
  xiaomi: "mimo-v2.6-pro",
  openai: "gpt-6.1-sol",
  gemini: "gemini-3.1-flash-lite",
  glm: "glm-5.3",
  moonshot: "kimi-k3",
  minimax: "MiniMax-M3",
  deepseek: "deepseek-v4-pro",
  huggingface: "moonshotai/Kimi-K2.7-Code",
  openrouter: "qwen/qwen3.8-max",
  sakana: "fugu",
  xai: "grok-4.7",
};
const FALLBACK_DEFAULT_MODEL_ID = "claude-sonnet-5-5";

function registeredModel(id: string): ModelInfo {
  const model = MODELS.find((m) => m.id === id);
  // A default that isn't registered is a bug in this file, caught by the tests.
  if (!model) throw new Error(`Default model "${id}" is not in the model registry`);
  return model;
}

export function getDefaultModel(provider: Provider): ModelInfo {
  // Local models only exist once discovery has run, and there's no "the" local
  // model. Never throw here (callers rely on a ModelInfo): fall back to a
  // placeholder that carries the conservative defaults, so a caller asking
  // before a scan gets a coherent object instead of a crash.
  if (provider === "local") {
    return getModelsForProvider("local")[0] ?? PLACEHOLDER_LOCAL_MODEL;
  }
  return registeredModel(DEFAULT_MODEL_IDS[provider] ?? FALLBACK_DEFAULT_MODEL_ID);
}

/**
 * Stand-in returned by `getDefaultModel("local")` before any local model has
 * been discovered. Not registered, never selectable in the UI — it exists only
 * so the non-null contract of `getDefaultModel` holds.
 */
const PLACEHOLDER_LOCAL_MODEL: ModelInfo = {
  id: "local/none/none",
  name: "No local model discovered",
  provider: "local",
  contextWindow: 8192,
  maxOutputTokens: 2048,
  supportsThinking: false,
  supportsImages: false,
  supportsVideo: false,
  costTier: "low",
  maxThinkingLevel: "high",
};

export interface ContextWindowOptions {
  provider?: Provider;
  accountId?: string;
}

export function usesOpenAICodexTransport(options?: ContextWindowOptions): boolean {
  return options?.provider === "openai" && Boolean(options.accountId);
}

/**
 * Codex applies a 10K-token history cap to every tool/function output. GG's
 * generic 30%-of-context allowance is far larger on 272K/372K Codex windows
 * and can turn a few reads into 100K+ fresh input tokens. Four characters per
 * token matches Codex's byte approximation and keeps this provider policy in
 * the shared model registry instead of an app-specific copy.
 */
export function getToolResultCharLimit(
  _modelId: string,
  options?: ContextWindowOptions,
): number | undefined {
  return usesOpenAICodexTransport(options) ? 10_000 * 4 : undefined;
}

export function getContextWindow(modelId: string, options?: ContextWindowOptions): number {
  const model = getModel(modelId);
  if (!model) return 200_000;
  if (usesOpenAICodexTransport(options) && model.codexContextWindow) {
    return model.codexContextWindow;
  }
  return model.contextWindow;
}

/**
 * The strongest thinking level the given model genuinely uses. Falls back to
 * `"high"` for unknown models since every provider we ship accepts it.
 */
export function getMaxThinkingLevel(modelId: string): ThinkingLevel {
  return getModel(modelId)?.maxThinkingLevel ?? "high";
}

/**
 * The thinking level a fresh session starts at. Identical to
 * {@link getMaxThinkingLevel} except where the provider declares a lower
 * default effort server-side — Kimi K3's Kimi For Coding OAuth endpoint
 * declares `default_effort: "high"` in its /models think_efforts (the public
 * Moonshot API declares "max"), and the official kimi-code CLI starts there.
 * Pass the active credential's baseUrl so the endpoint-aware default resolves;
 * matching it keeps plan-usage burn identical to the official CLI (users can
 * still toggle up to max).
 */
export function getDefaultThinkingLevel(
  modelId: string,
  options?: { baseUrl?: string },
): ThinkingLevel {
  const model = getModel(modelId);
  if (model?.id === "kimi-k3" && isKimiCodingEndpoint(options?.baseUrl)) return "high";
  return model?.defaultThinkingLevel ?? model?.maxThinkingLevel ?? "high";
}

/**
 * The cost tier each provider's compaction summaries run on. Chosen by TAG,
 * never by model id, so adding, renaming or removing models needs no change
 * here: the first registered model of that provider carrying the tag wins.
 * Providers not listed summarize on the active model.
 * - Anthropic: "medium" (the Sonnet line) — Haiku's shallower summaries
 *   cost more in lost memory than they save.
 * - OpenAI, GLM, DeepSeek, Hugging Face: "low" (Luna and the Flash models).
 */
const SUMMARY_COST_TIER: Readonly<Partial<Record<Provider, ModelInfo["costTier"]>>> = {
  anthropic: "medium",
  openai: "low",
  glm: "low",
  deepseek: "low",
  huggingface: "low",
};

/**
 * Get the model to use for compaction summarization — the ONLY place a
 * cheaper model is used. Everything else (sub-agents, reviewers, judges)
 * runs on the parent's model.
 *
 * Picks the provider's first model tagged with its summary tier
 * ({@link SUMMARY_COST_TIER}). When none is registered — the tier was removed,
 * or the provider has no cheap sibling — it summarizes on the current model.
 * Never throws. The caller still retries on the current model when the
 * provider rejects the chosen one at runtime (retired upstream, or not on the
 * user's plan), since the registry cannot know that.
 */
export function getSummaryModel(provider: Provider, currentModelId: string): ModelInfo {
  const tier = SUMMARY_COST_TIER[provider];
  const tagged = tier ? getModelsForProvider(provider).find((m) => m.costTier === tier) : undefined;
  return tagged ?? getModel(currentModelId) ?? getDefaultModel(provider);
}
