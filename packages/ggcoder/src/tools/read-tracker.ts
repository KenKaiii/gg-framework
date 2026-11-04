import crypto from "node:crypto";
import type { ToolOperations } from "./operations.js";

/** A 1-based, inclusive range of line numbers. */
export type LineRange = readonly [start: number, end: number];

export interface ReadEntry {
  mtimeMs: number;
  hash: string;
  /** Lines in the content `hash` covers (a trailing newline does not add one). */
  lineCount: number;
  /**
   * How much of that content the model has been shown: `"all"`, or the merged,
   * sorted line ranges seen so far. A full-file `write` requires `"all"`.
   */
  seen: "all" | readonly LineRange[];
}

export type ReadTracker = Map<string, ReadEntry>;

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Line count as the read tool numbers lines, not counting the empty "line" after a final newline. */
export function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Clamp `ranges` to the file and collapse them to `"all"` once they cover every line. */
function toSeen(ranges: readonly LineRange[], lineCount: number): ReadEntry["seen"] {
  if (lineCount === 0) return "all";
  const merged = mergeRanges(
    ranges
      .map(([start, end]): LineRange => [Math.max(1, start), Math.min(lineCount, end)])
      .filter(([start, end]) => start <= end),
  );
  const only = merged.length === 1 ? merged[0] : undefined;
  return only && only[0] === 1 && only[1] === lineCount ? "all" : merged;
}

/**
 * Record that the model was shown `shown` (default: every line) of `content`.
 * Reads of unchanged content accumulate, so paging through a long file with
 * offset/limit eventually counts as having seen all of it.
 */
export function recordRead(
  tracker: ReadTracker | undefined,
  resolvedPath: string,
  content: string,
  mtimeMs: number,
  shown?: LineRange,
): void {
  if (!tracker) return;
  const hash = hashContent(content);
  const lineCount = countLines(content);
  const previous = tracker.get(resolvedPath);
  let seen: ReadEntry["seen"];
  if (!shown) {
    seen = "all";
  } else if (previous?.hash === hash) {
    seen = previous.seen === "all" ? "all" : toSeen([...previous.seen, shown], lineCount);
  } else {
    seen = toSeen([shown], lineCount);
  }
  tracker.set(resolvedPath, { mtimeMs, hash, lineCount, seen });
}

/**
 * Record the model's own change to a file. `write` supplies every line itself,
 * so the model knows the whole result. `edit` changes only part of a file, so
 * it knows the whole result only if it had already seen all of the original.
 */
export async function recordWrite(
  tracker: ReadTracker | undefined,
  resolvedPath: string,
  content: string,
  ops: ToolOperations,
  scope: "whole" | "edit" = "whole",
): Promise<void> {
  if (!tracker) return;
  const stat = await ops.stat(resolvedPath);
  const knewAll = scope === "whole" || tracker.get(resolvedPath)?.seen === "all";
  tracker.set(resolvedPath, {
    mtimeMs: stat.mtimeMs,
    hash: hashContent(content),
    lineCount: countLines(content),
    // An edit shifts line numbers, so ranges seen before it no longer line up.
    seen: knewAll ? "all" : [],
  });
}

/**
 * Lines of the file as it is on disk now that the model has not been shown:
 * `"all"` when it never read the file or the file changed since its last
 * read/write (mtime, else content hash), otherwise the gaps between the ranges
 * it has seen (empty when it has seen every line). A full-file `write` uses
 * this to report which lines it removed without the model having seen them.
 */
export async function unseenLines(
  tracker: ReadTracker | undefined,
  resolvedPath: string,
  ops: ToolOperations,
): Promise<"all" | readonly LineRange[]> {
  if (!tracker) return [];
  if (!tracker.has(resolvedPath) || !(await isFresh(tracker, resolvedPath, ops))) return "all";
  const entry = tracker.get(resolvedPath);
  if (!entry || entry.seen === "all") return [];
  const gaps: LineRange[] = [];
  let next = 1;
  for (const [start, end] of entry.seen) {
    if (start > next) gaps.push([next, start - 1]);
    next = end + 1;
  }
  if (next <= entry.lineCount) gaps.push([next, entry.lineCount]);
  return gaps;
}

/**
 * True when the recorded read still matches disk (mtime, else content hash).
 * A hash match after an mtime-only change refreshes the recorded mtime.
 */
export async function isFresh(
  tracker: ReadTracker,
  resolvedPath: string,
  ops: ToolOperations,
): Promise<boolean> {
  const entry = tracker.get(resolvedPath);
  if (!entry) return false;
  const stat = await ops.stat(resolvedPath);
  if (stat.mtimeMs === entry.mtimeMs) return true;
  const current = await ops.readFile(resolvedPath);
  if (hashContent(current) !== entry.hash) return false;
  tracker.set(resolvedPath, { ...entry, mtimeMs: stat.mtimeMs });
  return true;
}
