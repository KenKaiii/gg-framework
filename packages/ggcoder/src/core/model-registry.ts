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
];

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function getModelsForProvider(provider: Provider): ModelInfo[] {
  return MODELS.filter((m) => m.provider === provider);
}

export function getDefaultModel(provider: Provider): ModelInfo {
  if (provider === "openai") return MODELS.find((m) => m.id === "gpt-5.3-codex")!;
  if (provider === "glm") return MODELS.find((m) => m.id === "glm-5.1")!;
  if (provider === "moonshot") return MODELS.find((m) => m.id === "kimi-k2.5")!;
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
  if (provider === "openai" || provider === "glm") {
    const low = getModelsForProvider(provider).find((m) => m.costTier === "low");
    if (low) return low;
  }
  // Moonshot or fallback: use current model
  return getModel(currentModelId) ?? getDefaultModel(provider);
}
