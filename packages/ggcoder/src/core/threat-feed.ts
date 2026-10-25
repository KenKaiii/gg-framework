/**
 * Local daily feed of known-malicious packages (OSV `MAL-*` entries for npm
 * and PyPI). Lets install checks answer instantly and offline for anything
 * flagged recently; live OSV at install time covers everything older.
 *
 * Sync is incremental: OSV publishes `<eco>/modified_id.csv` newest-first, so
 * a Range read of the first bytes yields every change since the last sync. The
 * 218 MB `all.zip` is never downloaded. The first sync covers a bounded window.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "@kenkaiiii/gg-core";
import { log } from "./logger.js";
import { retryWindowsReplace } from "./session-storage.js";

export type FeedEcosystem = "npm" | "PyPI";

export interface FeedRange {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

export interface FeedEntry {
  id: string;
  versions: string[];
  ranges: FeedRange[][];
  /** Advisory publish time (ISO); entries older than MAX_AGE_DAYS are pruned. */
  published?: string;
}

export interface ThreatFeedData {
  /** Per ecosystem: newest `modified` timestamp already synced, and last run (ms). */
  sync: Partial<Record<FeedEcosystem, { modified: string; ranAt: number }>>;
  /** `<eco>:<name>` → entries. */
  entries: Record<string, FeedEntry[]>;
}

export interface ThreatFeedSyncOptions {
  dir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** First-sync window (days). */
  windowDays?: number;
  /** Max advisory downloads per ecosystem per sync. */
  maxRequests?: number;
  signal?: AbortSignal;
}

const BUCKET = "https://osv-vulnerabilities.storage.googleapis.com";
const FEED_FILE = "threat-feed.json";
const DAY_MS = 86_400_000;
const CHUNK_BYTES = 128 * 1024;
const MAX_CHUNKS = 8;
const TIMEOUT_MS = 3_000;
/** Older advisories are dropped from the local feed; live OSV at install time still covers them. */
const MAX_AGE_DAYS = 365;
/** Hard cap on entries (~250 bytes each → feed file ≲ 5 MB). */
const MAX_ENTRIES = 20_000;
const ECOSYSTEMS: FeedEcosystem[] = ["npm", "PyPI"];

export function feedKey(ecosystem: FeedEcosystem, name: string): string {
  return `${ecosystem}:${normalizeName(ecosystem, name)}`;
}

function normalizeName(ecosystem: FeedEcosystem, name: string): string {
  const lower = name.toLowerCase();
  return ecosystem === "PyPI" ? lower.replace(/[._]+/g, "-") : lower;
}

export function threatFeedPath(dir?: string): string {
  return path.join(dir ?? getAppPaths().agentDir, FEED_FILE);
}

export function emptyFeed(): ThreatFeedData {
  return { sync: {}, entries: {} };
}

/**
 * Read the feed (missing/corrupt → empty). Cached by file identity so repeat
 * reads are free. mtime alone is not enough: Windows file times tick coarsely,
 * so two quick atomic writes can share one; the replaced file's inode and size
 * tell them apart.
 */
const loadCache = new Map<string, { stamp: string; data: ThreatFeedData }>();
export function loadThreatFeed(dir?: string): ThreatFeedData {
  const file = threatFeedPath(dir);
  try {
    const { mtimeMs, size, ino } = fs.statSync(file);
    const stamp = `${mtimeMs}:${size}:${ino}`;
    const hit = loadCache.get(file);
    if (hit && hit.stamp === stamp) return hit.data;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ThreatFeedData>;
    const data: ThreatFeedData = { sync: raw.sync ?? {}, entries: raw.entries ?? {} };
    loadCache.set(file, { stamp, data });
    return data;
  } catch {
    return emptyFeed();
  }
}

// ── Version matching ──────────────────────────────────────

/** Compare dotted versions numerically; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string] => {
    const clean = v.replace(/^v/, "").split("+")[0] ?? "";
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(clean);
    if (!m) return [[], clean];
    return [(m[1] ?? "").split(".").map(Number), (m[2] ?? "").replace(/^[-.]/, "")];
  };
  const [na, pa] = split(a);
  const [nb, pb] = split(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa === pb) return 0;
  if (pa === "") return 1;
  if (pb === "") return -1;
  return pa < pb ? -1 : 1;
}

function inRanges(version: string, ranges: FeedRange[][]): boolean {
  for (const events of ranges) {
    let affected = false;
    for (const e of events) {
      if (e.introduced !== undefined) {
        if (e.introduced === "0" || compareVersions(version, e.introduced) >= 0) affected = true;
      } else if (e.fixed !== undefined) {
        if (compareVersions(version, e.fixed) >= 0) affected = false;
      } else if (e.last_affected !== undefined) {
        if (compareVersions(version, e.last_affected) > 0) affected = false;
      }
    }
    if (affected) return true;
  }
  return false;
}

/** An entry that flags every version (typical for a malicious-from-birth package). */
function coversAll(entry: FeedEntry): boolean {
  return entry.ranges.some(
    (events) =>
      events.some((e) => e.introduced === "0") &&
      !events.some((e) => e.fixed !== undefined || e.last_affected !== undefined),
  );
}

/**
 * Advisory IDs in the feed for `name@version`. Without a version only an
 * entry covering every version matches — never a single bad old release.
 */
export function feedMatches(
  feed: ThreatFeedData,
  ecosystem: FeedEcosystem,
  name: string,
  version: string | undefined,
): string[] {
  const entries = feed.entries[feedKey(ecosystem, name)];
  if (!entries) return [];
  return entries
    .filter((e) =>
      version === undefined
        ? coversAll(e)
        : e.versions.includes(version) || inRanges(version, e.ranges),
    )
    .map((e) => e.id);
}

// ── Sync ───────────────────────────────────────────────────

interface OsvAdvisory {
  id?: string;
  published?: string;
  modified?: string;
  withdrawn?: string;
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    versions?: string[];
    ranges?: Array<{ events?: FeedRange[] }>;
  }>;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** New MAL- IDs modified after `since`, newest first, by Range-reading the index head. */
async function newMalIds(
  ecosystem: FeedEcosystem,
  since: string,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<{ ids: string[]; newest: string | null }> {
  const ids: string[] = [];
  let newest: string | null = null;
  let carry = "";
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const start = chunk * CHUNK_BYTES;
    const res = await doFetch(`${BUCKET}/${ecosystem}/modified_id.csv`, {
      headers: { range: `bytes=${start}-${start + CHUNK_BYTES - 1}` },
      signal: withTimeout(signal),
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`index HTTP ${res.status}`);
    const body = await res.text();
    // A chunk shorter than requested is the end of the file.
    const atEnd = res.status === 200 || Buffer.byteLength(body) < CHUNK_BYTES;
    const text = carry + (atEnd ? `${body}\n` : body);
    const lines = text.split(/\r?\n/);
    // A full (200) body has no partial tail; a 206 chunk's last line may be cut.
    carry = res.status === 206 ? (lines.pop() ?? "") : "";
    for (const line of lines) {
      const comma = line.indexOf(",");
      if (comma < 0) continue;
      const modified = line.slice(0, comma).trim();
      const id = line.slice(comma + 1).trim();
      if (modified <= since) return { ids, newest };
      newest ??= modified;
      if (id.startsWith("MAL-")) ids.push(id);
    }
    if (atEnd || lines.length === 0) break;
  }
  return { ids, newest };
}

function toEntries(advisory: OsvAdvisory, ecosystem: FeedEcosystem): Array<[string, FeedEntry]> {
  const id = advisory.id;
  if (!id?.startsWith("MAL-") || advisory.withdrawn) return [];
  const out: Array<[string, FeedEntry]> = [];
  for (const a of advisory.affected ?? []) {
    const name = a.package?.name;
    if (!name || a.package?.ecosystem !== ecosystem) continue;
    out.push([
      feedKey(ecosystem, name),
      {
        id,
        versions: a.versions ?? [],
        ranges: (a.ranges ?? []).map((r) => r.events ?? []),
        ...(advisory.published || advisory.modified
          ? { published: advisory.published ?? advisory.modified }
          : {}),
      },
    ]);
  }
  return out;
}

async function readFeedAsync(file: string): Promise<ThreatFeedData> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<ThreatFeedData>;
    return { sync: raw.sync ?? {}, entries: raw.entries ?? {} };
  } catch {
    return emptyFeed();
  }
}

/**
 * Bound the feed: drop advisories published more than MAX_AGE_DAYS ago, then
 * keep the newest MAX_ENTRIES. Entries without a date (older feeds) are kept
 * until the cap pushes them out. Mutates `feed`.
 */
export function pruneFeed(feed: ThreatFeedData, now: number, maxEntries = MAX_ENTRIES): void {
  const cutoff = now - MAX_AGE_DAYS * DAY_MS;
  const all: Array<{ key: string; entry: FeedEntry; t: number }> = [];
  for (const [key, list] of Object.entries(feed.entries)) {
    for (const entry of list) {
      const t = entry.published ? Date.parse(entry.published) : Number.NaN;
      if (!Number.isNaN(t) && t < cutoff) continue;
      all.push({ key, entry, t: Number.isNaN(t) ? 0 : t });
    }
  }
  all.sort(
    (a, b) => b.t - a.t || a.key.localeCompare(b.key) || a.entry.id.localeCompare(b.entry.id),
  );
  const entries: Record<string, FeedEntry[]> = {};
  for (const { key, entry } of all.slice(0, maxEntries)) (entries[key] ??= []).push(entry);
  feed.entries = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

/** Async write-then-rename, retrying Windows EPERM/EBUSY/EACCES when the target is held open. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(data));
    await retryWindowsReplace(() => fsp.rename(tmp, file));
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** One sync pass. Returns whether anything ran (false when synced < 1 day ago). */
export async function syncThreatFeed(options: ThreatFeedSyncOptions = {}): Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const now = (options.now ?? Date.now)();
  const windowDays = options.windowDays ?? 90;
  const maxRequests = options.maxRequests ?? 200;
  // Async read: the background sync never blocks the event loop on a big file.
  const feed = await readFeedAsync(threatFeedPath(options.dir));
  let ran = false;
  for (const ecosystem of ECOSYSTEMS) {
    const state = feed.sync[ecosystem];
    if (state && now - state.ranAt < DAY_MS) continue;
    ran = true;
    const since = state?.modified ?? new Date(now - windowDays * DAY_MS).toISOString();
    const { ids, newest } = await newMalIds(ecosystem, since, doFetch, options.signal);
    const wanted = ids.slice(0, maxRequests);
    let failed = 0;
    for (let i = 0; i < wanted.length; i += 8) {
      await Promise.all(
        wanted.slice(i, i + 8).map(async (id) => {
          try {
            const res = await doFetch(`${BUCKET}/${ecosystem}/${id}.json`, {
              signal: withTimeout(options.signal),
            });
            if (!res.ok) {
              failed++;
              return;
            }
            for (const [key, entry] of toEntries((await res.json()) as OsvAdvisory, ecosystem)) {
              const list = (feed.entries[key] ?? []).filter((e) => e.id !== entry.id);
              list.push(entry);
              feed.entries[key] = list;
            }
          } catch {
            // One advisory failing must not lose the rest.
            failed++;
          }
        }),
      );
    }
    // An interrupted pass keeps what it got but doesn't advance, so the next
    // retry (6h) re-reads the advisories it missed instead of skipping them.
    if (failed === 0) feed.sync[ecosystem] = { modified: newest ?? since, ranAt: now };
  }
  if (!ran) return false;
  pruneFeed(feed, now);
  await writeJsonAtomic(threatFeedPath(options.dir), feed);
  return true;
}

/** Listeners told when a sync brought new data (e.g. re-check open projects). */
const feedListeners = new Set<() => void>();

/** Run `listener` after each sync that changed the feed. Returns unsubscribe. */
export function onThreatFeedUpdated(listener: () => void): () => void {
  feedListeners.add(listener);
  return () => feedListeners.delete(listener);
}

function emitFeedUpdated(): void {
  for (const listener of feedListeners) {
    try {
      listener();
    } catch (err) {
      log("WARN", "threat-feed", `feed listener failed: ${String(err)}`);
    }
  }
}

const RECHECK_MS = 6 * 3_600_000;

/**
 * Start the daily sync in the background after `delayMs`, then re-try every
 * `intervalMs` (the sync itself runs at most once a day), so an app left open
 * for days keeps its feed current. Never blocks startup or a command, never
 * throws. Returns a cancel function.
 */
export function startThreatFeedSync(
  options: ThreatFeedSyncOptions & { delayMs?: number; intervalMs?: number } = {},
): () => void {
  const run = (): void => {
    syncThreatFeed(options).then(
      (ran) => {
        if (!ran) return;
        log("INFO", "threat-feed", "threat feed synced");
        emitFeedUpdated();
      },
      (err: unknown) => log("WARN", "threat-feed", `threat feed sync failed: ${String(err)}`),
    );
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const timer = setTimeout(() => {
    run();
    interval = setInterval(run, options.intervalMs ?? RECHECK_MS);
    interval.unref?.();
  }, options.delayMs ?? 15_000);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    if (interval) clearInterval(interval);
  };
}
