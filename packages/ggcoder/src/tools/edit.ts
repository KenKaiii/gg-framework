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
  stripLeadingBlankLine,
  applyDotdotdots,
  applyMissingLeadingWhitespace,
} from "./edit-diff.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { assertFresh, recordWrite, type ReadTracker } from "./read-tracker.js";

const EditItem = z.object({
  old_text: z.string().describe("The exact text to find and replace"),
  new_text: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence of old_text instead of requiring a unique match. " +
        "Use for renames or repeated tokens. Defaults to false.",
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

  if (replaceAll && working.includes(old)) {
    return { ok: true, newWorking: working.split(old).join(next) };
  }

  const occurrences = countOccurrences(working, old);
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
  | { reason: "not_found"; closestSnippet: string | null }
  | { reason: "ambiguous"; occurrences: number; matchLines: string; more: string };

interface EditOutcome {
  ok: boolean;
  failure?: FailureKind;
}

export function createEditTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    description:
      "Replace text in a file via { old_text, new_text } edits applied sequentially. Read the file first. " +
      "Each old_text must uniquely match exactly one location — set replace_all: true to swap every occurrence (renames). " +
      "For long blocks, a line containing only `...` in BOTH old_text and new_text elides a middle preserved verbatim. " +
      "Partial-apply by default: failed edits are listed for retry, successful ones are still written — " +
      "re-issue ONLY the listed failures, not the whole batch. Returns a unified diff.",
    parameters: EditParams,
    async execute({ file_path, edits, atomic = false }) {
      if (planModeRef?.current) {
        return "Error: edit is restricted in plan mode. Use read-only tools to explore the codebase, then write your plan to .gg/plans/.";
      }
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      await assertFresh(readFiles, resolved, ops);

      const original = await ops.readFile(resolved);
      const hasCRLF = original.includes("\r\n");
      const originalNormalized = hasCRLF ? original.replace(/\r\n/g, "\n") : original;

      let working = originalNormalized;
      const fileName = path.basename(resolved);
      const outcomes: EditOutcome[] = new Array(edits.length);

      for (let i = 0; i < edits.length; i++) {
        const { old_text, new_text, replace_all } = edits[i];
        const normalizedOld = hasCRLF ? old_text.replace(/\r\n/g, "\n") : old_text;
        const normalizedNew = hasCRLF ? new_text.replace(/\r\n/g, "\n") : new_text;
        const replaceAll = replace_all ?? false;

        // Reject no-op edits before they consume a write or silently "succeed"
        // — usually the model paraphrased the new_text to be identical to old.
        if (normalizedOld === normalizedNew) {
          outcomes[i] = { ok: false, failure: { reason: "noop" } };
          continue;
        }

        // Aider's full fallback ladder, run only when the primary match
        // returns "not_found". Ambiguous matches deliberately don't fall
        // through — the model needs to add context, not paraphrase further.
        // Order mirrors aider/coders/editblock_coder.py:
        //   1. exact + smart-quote/dash fuzzy (in tryMatch)
        //   2. indent-flex (model omitted/shortened leading whitespace)
        //   3. drop leading blank line, retry 1+2
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
          const stripped = stripLeadingBlankLine(normalizedOld);
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
          outcomes[i] = {
            ok: false,
            failure: {
              reason: "not_found",
              closestSnippet: findClosestSnippet(working, normalizedOld),
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
        if (f.reason === "noop") {
          return `old_text and new_text are identical in ${fileName} — this edit would be a no-op. Either fix new_text or drop this edit.`;
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
          "Text must match verbatim — do not paraphrase. Re-read the file if unsure.";
        if (willPersistSuccesses || !f.closestSnippet) return base;
        return `${base}\nClosest match in file:\n${f.closestSnippet}`;
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
        const header =
          atomic && failures.length > 0
            ? `${failures.length} of ${edits.length} edit${edits.length === 1 ? "" : "s"} failed; no changes written (atomic).\n\n`
            : edits.length > 1
              ? `${failures.length} of ${edits.length} edits failed; no changes written.\n\n`
              : "";
        throw new Error(header + formatFailures());
      }

      const finalContent = hasCRLF ? working.replace(/\n/g, "\r\n") : working;
      await ops.writeFile(resolved, finalContent);
      await recordWrite(readFiles, resolved, finalContent, ops);

      const relPath = path.relative(cwd, resolved);
      const diff = generateDiff(originalNormalized, working, relPath);

      if (failures.length === 0) {
        const summary =
          edits.length > 1
            ? `Successfully applied ${edits.length} edits to ${relPath}.`
            : `Successfully replaced text in ${relPath}.`;
        return { content: summary, details: { diff } };
      }

      // Partial success — the loud header is deliberate: the model has to know
      // that work was saved AND that only the listed edits need to be retried.
      const noun = failures.length === 1 ? "edit" : "edits";
      const content =
        `Applied ${successCount} of ${edits.length} edits to ${relPath}.\n` +
        `${failures.length} ${noun} skipped — re-issue ONLY these (the rest are already done, do not redo them):\n\n` +
        formatFailures();
      return { content, details: { diff } };
    },
  };
}
