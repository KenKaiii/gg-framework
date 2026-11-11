import fs from "node:fs/promises";
import path from "node:path";
import { GG_CODER_USER_AGENT } from "@kenkaiiii/gg-ai";
import {
  OPENCODE_CATALOG_URLS,
  OPENCODE_PROVIDERS,
  getAppPaths,
  getProviderCatalog,
  parseOpenCodeCatalog,
  setProviderCatalog,
  type OpenCodeProvider,
} from "@kenkaiiii/gg-core";
import { atomicWrite } from "./session-storage.js";

/**
 * OpenCode's model lists (Go and pay-as-you-go), read from the Console's
 * public `/v1/models` and cached so they survive restarts and offline starts.
 * The lists change often, so a connected plan's list is read again once it is
 * older than `REFRESH_MS`; the built-in rows only cover a first offline start.
 */
const REFRESH_MS = 6 * 60 * 60_000;
/** After a failed read, wait this long before trying again. */
const RETRY_MS = 10 * 60_000;

interface CatalogFile {
  syncedAt: number;
  /** The `/v1/models` answer as served; parsed again on load, so a stale shape can't install. */
  body: unknown;
}

export interface OpenCodeCatalogStoreOptions {
  /** Folder for the cache files. Defaults to `~/.gg`. */
  dir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface OpenCodeCatalogStore {
  /** Boot: install every cached list. Returns true when any list was installed. */
  load(): Promise<boolean>;
  /**
   * Read the list again for each connected OpenCode plan whose list is stale.
   * Never throws: a failed read keeps the current list. Returns true when a
   * list changed, so the caller can refresh open model pickers.
   */
  refreshStale(connected: readonly string[]): Promise<boolean>;
}

export function createOpenCodeCatalogStore(
  options: OpenCodeCatalogStoreOptions = {},
): OpenCodeCatalogStore {
  const now = options.now ?? Date.now;
  const nextRead = new Map<OpenCodeProvider, number>();
  const inFlight = new Map<OpenCodeProvider, Promise<boolean>>();

  const file = (provider: OpenCodeProvider): string =>
    path.join(options.dir ?? getAppPaths().agentDir, `${provider}-models.json`);

  /** Install `body`'s rows; false when it lists nothing usable or nothing changed. */
  function install(provider: OpenCodeProvider, body: unknown): boolean {
    const { models } = parseOpenCodeCatalog(provider, body);
    // An empty answer never wipes a working list.
    if (models.length === 0) return false;
    const before = JSON.stringify(getProviderCatalog(provider) ?? null);
    return JSON.stringify(setProviderCatalog(provider, models)) !== before;
  }

  async function load(): Promise<boolean> {
    let installed = false;
    for (const provider of OPENCODE_PROVIDERS) {
      try {
        const cached = JSON.parse(await fs.readFile(file(provider), "utf8")) as CatalogFile;
        if (install(provider, cached.body)) installed = true;
        nextRead.set(provider, (Number(cached.syncedAt) || 0) + REFRESH_MS);
      } catch {
        // No cache yet, or an unreadable one: the built-in rows stay.
      }
    }
    return installed;
  }

  async function refresh(provider: OpenCodeProvider): Promise<boolean> {
    nextRead.set(provider, now() + RETRY_MS);
    try {
      const res = await (options.fetch ?? fetch)(OPENCODE_CATALOG_URLS[provider], {
        headers: { Accept: "application/json", "User-Agent": GG_CODER_USER_AGENT },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!res.ok) return false;
      const body: unknown = await res.json();
      if (parseOpenCodeCatalog(provider, body).models.length === 0) return false;
      const target = file(provider);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, JSON.stringify({ syncedAt: now(), body } satisfies CatalogFile));
      nextRead.set(provider, now() + REFRESH_MS);
      return install(provider, body);
    } catch {
      return false;
    }
  }

  async function refreshStale(connected: readonly string[]): Promise<boolean> {
    const due = OPENCODE_PROVIDERS.filter(
      (p) => connected.includes(p) && (inFlight.has(p) || now() >= (nextRead.get(p) ?? 0)),
    );
    const results = await Promise.all(
      due.map((provider) => {
        let running = inFlight.get(provider);
        if (!running) {
          running = refresh(provider).finally(() => inFlight.delete(provider));
          inFlight.set(provider, running);
        }
        return running;
      }),
    );
    return results.some(Boolean);
  }

  return { load, refreshStale };
}

/** The app's one store: the sidecar loads it at boot and refreshes it from `/models`. */
export const openCodeCatalogs = createOpenCodeCatalogStore();
