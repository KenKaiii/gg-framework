import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";

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
   *   - OpenAI GPT-5.5-era: `xhigh`
   *   - OpenAI Pro/Codex/old: clamped to what the model accepts
   *   - Claude Fable 5 / Mythos 5, Opus 4.8 / 4.7 / 4.6 and Sonnet 4.6: `max`
   *     (Fable 5 / Mythos 5 use always-on adaptive thinking, low→max ladder)
   *   - Claude Haiku 4.5: `high` (no adaptive `max` tier)
   *   - GLM / Moonshot / Xiaomi / MiniMax / Qwen: `high` — binary-thinking
   *     providers ignore the level on the wire, so the value is cosmetic
   *   - DeepSeek V4: `xhigh` (DeepSeek maps `xhigh` → its internal `max`)
   */
  maxThinkingLevel: ThinkingLevel;
}

// Provider display order — mirrors `PROVIDERS` in ui/login.tsx so the
// /model selector and login selector sort models identically.
export const MODELS: ModelInfo[] = [
  // ── Anthropic ──────────────────────────────────────────
  // NOTE: Claude Fable 5 (`claude-fable-5`) and Claude Mythos 5
  // (`claude-mythos-5`) are temporarily unavailable, so they're commented out
  // here to keep them out of the /model selector and avoid user confusion.
  // Re-enable once they're generally available again.
  // {
  //   id: "claude-fable-5",
  //   name: "Claude Fable 5",
  //   provider: "anthropic",
  //   contextWindow: 1_000_000,
  //   maxOutputTokens: 128_000,
  //   supportsThinking: true,
  //   supportsImages: true,
  //   supportsVideo: false,
  //   costTier: "high",
  //   maxThinkingLevel: "max",
  // },
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
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
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
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
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
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "xhigh",
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "openai",
    contextWindow: 400_000,
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
  // ── Gemini ─────────────────────────────────────────────
  {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite Preview",
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
    id: "gemini-3.5-flash",
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
  // ── Moonshot (Kimi) ────────────────────────────────────
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7",
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
  if (provider === "openai") return MODELS.find((m) => m.id === "gpt-5.5")!;
  if (provider === "gemini") return MODELS.find((m) => m.id === "gemini-3.1-flash-lite-preview")!;
  if (provider === "glm") return MODELS.find((m) => m.id === "glm-5.2")!;
  if (provider === "moonshot") return MODELS.find((m) => m.id === "kimi-k2.7-code")!;
  if (provider === "minimax") return MODELS.find((m) => m.id === "MiniMax-M3")!;
  if (provider === "deepseek") return MODELS.find((m) => m.id === "deepseek-v4-pro")!;
  if (provider === "openrouter") return MODELS.find((m) => m.id === "qwen/qwen3.6-plus")!;
  if (provider === "sakana") return MODELS.find((m) => m.id === "fugu")!;
  return MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
}

export interface ContextWindowOptions {
  provider?: Provider;
  accountId?: string;
}

export function usesOpenAICodexTransport(options?: ContextWindowOptions): boolean {
  return options?.provider === "openai" && Boolean(options.accountId);
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
 * Get the model to use for compaction summarization.
 * - Anthropic: always Sonnet 4.6
 * - OpenAI: cheapest (Codex Mini)
 * - Gemini: use the current model
 * - GLM: GLM-4.7 Flash (cheap alternative)
 * - Moonshot: use the current model (no cheap alternative)
 */
export function getSummaryModel(provider: Provider, currentModelId: string): ModelInfo {
  if (provider === "anthropic") {
    return MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
  }
  if (provider === "openai" || provider === "glm" || provider === "deepseek") {
    const low = getModelsForProvider(provider).find((m) => m.costTier === "low");
    if (low) return low;
  }
  // Moonshot or fallback: use current model
  return getModel(currentModelId) ?? getDefaultModel(provider);
}
