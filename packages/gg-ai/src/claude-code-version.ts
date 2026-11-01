import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { providerDiag } from "./utils/diag.js";

// Anthropic's OAuth edge rejects requests whose claude-cli UA version lags too
// far behind the actual Claude Code release. Resolve dynamically from the npm
// registry so we never ship a stale-version time bomb.
const NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
// Last known good version at publish time. Used when the npm fetch fails and no
// on-disk cache exists, and as a floor for an older cached version. Must stay at
// or above Anthropic's minimum for current models (2.1.280 for Opus 5.5).
export const CLAUDE_CODE_FALLBACK_VERSION = "2.1.316";

function isOlder(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

// A cache written by an older build can hold a version the edge now rejects.
function atLeastFallback(version: string): string {
  return isOlder(version, CLAUDE_CODE_FALLBACK_VERSION) ? CLAUDE_CODE_FALLBACK_VERSION : version;
}

type CachedVersion = { version: string; fetchedAt: number };

let memoryCache: { version: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

function agentDir(): string {
  return path.join(os.homedir(), ".gg");
}

function cachePath(): string {
  return path.join(agentDir(), "claude-code-version.json");
}

async function readDiskCache(): Promise<CachedVersion | null> {
  try {
    const raw = await fs.readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CachedVersion;
    if (typeof parsed.version === "string" && typeof parsed.fetchedAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeDiskCache(data: CachedVersion): Promise<void> {
  try {
    await fs.mkdir(agentDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(cachePath(), JSON.stringify(data), { mode: 0o600 });
  } catch (err) {
    providerDiag("claude_code_version_cache_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(NPM_LATEST_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    if (typeof data.version === "string" && /^\d/.test(data.version)) {
      return data.version;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let refreshing: Promise<void> | null = null;

function refreshInBackground(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const fetched = await fetchLatest();
      if (!fetched) return;
      await writeDiskCache({ version: fetched, fetchedAt: Date.now() });
      memoryCache = { version: fetched, expiresAt: Date.now() + CACHE_TTL_MS };
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Test hook: the pending background refresh, if any. */
export function pendingClaudeCodeVersionRefresh(): Promise<void> | null {
  return refreshing;
}

/**
 * Resolve the current Claude Code release version for spoofing the claude-cli
 * User-Agent on OAuth and inference requests. Cached in-memory for the process
 * lifetime and on disk for 24h. Falls back to a hardcoded constant if the npm
 * registry is unreachable and no cache exists.
 */
export async function getClaudeCodeVersion(): Promise<string> {
  if (memoryCache && Date.now() < memoryCache.expiresAt) {
    return memoryCache.version;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const disk = await readDiskCache();
    const diskFresh = disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS;
    if (disk && diskFresh) {
      const version = atLeastFallback(disk.version);
      memoryCache = { version, expiresAt: Date.now() + CACHE_TTL_MS };
      return version;
    }
    if (disk) {
      // Stale-while-revalidate: a day-old version is still accepted by the
      // OAuth edge, so serve it now and refresh in the background instead of
      // blocking the first request of the day on npm (up to FETCH_TIMEOUT_MS).
      const version = atLeastFallback(disk.version);
      memoryCache = { version, expiresAt: Date.now() + 5 * 60 * 1000 };
      void refreshInBackground();
      return version;
    }
    const fetched = await fetchLatest();
    if (fetched) {
      await writeDiskCache({ version: fetched, fetchedAt: Date.now() });
      memoryCache = { version: fetched, expiresAt: Date.now() + CACHE_TTL_MS };
      return fetched;
    }
    // npm unreachable and no disk cache (a stale one was served above).
    const resolved = CLAUDE_CODE_FALLBACK_VERSION;
    // Short TTL so we retry the npm fetch soon, but don't hammer it.
    memoryCache = { version: resolved, expiresAt: Date.now() + 5 * 60 * 1000 };
    providerDiag("claude_code_version_fallback", { version: resolved });
    return resolved;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function claudeCliUserAgent(version: string): string {
  return `claude-cli/${version} (external, cli)`;
}

/** Build the User-Agent string Anthropic's OAuth + inference edges expect. */
export async function getClaudeCliUserAgent(): Promise<string> {
  return claudeCliUserAgent(await getClaudeCodeVersion());
}
