import fs from "node:fs/promises";
import path from "node:path";
import {
  HERMES_PROXY_BASE_URL,
  NOUS_AUTH_KEY,
  getAppPaths,
  parseNousCatalog,
  setProviderCatalog,
  type AuthStorage,
  type ModelInfo,
} from "@kenkaiiii/gg-core";
import { atomicWrite } from "./session-storage.js";
import { cachedCatalogModel } from "./openrouter-catalog-store.js";

/**
 * Every model on the user's Nous Portal plan, read from the Portal's `/models`
 * through the Hermes proxy and cached so the picker has it at the next start
 * before the proxy is up. Synced automatically on sign-in and at startup.
 */
interface CatalogFile {
  syncedAt: number;
  models: ModelInfo[];
}

export interface NousCatalogOptions {
  file?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function catalogFile(options: NousCatalogOptions): string {
  return options.file ?? path.join(getAppPaths().agentDir, "nous-models.json");
}

/** Boot: install the cached plan list. Returns how many models it installed. */
export async function loadNousCatalog(options: NousCatalogOptions = {}): Promise<number> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(catalogFile(options), "utf8"),
    ) as Partial<CatalogFile>;
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .map((m) => cachedCatalogModel(m, "nous"))
      .filter((m): m is ModelInfo => m !== undefined);
    if (models.length === 0) return 0;
    return setProviderCatalog("nous", models).length;
  } catch {
    return 0;
  }
}

/** Fetch the plan's models through the proxy, install the tool-capable ones and cache them. */
export async function syncNousCatalog(
  auth: AuthStorage,
  options: NousCatalogOptions = {},
): Promise<number> {
  const creds = await auth.getCredentials(NOUS_AUTH_KEY);
  if (!creds) throw new Error("Sign in with Hermes to connect Nous Portal first.");
  const baseUrl = (creds.baseUrl ?? HERMES_PROXY_BASE_URL).replace(/\/+$/, "");
  const res = await (options.fetch ?? fetch)(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${creds.accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`Nous Portal's model list answered HTTP ${res.status}.`);
  const { models } = parseNousCatalog(await res.json());
  // An empty answer never wipes a working list.
  if (models.length === 0) return 0;
  const file = catalogFile(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify({ syncedAt: Date.now(), models } satisfies CatalogFile));
  return setProviderCatalog("nous", models).length;
}

/** Disconnecting drops the plan list; the built-in rows return. */
export async function resetNousCatalog(options: NousCatalogOptions = {}): Promise<void> {
  setProviderCatalog("nous", undefined);
  await fs.rm(catalogFile(options), { force: true });
}
