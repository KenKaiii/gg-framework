import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import {
  fuzzyFindText,
  countOccurrences,
  generateDiff,
  findClosestSnippet,
  findOccurrenceLines,
  stripBlankEdges,
  applyDotdotdots,
  applyMissingLeadingWhitespace,
} from "./edit-diff.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { assertFresh, recordWrite, type ReadTracker } from "./read-tracker.js";
import { resolveAnchoredEdit } from "../core/hashline.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";

type MutationCallback = (filePath: string) => void | Promise<void>;

/** Post-write diagnostics provider (LSP). Non-empty results are appended to successful tool output. */
type DiagnosticsProvider = (filePath: string, content: string) => Promise<string>;

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

const EditAnchorSchema = z.object({
  start_line: z.number().int().min(1).describe("1-based line number of the first edited line"),
  start_hash: z
    .string()
    .describe("Content anchor of the first line (from a read with anchors:true)"),
  end_line: z.number().int().min(1).describe("1-based line number of the last edited line"),
  end_hash: z.string().describe("Content anchor of the last line"),
});

const EditItem = z.object({
  old_text: z.string().optional().describe("The exact text to find and replace (text form)"),
  new_text: z.string().optional().describe("The replacement text (text form)"),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence of old_text instead of requiring a unique match. " +
        "Use for renames or repeated tokens. Defaults to false.",
    ),
  anchor: EditAnchorSchema.optional().describe(
    "Optional staleness guard for the text form. When set (using line+hash anchors from a read " +
      "with anchors:true), the edit is rejected if the file changed since you read it. " +
      "old_text/new_text still drive the actual replacement.",
  ),
  span: EditAnchorSchema.optional().describe(
    "Span form (preferred when you did a read with anchors:true): replace the inclusive line " +
      "range pinned by these line+hash endpoints with `lines` — no old_text needed, so you never " +
      "retype existing code. Rejected if the file changed since the read. " +
      "Use INSTEAD of old_text/new_text, together with `lines`.",
  ),
  lines: z
    .array(z.string())
    .optional()
    .describe(
      "Replacement lines for `span` (full lines with correct indentation, no anchor/line-number " +
        "prefixes). An empty array deletes the span.",
    ),
});

// Some models (Opus 4.6, GLM-5.1) occasionally send `edits` as a JSON string
// instead of a real array, which trips Zod and makes the model fall back to
// sed/python. Coerce the string back into an array before validation.
const coerceStringifiedEdits = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
};

const EditParams = z.object({
  file_path: z.string().describe("The file path to edit"),
  edits: z
    .preprocess(coerceStringifiedEdits, z.array(EditItem).min(1))
    .describe(
      "One or more edits applied in order. Each edit operates on the result of the previous one.",
    ),
  atomic: z
    .boolean()
    .optional()
    .describe(
      "If true, fail the whole batch when any edit fails — no changes written. " +
        "Default false: partial-apply, keep every successful edit and report failures " +
        "for retry. Use atomic only when later edits depend on earlier ones in a way " +
        "where a half-applied state would be worse than nothing.",
    ),
});

interface MatchSuccess {
  ok: true;
  newWorking: string;
}
interface MatchFailure {
  ok: false;
  reason: "not_found" | "ambiguous";
  occurrences?: number;
}
type MatchResult = MatchSuccess | MatchFailure;

function tryMatch(working: string, old: string, next: string, replaceAll: boolean): MatchResult {
  if (old.length === 0) return { ok: false, reason: "not_found" };

  const occurrences = countOccurrences(working, old);

  if (replaceAll && occurrences > 0) {
    let newWorking = working;
    let replaced = 0;
    while (replaced < occurrences) {
      const match = fuzzyFindText(newWorking, old);
      if (!match.found) break;
      newWorking =
        newWorking.slice(0, match.index) + next + newWorking.slice(match.index + match.matchLength);
      replaced++;
    }
    return replaced === occurrences ? { ok: true, newWorking } : { ok: false, reason: "not_found" };
  }

  if (occurrences === 0) return { ok: false, reason: "not_found" };
  if (occurrences > 1) return { ok: false, reason: "ambiguous", occurrences };

  const match = fuzzyFindText(working, old);
  if (!match.found) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    newWorking:
      working.slice(0, match.index) + next + working.slice(match.index + match.matchLength),
  };
}

type FailureKind =
  | { reason: "noop" }
  | { reason: "not_found"; closestSnippet: string | null; closestLine: number | null }
  | { reason: "ambiguous"; occurrences: number; matchLines: string; more: string }
  | { reason: "stale_anchor" }
  | { reason: "invalid"; detail: string }
  | { reason: "overlap" };

interface EditOutcome {
  ok: boolean;
  failure?: FailureKind;
}

export function createEditTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  planModeRefOrOnFileMutated?: { current: boolean } | MutationCallback,
  onFileMutated?: MutationCallback,
  onPreFileMutation?: MutationCallback,
  getDiagnostics?: DiagnosticsProvider,
): AgentTool<typeof EditParams> {
  const planModeRef = isPlanModeRef(planModeRefOrOnFileMutated)
    ? planModeRefOrOnFileMutated
    : undefined;
  const mutationCallback = isMutationCallback(planModeRefOrOnFileMutated)
    ? planModeRefOrOnFileMutated
    : onFileMutated;
  return {
    name: "edit",
    description:
      "Replace text in a file. Two edit forms:\n" +
      "1. TEXT form { old_text, new_text }: copy old_text verbatim from the latest read/diff with " +
      "enough context to match one location; set replace_all: true only for deliberate global renames. " +
      "The matcher tolerates safe whitespace/quote/dash drift, but do not paraphrase. For long blocks, " +
      "a line containing only `...` in BOTH old_text and new_text elides a middle preserved verbatim.\n" +
      "2. SPAN form { span, lines } (preferred after a read with anchors:true): pin the line range by " +
      "its line+hash endpoints and supply the full replacement lines — no old_text to retype, and the " +
      "edit is rejected if the file changed since the read. Span edits apply against the file as read; " +
      "text edits then run on the result.\n" +
      "Partial-apply by default: failed edits are listed for retry, successful ones are still written — " +
      "re-issue ONLY the listed failures, not the whole batch. " +
      "Returns a unified diff.",
    parameters: EditParams,
    executionMode: "sequential",
    async execute({ file_path, edits, atomic = false }) {
      if (isPlanModeActive(planModeRef)) {
        return planModeRestriction("edit");
      }
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      await assertFresh(readFiles, resolved, ops);

      const original = await ops.readFile(resolved);
      const hasCRLF = original.includes("\r\n");
      const originalNormalized = hasCRLF ? original.replace(/\r\n/g, "\n") : original;

      // Anchors pin lines in the file AS READ, so they always verify against the
      // original (pre-edit) line array — earlier edits in the batch don't shift
      // what an anchor refers to.
      const originalLines = originalNormalized.split("\n");
      const fileName = path.basename(resolved);
      const outcomes: EditOutcome[] = new Array(edits.length);

      // ── Phase 1: span-form edits (hash-anchored replacement). Spans resolve
      // against the file AS READ and apply bottom-up so indices stay valid.
      // Text-form edits then run on the result in phase 2.
      const isSpanForm = (e: (typeof edits)[number]): boolean =>
        e.span !== undefined || e.lines !== undefined;
      const spanResolved: Array<{ index: number; start: number; end: number; lines: string[] }> =
        [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        if (!isSpanForm(e)) {
          if (e.old_text === undefined || e.new_text === undefined) {
            outcomes[i] = {
              ok: false,
              failure: {
                reason: "invalid",
                detail: "provide either old_text+new_text, or span+lines — this edit has neither",
              },
            };
          }
          continue;
        }
        if (!e.span || !e.lines || e.old_text !== undefined || e.new_text !== undefined) {
          outcomes[i] = {
            ok: false,
            failure: {
              reason: "invalid",
              detail:
                "span form requires BOTH span and lines, and must not mix with old_text/new_text",
            },
          };
          continue;
        }
        const res = resolveAnchoredEdit(originalLines, e.span);
        if (!res.ok) {
          outcomes[i] = { ok: false, failure: { reason: "stale_anchor" } };
          continue;
        }
        spanResolved.push({ index: i, start: res.startIndex!, end: res.endIndex!, lines: e.lines });
      }
      // Reject overlapping spans (keep the first, fail the rest) — overlap means
      // the model double-addressed the same region and the result is undefined.
      spanResolved.sort((a, b) => a.start - b.start || a.index - b.index);
      const spanApplied: typeof spanResolved = [];
      let lastEnd = -1;
      for (const s of spanResolved) {
        if (s.start <= lastEnd) {
          outcomes[s.index] = { ok: false, failure: { reason: "overlap" } };
          continue;
        }
        spanApplied.push(s);
        lastEnd = s.end;
      }
      const workingLines = [...originalLines];
      for (let i = spanApplied.length - 1; i >= 0; i--) {
        const s = spanApplied[i];
        workingLines.splice(s.start, s.end - s.start + 1, ...s.lines);
        outcomes[s.index] = { ok: true };
      }
      let working = workingLines.join("\n");

      // ── Phase 2: text-form edits, sequential on the working buffer.
      for (let i = 0; i < edits.length; i++) {
        if (outcomes[i] !== undefined) continue; // span-form or invalid, already settled
        const { old_text, new_text, replace_all, anchor } = edits[i];
        if (old_text === undefined || new_text === undefined) continue; // settled above

        // Optional staleness guard (opt-in). Runs BEFORE the fuzzy match ladder:
        // if the model supplied an anchor and the file drifted since it read it,
        // reject this edit instead of risking a misplaced fuzzy match. The fuzzy
        // path below is byte-identical to today when `anchor` is absent.
        if (anchor) {
          const res = resolveAnchoredEdit(originalLines, anchor);
          if (!res.ok) {
            outcomes[i] = { ok: false, failure: { reason: "stale_anchor" } };
            continue;
          }
        }

        const normalizedOld = hasCRLF ? old_text.replace(/\r\n/g, "\n") : old_text;
        const normalizedNew = hasCRLF ? new_text.replace(/\r\n/g, "\n") : new_text;
        const replaceAll = replace_all ?? false;

        // Identical replacements are explicit no-op successes. They should not
        // block atomic batches that contain real edits, and all-no-op batches
        // should report success without writing.
        if (normalizedOld === normalizedNew) {
          outcomes[i] = { ok: true };
          continue;
        }

        // Aider's full fallback ladder, run only when the primary match
        // returns "not_found". Ambiguous matches deliberately don't fall
        // through — the model needs to add context, not paraphrase further.
        // Order mirrors aider/coders/editblock_coder.py:
        //   1. exact + smart-quote/dash fuzzy (in tryMatch)
        //   2. indent-flex (model omitted/shortened leading whitespace)
        //   3. drop spurious leading/trailing blank lines, retry 1+2
        //   4. dotdotdots (`...` elision with preserved middle)
        let result = tryMatch(working, normalizedOld, normalizedNew, replaceAll);

        const tryFallbacks = (oldText: string): string | null => {
          const flexed = applyMissingLeadingWhitespace(working, oldText, normalizedNew);
          if (flexed !== null) return flexed;
          // Re-run primary matcher on the stripped variant as a cheap retry.
          const exact = tryMatch(working, oldText, normalizedNew, replaceAll);
          if (exact.ok) return exact.newWorking;
          return null;
        };

        if (!result.ok && result.reason === "not_found") {
          const indentFlexed = applyMissingLeadingWhitespace(working, normalizedOld, normalizedNew);
          if (indentFlexed !== null) {
            result = { ok: true, newWorking: indentFlexed };
          }
        }

        if (!result.ok && result.reason === "not_found") {
          const stripped = stripBlankEdges(normalizedOld);
          if (stripped !== null) {
            const candidate = tryFallbacks(stripped);
            if (candidate !== null) result = { ok: true, newWorking: candidate };
          }
        }

        if (!result.ok && result.reason === "not_found") {
          const elided = applyDotdotdots(working, normalizedOld, normalizedNew);
          if (elided !== null) result = { ok: true, newWorking: elided };
        }

        if (result.ok) {
          working = result.newWorking;
          outcomes[i] = { ok: true };
          continue;
        }

        if (result.reason === "not_found") {
          // Capture the closest-match snippet eagerly against the current
          // working buffer; we'll decide whether to render it post-loop based
          // on whether other edits in this batch succeeded.
          const closest = findClosestSnippet(working, normalizedOld);
          outcomes[i] = {
            ok: false,
            failure: {
              reason: "not_found",
              closestSnippet: closest?.snippet ?? null,
              closestLine: closest?.topLine ?? null,
            },
          };
        } else {
          const occurrences = result.occurrences ?? 0;
          const matches = findOccurrenceLines(working, normalizedOld);
          const matchLines = matches.map((m) => `  line ${m.line}: ${m.preview}`).join("\n");
          const more =
            occurrences > matches.length ? `\n  …and ${occurrences - matches.length} more` : "";
          outcomes[i] = {
            ok: false,
            failure: { reason: "ambiguous", occurrences, matchLines, more },
          };
        }
      }

      const failures = outcomes
        .map((o, i) => (o.ok || !o.failure ? null : { index: i, failure: o.failure }))
        .filter((x): x is { index: number; failure: FailureKind } => x !== null);
      const successCount = outcomes.length - failures.length;

      // Closest-match snippets only get suppressed when successes will ACTUALLY
      // be persisted (partial-apply with at least one win). In atomic mode we
      // throw before writing, so the model retries against an unchanged file
      // and the snippet is its only guidance — keep it.
      const willPersistSuccesses = successCount > 0 && !atomic;
      const formatFailureMessage = (f: FailureKind): string => {
        if (f.reason === "stale_anchor") {
          return `the file changed since you read it (anchor mismatch) — re-read \`${file_path}\` and retry`;
        }
        if (f.reason === "noop") {
          return `old_text and new_text are identical in ${fileName} — this edit would be a no-op. Either fix new_text or drop this edit.`;
        }
        if (f.reason === "invalid") {
          return `invalid edit: ${f.detail}.`;
        }
        if (f.reason === "overlap") {
          return (
            `span overlaps another span edit in this batch — the overlapping region was addressed twice. ` +
            `Merge the overlapping spans into one edit and retry.`
          );
        }
        if (f.reason === "ambiguous") {
          return (
            `old_text found ${f.occurrences} times in ${fileName}. ` +
            "Include more surrounding context to make the match unique, " +
            "or set replace_all: true to swap every occurrence.\n" +
            "Matches at:\n" +
            f.matchLines +
            f.more
          );
        }
        const base =
          `old_text not found in ${fileName}. ` +
          "Text must match verbatim — do not paraphrase. " +
          "Fix this edit's old_text to match the file exactly (re-read the region below if unsure); " +
          "the file is unchanged, so successful edits and prior reads are still valid.";
        // Build a bounded read suggestion around the closest-match line so the
        // model can re-read just that region (e.g. ±25 lines) instead of the
        // whole file. Skipped when willPersistSuccesses — see comment above.
        const readHint =
          f.closestLine !== null && !willPersistSuccesses
            ? `\nSuggested re-read: \`read file_path="${file_path}" offset=${Math.max(1, f.closestLine - 25)} limit=50\``
            : "";
        if (willPersistSuccesses || !f.closestSnippet) return base + readHint;
        return `${base}${readHint}\nClosest match in file:\n${f.closestSnippet}`;
      };

      const formatFailures = (): string => {
        if (failures.length === 1 && edits.length === 1) {
          return formatFailureMessage(failures[0].failure);
        }
        return failures
          .map((f) => `[edit ${f.index + 1}/${edits.length}] ${formatFailureMessage(f.failure)}`)
          .join("\n\n");
      };

      // Atomic-mode failure, OR partial-mode failure where literally nothing
      // succeeded. Either way nothing should be written and we throw to make
      // the model retry the whole batch.
      if (failures.length > 0 && (atomic || successCount === 0)) {
        // Nothing was written — the file is byte-identical to the last read, so
        // the read tracker stays valid. We deliberately do NOT invalidate it
        // here: doing so turned a precise "old_text not found (closest match
        // below)" error into a misleading "File must be read first" on every
        // following edit, hiding the real fix from the model. assertFresh still
        // catches genuine on-disk changes (formatter/external edit).
        const header =
          atomic && failures.length > 0
            ? `${failures.length} of ${edits.length} edit${edits.length === 1 ? "" : "s"} failed; no changes written (atomic).\n\n`
            : edits.length > 1
              ? `${failures.length} of ${edits.length} edits failed; no changes written.\n\n`
              : "";
        throw new Error(header + formatFailures());
      }

      const relPath = path.relative(cwd, resolved);
      const diff = generateDiff(originalNormalized, working, relPath);
      const changed = working !== originalNormalized;

      // LSP diagnostics for the just-written content. Best-effort enhancement:
      // any failure (or an opted-out provider) leaves output identical to today.
      let diagnosticsNote = "";
      if (changed) {
        const finalContent = hasCRLF ? working.replace(/\n/g, "\r\n") : working;
        // Snapshot the pre-mutation on-disk state for /rewind before writing.
        await onPreFileMutation?.(resolved);
        await ops.writeFile(resolved, finalContent);
        await recordWrite(readFiles, resolved, finalContent, ops);
        await mutationCallback?.(resolved);
        // recordWrite refreshed the tracker to the just-written content, so the
        // next edit (including retries of the skipped ones) validates against an
        // accurate snapshot. No invalidation — the failure message already
        // carries the closest match and a bounded re-read hint.
        if (getDiagnostics) {
          try {
            diagnosticsNote = await getDiagnostics(resolved, finalContent);
          } catch {
            // Diagnostics must never break a successful edit.
          }
        }
      }

      if (failures.length === 0) {
        if (!changed) {
          const summary =
            edits.length > 1
              ? `No changes needed in ${relPath}; ${edits.length} edits were no-ops.`
              : `No changes needed in ${relPath}; edit was a no-op.`;
          return { content: summary, details: { diff } };
        }
        const summary =
          edits.length > 1
            ? `Successfully applied ${edits.length} edits to ${relPath}.`
            : `Successfully replaced text in ${relPath}.`;
        return { content: summary + diagnosticsNote, details: { diff } };
      }

      // Partial success — the loud header is deliberate: the model has to know
      // that work was saved AND that only the listed edits need to be retried.
      const noun = failures.length === 1 ? "edit" : "edits";
      const content =
        `Applied ${successCount} of ${edits.length} edits to ${relPath}.\n` +
        `${failures.length} ${noun} skipped — re-issue ONLY these (the rest are already done, do not redo them):\n\n` +
        formatFailures() +
        diagnosticsNote;
      return { content, details: { diff } };
    },
  };
}
