import type { Provider } from "@kenkaiiii/gg-ai";

export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsImages: boolean;
  costTier: "low" | "medium" | "high";
}

export const MODELS: ModelInfo[] = [
  // ── Anthropic ──────────────────────────────────────────
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "high",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "medium",
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "low",
  },
  // ── OpenAI (Codex) ─────────────────────────────────────
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "high",
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini",
    provider: "openai",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "low",
  },
  // ── GLM (Z.AI) ───────────────────────────────────────────
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    provider: "glm",
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: false,
    costTier: "medium",
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    provider: "glm",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
    supportsImages: false,
    costTier: "low",
  },
  {
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash",
    provider: "glm",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
    supportsImages: false,
    costTier: "low",
  },
  // ── Moonshot (Kimi) ──────────────────────────────────────
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshot",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
    supportsImages: true,
    costTier: "medium",
  },
  // ── Venice ────────────────────────────────────────────────
  // Privacy-first AI: no data retention, permissionless access, uncensored models.
  // "Build AI with no data retention, permissionless access, and compute you
  // permanently own." — venice.ai
  // OpenAI-compatible API at api.venice.ai — ideal when privacy, anonymity,
  // or uncensored generation is needed. https://venice.ai
  //
  // Venice proxies models from multiple providers through its privacy
  // infrastructure. Users can add more Venice models via customModels in
  // ~/.gg/settings.json (see Settings).

  // Anthropic via Venice — same models, routed through Venice's zero-retention infra
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Venice)",
    provider: "venice",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "high",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Venice)",
    provider: "venice",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "medium",
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (Venice)",
    provider: "venice",
    contextWindow: 198_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "medium",
  },
  // OpenAI via Venice
  {
    id: "openai-gpt-54",
    name: "GPT-5.4 (Venice)",
    provider: "venice",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsImages: true,
    costTier: "high",
  },
  {
    id: "openai-gpt-53-codex",
    name: "GPT-5.3 Codex (Venice)",
    provider: "venice",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
    costTier: "high",
  },
  // Code-optimized models
  {
    id: "qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B",
    provider: "venice",
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    supportsThinking: false,
    supportsImages: false,
    costTier: "high",
  },
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    provider: "venice",
    contextWindow: 160_000,
    maxOutputTokens: 32_768,
    supportsThinking: true,
    supportsImages: false,
    costTier: "medium",
  },
  {
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    provider: "venice",
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    supportsThinking: true,
    supportsImages: false,
    costTier: "medium",
  },
  // Uncensored / privacy-focused
  {
    id: "venice-uncensored",
    name: "Venice Uncensored",
    provider: "venice",
    contextWindow: 32_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    supportsImages: false,
    costTier: "low",
  },
];

// ── Custom models (loaded from settings at startup) ───────

const customModels: ModelInfo[] = [];

/**
 * Register additional models at runtime. Called during startup to load
 * user-defined models from ~/.gg/settings.json `customModels` array.
 *
 * Example settings.json entry:
 * ```json
 * {
 *   "customModels": [
 *     {
 *       "id": "grok-4-20-beta",
 *       "name": "Grok 4",
 *       "provider": "venice",
 *       "contextWindow": 2000000,
 *       "maxOutputTokens": 128000,
 *       "supportsThinking": true,
 *       "supportsImages": false,
 *       "costTier": "high"
 *     }
 *   ]
 * }
 * ```
 */
export function registerCustomModels(models: ModelInfo[]): void {
  customModels.length = 0;
  customModels.push(...models);
}

/** All models: built-in + user-defined custom models. */
export function getAllModels(): ModelInfo[] {
  return [...MODELS, ...customModels];
}

export function getModel(id: string): ModelInfo | undefined {
  return getAllModels().find((m) => m.id === id);
}

export function getModelsForProvider(provider: Provider): ModelInfo[] {
  return getAllModels().filter((m) => m.provider === provider);
}

export function getDefaultModel(provider: Provider): ModelInfo {
  if (provider === "openai") return MODELS.find((m) => m.id === "gpt-5.3-codex")!;
  if (provider === "glm") return MODELS.find((m) => m.id === "glm-5.1")!;
  if (provider === "moonshot") return MODELS.find((m) => m.id === "kimi-k2.5")!;
  if (provider === "venice")
    return MODELS.find((m) => m.id === "qwen3-coder-480b-a35b-instruct")!;
  return MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
}

export function getContextWindow(modelId: string): number {
  const model = getModel(modelId);
  return model?.contextWindow ?? 200_000;
}

/**
 * Get the model to use for compaction summarization.
 * - Anthropic: always Sonnet 4.6
 * - OpenAI: cheapest (Codex Mini)
 * - GLM: GLM-4.7 Flash (cheap alternative)
 * - Moonshot: use the current model (no cheap alternative)
 */
export function getSummaryModel(provider: Provider, currentModelId: string): ModelInfo {
  if (provider === "anthropic") {
    return MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
  }
  if (provider === "venice") {
    // Venice: use the cheapest model for compaction
    const low = getModelsForProvider("venice").find((m) => m.costTier === "low");
    if (low) return low;
  }
  if (provider === "openai" || provider === "glm") {
    const low = getModelsForProvider(provider).find((m) => m.costTier === "low");
    if (low) return low;
  }
  // Moonshot or fallback: use current model
  return getModel(currentModelId) ?? getDefaultModel(provider);
}
