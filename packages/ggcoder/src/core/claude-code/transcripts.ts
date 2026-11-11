import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";

/**
 * Claude Code keeps its own copy of every chat it ran, as
 * `<config>/projects/<cwd slug>/<session id>.jsonl`. GG's session file is the
 * source of truth, so a copy nobody has touched for this long is only disk use:
 * its cache expired long ago and the chat re-seeds from GG's history.
 */
export const CLAUDE_CODE_TRANSCRIPT_RETENTION_DAYS = 7;

const TRANSCRIPT_EXTENSION = ".jsonl";
const heldSessionIds = new Map<string, number>();
const prunedConfigDirs = new Set<string>();

/** Keep this session's transcript out of the retention pass until released. */
export function holdClaudeCodeTranscript(sessionId: string): () => void {
  heldSessionIds.set(sessionId, (heldSessionIds.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const holders = (heldSessionIds.get(sessionId) ?? 1) - 1;
    if (holders > 0) heldSessionIds.set(sessionId, holders);
    else heldSessionIds.delete(sessionId);
  };
}

/** Real sub-directories only: a symlink is never followed out of `projects`. */
async function projectDirs(configDir: string): Promise<string[]> {
  const root = path.join(configDir, "projects");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

/** Whether Claude Code still has the transcript a resume of `sessionId` needs. */
export async function claudeCodeTranscriptExists(
  configDir: string,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId || path.basename(sessionId) !== sessionId) return false;
  for (const dir of await projectDirs(configDir)) {
    const found = await fs
      .stat(path.join(dir, `${sessionId}${TRANSCRIPT_EXTENSION}`))
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (found) return true;
  }
  return false;
}

export interface ClaudeCodeTranscriptPruneResult {
  /** Transcripts past the age limit, counted before anything is deleted. */
  staleFiles: number;
  deletedFiles: number;
  freedBytes: number;
}

/**
 * Delete transcripts not modified for `maxAgeDays`. Only plain `*.jsonl` files
 * directly inside a project directory are considered; transcripts held by a
 * session in this process are skipped.
 */
export async function pruneClaudeCodeTranscripts(options: {
  configDir: string;
  maxAgeDays?: number;
  now?: number;
}): Promise<ClaudeCodeTranscriptPruneResult> {
  const maxAgeDays = options.maxAgeDays ?? CLAUDE_CODE_TRANSCRIPT_RETENTION_DAYS;
  const result: ClaudeCodeTranscriptPruneResult = { staleFiles: 0, deletedFiles: 0, freedBytes: 0 };
  if (maxAgeDays <= 0) return result;
  const cutoffMs = (options.now ?? Date.now()) - maxAgeDays * 86_400_000;
  const isStale = async (file: string): Promise<number | null> => {
    const stat = await fs.lstat(file).catch(() => null);
    return stat?.isFile() && stat.mtimeMs < cutoffMs ? stat.size : null;
  };

  const stale: string[] = [];
  for (const dir of await projectDirs(options.configDir)) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_EXTENSION)) continue;
      if (heldSessionIds.has(entry.name.slice(0, -TRANSCRIPT_EXTENSION.length))) continue;
      const file = path.join(dir, entry.name);
      if ((await isStale(file)) !== null) stale.push(file);
    }
  }
  result.staleFiles = stale.length;

  for (const file of stale) {
    // Judged again right before the delete: a chat resumed since the count is in use.
    const size = await isStale(file);
    if (size === null || heldSessionIds.has(path.basename(file, TRANSCRIPT_EXTENSION))) continue;
    try {
      await fs.unlink(file);
      result.deletedFiles += 1;
      result.freedBytes += size;
    } catch {
      // Raced or locked (Windows): the next daemon start tries again.
    }
  }
  return result;
}

/** The retention pass, once per config directory per process, never throwing. */
export async function pruneClaudeCodeTranscriptsOnce(configDir: string): Promise<void> {
  const key = path.resolve(configDir);
  if (prunedConfigDirs.has(key)) return;
  prunedConfigDirs.add(key);
  try {
    const result = await pruneClaudeCodeTranscripts({ configDir });
    if (result.staleFiles === 0) return;
    log("INFO", "claude-code", "Old transcripts removed", {
      staleFiles: String(result.staleFiles),
      deletedFiles: String(result.deletedFiles),
      freedMB: (result.freedBytes / 1024 / 1024).toFixed(1),
      olderThanDays: String(CLAUDE_CODE_TRANSCRIPT_RETENTION_DAYS),
    });
  } catch (error) {
    log("WARN", "claude-code", "Transcript retention pass failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
