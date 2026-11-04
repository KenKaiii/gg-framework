import fs from "node:fs/promises";
import path from "node:path";
import { temporarySiblingPath } from "./session-storage.js";
import type { SessionSummary } from "./session-manager.js";

/**
 * Per-directory cache of session summaries, persisted next to the sessions.
 *
 * Resolving which checkpoint of a conversation is newest needs the header of
 * every session in the directory. Reading 14,600 headers took ~1.7 s and
 * ~1.5 GB peak RSS on every resume (bench/baseline/31-session-list-latency.mjs),
 * and the desktop app pays that on each project switch because it respawns the
 * sidecar. The index keeps each summary with the file's size+mtime fingerprint,
 * so a scan is one `readdir` plus a `stat` per file, and only files that changed
 * since the last scan are re-read (after vercel-labs/fx#1021).
 *
 * The index is only a cache: a missing, corrupt or foreign index is ignored and
 * rebuilt, and every entry is re-validated against the live filesystem.
 */

export type IndexedSessionSummary = SessionSummary & { conversationId: string; generation: number };

export const SESSION_SUMMARY_INDEX_FILE = ".session-index.json";
const INDEX_VERSION = 1;
/** Bounded so a cold scan never holds thousands of open read streams at once. */
const SCAN_CONCURRENCY = 32;

interface Fingerprint {
  size: number;
  mtimeMs: number;
}

interface IndexEntry extends Fingerprint {
  /** Fingerprint of the redirect target when the candidate is a redirect stub. */
  target?: Fingerprint;
  summary: IndexedSessionSummary;
}

async function fingerprint(filePath: string): Promise<Fingerprint | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function sameFingerprint(a: Fingerprint | undefined, b: Fingerprint | null): boolean {
  return a !== undefined && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.size === "number" && typeof v.mtimeMs === "number";
}

function isIndexedSummary(value: unknown, directory: string): value is IndexedSessionSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.conversationId === "string" &&
    typeof v.generation === "number" &&
    typeof v.path === "string" &&
    // Contain cached paths to this directory: the index file is untrusted input.
    path.dirname(path.resolve(v.path)) === directory &&
    typeof v.timestamp === "string" &&
    typeof v.lastActivity === "string" &&
    typeof v.cwd === "string" &&
    typeof v.hasMessages === "boolean" &&
    (v.preview === undefined || typeof v.preview === "string")
  );
}

/** Bounded-parallel map that keeps input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class SessionSummaryIndex {
  private readonly directory: string;
  private readonly indexPath: string;
  private entries = new Map<string, IndexEntry>();
  private loading: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    this.indexPath = path.join(this.directory, SESSION_SUMMARY_INDEX_FILE);
  }

  /**
   * Summaries for `candidates` (the directory's full candidate list, in the
   * same order). Unchanged files come from the index; changed or new ones are
   * read with `read` and the index is rewritten.
   */
  async summaries(
    candidates: readonly string[],
    read: (candidate: string) => Promise<IndexedSessionSummary | null>,
  ): Promise<Array<IndexedSessionSummary | null>> {
    this.loading ??= this.load();
    await this.loading;

    let dirty = false;
    const seen = new Set<string>();
    const results = await mapLimited(candidates, SCAN_CONCURRENCY, async (candidate) => {
      const name = path.basename(candidate);
      seen.add(name);
      const current = await fingerprint(candidate);
      const cached = this.entries.get(name);
      if (cached && sameFingerprint(cached, current)) {
        const redirected = path.resolve(cached.summary.path) !== path.resolve(candidate);
        if (!redirected || sameFingerprint(cached.target, await fingerprint(cached.summary.path))) {
          return cached.summary;
        }
      }
      const summary = await read(candidate);
      if (!summary || !current) {
        if (cached) {
          this.entries.delete(name);
          dirty = true;
        }
        return summary;
      }
      const entry: IndexEntry = { ...current, summary };
      if (path.resolve(summary.path) !== path.resolve(candidate)) {
        const target = await fingerprint(summary.path);
        if (target) entry.target = target;
      }
      this.entries.set(name, entry);
      dirty = true;
      return summary;
    });

    for (const name of [...this.entries.keys()]) {
      if (!seen.has(name)) {
        this.entries.delete(name);
        dirty = true;
      }
    }
    if (dirty) await this.save();
    return results;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, "utf-8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== INDEX_VERSION) return;
      if (typeof parsed.entries !== "object" || parsed.entries === null) return;
      for (const [name, value] of Object.entries(parsed.entries)) {
        if (typeof value !== "object" || value === null) continue;
        const entry = value as Record<string, unknown>;
        if (
          name !== path.basename(name) ||
          !isFingerprint(entry) ||
          (entry.target !== undefined && !isFingerprint(entry.target)) ||
          !isIndexedSummary(entry.summary, this.directory)
        ) {
          continue;
        }
        this.entries.set(name, {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          ...(entry.target ? { target: entry.target } : {}),
          summary: entry.summary,
        });
      }
    } catch {
      // Corrupt index: start empty; the next scan rewrites it.
      this.entries.clear();
    }
  }

  /** Atomic replace; serialized so concurrent scans never interleave writes. */
  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const sorted = [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b));
      const content = JSON.stringify({
        version: INDEX_VERSION,
        entries: Object.fromEntries(sorted),
      });
      const tempPath = temporarySiblingPath(this.indexPath);
      try {
        await fs.writeFile(tempPath, content, "utf-8");
        await fs.rename(tempPath, this.indexPath);
      } catch {
        // Best-effort cache: a failed write only costs a slower next scan.
        await fs.unlink(tempPath).catch(() => {});
      }
    });
    return this.saving;
  }
}
