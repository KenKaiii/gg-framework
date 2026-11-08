import {
  discoverLocalModels,
  type LocalEndpointProbe,
  parseLocalModelId,
  probeEndpoint,
  toModelInfo as localModelInfo,
} from "@kleio/core";
import { listAllEndpoints, syncEndpointCredentials } from "../core/local-endpoint-store.js";
import { registerRuntimeModels, getModel } from "../core/model-registry.js";
import { log } from "../core/logger.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { Provider } from "@kleio/ai";

/** How long a new session waits to discover a project's pinned local model. */
const LOCAL_PIN_DISCOVERY_TIMEOUT_MS = 10_000;

/** Reject after `ms` (the timer never outlives the race). */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** POST /session asked for a model that can't be started; the daemon answers 409. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly modelId: string,
    readonly reason: string,
  ) {
    super(`model unavailable: ${modelId}`);
    this.name = "ModelUnavailableError";
  }
}

/**
 * Local models only exist once discovery has registered them, and the
 * per-session scan runs after the model is chosen. For a project pinned to one
 * (e.g. a Tinfoil proxy) or an explicitly requested local model, discover first
 * — bounded, never fatal — so the pin can win.
 */
export async function discoverLocalModelForPin(modelId: string): Promise<void> {
  try {
    const { models } = await withTimeout(
      discoverLocalModels(await listAllEndpoints(), { force: false }),
      LOCAL_PIN_DISCOVERY_TIMEOUT_MS,
    );
    registerRuntimeModels(models);
  } catch (err) {
    log("WARN", "app-sidecar", "local model discovery for a pinned project failed", {
      model: modelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Why local `modelId` can't be selected right now (`problem`), or no problem
 * when it can. Also returns the fresh endpoint probe so a session can keep its
 * cached view honest. Non-local ids have no blocker.
 */
export async function probeLocalModelBlocker(
  modelId: string,
  // A session overlays the context Ollama really served (withServedContexts).
  adjust: (probe: LocalEndpointProbe) => LocalEndpointProbe = (probe) => probe,
): Promise<{ problem?: string; probe?: LocalEndpointProbe }> {
  const parsed = parseLocalModelId(modelId);
  if (!parsed) return {};
  const endpoints = await listAllEndpoints();
  const endpoint = endpoints.find((e) => e.id === parsed.endpointId);
  if (!endpoint) {
    return { problem: `Unknown local endpoint "${parsed.endpointId}" — re-scan for local models.` };
  }
  const probe = adjust(await probeEndpoint(endpoint));
  if (!probe.reachable) {
    return {
      problem: `${endpoint.label} isn't running at ${endpoint.baseUrl}. Start it and scan again.`,
      probe,
    };
  }
  const model = probe.models.find((m) => m.rawId === parsed.rawId);
  if (!model) {
    return { problem: `${endpoint.label} no longer serves "${parsed.rawId}".`, probe };
  }
  if (!model.supportsTools) {
    return {
      problem: `${parsed.rawId} has no tool calling, so it can't run the agent. Pick a tool-capable model.`,
      probe,
    };
  }
  registerRuntimeModels(probe.models.map((m) => localModelInfo(m, endpoint)));
  return { probe };
}

/**
 * Resolve an explicitly requested start model, failing closed: an unknown,
 * blocked, or unauthenticated model throws ModelUnavailableError instead of
 * falling back (possibly to a cloud provider — privacy matters here).
 */
export async function requireStartModel(
  auth: AuthStorage,
  modelId: string,
): Promise<{ provider: Provider; id: string }> {
  if (!getModel(modelId) && parseLocalModelId(modelId)) {
    await discoverLocalModelForPin(modelId);
  }
  const target = getModel(modelId);
  if (!target) throw new ModelUnavailableError(modelId, "not registered");
  const { problem, probe } = await probeLocalModelBlocker(target.id);
  if (problem) throw new ModelUnavailableError(modelId, problem);
  // A reachable local endpoint's credential carries its baseUrl into the
  // stream call; write it now (as a scan would) so a cold daemon can use it.
  if (probe) await syncEndpointCredentials([probe.endpoint], { auth });
  if (!(await auth.hasProviderAuth(target.provider))) {
    throw new ModelUnavailableError(modelId, `provider ${target.provider} is not connected`);
  }
  return { provider: target.provider, id: target.id };
}
