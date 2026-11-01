import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** How a rewind restores state. Mirrors Claude Code's `/rewind` modes. */
export type RestoreMode = "code" | "conversation" | "both";

/**
 * A single file touched during a checkpoint's turn. `snapshot` is the sha256 of
 * the file's PRE-mutation content (blob stored under blobs/<sha256>), or the
 * sentinel `"absent"` when the file did not exist before the turn (restore
 * deletes it).
 */
export interface CheckpointFileEntry {
  relPath: string;
  absPath: string;
  snapshot: string;
}

export const ABSENT = "absent" as const;

export interface CheckpointManifest {
  id: string;
  turnIndex: number;
  /** messages.length at checkpoint open — conversation rewind truncates to this. */
  messageIndex: number;
  timestamp: number;
  files: CheckpointFileEntry[];
}

export interface CheckpointInfo {
  id: string;
  turnIndex: number;
  messageIndex: number;
  timestamp: number;
  changedFileCount: number;
  /** One-line summary of changed files, e.g. "a.ts, b.ts". */
  summary: string;
}

export interface RestoreResult {
  filesRestored: number;
  messageIndex: number;
}

export interface CheckpointStoreOptions {
  sessionId: string;
  cwd: string;
  /** Root for checkpoint storage. Defaults to ~/.gg/checkpoints. Injectable for tests. */
  baseDir?: string;
  /** Max checkpoints retained per session; older ones are pruned. Default 50. */
  maxCheckpoints?: number;
}

function hashContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function summarizeFiles(files: readonly CheckpointFileEntry[]): string {
  if (files.length === 0) return "no file changes";
  const names = files.map((f) => path.basename(f.relPath));
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
}

/**
 * Per-session file checkpoint store. Snapshots the pre-mutation content of files
 * that the agent edits through the `write`/`edit` tools so `/rewind` can restore
 * earlier on-disk state and/or conversation position.
 *
 * Snapshots live under `~/.gg/checkpoints/<sessionId>/` (never in the project
 * tree): a manifest JSON per checkpoint plus content-hash-deduped file blobs.
 * Changes made by `bash` (sed/rm/codegen) are NOT tracked — same documented
 * limitation as Claude Code's `/rewind`.
 */
export class CheckpointStore {
  private readonly sessionDir: string;
  private readonly blobsDir: string;
  private readonly checkpointsDir: string;
  private readonly cwd: string;
  private readonly maxCheckpoints: number;
  /** The checkpoint currently accumulating mutations for the active turn. */
  private current: CheckpointManifest | null = null;

  constructor(options: CheckpointStoreOptions) {
    const base = options.baseDir ?? path.join(os.homedir(), ".gg", "checkpoints");
    this.sessionDir = path.join(base, options.sessionId);
    this.blobsDir = path.join(this.sessionDir, "blobs");
    this.checkpointsDir = path.join(this.sessionDir, "checkpoints");
    this.cwd = options.cwd;
    this.maxCheckpoints = options.maxCheckpoints ?? 50;
  }

  private manifestPath(id: string): string {
    return path.join(this.checkpointsDir, `${id}.json`);
  }

  /**
   * Open a fresh checkpoint for a new user turn. Persisted immediately so a turn
   * with no file changes still serves as a conversation-rewind point.
   */
  async openCheckpoint(meta: { turnIndex: number; messageIndex: number }): Promise<string> {
    await fs.mkdir(this.checkpointsDir, { recursive: true });
    await fs.mkdir(this.blobsDir, { recursive: true });
    const id = `cp-${String(meta.turnIndex).padStart(4, "0")}`;
    this.current = {
      id,
      turnIndex: meta.turnIndex,
      messageIndex: meta.messageIndex,
      timestamp: Date.now(),
      files: [],
    };
    await this.persistCurrent();
    await this.prune();
    return id;
  }

  /**
   * Snapshot a file's current on-disk content before it is mutated. Idempotent
   * per (checkpoint, file): only the FIRST mutation of a file in a turn is
   * captured, so restore returns the pre-turn state. No-op when no checkpoint
   * is open.
   */
  async recordPreMutation(filePath: string): Promise<void> {
    const checkpoint = this.current;
    if (!checkpoint) return;
    const absPath = path.resolve(filePath);
    if (checkpoint.files.some((f) => f.absPath === absPath)) return;

    let snapshot: string;
    try {
      const buffer = await fs.readFile(absPath);
      snapshot = hashContent(buffer);
      const blobPath = path.join(this.blobsDir, snapshot);
      // Dedup: identical content shares one blob. Skip the copy if it exists.
      const exists = await fs.stat(blobPath).then(
        () => true,
        () => false,
      );
      if (!exists) await fs.writeFile(blobPath, buffer);
    } catch {
      // File doesn't exist yet — record so restore can delete it.
      snapshot = ABSENT;
    }

    checkpoint.files.push({
      relPath: path.relative(this.cwd, absPath),
      absPath,
      snapshot,
    });
    await this.persistCurrent();
  }

  /** List persisted checkpoints in turn order with changed-file summaries. */
  async listCheckpoints(): Promise<CheckpointInfo[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.checkpointsDir);
    } catch {
      return [];
    }
    const manifests: CheckpointManifest[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.checkpointsDir, entry), "utf-8");
        manifests.push(JSON.parse(raw) as CheckpointManifest);
      } catch {
        // Skip corrupt manifests.
      }
    }
    manifests.sort((a, b) => a.turnIndex - b.turnIndex);
    return manifests.map((m) => ({
      id: m.id,
      turnIndex: m.turnIndex,
      messageIndex: m.messageIndex,
      timestamp: m.timestamp,
      changedFileCount: m.files.length,
      summary: summarizeFiles(m.files),
    }));
  }

  /**
   * Restore on-disk file state and/or report the conversation position for a
   * checkpoint. For `code`/`both`, writes snapshotted bytes back (or deletes
   * files that were absent at the checkpoint). Conversation truncation is left
   * to the caller via the returned `messageIndex`.
   */
  async restore(id: string, mode: RestoreMode): Promise<RestoreResult> {
    const manifest = await this.readManifest(id);
    if (!manifest) throw new Error(`Checkpoint ${id} not found`);

    let filesRestored = 0;
    if (mode === "code" || mode === "both") {
      for (const entry of manifest.files) {
        if (entry.snapshot === ABSENT) {
          await fs.rm(entry.absPath, { force: true });
          filesRestored++;
          continue;
        }
        const blobPath = path.join(this.blobsDir, entry.snapshot);
        const buffer = await fs.readFile(blobPath);
        await fs.mkdir(path.dirname(entry.absPath), { recursive: true });
        await fs.writeFile(entry.absPath, buffer);
        filesRestored++;
      }
    }
    return { filesRestored, messageIndex: manifest.messageIndex };
  }

  private async readManifest(id: string): Promise<CheckpointManifest | null> {
    try {
      const raw = await fs.readFile(this.manifestPath(id), "utf-8");
      return JSON.parse(raw) as CheckpointManifest;
    } catch {
      return null;
    }
  }

  private async persistCurrent(): Promise<void> {
    if (!this.current) return;
    await fs.writeFile(this.manifestPath(this.current.id), JSON.stringify(this.current, null, 2));
  }

  /** Drop the oldest manifests beyond maxCheckpoints (blobs are left for GC simplicity). */
  private async prune(): Promise<void> {
    let entries: string[];
    try {
      entries = (await fs.readdir(this.checkpointsDir)).filter((e) => e.endsWith(".json"));
    } catch {
      return;
    }
    if (entries.length <= this.maxCheckpoints) return;
    const sorted = entries.sort();
    const toRemove = sorted.slice(0, entries.length - this.maxCheckpoints);
    for (const entry of toRemove) {
      await fs.rm(path.join(this.checkpointsDir, entry), { force: true });
    }
  }
}

// ── Retention ──────────────────────────────────────────────

/** Per-session checkpoint folders untouched for this long are pruned. */
export const CHECKPOINT_RETENTION_DAYS = 30;

/** Newest mtime of any regular file under `dir` (lstat; symlinks never followed). */
async function newestFileMtime(dir: string): Promise<number> {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return Number.POSITIVE_INFINITY; // unreadable: treat as recent, never delete
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestFileMtime(full));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, (await fs.lstat(full)).mtimeMs);
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    }
  }
  return newest;
}

/**
 * Delete whole per-session checkpoint folders (`~/.gg/checkpoints/<sessionId>/`)
 * whose newest file is older than `maxAgeDays`. Per-session pruning only caps
 * manifests; folders of finished sessions (and their blobs) were never removed.
 * Guarded: only real directories directly inside the root (symlinks skipped,
 * paths must resolve inside it); a folder with ANY recent file survives; errors
 * (Windows EBUSY/EPERM, races) are skipped and retried on a later launch.
 */
export async function pruneCheckpointSessions(
  options: { baseDir?: string; maxAgeDays?: number; now?: number } = {},
): Promise<{ removed: number }> {
  const result = { removed: 0 };
  const maxAgeDays = options.maxAgeDays ?? CHECKPOINT_RETENTION_DAYS;
  if (maxAgeDays <= 0) return result;
  const root = path.resolve(options.baseDir ?? path.join(os.homedir(), ".gg", "checkpoints"));
  const cutoff = (options.now ?? Date.now()) - maxAgeDays * 86_400_000;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = path.resolve(root, entry.name);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) continue;
    try {
      if ((await newestFileMtime(target)) >= cutoff) continue;
      await fs.rm(target, { recursive: true, force: true });
      result.removed++;
    } catch {
      // In use or raced away — retry on a later launch.
    }
  }
  return result;
}
