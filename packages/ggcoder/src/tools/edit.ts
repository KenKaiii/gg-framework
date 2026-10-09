import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import {
  fuzzyFindText,
  normalizeForFuzzyMatch,
  countOccurrences,
  generateDiff,
  findClosestSnippet,
  findOccurrenceLines,
  stripBlankEdges,
  applyDotdotdots,
  applyMissingLeadingWhitespace,
} from "./edit-diff.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { isFresh, recordWrite, type ReadTracker } from "./read-tracker.js";
import { resolveAnchoredEdit } from "../core/hashline.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import type { EditSource } from "../core/lsp/edit-telemetry.js";
import { resolveWriteGuard, type WriteGuardSettings } from "../core/workspace-guard.js";
import { redactedOldTextHint, redactionLossError } from "./redaction-guard.js";

type MutationCallback = (filePath: string) => void | Promise<void>;

/** Post-write diagnostics provider (LSP). Non-empty results are appended to successful tool output. */
type DiagnosticsProvider = (
  filePath: string,
  content: string,
  source?: EditSource,
) => Promise<string>;

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
  start_line: z.number().int().min(1),
  start_hash: z.string(),
  end_line: z.number().int().min(1),
  end_hash: z.string(),
});

const EditItemFields = z.object({
  old_text: z.string().optional(),
  new_text: z.string().optional(),
  replace_all: z.boolean().optional(),
  span: EditAnchorSchema.optional(),
  lines: z.array(z.string()).optional(),
});

// The text-form `anchor` staleness guard is still honoured, but no longer
// advertised: 3 of ~4,700 real edit calls used it, and its schema cost ~85
// tokens on every request (bench/prompt-diet). Unknown keys pass through and
// `anchor` alone is validated here.
const EditItem = EditItemFields.loose().superRefine((item, ctx) => {
  if (item.anchor === undefined) return;
  if (!EditAnchorSchema.safeParse(item.anchor).success) {
    ctx.addIssue({
      code: "custom",
      path: ["anchor"],
      message: "anchor needs start_line, start_hash, end_line, end_hash",
    });
  }
});

// Several models (opus-5, sonnet-5, fable-5, glm-5.x) occasionally send `edits`
// as a JSON string instead of a real array, which trips Zod and makes the model
// fall back to sed/python. Coerce the well-formed case back into an array before
// validation.
const coerceStringifiedEdits = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
};

// Reaching the array schema with a string means the coercion above could not
// parse it. Every observed case is a hand-serialized array whose inner escaping
// broke, whose `new_text` key went missing, or that was truncated mid-write.
//
// A lenient repair stage (the `jsonrepair` package, as used by several agent
// runtimes) was measured against 41 real failures from ~/.gg session logs: it
// parses 11, but only 2 faithfully. The rest pass this schema while silently
// dropping content -- it closes the JSON at the first error, so a truncated
// stream yields a short `new_text` and one 8.8KB payload came back with 11% of
// its characters. Those write partial code over a real file. Recovering 2 in 41
// is not worth 4 corrupted files, so this stays a hard rejection.
//
// What was actually costing turns is the message: Zod's stock "expected array,
// received string" never tells the model what it did, so it re-sends the
// identical payload until the agent loop's repeat counter turns the turn fatal.
// Name the mistake and the way out instead.
const STRINGIFIED_EDITS_ERROR =
  "`edits` arrived as a JSON-encoded string and could not be parsed back into an array. " +
  "Send `edits` as a real JSON array of objects, never as a string. " +
  "Re-sending the same large payload usually breaks the same way: split the work into " +
  "several `edit` calls carrying one or two smaller edits each.";

const EditList = z.preprocess(
  coerceStringifiedEdits,
  z
    .array(EditItem, {
      // Narrow to "an array was expected, a string arrived" so a nested
      // string-typed mistake (`anchor: "x"`, `replace_all: "true"`) keeps
      // its own accurate message. Any non-matching issue returns undefined
      // and falls through to Zod's default.
      error: (issue) =>
        issue.code === "invalid_type" &&
        issue.expected === "array" &&
        typeof issue.input === "string"
          ? STRINGIFIED_EDITS_ERROR
          : undefined,
    })
    .min(1),
);

// Multi-file entries take the text form only: a replay test batched all 7
// files 8/8 times either way, and dropping the anchor/span forms here keeps
// ~2k chars of duplicated schema out of every request.
const TextEditItem = EditItemFields.pick({ old_text: true, new_text: true, replace_all: true });

const FileEdits = z.object({
  file_path: z.string(),
  edits: z.preprocess(coerceStringifiedEdits, z.array(TextEditItem).min(1)),
});

// `files` lets one call cover a multi-file change. Measured on gpt-6-astra
// (replay of a 7-file refactor at the point where every file had been read):
// with it the model sent all 7 files in one call 8/8 times; without it 5/8
// responses carried every edit and the rest fell back to one file per turn.
type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An `edits` item that is really a `files` entry: only nested `edits` (+ optional file_path). */
const isNestedFileEntry = (v: unknown): v is UnknownRecord =>
  isRecord(v) &&
  Array.isArray(coerceStringifiedEdits(v.edits)) &&
  Object.keys(v).every((key) => key === "edits" || key === "file_path");

// Prompt-diet bench (bench/prompt-diet, GLM-5.3-Flash): the model's commonest
// malformed edit call puts the multi-file shape under `edits`, either
// `edits: [{file_path, edits}]` or `file_path` + `edits: [{edits}]`. Zod would
// strip the nested keys and the call fails with no file to edit, costing a
// turn. Both shapes are unambiguous, so route them to the intended form.
const normalizeMisnestedEdits = (raw: unknown): unknown => {
  if (!isRecord(raw) || raw.files !== undefined) return raw;
  const edits = coerceStringifiedEdits(raw.edits);
  if (!Array.isArray(edits) || edits.length === 0 || !edits.every(isNestedFileEntry)) return raw;
  const { edits: _nested, ...rest } = raw;
  if (raw.file_path === undefined && edits.every((e) => typeof e.file_path === "string")) {
    return { ...rest, files: edits };
  }
  if (
    typeof raw.file_path === "string" &&
    edits.every((e) => e.file_path === undefined || e.file_path === raw.file_path)
  ) {
    return { ...rest, edits: edits.flatMap((e) => coerceStringifiedEdits(e.edits) as unknown[]) };
  }
  return raw;
};

// Haiku 5.5 (bench/h2h arena, 2026-10-09: a 6-file refactor lost a turn to it)
// flattens the `files` form into `edits`, naming the file on every item and
// sending no top-level `file_path`:
//   { edits: [{ file_path, old_text, new_text }, ...] }
// Each item says which file it edits, so group them, in first-seen order, into
// `files`. Only text-form items qualify: `files` takes no span/anchor edits, so
// any other key keeps the existing "Provide file_path and edits" rejection.
const FLAT_FILE_ITEM_KEYS = new Set(["file_path", "old_text", "new_text", "replace_all"]);

const isFlatFileItem = (v: unknown): v is UnknownRecord & { file_path: string } =>
  isRecord(v) &&
  typeof v.file_path === "string" &&
  typeof v.old_text === "string" &&
  Object.keys(v).every((key) => FLAT_FILE_ITEM_KEYS.has(key));

const groupFlatFileEdits = (raw: unknown): unknown => {
  if (!isRecord(raw) || raw.files !== undefined || raw.file_path !== undefined) return raw;
  const edits = coerceStringifiedEdits(raw.edits);
  if (!Array.isArray(edits) || edits.length === 0 || !edits.every(isFlatFileItem)) return raw;
  const byFile = new Map<string, UnknownRecord[]>();
  for (const { file_path: filePath, ...edit } of edits) {
    const fileEdits = byFile.get(filePath) ?? [];
    fileEdits.push(edit);
    byFile.set(filePath, fileEdits);
  }
  const { edits: _flat, ...rest } = raw;
  return {
    ...rest,
    files: [...byFile].map(([filePath, fileEdits]) => ({ file_path: filePath, edits: fileEdits })),
  };
};

// Haiku 5.5 (bench/h2h: 20 of 76 edit calls across 30 runs, and the cause of
// a failed run) closes the `edits` string where `old_text` should end, which
// pushes `new_text` up to the top level:
//   { file_path, edits: '[{"old_text">OLD', new_text: 'NEW' }
// OLD is then the raw, complete old text: the model ended it with its own
// string terminator, and NEW is a separately parsed, complete JSON string.
// Nothing is guessed, and the matcher still requires OLD to match the file
// exactly once, so a wrong recovery fails like any other bad `old_text`.
// Any other shape (no top-level new_text, extra keys) keeps the hard
// rejection below.
const SPLIT_OLD_TEXT_PREFIX = '[{"old_text">';
const SPLIT_OLD_TEXT_KEYS = new Set(["file_path", "edits", "new_text", "atomic"]);

const recoverSplitOldText = (raw: unknown): unknown => {
  if (!isRecord(raw) || typeof raw.edits !== "string" || typeof raw.new_text !== "string") {
    return raw;
  }
  if (!raw.edits.startsWith(SPLIT_OLD_TEXT_PREFIX)) return raw;
  if (!Object.keys(raw).every((key) => SPLIT_OLD_TEXT_KEYS.has(key))) return raw;
  const oldText = raw.edits.slice(SPLIT_OLD_TEXT_PREFIX.length);
  if (oldText.length === 0) return raw;
  const { new_text: newText, ...rest } = raw;
  return { ...rest, edits: [{ old_text: oldText, new_text: newText }] };
};

// A single flat edit, the shape most agents' edit tools use:
//   { file_path, old_text, new_text, replace_all? }
// Haiku 5.5 sends it unprompted, and the schema used to strip the unknown
// top-level fields, leaving `{ file_path }`: the change was lost and the call
// failed. Lifted into `edits` only when it is the whole call (no `edits`/
// `files`, no other keys), so nothing is merged or guessed.
const FLAT_EDIT_KEYS = new Set(["file_path", "old_text", "new_text", "replace_all", "atomic"]);

const liftFlatEdit = (raw: unknown): unknown => {
  if (!isRecord(raw) || typeof raw.old_text !== "string") return raw;
  if (raw.edits !== undefined || raw.files !== undefined) return raw;
  if (!Object.keys(raw).every((key) => FLAT_EDIT_KEYS.has(key))) return raw;
  const { old_text: oldText, new_text: newText, replace_all: replaceAll, ...rest } = raw;
  return {
    ...rest,
    edits: [
      {
        old_text: oldText,
        new_text: newText,
        ...(replaceAll === undefined ? {} : { replace_all: replaceAll }),
      },
    ],
  };
};

const EditParams = z.preprocess(
  (raw: unknown) =>
    groupFlatFileEdits(normalizeMisnestedEdits(recoverSplitOldText(liftFlatEdit(raw)))),
  z.object({
    file_path: z.string().optional(),
    edits: EditList.optional(),
    files: z
      .array(FileEdits)
      .min(1)
      .optional()
      .describe("Several files: [{file_path, edits}], instead of file_path/edits"),
    atomic: z.boolean().optional().describe("All-or-nothing per file"),
  }),
);

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

  const occurrences = countOccurrences(working, old, !replaceAll);

  if (replaceAll && occurrences > 0) {
    const parts: string[] = [];
    let cursor = 0;
    // Search only untouched input: replacements can contain old_text or create
    // new matches at their boundaries, neither of which belongs to this edit.
    for (let replaced = 0; replaced < occurrences; replaced++) {
      const match = fuzzyFindText(working.slice(cursor), old);
      if (!match.found || match.matchLength === 0) return { ok: false, reason: "not_found" };
      const start = cursor + match.index;
      parts.push(working.slice(cursor, start), next);
      cursor = start + match.matchLength;
    }
    parts.push(working.slice(cursor));
    return { ok: true, newWorking: parts.join("") };
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
  | {
      reason: "not_found";
      closestSnippet: string | null;
      closestLine: number | null;
      redactedHint: string;
    }
  | { reason: "ambiguous"; occurrences: number; matchLines: string; more: string }
  | { reason: "stale_anchor" }
  | { reason: "invalid"; detail: string }
  | { reason: "overlap" };

interface EditOutcome {
  ok: boolean;
  failure?: FailureKind;
  /** Which matching strategy placed this edit; absent for no-ops. */
  source?: EditSource;
}

/**
 * Riskiest strategy used in a batch, worst first. When one edit landed by exact
 * text and another only by `...` elision, the elision is what a resulting
 * breakage should be attributed to.
 */
const SOURCE_RISK: EditSource[] = ["dotdotdot", "blank_edges", "indent_flex", "text", "span"];

function riskiestSource(outcomes: EditOutcome[]): EditSource | undefined {
  const used = new Set(outcomes.map((o) => o.source).filter(Boolean));
  return SOURCE_RISK.find((s) => used.has(s));
}

export function createEditTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  planModeRefOrOnFileMutated?: { current: boolean } | MutationCallback,
  onFileMutated?: MutationCallback,
  onPreFileMutation?: MutationCallback,
  getDiagnostics?: DiagnosticsProvider,
  getWriteGuardSettings?: () => WriteGuardSettings | undefined,
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
      "Edit files. `old_text`: verbatim, unique unless replace_all. Or `span` (from read " +
      "anchors:true) + full replacement `lines`. Re-send only failed edits.",
    parameters: EditParams,
    executionMode: "sequential",
    async execute({ file_path, edits, files, atomic = false }) {
      if (isPlanModeActive(planModeRef)) {
        return planModeRestriction("edit");
      }
      const targets = resolveEditTargets(file_path, edits, files);
      if (!targets.ok) throw new Error(targets.error);
      if (targets.value.length === 1) {
        const only = targets.value[0];
        return editOneFile(only.file_path, only.edits, atomic);
      }
      // Files apply in order, each independently: one file's failure never
      // rolls back another, and the result says exactly which to re-issue.
      const parts: string[] = [];
      const diffs: string[] = [];
      let failed = 0;
      for (const target of targets.value) {
        try {
          const result = await editOneFile(target.file_path, target.edits, atomic);
          const content = typeof result === "string" ? result : result.content;
          if (typeof result !== "string" && result.details.diff) diffs.push(result.details.diff);
          if (typeof result === "string" && result.startsWith("Error:")) failed++;
          parts.push(`### ${target.file_path}\n${content}`);
        } catch (error) {
          failed++;
          parts.push(
            `### ${target.file_path}\nFAILED — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const total = targets.value.length;
      if (failed === total)
        throw new Error(`All ${total} files failed; no changes written.\n\n${parts.join("\n\n")}`);
      const header =
        failed === 0
          ? `Edited ${total} files.`
          : `Edited ${total - failed} of ${total} files. ${failed} failed — re-issue ONLY the failed files (the rest are already done).`;
      return { content: `${header}\n\n${parts.join("\n\n")}`, details: { diff: diffs.join("\n") } };
    },
  };

  async function editOneFile(
    file_path: string,
    edits: z.infer<typeof EditList>,
    atomic: boolean,
  ): Promise<string | { content: string; details: { diff: string } }> {
    const resolved = resolvePath(cwd, file_path);
    await rejectSymlink(resolved);

    // Workspace write guard: outside cwd/tmp/~/.gg requires user approval.
    const guard = resolveWriteGuard(cwd, resolved, getWriteGuardSettings?.());
    if (!guard.allowed) {
      return `Error: ${guard.reason}`;
    }

    // No prior read is required: every old_text, span and anchor is matched
    // against the live content below, which proves the model knows the text
    // it replaces (it may have seen it via `cat`, or changed the file itself
    // with a script). A read that no longer matches disk is forgotten, so the
    // file counts as unread again: the edit still validates against live
    // content, but a later full-file `write` needs a fresh read.
    if (readFiles?.has(resolved) && !(await isFresh(readFiles, resolved, ops))) {
      readFiles.delete(resolved);
    }

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
    const spanResolved: Array<{ index: number; start: number; end: number; lines: string[] }> = [];
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
      spanResolved.push({ index: i, start: res.startIndex, end: res.endIndex, lines: e.lines });
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
      outcomes[s.index] = { ok: true, source: "span" };
    }
    let working = workingLines.join("\n");

    // ── Phase 2: text-form edits, sequential on the working buffer.
    for (let i = 0; i < edits.length; i++) {
      if (outcomes[i] !== undefined) continue; // span-form or invalid, already settled
      const { old_text, new_text, replace_all } = edits[i];
      const parsedAnchor = EditAnchorSchema.safeParse(edits[i].anchor);
      const anchor = parsedAnchor.success ? parsedAnchor.data : undefined;
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

      if (
        normalizedOld.length === 0 ||
        (!working.includes(normalizedOld) && normalizeForFuzzyMatch(normalizedOld).length === 0)
      ) {
        outcomes[i] = {
          ok: false,
          failure: {
            reason: "invalid",
            detail: "old_text is empty after normalization; provide visible surrounding context.",
          },
        };
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
      let source: EditSource = "text";
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
          source = "indent_flex";
        }
      }

      if (!result.ok && result.reason === "not_found") {
        const stripped = stripBlankEdges(normalizedOld);
        if (stripped !== null) {
          const candidate = tryFallbacks(stripped);
          if (candidate !== null) {
            result = { ok: true, newWorking: candidate };
            source = "blank_edges";
          }
        }
      }

      if (!result.ok && result.reason === "not_found") {
        if (replaceAll && /^[ \t]*\.\.\.[ \t]*$/m.test(normalizedOld)) {
          outcomes[i] = {
            ok: false,
            failure: {
              reason: "invalid",
              detail:
                "replace_all does not support ... elision; use complete matching text or separate uniquely anchored edits.",
            },
          };
          continue;
        }
        const elided = applyDotdotdots(working, normalizedOld, normalizedNew);
        if (elided !== null) {
          result = { ok: true, newWorking: elided };
          source = "dotdotdot";
        }
      }

      if (result.ok) {
        working = result.newWorking;
        outcomes[i] = { ok: true, source };
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
            redactedHint: redactedOldTextHint(normalizedOld),
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
        "the file is unchanged, so successful edits and prior reads are still valid." +
        f.redactedHint;
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
      // following edit, hiding the real fix from the model. A genuine on-disk
      // change (formatter/external edit) is caught by the freshness check.
      const header =
        atomic && failures.length > 0
          ? `${failures.length} of ${edits.length} edit${edits.length === 1 ? "" : "s"} failed; no changes written (atomic).\n\n`
          : edits.length > 1
            ? `${failures.length} of ${edits.length} edits failed; no changes written.\n\n`
            : "";
      throw new Error(header + formatFailures());
    }

    // Never replace real secrets with the placeholder the model was shown.
    const lossError = redactionLossError(originalNormalized, working, fileName);
    if (lossError) throw new Error(lossError);

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
      await recordWrite(readFiles, resolved, finalContent, ops, "edit");
      await mutationCallback?.(resolved);
      // recordWrite refreshed the tracker to the just-written content, so the
      // next edit (including retries of the skipped ones) validates against an
      // accurate snapshot. No invalidation — the failure message already
      // carries the closest match and a bounded re-read hint.
      if (getDiagnostics) {
        try {
          diagnosticsNote = await getDiagnostics(resolved, finalContent, riskiestSource(outcomes));
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
  }
}

type EditTarget = { file_path: string; edits: z.infer<typeof EditList> };

/** Exactly one form: `file_path`+`edits`, or `files`. */
function resolveEditTargets(
  file_path: string | undefined,
  edits: z.infer<typeof EditList> | undefined,
  files: EditTarget[] | undefined,
): { ok: true; value: EditTarget[] } | { ok: false; error: string } {
  const single = file_path !== undefined || edits !== undefined;
  if (files !== undefined && single) {
    return { ok: false, error: "Use either file_path+edits or files, not both." };
  }
  if (files !== undefined) return { ok: true, value: files };
  if (file_path === undefined || edits === undefined) {
    return {
      ok: false,
      error: "Provide file_path and edits (one file), or files (several files).",
    };
  }
  return { ok: true, value: [{ file_path, edits }] };
}

// The edit tool as Claude models see it: three flat fields, the shape every
// other coding agent's edit tool uses (Claude Code, Copilot CLI, Goose).
// GG's nested form (`edits[]`, `files[]`, line spans) made Haiku 5.5 send the
// list as a JSON string in 30-57% of calls and think more per line of code
// than any peer; with this shape it sent 166/166 edits well-formed and its
// thinking per line of code matched the peers (bench/h2h arena, 2026-10-09).
//
// Only the advertised schema changes. Arguments still go through EditParams,
// which lifts a flat call into `edits` and keeps accepting every nested shape
// (resumed sessions, callers inside GG), so execution is identical.
const FLAT_EDIT_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    old_text: { type: "string" },
    new_text: { type: "string" },
    replace_all: { type: "boolean" },
  },
  required: ["file_path", "old_text", "new_text"],
};

export function createFlatEditTool(
  ...args: Parameters<typeof createEditTool>
): AgentTool<typeof EditParams> {
  return {
    ...createEditTool(...args),
    description:
      "Edit a file by replacing old_text (verbatim, unique unless replace_all) with new_text.",
    rawInputSchema: FLAT_EDIT_SCHEMA,
  };
}
