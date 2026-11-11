import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ModelInfo } from "./model-registry.js";

/** The two OpenCode Console plans, each with its own endpoint and model list. */
export type OpenCodeProvider = "opencode" | "opencode-go";

export const OPENCODE_PROVIDERS: readonly OpenCodeProvider[] = ["opencode-go", "opencode"];

/** Where each plan publishes its model list. Public: the list needs no key. */
export const OPENCODE_CATALOG_URLS: Record<OpenCodeProvider, string> = {
  opencode: "https://opencode.ai/inference/v1/models",
  "opencode-go": "https://opencode.ai/inference/go/v1/models",
};

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;

/** One `/v1/models` row as the Console serves it (opencode.ai/docs/console/api/inference). */
interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  modalities?: { input?: unknown };
  capabilities?: {
    tools?: { supported?: unknown };
    reasoning?: { effort?: unknown; default?: { type?: unknown; value?: unknown } };
  };
  limit?: { context?: unknown; output?: unknown };
  /** The APIs the model is served on, keyed by protocol (`chat-completions`, `responses`, …). */
  api?: Record<string, unknown>;
  cost?: { text?: { input?: { price?: unknown } } };
}

export interface ParsedOpenCodeCatalog {
  models: ModelInfo[];
  /** Rows dropped: not served on Chat Completions, no tool calling, free tier, or malformed. */
  skipped: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `price` is US dollars per million input tokens. */
function costTier(price: unknown): ModelInfo["costTier"] {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0.5) return "low";
  return price < 3 ? "medium" : "high";
}

/** The registry id of a Console model: the plan's provider id, then the gateway's id. */
export function formatOpenCodeModelId(provider: OpenCodeProvider, rawId: string): string {
  return `${provider}/${rawId}`;
}

/**
 * Turn a Console `/v1/models` body into registry rows for one plan. Only models
 * the gateway serves on Chat Completions are listed, since that is the one API
 * gg-ai sends OpenCode requests to: a Responses, Messages or Gemini model
 * called there has failed for other clients (HTTP 500, "Model does not support
 * this protocol"). Pay-as-you-go also drops the free tier: the gateway answers
 * HTTP 403 for those models from any client but OpenCode itself. Go keeps its
 * free models, which the subscription covers.
 */
export function parseOpenCodeCatalog(
  provider: OpenCodeProvider,
  body: unknown,
): ParsedOpenCodeCatalog {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { models: [], skipped: 0 };
  const models: ModelInfo[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const raw of data as CatalogEntry[]) {
    const rawId = typeof raw?.id === "string" ? raw.id.trim() : "";
    const contextWindow = positiveInt(raw?.limit?.context);
    const price = raw?.cost?.text?.input?.price;
    if (
      !/^[\w.:-]+$/.test(rawId) ||
      seen.has(rawId) ||
      raw.type !== "chat" ||
      !raw.api?.["chat-completions"] ||
      raw.capabilities?.tools?.supported !== true ||
      !contextWindow ||
      (provider === "opencode" && price === 0)
    ) {
      skipped++;
      continue;
    }
    seen.add(rawId);
    const reasoning = raw.capabilities.reasoning;
    const efforts = strings(reasoning?.effort);
    const ladder: ThinkingLevel[] = EFFORT_LADDER.filter((rung) => efforts.includes(rung));
    const defaultEffort = reasoning?.default?.type === "effort" ? reasoning.default.value : null;
    // Half the window at most, so the input keeps room (Grok lists output = context).
    const maxOutput = Math.min(
      positiveInt(raw.limit?.output) ?? 16_384,
      Math.floor(contextWindow / 2),
    );
    models.push({
      id: formatOpenCodeModelId(provider, rawId),
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : rawId,
      provider,
      contextWindow,
      maxOutputTokens: Math.max(1, maxOutput),
      // Only a declared effort ladder counts: a model without one is never sent
      // a reasoning_effort it might reject.
      supportsThinking: ladder.length > 0,
      supportsImages: strings(raw.modalities?.input).some((m) => m.startsWith("image")),
      // Video needs a per-transport payload cap the catalog doesn't publish.
      supportsVideo: false,
      costTier: costTier(price),
      maxThinkingLevel: ladder[ladder.length - 1] ?? "low",
      ...(ladder.length > 0 ? { thinkingLevels: ladder } : {}),
      ...(typeof defaultEffort === "string" && ladder.includes(defaultEffort as ThinkingLevel)
        ? { defaultThinkingLevel: defaultEffort as ThinkingLevel }
        : {}),
    });
  }
  return { models, skipped };
}
