/**
 * Register the synced gateway model catalogs (OpenRouter, or a custom base URL
 * it's pointed at) into this process's model registry.
 *
 * The app daemon syncs them (`POST /models/sync`) and caches them in
 * `~/.gg/gateway-models.json`; every surface that resolves a model id has to
 * load that cache or `openrouter/<rawId>` looks unknown — which silently costs
 * the endpoint's declared effort ladder and falls back to the static defaults.
 * That is why the CLI's `--json` path (which returns before the main init
 * block) calls this too.
 */
import { readGatewayCache } from "@kenkaiiii/gg-core";
import { clearRuntimeModels, registerRuntimeModels } from "./model-registry.js";
import { log } from "./logger.js";

let loaded = false;

export async function ensureGatewayCatalogLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const cache = await readGatewayCache();
    for (const [provider, entry] of Object.entries(cache.providers)) {
      clearRuntimeModels((m) => m.provider === provider);
      registerRuntimeModels(entry.models);
      log("DEBUG", "models", "synced catalog loaded", {
        provider,
        count: String(entry.models.length),
        baseUrl: entry.baseUrl,
      });
    }
  } catch {
    // No cache (never synced) is normal: the static catalog stands.
  }
}

/** Test-only: allow a later call to reload after the cache changed. */
export function resetGatewayCatalogLoadedForTests(): void {
  loaded = false;
}
