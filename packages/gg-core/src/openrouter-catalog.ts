import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ModelInfo } from "./model-registry.js";

/** gg-ai's OPENROUTER_BASE_URL — where the openrouter transport goes with no override. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;

/** One `/models` row, as OpenRouter (and gateways cloning it) actually serve it. */
interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown };
  pricing?: { prompt?: unknown };
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
  supported_parameters?: unknown;
  reasoning?: { supported_efforts?: unknown; default_effort?: unknown };
}

export interface ParsedOpenRouterCatalog {
  models: ModelInfo[];
  /** Rows dropped because they can't call tools (the agent needs tools) or are malformed. */
  skipped: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function costTier(prompt: unknown): ModelInfo["costTier"] {
  const perToken = typeof prompt === "string" ? Number(prompt) : NaN;
  if (!Number.isFinite(perToken) || perToken < 0.5e-6) return "low";
  return perToken < 3e-6 ? "medium" : "high";
}

/**
 * Turn an OpenRouter-style `/models` body into registry rows. Field mapping is
 * the live schema: tools from `supported_parameters`, image input from
 * `architecture.input_modalities`, the effort ladder from
 * `reasoning.supported_efforts`, output cap from `top_provider`.
 */
export function parseOpenRouterCatalog(body: unknown): ParsedOpenRouterCatalog {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { models: [], skipped: 0 };
  const models: ModelInfo[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const raw of data as CatalogEntry[]) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const params = strings(raw?.supported_parameters);
    const contextWindow =
      positiveInt(raw?.top_provider?.context_length) ?? positiveInt(raw?.context_length);
    if (!id || seen.has(id) || !params.includes("tools") || !contextWindow) {
      skipped++;
      continue;
    }
    seen.add(id);
    const efforts = strings(raw.reasoning?.supported_efforts);
    const ladder: ThinkingLevel[] = EFFORT_LADDER.filter((rung) => efforts.includes(rung));
    const supportsThinking =
      ladder.length > 0 || params.includes("reasoning") || params.includes("reasoning_effort");
    const defaultEffort = raw.reasoning?.default_effort;
    const maxOutput =
      positiveInt(raw.top_provider?.max_completion_tokens) ?? Math.min(contextWindow, 16_384);
    models.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
      provider: "openrouter",
      contextWindow,
      maxOutputTokens: Math.min(maxOutput, contextWindow),
      supportsThinking,
      supportsImages: strings(raw.architecture?.input_modalities).includes("image"),
      // Video needs a per-transport payload cap the catalog doesn't publish.
      supportsVideo: false,
      costTier: costTier(raw.pricing?.prompt),
      maxThinkingLevel: ladder[ladder.length - 1] ?? "high",
      ...(ladder.length > 0 ? { thinkingLevels: ladder } : {}),
      ...(typeof defaultEffort === "string" && ladder.includes(defaultEffort as ThinkingLevel)
        ? { defaultThinkingLevel: defaultEffort as ThinkingLevel }
        : {}),
    });
  }
  return { models, skipped };
}
