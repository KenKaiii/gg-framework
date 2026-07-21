import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { isKimiCodingEndpoint } from "./oauth/kimi.js";
import { XIAOMI_CREDITS_KEY } from "./auth-storage.js";

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
   *   - OpenAI GPT-5.6-era (Sol/Terra/Luna): `max` (the 5.6 ladder adds `max`
   *     and `ultra`; gg-ai caps at `max` — `ultra` needs a ThinkingLevel bump)
   *   - OpenAI GPT-5.5-era: `xhigh`
   *   - OpenAI Pro/Codex/old: clamped to what the model accepts
   *   - Claude Fable 5 / Mythos 5, Opus 4.8 / 4.7 / 4.6 and Sonnet 5: `max`
   *     (Fable 5 / Mythos 5 use always-on adaptive thinking, low→max ladder)
   *   - Claude Haiku 4.5: `high` (no adaptive `max` tier)
   *   - Kimi K3: `max` (always-on reasoning; currently the only API effort)
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
   *   - `mimo-v2.5-pro` / `mimo-v2.5`: `["xiaomi", XIAOMI_CREDITS_KEY]` —
   *     prefer the Token Plan, fall back to API Credits (API Credits serves
   *     every MiMo model, so a Credits-only user still reaches these).
   *   - `mimo-v2.5-pro-ultraspeed`: `[XIAOMI_CREDITS_KEY]` only — not served
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
  // NOTE: Claude Mythos 5 (`claude-mythos-5`) is kept commented out — it's a
  // Project Glasswing (limited, invitation-only) model unavailable to most
  // users. Re-enable once it's generally available.
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
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
  //   // availability, invitation-only). Same underlying model as Fable 5 with
  //   // some safeguards lifted; kept here so approved accounts can select it.
  //   id: "claude-mythos-5",
  //   name: "Claude Mythos 5",
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
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
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
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
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
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  // ── OpenAI (Codex) ─────────────────────────────────────
  // GPT-5.6 family — three agentic coding tiers launched July 2026. The public
  // Responses API advertises a 1.05M context window; OpenAI's Codex product
  // catalog advertises 272K on the ChatGPT OAuth route (corrected from the
  // initially advertised 372K — openai/codex PR #33972, Jul 18 2026 hotfix). All three take
  // text+image input, freeform apply_patch, text+image web search, and parallel
  // tool calls.
  {
    // Sol — "Latest frontier agentic coding model." (priority 1, default low).
    // Reasoning ladder: low → medium → high → xhigh → max → ultra. Ultra is a
    // Codex orchestration preset: the request uses max effort while the local
    // runtime proactively delegates suitable independent work to subagents.
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "ultra",
  },
  {
    // Terra — "Balanced agentic coding model for everyday work." (priority 2,
    // default medium).
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "ultra",
  },
  {
    // Luna — "Fast and affordable agentic coding model." (priority 3, default
    // medium). Reasoning tops out at `max`.
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "max",
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    contextWindow: 1_050_000,
    codexContextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "xhigh",
  },
  // ── Sakana (Fugu) ──────────────────────────────────────
  // Sakana Fugu is a multi-agent system surfaced as a standard LLM via the
  // OpenAI-compatible Sakana API (https://api.sakana.ai/v1). Both models take
  // text + image input and only accept "high"/"xhigh" reasoning effort, so the
  // top tier is `xhigh`. `fugu` routes across all providers; `fugu-ultra` is
  // the heavier tier (may need larger client timeouts on complex tasks).
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
    id: "fugu-ultra",
    name: "Fugu Ultra",
    provider: "sakana",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "xhigh",
  },
  // ── xAI (Grok) ─────────────────────────────────────────
  // Grok 4.5 (released 2026-07-08) is xAI's flagship for coding, agentic
  // tasks, and knowledge work — 500K context, text+image input, configurable
  // `reasoning_effort` (low/medium/high, server default high; reasoning can't
  // be fully disabled). Served over the OpenAI-compatible API at
  // https://api.x.ai/v1 (API key from console.x.ai). xAI hasn't published an
  // official max-output cap for 4.5; 131K matches the Grok Responses ceiling
  // third-party integrations use.
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    provider: "xai",
    contextWindow: 500_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  // ── Gemini ─────────────────────────────────────────────
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
  // Retain the cheaper dedicated coding model as an explicit alternative.
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
  // ── Z.AI (GLM) ─────────────────────────────────────────
  // GLM-5.2: coding-first flagship with a usable 1M-token context window
  // (5x jump over GLM-5.1's ~200K) and 131K max output. Released 2026-06-13.
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    provider: "glm",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    provider: "glm",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    provider: "glm",
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "high",
  },
  {
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash",
    provider: "glm",
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "high",
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
  // Pro series: text-only coding/agentic flagship. The legacy mimo-v2-pro
  // auto-routes to v2.5 on 2026-06-01 and is fully deprecated by 2026-06-30.
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    provider: "xiaomi",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "high",
    authStorageKeys: ["xiaomi", XIAOMI_CREDITS_KEY],
  },
  // UltraSpeed: lower-latency sibling of the Pro coding flagship, same
  // text-only capability surface, premium-priced for the throughput gain.
  // API-only — not served over the Token Plan endpoint, so credentials
  // resolve from the distinct API Credits key only (see authStorageKeys doc).
  {
    id: "mimo-v2.5-pro-ultraspeed",
    name: "MiMo-V2.5-Pro-UltraSpeed",
    provider: "xiaomi",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "high",
    maxThinkingLevel: "high",
    authStorageKeys: [XIAOMI_CREDITS_KEY],
  },
  // Omni series: native full-modal understanding (image + audio + video).
  // Video/image ride the OpenAI-compatible transport as base64 data URLs
  // (`video_url`/`image_url`), which the shared transform already emits.
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
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
  // ── DeepSeek ───────────────────────────────────────────
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "high",
    // DeepSeek V4 maps `xhigh` → its internal `max` tier.
    maxThinkingLevel: "xhigh",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "xhigh",
  },
  // ── OpenRouter ─────────────────────────────────────────
  {
    id: "qwen/qwen3.6-plus",
    name: "Qwen3.6-Plus",
    provider: "openrouter",
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "medium",
    maxThinkingLevel: "high",
  },
];

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function getModelsForProvider(provider: Provider): ModelInfo[] {
  return MODELS.filter((m) => m.provider === provider);
}

/**
 * Ordered auth-storage keys to try resolving credentials from for
 * `(provider, model)`, first match wins. Almost every model just uses its
 * provider id (one credential per provider). Models with `authStorageKeys`
 * set (currently only Xiaomi) can prefer one endpoint and fall back to
 * another — e.g. `mimo-v2.5-pro` prefers the Token Plan but falls back to API
 * Credits, while the API-only `mimo-v2.5-pro-ultraspeed` has no fallback.
 */
export function getAuthStorageKeys(provider: Provider, modelId: string): string[] {
  const model = MODELS.find((m) => m.id === modelId && m.provider === provider);
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

export function getDefaultModel(provider: Provider): ModelInfo {
  if (provider === "xiaomi") return MODELS.find((m) => m.id === "mimo-v2.5-pro")!;
  if (provider === "openai") return MODELS.find((m) => m.id === "gpt-5.6-sol")!;
  if (provider === "gemini") return MODELS.find((m) => m.id === "gemini-3.1-flash-lite")!;
  if (provider === "glm") return MODELS.find((m) => m.id === "glm-5.2")!;
  if (provider === "moonshot") return MODELS.find((m) => m.id === "kimi-k3")!;
  if (provider === "minimax") return MODELS.find((m) => m.id === "MiniMax-M3")!;
  if (provider === "deepseek") return MODELS.find((m) => m.id === "deepseek-v4-pro")!;
  if (provider === "openrouter") return MODELS.find((m) => m.id === "qwen/qwen3.6-plus")!;
  if (provider === "sakana") return MODELS.find((m) => m.id === "fugu")!;
  if (provider === "xai") return MODELS.find((m) => m.id === "grok-4.5")!;
  return MODELS.find((m) => m.id === "claude-sonnet-5")!;
}

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
  return model?.maxThinkingLevel ?? "high";
}

/**
 * Get the model to use for compaction summarization.
 * - Anthropic: always Sonnet 5
 * - OpenAI: cheapest (Codex Mini)
 * - Gemini: use the current model
 * - GLM: GLM-4.7 Flash (cheap alternative)
 * - Moonshot: use the current model (no cheap alternative)
 */
export function getSummaryModel(provider: Provider, currentModelId: string): ModelInfo {
  if (provider === "anthropic") {
    return MODELS.find((m) => m.id === "claude-sonnet-5")!;
  }
  if (provider === "openai" || provider === "glm" || provider === "deepseek") {
    const low = getModelsForProvider(provider).find((m) => m.costTier === "low");
    if (low) return low;
  }
  // Moonshot or fallback: use current model
  return getModel(currentModelId) ?? getDefaultModel(provider);
}

/**
 * Fastest/cheapest sibling within the SAME provider, for scout-style read-only
 * sub-agents (recon, research) where a low-latency model is enough and the
 * frontier model is wasted spend + latency.
 *
 * Routes off each model's `costTier` — the single source of truth that already
 * travels with the registry entry — so a model rename/bump needs no change
 * here. Providers with no low-tier sibling (Moonshot, MiniMax, Xiaomi, Sakana,
 * OpenRouter) gracefully keep the parent model, so there's never a crash or a
 * cross-provider jump to a login the user may not have.
 */
export function getFastModel(provider: Provider, currentModelId: string): ModelInfo {
  const low = getModelsForProvider(provider).find((m) => m.costTier === "low");
  return low ?? getModel(currentModelId) ?? getDefaultModel(provider);
}
