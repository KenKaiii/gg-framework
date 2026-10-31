/**
 * Local model discovery — Ollama, LM Studio, llama.cpp (`llama-server`), vLLM,
 * and any other OpenAI-compatible server the user points us at.
 *
 * Everything rides the OpenAI-compatible `/v1` transport (see the `local`
 * provider in gg-ai's stream.ts); the only per-server difference is where the
 * *capabilities* come from, because `GET /v1/models` reports nothing useful:
 *
 *   - Ollama    → `/api/show` + `/api/ps` → capabilities + running context
 *   - LM Studio → `/api/v1/models` (v0 fallback) → capabilities + loaded context
 *   - llama.cpp → `GET /props`          → `default_generation_settings.n_ctx`
 *   - vLLM      → `max_model_len` on the model object; llama.cpp-derived
 *                 servers instead report `context_length` or `meta.n_ctx`
 *                 on the same object, and a custom endpoint may pin one by hand.
 *
 * Probing never throws: an unreachable server is a normal state (the user just
 * doesn't have it running), not an error to surface.
 */
import type { ModelInfo } from "./model-registry.js";
import { log } from "./logger.js";

// ── Types ──────────────────────────────────────────────────

/** Which capability API a local endpoint speaks, beyond plain `/v1/models`. */
export type LocalEndpointKind = "ollama" | "lmstudio" | "llamacpp" | "vllm" | "custom";

export interface LocalEndpoint {
  /** Stable slug, used in model ids (`local/<id>/<rawId>`) and auth keys (`local:<id>`). */
  id: string;
  label: string;
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  baseUrl: string;
  kind: LocalEndpointKind;
  /** Optional bearer token (LM Studio 0.4+ can require one). */
  apiKey?: string;
  /** True for endpoints the user added by hand (removable). */
  custom?: boolean;
  /**
   * User-pinned context window for this endpoint. Wins over anything the
   * server reports — for servers that report nothing at all, and for capping
   * a server whose reported window is more than you want the app to use.
   * Set it on a custom endpoint's entry under `localEndpoints` in
   * `~/.gg/gg-app.json`; it survives re-adding the same host.
   */
  contextLength?: number;
}

/** One model as reported (and enriched) by a local server. */
export interface LocalModel {
  /** Model id on the wire, exactly as the server names it (e.g. `qwen3-coder:30b`). */
  rawId: string;
  endpointId: string;
  contextWindow: number;
  /** True when the server told us the real window; false means we guessed. */
  contextWindowKnown: boolean;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  /** LM Studio only: whether the model is currently resident in memory. */
  loaded?: boolean;
}

export interface LocalEndpointProbe {
  endpoint: LocalEndpoint;
  reachable: boolean;
  /** Human-readable reason when `reachable` is false (never a raw stack). */
  reason?: string;
  models: LocalModel[];
}

// ── Defaults ───────────────────────────────────────────────

/**
 * The server we look for without being asked. LM Studio, llama.cpp and vLLM
 * are no longer auto-probed — one honest row beats four mostly-dead ones;
 * anything else is one "Add endpoint" away (custom kind keeps working).
 */
export const DEFAULT_LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", kind: "ollama" },
];

/**
 * Context window assumed when a server tells us nothing. Deliberately
 * conservative: over-guessing means the provider 400s mid-run at a point
 * auto-compaction already sailed past, while under-guessing only compacts early.
 */
// Matches Ollama's smallest documented default; still a guess, not an allocation.
export const FALLBACK_CONTEXT_WINDOW = 4096;

/** Placeholder token for endpoints with no key — these servers ignore it. */
export const LOCAL_API_KEY_PLACEHOLDER = "local";

const DEFAULT_PROBE_TIMEOUT_MS = 1200;
/** Capability lookups are per-model; cap the fan-out so 40 Ollama models don't stampede. */
const ENRICH_CONCURRENCY = 6;
const CACHE_TTL_MS = 30_000;

/** Ids that are embedding/rerank models, not chat models — they can't drive an agent. */
const NON_CHAT_ID_PATTERN = /(?:^|[-_/])(?:embed|embedding|rerank|reranker|bge|nomic-embed)/i;

// ── Model id scheme ────────────────────────────────────────

const LOCAL_ID_PREFIX = "local/";

/**
 * `local/<endpointId>/<rawModelId>`. The raw id can itself contain slashes
 * (`hf.co/user/repo:q4`), so only the first two segments are structural.
 */
export function formatLocalModelId(endpointId: string, rawId: string): string {
  return `${LOCAL_ID_PREFIX}${endpointId}/${rawId}`;
}

export function parseLocalModelId(id: string): { endpointId: string; rawId: string } | undefined {
  if (!id.startsWith(LOCAL_ID_PREFIX)) return undefined;
  const rest = id.slice(LOCAL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { endpointId: rest.slice(0, slash), rawId: rest.slice(slash + 1) };
}

export function isLocalModelId(id: string): boolean {
  return parseLocalModelId(id) !== undefined;
}

/** Auth-storage key holding the credential (and baseUrl) for one local endpoint. */
export function localAuthStorageKey(endpointId: string): string {
  return `local:${endpointId}`;
}

// ── HTTP helpers ───────────────────────────────────────────

/** Base URL with any trailing `/v1` (and trailing slashes) removed — the server root. */
export function endpointRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function authHeaders(endpoint: LocalEndpoint): Record<string, string> {
  return {
    Authorization: `Bearer ${endpoint.apiKey ?? LOCAL_API_KEY_PLACEHOLDER}`,
    Accept: "application/json",
  };
}

interface FetchJsonOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  body?: unknown;
}

/** GET/POST JSON with a hard timeout. Returns `undefined` on any failure. */
async function fetchJson<T>(
  url: string,
  endpoint: LocalEndpoint,
  options: FetchJsonOptions,
): Promise<T | undefined> {
  try {
    const res = await fetchJsonOrThrow<T>(url, endpoint, options);
    return res;
  } catch {
    return undefined;
  }
}

async function fetchJsonOrThrow<T>(
  url: string,
  endpoint: LocalEndpoint,
  { timeoutMs, signal, method = "GET", body }: FetchJsonOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body
        ? { ...authHeaders(endpoint), "Content-Type": "application/json" }
        : authHeaders(endpoint),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Turn a fetch failure into wording a user can act on. */
function unreachableReason(endpoint: LocalEndpoint, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) return `No response from ${endpoint.baseUrl} (timed out)`;
  if (/HTTP 401|HTTP 403/.test(message)) {
    return `${endpoint.baseUrl} rejected the API key (HTTP ${message.includes("401") ? 401 : 403})`;
  }
  if (/HTTP \d+/.test(message)) return `${endpoint.baseUrl} returned ${message}`;
  return `Not running at ${endpoint.baseUrl}`;
}

// ── Server response shapes ─────────────────────────────────

interface OpenAIModelListEntry {
  id?: string;
  /** vLLM reports the real window here. */
  max_model_len?: number;
  /** llama.cpp-derived servers (llama-server forks, GGUF frontends) use this. */
  context_length?: number;
  /** llama.cpp rides the loaded allocation in `meta.n_ctx` on the same object. */
  meta?: { n_ctx?: number };
}
interface OpenAIModelList {
  data?: OpenAIModelListEntry[];
}

interface OllamaShowResponse {
  capabilities?: string[];
}
interface OllamaRunningModels {
  models?: { name?: string; model?: string; context_length?: number }[];
}

interface LmStudioV1ModelList {
  models?: {
    key?: string;
    type?: string;
    capabilities?: { vision?: boolean };
    loaded_instances?: { id?: string; config?: { context_length?: number } }[];
  }[];
}

interface LmStudioModelEntry {
  id?: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}
interface LmStudioModelList {
  data?: LmStudioModelEntry[];
}

interface LlamaCppProps {
  default_generation_settings?: { n_ctx?: number };
}

// ── Probing ────────────────────────────────────────────────

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ask one endpoint what it serves. Never throws — an unreachable server yields
 * `{ reachable: false, reason }` so the UI can say "not running" without an
 * error toast.
 */
export async function probeEndpoint(
  endpoint: LocalEndpoint,
  { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal }: ProbeOptions = {},
): Promise<LocalEndpointProbe> {
  const listUrl = `${endpoint.baseUrl.replace(/\/+$/, "")}/models`;
  let list: OpenAIModelList;
  try {
    list = await fetchJsonOrThrow<OpenAIModelList>(listUrl, endpoint, { timeoutMs, signal });
  } catch (err) {
    return { endpoint, reachable: false, reason: unreachableReason(endpoint, err), models: [] };
  }

  const entries = (list.data ?? []).filter(
    (entry): entry is OpenAIModelListEntry & { id: string } =>
      typeof entry.id === "string" && entry.id.length > 0 && !NON_CHAT_ID_PATTERN.test(entry.id),
  );

  const models = await enrich(endpoint, entries, { timeoutMs, signal });
  log("INFO", "local-models", `Probed ${endpoint.label}`, {
    baseUrl: endpoint.baseUrl,
    models: String(models.length),
  });
  return { endpoint, reachable: true, models };
}

async function enrich(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  if (endpoint.kind === "lmstudio") return enrichLmStudio(endpoint, entries, options);
  if (endpoint.kind === "ollama") return enrichOllama(endpoint, entries, options);
  if (endpoint.kind === "llamacpp") return enrichLlamaCpp(endpoint, entries, options);
  return entries.map((entry) => genericModel(endpoint, entry));
}

/**
 * Servers that report no capabilities (vLLM, generic gateways) gate tool calling
 * per-model server-side. Assuming tools work is the useful default: a model that
 * genuinely can't will surface a normal provider error on the first tool call,
 * whereas assuming it can't makes every such model unusable.
 */
function genericModel(
  endpoint: LocalEndpoint,
  entry: OpenAIModelListEntry & { id: string },
): LocalModel {
  // A user pin wins (cap a 512k server to what you want the app to use, or
  // supply a window a server never reported); otherwise trust whichever
  // spelling of "this is my window" the server speaks.
  const declared =
    contextLength(endpoint.contextLength) ??
    contextLength(entry.max_model_len) ??
    contextLength(entry.context_length) ??
    contextLength(entry.meta?.n_ctx);
  return {
    rawId: entry.id,
    endpointId: endpoint.id,
    contextWindow: declared ?? FALLBACK_CONTEXT_WINDOW,
    contextWindowKnown: declared !== undefined,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
  };
}

async function enrichOllama(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  const showUrl = `${endpointRoot(endpoint.baseUrl)}/api/show`;
  const running = await fetchJson<OllamaRunningModels>(
    `${endpointRoot(endpoint.baseUrl)}/api/ps`,
    endpoint,
    options,
  );
  const runningModels = Array.isArray(running?.models) ? running.models : [];
  const enriched = await mapLimited(entries, ENRICH_CONCURRENCY, async (entry) => {
    const show = await fetchJson<OllamaShowResponse>(showUrl, endpoint, {
      ...options,
      method: "POST",
      body: { model: entry.id },
    });
    const caps = Array.isArray(show?.capabilities) ? show.capabilities : [];
    // Capabilities are authoritative for "is this a chat model at all". Names
    // like `all-minilm` carry no hint, so filtering on the id alone leaves
    // embedding models in the picker as dead, tool-less rows.
    if (caps.includes("embedding") && !caps.includes("completion")) return undefined;
    const ctx = contextLength(
      runningModels.find((model) => model?.name === entry.id || model?.model === entry.id)
        ?.context_length,
    );
    return {
      rawId: entry.id,
      endpointId: endpoint.id,
      contextWindow: ctx ?? FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: ctx !== undefined,
      // Ollama reports capabilities honestly, so trust it here rather than
      // using the optimistic generic default.
      supportsTools: show ? caps.includes("tools") : true,
      supportsImages: caps.includes("vision"),
      supportsThinking: caps.includes("thinking"),
    };
  });
  return enriched.filter((model): model is LocalModel => model !== undefined);
}

/** Never let malformed server metadata become a request or compaction budget. */
function contextLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function enrichLmStudio(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  const root = endpointRoot(endpoint.baseUrl);
  const detail = await fetchJson<LmStudioV1ModelList>(`${root}/api/v1/models`, endpoint, options);
  const byId = new Map<string, LmStudioModelEntry>();
  if (Array.isArray(detail?.models)) {
    for (const model of detail.models) {
      if (typeof model?.key !== "string") continue;
      const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
      const contexts = instances.map((instance) => contextLength(instance?.config?.context_length));
      // A model key may route to any loaded instance; use the smallest allocation.
      const ctx =
        contexts.length && contexts.every((value) => value !== undefined)
          ? contexts.reduce((min, value) => Math.min(min, value))
          : undefined;
      const info: LmStudioModelEntry = {
        id: model.key,
        type: model.type === "llm" && model.capabilities?.vision === true ? "vlm" : model.type,
        state: instances.length ? "loaded" : "not-loaded",
        loaded_context_length: ctx,
      };
      byId.set(model.key, info);
      for (const instance of instances) {
        if (typeof instance?.id === "string" && instance.id !== model.key) {
          byId.set(instance.id, {
            ...info,
            id: instance.id,
            loaded_context_length: contextLength(instance.config?.context_length),
          });
        }
      }
    }
  } else {
    const legacy = await fetchJson<LmStudioModelList>(`${root}/api/v0/models`, endpoint, options);
    if (Array.isArray(legacy?.data)) {
      for (const model of legacy.data) {
        if (typeof model?.id === "string") byId.set(model.id, model);
      }
    }
  }
  const models: LocalModel[] = [];
  for (const entry of entries) {
    const info = byId.get(entry.id);
    // `type` is authoritative here: embeddings models are listed by
    // /v1/models too and would otherwise show up as selectable chat models.
    if (info && info.type !== "llm" && info.type !== "vlm") continue;
    const ctx = info?.state === "loaded" ? contextLength(info.loaded_context_length) : undefined;
    models.push({
      rawId: entry.id,
      endpointId: endpoint.id,
      contextWindow: ctx ?? FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: ctx !== undefined,
      // LM Studio doesn't report tool support; it gates per-model at request time.
      supportsTools: true,
      supportsImages: info?.type === "vlm",
      supportsThinking: false,
      loaded: info?.state === "loaded",
    });
  }
  return models;
}

async function enrichLlamaCpp(
  endpoint: LocalEndpoint,
  entries: (OpenAIModelListEntry & { id: string })[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<LocalModel[]> {
  const props = await fetchJson<LlamaCppProps>(
    `${endpointRoot(endpoint.baseUrl)}/props`,
    endpoint,
    options,
  );
  const nCtx = contextLength(props?.default_generation_settings?.n_ctx);
  const known = nCtx !== undefined;
  return entries.map((entry) => ({
    ...genericModel(endpoint, entry),
    contextWindow: known ? nCtx : FALLBACK_CONTEXT_WINDOW,
    contextWindowKnown: known,
  }));
}

/** Bounded-parallel map — keeps input order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── ModelInfo mapping ──────────────────────────────────────

/**
 * Highest reasoning effort an endpoint accepts. Ollama documents (and 0.32
 * verifiably accepts) `low|medium|high|max|none` on `reasoning_effort`; the
 * other OpenAI-compatible servers only define `low|medium|high`, so they stop
 * at `high` rather than risking a 400 mid-run on an effort they never declared.
 * No local server accepts `xhigh`.
 */
function maxThinkingLevelFor(endpoint: LocalEndpoint): "high" | "max" {
  return endpoint.kind === "ollama" ? "max" : "high";
}

/** Convert a probed local model into the registry shape the whole app speaks. */
export function toModelInfo(model: LocalModel, endpoint: LocalEndpoint): ModelInfo {
  return {
    id: formatLocalModelId(model.endpointId, model.rawId),
    name: `${model.rawId} (${endpoint.label})`,
    provider: "local",
    contextWindow: model.contextWindow,
    // Leave real headroom for the prompt on small local windows.
    maxOutputTokens: Math.max(512, Math.min(4096, Math.floor(model.contextWindow / 4))),
    supportsThinking: model.supportsThinking,
    supportsImages: model.supportsImages,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: maxThinkingLevelFor(endpoint),
    authStorageKeys: [localAuthStorageKey(model.endpointId)],
  };
}

// ── Discovery ──────────────────────────────────────────────

export interface DiscoveryResult {
  probes: LocalEndpointProbe[];
  models: ModelInfo[];
}

interface CacheEntry {
  key: string;
  at: number;
  result: DiscoveryResult;
}

let cache: CacheEntry | undefined;

function cacheKey(endpoints: readonly LocalEndpoint[]): string {
  return endpoints.map((e) => `${e.id}@${e.baseUrl}`).join("|");
}

export interface DiscoverOptions extends ProbeOptions {
  /** Skip the 30s cache (the UI's "Scan" button). */
  force?: boolean;
}

/**
 * Probe every endpoint in parallel and return both the per-endpoint status (for
 * the UI) and the `ModelInfo[]` ready for `registerRuntimeModels()`. Results are
 * cached for 30s per endpoint set so repeated `GET /models` calls don't re-probe
 * four servers; `force` bypasses it after an `ollama pull`.
 */
export async function discoverLocalModels(
  endpoints: readonly LocalEndpoint[] = DEFAULT_LOCAL_ENDPOINTS,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const key = cacheKey(endpoints);
  if (!options.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.result;
  }
  const probes = await Promise.all(endpoints.map((endpoint) => probeEndpoint(endpoint, options)));
  const models = probes.flatMap((probe) =>
    probe.models.map((model) => toModelInfo(model, probe.endpoint)),
  );
  const result: DiscoveryResult = { probes, models };
  cache = { key, at: Date.now(), result };
  return result;
}

/** Drop the discovery cache (used by tests and after an endpoint is added/removed). */
export function clearLocalDiscoveryCache(): void {
  cache = undefined;
}

/** Look up the probed capabilities of a discovered model, by full local id. */
export function findProbedModel(
  probes: readonly LocalEndpointProbe[],
  modelId: string,
): { model: LocalModel; endpoint: LocalEndpoint } | undefined {
  const parsed = parseLocalModelId(modelId);
  if (!parsed) return undefined;
  for (const probe of probes) {
    if (probe.endpoint.id !== parsed.endpointId) continue;
    const model = probe.models.find((m) => m.rawId === parsed.rawId);
    if (model) return { model, endpoint: probe.endpoint };
  }
  return undefined;
}
