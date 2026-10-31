/**
 * Synced model catalogs for gateway providers.
 *
 * OpenRouter ships a static model table, and that table is wrong the moment a
 * custom base URL is set: its ids don't exist on the user's gateway, and its
 * metadata (context window, output cap, reasoning levels, price) describes
 * someone else's deployment. This module reads the endpoint's OWN `/v1/models`,
 * which OpenRouter and OpenRouter-compatible gateways answer with rich entries
 * (`context_length`, `max_output_length`, `pricing`, `reasoning_parameters`,
 * `supported_features`, `input_modalities`), and turns them into `ModelInfo`
 * rows that get registered at runtime — the same mechanism local endpoints use.
 *
 * Model ids are namespaced (`openrouter/<rawId>`) so a gateway model can never
 * shadow another provider's static id. The raw id (what the HTTP request must
 * carry) is recovered by {@link gatewayWireModelId} at the transport boundary.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ModelInfo } from "./model-registry.js";
import { getAppPaths } from "./paths.js";

/** Providers whose model list can be synced from their configured endpoint. */
export const GATEWAY_SYNC_PROVIDERS: readonly string[] = ["openrouter"];

/**
 * Context window assumed when the endpoint declares none. Deliberately
 * conservative: under-estimating costs an early compaction, over-estimating
 * overflows the real window mid-turn.
 */
export const FALLBACK_GATEWAY_CONTEXT_WINDOW = 32_768;

/** Default output cap when the endpoint declares none. */
const FALLBACK_GATEWAY_MAX_OUTPUT = 8_192;

const THINKING_LADDER: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface GatewayCatalogResult {
  provider: string;
  /** Endpoint the catalog came from, for the "synced from …" label. */
  baseUrl: string;
  models: ModelInfo[];
  /** Entries dropped because the model can't call tools (the agent needs it). */
  skippedNoTools: number;
}

/** Cached sync, one entry per provider, persisted across restarts. */
export interface GatewayCatalogCache {
  version: 1;
  providers: Record<string, { baseUrl: string; syncedAt: number; models: ModelInfo[] }>;
}

// ── Ids ───────────────────────────────────────────────────

export function formatGatewayModelId(provider: string, rawId: string): string {
  return `${provider}/${rawId}`;
}

/** Split a namespaced gateway id, or `undefined` when it isn't one. */
export function parseGatewayModelId(
  modelId: string,
): { provider: string; rawId: string } | undefined {
  for (const provider of GATEWAY_SYNC_PROVIDERS) {
    const prefix = `${provider}/`;
    if (modelId.startsWith(prefix) && modelId.length > prefix.length) {
      return { provider, rawId: modelId.slice(prefix.length) };
    }
  }
  return undefined;
}

/** The id to send on the wire: namespaced gateway ids lose their prefix. */
export function gatewayWireModelId(modelId: string): string {
  return parseGatewayModelId(modelId)?.rawId ?? modelId;
}

// ── Catalog parsing ───────────────────────────────────────

type Json = Record<string, unknown>;

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** First declared value among the shapes gateways actually use. */
function firstNumber(entry: Json, paths: readonly string[][]): number | undefined {
  for (const keys of paths) {
    let node: unknown = entry;
    for (const key of keys) {
      node = asRecord(node)?.[key];
      if (node === undefined) break;
    }
    const n = asNumber(node);
    if (n !== undefined) return n;
  }
  return undefined;
}

function thinkingLevelFrom(efforts: readonly string[]): ThinkingLevel | undefined {
  let best: ThinkingLevel | undefined;
  for (const raw of efforts) {
    const effort = raw.toLowerCase() as ThinkingLevel;
    if (!THINKING_LADDER.includes(effort)) continue;
    if (!best || THINKING_LADDER.indexOf(effort) > THINKING_LADDER.indexOf(best)) best = effort;
  }
  return best;
}

/**
 * Prompt price per token → the coarse tier the picker shows. Thresholds are in
 * dollars per token: 2e-6 ≈ $2/M tokens, 1e-5 = $10/M tokens.
 */
function costTierFromPromptPrice(pricePerToken: number | undefined): "low" | "medium" | "high" {
  if (pricePerToken === undefined) return "medium";
  if (pricePerToken < 2e-6) return "low";
  if (pricePerToken < 1e-5) return "medium";
  return "high";
}

/** True when the entry declares tools, or declares nothing that rules them out. */
function supportsTools(entry: Json): boolean {
  const features = asStringArray(entry.supported_features).map((f) => f.toLowerCase());
  if (features.includes("tools")) return true;
  // An explicit feature list without "tools" means no tool calling; a missing
  // list is unknown, and refusing every model would empty the catalog.
  return features.length === 0;
}

/** One `/v1/models` entry → ModelInfo, or `undefined` when it's unusable. */
export function gatewayModelInfo(
  provider: string,
  entry: unknown,
): { model: ModelInfo; hasTools: boolean } | undefined {
  const row = asRecord(entry);
  const rawId = typeof row?.id === "string" ? row.id.trim() : "";
  if (!row || !rawId) return undefined;

  const contextWindow =
    firstNumber(row, [
      ["context_length"],
      ["limit", "context"],
      ["context_window"],
      ["top_provider", "context_length"],
      ["max_context_length"],
    ]) ?? FALLBACK_GATEWAY_CONTEXT_WINDOW;
  const maxOutputTokens =
    firstNumber(row, [
      ["max_output_length"],
      ["limit", "output"],
      ["top_provider", "max_completion_tokens"],
      ["max_completion_tokens"],
    ]) ?? Math.max(512, Math.min(FALLBACK_GATEWAY_MAX_OUTPUT, Math.floor(contextWindow / 4)));

  const efforts = asStringArray(asRecord(row.reasoning_parameters)?.efforts);
  const features = asStringArray(row.supported_features).map((f) => f.toLowerCase());
  const modalities = asStringArray(row.input_modalities).map((m) => m.toLowerCase());
  const supportsThinking =
    efforts.length > 0 || features.includes("reasoning") || row.reasoning === true;

  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : rawId;
  const model: ModelInfo = {
    id: formatGatewayModelId(provider, rawId),
    name,
    provider: provider as Provider,
    contextWindow,
    maxOutputTokens,
    supportsThinking,
    supportsImages: modalities.includes("image"),
    supportsVideo: modalities.includes("video"),
    costTier: costTierFromPromptPrice(firstNumber(row, [["pricing", "prompt"]])),
    // Only meaningful when the model reasons; the ladder caps at "max" because
    // "ultra" is a Codex orchestration preset, not an endpoint effort.
    maxThinkingLevel: thinkingLevelFrom(efforts) ?? "high",
    authStorageKeys: [provider],
  };
  return { model, hasTools: supportsTools(row) };
}

/** Parse a `/v1/models` payload into the models the agent can actually run. */
export function parseGatewayCatalog(provider: string, payload: unknown): {
  models: ModelInfo[];
  skippedNoTools: number;
} {
  const rows = asRecord(payload)?.data;
  if (!Array.isArray(rows)) return { models: [], skippedNoTools: 0 };
  const models: ModelInfo[] = [];
  let skippedNoTools = 0;
  for (const row of rows) {
    const parsed = gatewayModelInfo(provider, row);
    if (!parsed) continue;
    if (!parsed.hasTools) {
      skippedNoTools++;
      continue;
    }
    models.push(parsed.model);
  }
  // Cheapest-first so the picker leads with sane defaults on a big catalog.
  const rank = { low: 0, medium: 1, high: 2 } as const;
  models.sort(
    (a, b) => rank[a.costTier] - rank[b.costTier] || a.id.localeCompare(b.id),
  );
  return { models, skippedNoTools };
}

// ── Fetching ──────────────────────────────────────────────

export interface FetchGatewayOptions {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** GET `<baseUrl>/models` and parse it. Throws with a user-facing message. */
export async function fetchGatewayCatalog(
  options: FetchGatewayOptions,
): Promise<GatewayCatalogResult> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (err) {
    throw new Error(
      `Couldn't reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`${baseUrl}/models answered HTTP ${res.status}.`);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`${baseUrl}/models did not return JSON.`);
  }
  const { models, skippedNoTools } = parseGatewayCatalog(options.provider, payload);
  if (models.length === 0) {
    throw new Error(
      skippedNoTools > 0
        ? `${baseUrl} lists ${skippedNoTools} model(s), but none declares tool calling — the agent can't run them.`
        : `${baseUrl}/models returned no usable models.`,
    );
  }
  return { provider: options.provider, baseUrl, models, skippedNoTools };
}

// ── Persistence ───────────────────────────────────────────

export function gatewayCachePath(): string {
  return path.join(getAppPaths().agentDir, "gateway-models.json");
}

export async function readGatewayCache(): Promise<GatewayCatalogCache> {
  try {
    const raw = await fs.readFile(gatewayCachePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const root = asRecord(parsed);
    const providers = asRecord(root?.providers);
    if (!providers) return { version: 1, providers: {} };
    const out: GatewayCatalogCache = { version: 1, providers: {} };
    for (const [provider, value] of Object.entries(providers)) {
      const row = asRecord(value);
      const models = Array.isArray(row?.models) ? (row.models as ModelInfo[]) : [];
      const baseUrl = typeof row?.baseUrl === "string" ? row.baseUrl : "";
      const syncedAt = typeof row?.syncedAt === "number" ? row.syncedAt : 0;
      if (models.length > 0) out.providers[provider] = { baseUrl, syncedAt, models };
    }
    return out;
  } catch {
    return { version: 1, providers: {} };
  }
}

export async function writeGatewayCacheEntry(
  provider: string,
  entry: { baseUrl: string; syncedAt: number; models: ModelInfo[] },
): Promise<void> {
  const cache = await readGatewayCache();
  cache.providers[provider] = entry;
  const file = gatewayCachePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${os.userInfo().username.length}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch {
    // A cache that can't be written still works for this process; never throw.
  }
}
