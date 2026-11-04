import fs from "node:fs/promises";
import path from "node:path";
import {
  OPENROUTER_DEFAULT_BASE_URL,
  getAppPaths,
  getProviderCatalog,
  parseOpenRouterCatalog,
  setProviderCatalog,
  type AuthStorage,
  type ModelInfo,
} from "@kenkaiiii/gg-core";
import { atomicWrite } from "./session-storage.js";

/**
 * OpenRouter's model list, synced from whichever endpoint the key points at
 * (openrouter.ai or a compatible gateway) and cached so it survives restarts.
 * The cache is only trusted for the base URL it was synced from: changing the
 * URL falls back to the built-in list until the user syncs again.
 */
interface CatalogFile {
  baseUrl: string;
  syncedAt: number;
  models: ModelInfo[];
}

export interface OpenRouterCatalogStatus {
  synced: boolean;
  count: number;
  syncedAt?: number;
  baseUrl: string;
}

export interface OpenRouterSyncResult extends OpenRouterCatalogStatus {
  skipped: number;
}

export interface CatalogStoreOptions {
  file?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class CatalogSyncError extends Error {}

function catalogFile(options: CatalogStoreOptions): string {
  return options.file ?? path.join(getAppPaths().agentDir, "openrouter-models.json");
}

async function activeBaseUrl(auth: AuthStorage): Promise<string> {
  const creds = await auth.getCredentials("openrouter");
  return (creds?.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

let syncedFrom: { baseUrl: string; syncedAt: number } | undefined;

function status(baseUrl: string): OpenRouterCatalogStatus {
  const catalog = getProviderCatalog("openrouter");
  return catalog && syncedFrom
    ? { synced: true, count: catalog.length, syncedAt: syncedFrom.syncedAt, baseUrl }
    : { synced: false, count: 0, baseUrl };
}

const LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function positiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A cached row is only trusted if it still has the shape the parser writes. */
function cachedModel(raw: unknown): ModelInfo | undefined {
  const m = raw as Partial<ModelInfo> | null;
  if (
    !m ||
    typeof m.id !== "string" ||
    !m.id ||
    typeof m.name !== "string" ||
    m.provider !== "openrouter" ||
    !positiveInt(m.contextWindow) ||
    !positiveInt(m.maxOutputTokens) ||
    typeof m.supportsThinking !== "boolean" ||
    typeof m.supportsImages !== "boolean" ||
    !["low", "medium", "high"].includes(m.costTier as string) ||
    !LEVELS.has(m.maxThinkingLevel as string) ||
    (m.thinkingLevels !== undefined &&
      (!Array.isArray(m.thinkingLevels) || !m.thinkingLevels.every((l) => LEVELS.has(l)))) ||
    (m.defaultThinkingLevel !== undefined && !LEVELS.has(m.defaultThinkingLevel))
  ) {
    return undefined;
  }
  return {
    id: m.id,
    name: m.name,
    provider: "openrouter",
    contextWindow: m.contextWindow!,
    maxOutputTokens: m.maxOutputTokens!,
    supportsThinking: m.supportsThinking,
    supportsImages: m.supportsImages,
    supportsVideo: false,
    costTier: m.costTier!,
    maxThinkingLevel: m.maxThinkingLevel!,
    ...(m.thinkingLevels ? { thinkingLevels: m.thinkingLevels } : {}),
    ...(m.defaultThinkingLevel ? { defaultThinkingLevel: m.defaultThinkingLevel } : {}),
  };
}

async function readFile(file: string): Promise<CatalogFile | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CatalogFile>;
    if (typeof parsed.baseUrl !== "string" || !Array.isArray(parsed.models)) return undefined;
    const models = parsed.models.map(cachedModel).filter((m): m is ModelInfo => m !== undefined);
    return { baseUrl: parsed.baseUrl, syncedAt: Number(parsed.syncedAt) || 0, models };
  } catch {
    return undefined;
  }
}

function install(baseUrl: string, syncedAt: number, models: ModelInfo[]): number {
  const installed = setProviderCatalog("openrouter", models);
  syncedFrom = { baseUrl, syncedAt };
  return installed.length;
}

/** Boot: reinstall the cached catalog when it matches the key's current endpoint. */
export async function loadOpenRouterCatalog(
  auth: AuthStorage,
  options: CatalogStoreOptions = {},
): Promise<OpenRouterCatalogStatus> {
  const baseUrl = await activeBaseUrl(auth);
  const cached = await readFile(catalogFile(options));
  if (cached && cached.baseUrl === baseUrl && cached.models.length > 0) {
    install(baseUrl, cached.syncedAt, cached.models);
  } else {
    setProviderCatalog("openrouter", undefined);
    syncedFrom = undefined;
  }
  return status(baseUrl);
}

export async function openRouterCatalogStatus(auth: AuthStorage): Promise<OpenRouterCatalogStatus> {
  const baseUrl = await activeBaseUrl(auth);
  // The key's endpoint changed since the sync: that catalog describes another server.
  if (syncedFrom && syncedFrom.baseUrl !== baseUrl) {
    setProviderCatalog("openrouter", undefined);
    syncedFrom = undefined;
  }
  return status(baseUrl);
}

/** Fetch `<baseUrl>/models` with the stored key and install the tool-capable rows. */
export async function syncOpenRouterCatalog(
  auth: AuthStorage,
  options: CatalogStoreOptions = {},
): Promise<OpenRouterSyncResult> {
  const creds = await auth.getCredentials("openrouter");
  if (!creds?.accessToken) throw new CatalogSyncError("Connect an OpenRouter API key first.");
  const baseUrl = (creds.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  let body: unknown;
  try {
    const res = await doFetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${creds.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
      throw new CatalogSyncError(`${baseUrl}/models answered HTTP ${res.status}.`);
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof CatalogSyncError) throw err;
    throw new CatalogSyncError(`Couldn't read ${baseUrl}/models.`);
  }
  const { models, skipped } = parseOpenRouterCatalog(body);
  // An empty answer never wipes a working list.
  if (models.length === 0) {
    throw new CatalogSyncError(
      `${baseUrl}/models listed no models that can call tools, so the current list was kept.`,
    );
  }
  const syncedAt = Date.now();
  const file = catalogFile(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify({ baseUrl, syncedAt, models } satisfies CatalogFile));
  const count = install(baseUrl, syncedAt, models);
  return { synced: true, count, syncedAt, baseUrl, skipped: skipped + models.length - count };
}

/** Back to the built-in OpenRouter list. */
export async function resetOpenRouterCatalog(
  auth: AuthStorage,
  options: CatalogStoreOptions = {},
): Promise<OpenRouterCatalogStatus> {
  setProviderCatalog("openrouter", undefined);
  syncedFrom = undefined;
  await fs.rm(catalogFile(options), { force: true });
  return status(await activeBaseUrl(auth));
}
