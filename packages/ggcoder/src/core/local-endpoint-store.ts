/**
 * Persistence for user-added local model endpoints.
 *
 * The four well-known servers (Ollama, LM Studio, llama.cpp, vLLM) are probed
 * without configuration; this store holds only the extra endpoints a user typed
 * in — a moved port, a remote self-hosted box, an OpenAI-compatible gateway.
 *
 * Endpoints live in `~/.gg/gg-app.json` under `localEndpoints`; each one's key
 * (and, for keyed servers, its token) lives in `~/.gg/auth.json` as a
 * `local:<id>` credential, which is also what carries the baseUrl into the
 * stream call. The two are kept in sync here so the UI never has to.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  DEFAULT_LOCAL_ENDPOINTS,
  clearLocalDiscoveryCache,
  withFileLock,
  type LocalEndpoint,
} from "@kenkaiiii/gg-core";
import { atomicWrite } from "./session-storage.js";

/** What the caller supplies when adding an endpoint. */
export interface LocalEndpointInput {
  label?: string;
  baseUrl: string;
  apiKey?: string;
  /**
   * Optional user-pinned context window (positive integer). When omitted on a
   * re-add, any previously stored value for the same host is kept — so a pin
   * set by hand in `gg-app.json` survives a "fix my mistyped key" re-add.
   */
  contextLength?: number;
}

export class LocalEndpointError extends Error {}

/**
 * Where this store reads and writes. Both default to the real user's files;
 * tests inject a temp directory so they never touch `~/.gg` — note that
 * overriding `$HOME` is NOT a portable way to do that, since `os.homedir()`
 * reads `USERPROFILE` on Windows.
 */
export interface LocalEndpointStoreOptions {
  /** Path to the gg-app settings file (defaults to `~/.gg/gg-app.json`). */
  settingsFile?: string;
  /** Auth storage holding the `local:<id>` credentials. */
  auth?: AuthStorage;
}

const RESERVED_IDS = new Set(DEFAULT_LOCAL_ENDPOINTS.map((e) => e.id));
const MAX_CUSTOM_ENDPOINTS = 20;

function appSettingsFile(override?: string): string {
  return override ?? path.join(os.homedir(), ".gg", "gg-app.json");
}

/**
 * Normalize a user-typed URL into the OpenAI-compatible base we call.
 * Accepts `host:port`, a bare root, or a full `/v1` URL, and tolerates a pasted
 * `/v1/chat/completions` or `/v1/models` (people copy from docs).
 */
export function normalizeLocalBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new LocalEndpointError("Endpoint URL is required.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new LocalEndpointError("Endpoint URL must use http or https.");
  }
  // Bare `host:port` is the common case — assume plain http, like the servers do.
  const withScheme = scheme ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new LocalEndpointError(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalEndpointError("Endpoint URL must use http or https.");
  }
  if (!url.hostname) throw new LocalEndpointError("Endpoint URL is missing a host.");
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(?:chat\/completions|completions|models)$/, "");
  if (!/\/v\d+$/.test(pathname)) pathname = `${pathname}/v1`;
  return `${url.protocol}//${url.host}${pathname}`;
}

/** Slug derived from the URL, e.g. `custom-192-168-1-4-8000`. Stable per host:port. */
function endpointIdFor(baseUrl: string): string {
  const { host } = new URL(baseUrl);
  const slug = host
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `custom-${slug || "endpoint"}`;
}

function labelFor(baseUrl: string, label?: string): string {
  const trimmed = label?.trim();
  if (trimmed) return trimmed;
  return new URL(baseUrl).host;
}

// ── settings file I/O ──────────────────────────────────────

/**
 * Read/modify/write the whole settings object rather than a typed subset, so a
 * key written by another part of the app (or a newer version) survives.
 */
async function readSettings(file?: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(appSettingsFile(file), "utf-8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Replace `localEndpoints` under the shared gg-app.json lock with an atomic
 *  write, re-reading the file inside the lock so a concurrent save of another
 *  key (model prefs, hidden projects) is never lost. */
async function writeLocalEndpoints(value: unknown, file?: string): Promise<void> {
  const target = appSettingsFile(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    const settings = await readSettings(file);
    settings["localEndpoints"] = value;
    await atomicWrite(target, JSON.stringify(settings, null, 2));
  });
}

function parseStored(value: unknown): LocalEndpoint[] {
  if (!Array.isArray(value)) return [];
  const endpoints: LocalEndpoint[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, baseUrl, apiKey, contextLength } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof baseUrl !== "string") continue;
    endpoints.push({
      id,
      label: typeof label === "string" && label ? label : baseUrl,
      baseUrl,
      kind: "custom",
      custom: true,
      ...(typeof apiKey === "string" && apiKey ? { apiKey } : {}),
      ...(typeof contextLength === "number" &&
      Number.isSafeInteger(contextLength) &&
      contextLength > 0
        ? { contextLength }
        : {}),
    });
  }
  return endpoints;
}

/** User-added endpoints, in insertion order. Never throws on a corrupt file. */
export async function listCustomEndpoints(
  options: LocalEndpointStoreOptions = {},
): Promise<LocalEndpoint[]> {
  return parseStored((await readSettings(options.settingsFile))["localEndpoints"]);
}

/** Well-known endpoints first, then the user's own — the probe/scan order. */
export async function listAllEndpoints(
  options: LocalEndpointStoreOptions = {},
): Promise<LocalEndpoint[]> {
  return [...DEFAULT_LOCAL_ENDPOINTS, ...(await listCustomEndpoints(options))];
}

/**
 * Add a custom endpoint and write its `local:<id>` credential. Re-adding the
 * same host updates it (that's how a user fixes a mistyped key) instead of
 * creating a second row for the same server.
 */
export async function addCustomEndpoint(
  input: LocalEndpointInput,
  options: LocalEndpointStoreOptions = {},
): Promise<LocalEndpoint> {
  const auth = options.auth ?? new AuthStorage();
  const baseUrl = normalizeLocalBaseUrl(input.baseUrl);
  const id = endpointIdFor(baseUrl);
  if (RESERVED_IDS.has(id)) {
    throw new LocalEndpointError(`"${id}" is a built-in endpoint id.`);
  }
  const existing = await listCustomEndpoints(options);
  const builtIn = DEFAULT_LOCAL_ENDPOINTS.find((e) => e.baseUrl === baseUrl);
  if (builtIn) {
    throw new LocalEndpointError(`${baseUrl} is already probed automatically as ${builtIn.label}.`);
  }
  if (!existing.some((e) => e.id === id) && existing.length >= MAX_CUSTOM_ENDPOINTS) {
    throw new LocalEndpointError(`At most ${MAX_CUSTOM_ENDPOINTS} custom endpoints.`);
  }

  const prior = existing.find((e) => e.id === id);
  // A valid new pin replaces the old one; a junk one falls back to the pin
  // already stored instead of silently unpinning on a typo.
  const supplied = input.contextLength;
  const pinned =
    (typeof supplied === "number" && Number.isSafeInteger(supplied) && supplied > 0
      ? supplied
      : undefined) ?? prior?.contextLength;
  const pinnedContextLength =
    typeof pinned === "number" && Number.isSafeInteger(pinned) && pinned > 0 ? pinned : undefined;
  const endpoint: LocalEndpoint = {
    id,
    label: labelFor(baseUrl, input.label),
    baseUrl,
    kind: "custom",
    custom: true,
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    ...(pinnedContextLength ? { contextLength: pinnedContextLength } : {}),
  };
  const next = existing.some((e) => e.id === id)
    ? existing.map((e) => (e.id === id ? endpoint : e))
    : [...existing, endpoint];

  await writeLocalEndpoints(
    next.map(({ id: eid, label, baseUrl: url, apiKey, contextLength }) => ({
      id: eid,
      label,
      baseUrl: url,
      ...(apiKey ? { apiKey } : {}),
      ...(contextLength ? { contextLength } : {}),
    })),
    options.settingsFile,
  );
  await auth.setLocalEndpoint(id, baseUrl, endpoint.apiKey);
  clearLocalDiscoveryCache();
  return endpoint;
}

/**
 * Remove a custom endpoint and its credential. Built-in endpoints can't be
 * removed (they're discovered, not configured) — that's an error, not a no-op,
 * so a UI bug doesn't silently do nothing.
 */
export async function removeCustomEndpoint(
  id: string,
  options: LocalEndpointStoreOptions = {},
): Promise<void> {
  const auth = options.auth ?? new AuthStorage();
  if (RESERVED_IDS.has(id)) {
    throw new LocalEndpointError(`${id} is a built-in endpoint and can't be removed.`);
  }
  const existing = await listCustomEndpoints(options);
  if (!existing.some((e) => e.id === id)) {
    throw new LocalEndpointError(`Unknown local endpoint "${id}".`);
  }
  await writeLocalEndpoints(
    existing
      .filter((e) => e.id !== id)
      .map(({ id: eid, label, baseUrl, apiKey, contextLength }) => ({
        id: eid,
        label,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(contextLength ? { contextLength } : {}),
      })),
    options.settingsFile,
  );
  await auth.removeLocalEndpoint(id);
  clearLocalDiscoveryCache();
}

/**
 * Make sure every endpoint we're about to serve models from has a credential
 * carrying its baseUrl — otherwise `stream()` has no endpoint to talk to.
 * Called after each scan, so a fresh install works with zero setup.
 */
export async function syncEndpointCredentials(
  endpoints: readonly LocalEndpoint[],
  options: LocalEndpointStoreOptions = {},
): Promise<void> {
  const auth = options.auth ?? new AuthStorage();
  for (const endpoint of endpoints) {
    await auth.setLocalEndpoint(endpoint.id, endpoint.baseUrl, endpoint.apiKey);
  }
}
