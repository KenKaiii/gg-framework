import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { diffLines } from "diff";
import { recordWrite, unseenLines, type LineRange, type ReadTracker } from "./read-tracker.js";
import { writeOverflow } from "./overflow.js";
import { isPlanModeActive } from "../core/runtime-mode.js";
import { resolveWriteGuard, type WriteGuardSettings } from "../core/workspace-guard.js";
import { REDACTION_MARKER } from "@kleio/ai";
import { redactionLossError } from "./redaction-guard.js";

type MutationCallback = (filePath: string) => void | Promise<void>;

/** Post-write diagnostics provider (LSP). Non-empty results are appended to successful tool output. */
type DiagnosticsProvider = (filePath: string, content: string, source?: "write") => Promise<string>;

function isMutationCallback(value: unknown): value is MutationCallback {
  return typeof value === "function";
}

function isPlanModeRef(value: unknown): value is { current: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { current?: unknown }).current === "boolean"
  );
}

const WriteParams = z.object({
  file_path: z.string(),
  content: z.string(),
});

/** Above this, removed unseen lines are summarized instead of listed. */
const MAX_LISTED_CHARS = 4_000;

/**
 * Edit distance past which the exact line diff gives up. Its cost grows with
 * this distance times the file size, so an unbounded diff of a large rewrite
 * blocked the shared daemon for minutes (30k changed lines: ~190s).
 */
const MAX_DIFF_EDITS = 1_000;

/** Lines of `text`; a trailing newline does not add an empty last line. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/**
 * Fallback for rewrites too different to diff: an old line counts as removed
 * once the new text has no copies of it left. Linear time; a line that only
 * moved is not reported.
 */
function removedByCount(
  before: string,
  after: string,
  isUnseen: (line: number) => boolean,
): Array<[line: number, text: string]> {
  const left = new Map<string, number>();
  for (const text of splitLines(after)) left.set(text, (left.get(text) ?? 0) + 1);
  const removed: Array<[number, string]> = [];
  for (const [i, text] of splitLines(before).entries()) {
    const copies = left.get(text) ?? 0;
    if (copies > 0) left.set(text, copies - 1);
    else if (isUnseen(i + 1)) removed.push([i + 1, text]);
  }
  return removed;
}

/**
 * On-disk lines `next` removes or replaces that fall in `unseen`, with their
 * original 1-based line numbers. Line endings are normalized so a CRLF file
 * rewritten with LF does not count every line as removed.
 */
function removedUnseen(
  current: string,
  next: string,
  unseen: "all" | readonly LineRange[],
): Array<[line: number, text: string]> {
  const isUnseen = (line: number) =>
    unseen === "all" || unseen.some(([start, end]) => line >= start && line <= end);
  const normalize = (text: string) => text.replace(/\r\n/g, "\n");
  const before = normalize(current);
  const after = normalize(next);
  const changes = diffLines(before, after, { maxEditLength: MAX_DIFF_EDITS });
  if (!changes) return removedByCount(before, after, isUnseen);
  const removed: Array<[number, string]> = [];
  let line = 1;
  for (const change of changes) {
    if (change.added) continue;
    const lines = change.value.replace(/\n$/, "").split("\n");
    if (change.removed) {
      for (const [i, text] of lines.entries()) {
        if (isUnseen(line + i)) removed.push([line + i, text]);
      }
    }
    line += change.count ?? lines.length;
  }
  return removed;
}

/** Collapse sorted line numbers into "3-7, 12" form. */
function spans(lines: readonly number[]): string {
  const ranges: Array<[number, number]> = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}

/**
 * Note appended to a successful write that removed lines the model never saw
 * (unread file, changed since its last read, or only partly read). The write
 * is never refused for this: refusing threw away the generated content and
 * forced a full regeneration. Instead the previous file is backed up and the
 * model is shown exactly what went, so it can restore anything unintended.
 */
function unseenRemovalNote(
  removed: ReadonlyArray<[number, string]>,
  backup: string | null,
): string {
  const count = removed.length;
  const lines = `${count} line${count === 1 ? "" : "s"}`;
  const listing = removed.map(([line, text]) => `${line}|-${text}`).join("\n");
  const where = backup
    ? ` The previous file is saved at ${backup}.`
    : " /rewind restores the previous file.";
  const body =
    listing.length <= MAX_LISTED_CHARS
      ? `:\n${listing}`
      : ` (old lines ${spans(removed.map(([line]) => line))}).`;
  return (
    `\n\nNote: this write removed ${lines} you had not seen in their current form${body}\n` +
    `If that was intended, carry on. If not, put them back with edit.${where}`
  );
}

export function createWriteTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  planModeRefOrOnFileMutated?: { current: boolean } | MutationCallback,
  onFileMutated?: MutationCallback,
  onPreFileMutation?: MutationCallback,
  getDiagnostics?: DiagnosticsProvider,
  getWriteGuardSettings?: () => WriteGuardSettings | undefined,
): AgentTool<typeof WriteParams> {
  const planModeRef = isPlanModeRef(planModeRefOrOnFileMutated)
    ? planModeRefOrOnFileMutated
    : undefined;
  const mutationCallback = isMutationCallback(planModeRefOrOnFileMutated)
    ? planModeRefOrOnFileMutated
    : onFileMutated;
  return {
    name: "write",
    description:
      "Create or fully overwrite a file (read existing files first). Creates parent dirs.",
    parameters: WriteParams,
    executionMode: "sequential",
    async execute({ file_path, content }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      // Workspace write guard: outside cwd/tmp/~/.gg requires user approval.
      const guard = resolveWriteGuard(cwd, resolved, getWriteGuardSettings?.());
      if (!guard.allowed) {
        return `Error: ${guard.reason}`;
      }

      if (isPlanModeActive(planModeRef)) {
        const plansDir = path.join(cwd, ".gg", "plans");
        const relative = path.relative(plansDir, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return `Error: write is restricted in plan mode. You can only write to .gg/plans/. Got: ${file_path}`;
        }
        await fs.mkdir(plansDir, { recursive: true });
      }

      const exists = await ops.stat(resolved).then(
        () => true,
        () => false,
      );
      // Never replace real secrets with the placeholder the model was shown.
      if (exists && content.includes(REDACTION_MARKER)) {
        const original = await ops.readFile(resolved).catch(() => undefined);
        const lossError = redactionLossError(original, content, path.basename(resolved));
        if (lossError) return `Error: ${lossError}`;
      }
      // Lines this overwrite drops that the model never saw are reported, not
      // refused. Computed before the write, against the file as it is now.
      let unseenNote = "";
      if (exists) {
        const unseen = await unseenLines(readFiles, resolved, ops);
        if (unseen === "all" || unseen.length > 0) {
          const current = await ops.readFile(resolved);
          const removed = removedUnseen(current, content, unseen);
          if (removed.length > 0) {
            const backup = await writeOverflow(current, "write-backup").catch(() => null);
            unseenNote = unseenRemovalNote(removed, backup);
          }
        }
      }
      // Snapshot the pre-mutation on-disk state for /rewind before writing.
      await onPreFileMutation?.(resolved);
      await ops.writeFile(resolved, content);
      await recordWrite(readFiles, resolved, content, ops);
      await mutationCallback?.(resolved);
      // LSP diagnostics for the just-written content. Best-effort enhancement:
      // any failure (or an opted-out provider) leaves output identical to today.
      let diagnosticsNote = "";
      if (getDiagnostics) {
        try {
          diagnosticsNote = await getDiagnostics(resolved, content, "write");
        } catch {
          // Diagnostics must never break a successful write.
        }
      }
      const lines = content.split("\n").length;
      return `Wrote ${lines} lines to ${resolved}` + unseenNote + diagnosticsNote;
    },
  };
}
