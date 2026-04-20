import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { fuzzyFindText, countOccurrences, generateDiff } from "./edit-diff.js";
import { localOperations, type ToolOperations } from "./operations.js";

const EditItem = z.object({
  old_text: z.string().describe("The exact text to find and replace"),
  new_text: z.string().describe("The replacement text"),
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
      "One or more edits applied in order. Each edit operates on the result of the previous one. " +
        "Every old_text must uniquely match exactly one location in the file at the time it is applied.",
    ),
});

export function createEditTool(
  cwd: string,
  readFiles?: Set<string>,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    description:
      "Replace one or more text strings in a file. The file must be read first before editing. " +
      "Pass `edits` as an array of { old_text, new_text } pairs; edits are applied sequentially " +
      "so each subsequent match runs against the result of the prior edits. " +
      "Every old_text must uniquely match exactly one location in the file when applied. " +
      "Returns a unified diff of the combined change.",
    parameters: EditParams,
    async execute({ file_path, edits }) {
      if (planModeRef?.current) {
        return "Error: edit is restricted in plan mode. Use read-only tools to explore the codebase, then write your plan to .gg/plans/.";
      }
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      if (readFiles && !readFiles.has(resolved)) {
        throw new Error("File must be read first before editing. Use the read tool first.");
      }

      const original = await ops.readFile(resolved);
      const hasCRLF = original.includes("\r\n");
      const originalNormalized = hasCRLF ? original.replace(/\r\n/g, "\n") : original;

      let working = originalNormalized;
      const fileName = path.basename(resolved);

      for (let i = 0; i < edits.length; i++) {
        const { old_text, new_text } = edits[i];
        const normalizedOld = hasCRLF ? old_text.replace(/\r\n/g, "\n") : old_text;
        const normalizedNew = hasCRLF ? new_text.replace(/\r\n/g, "\n") : new_text;

        const label = edits.length > 1 ? ` (edit ${i + 1}/${edits.length})` : "";

        const occurrences = countOccurrences(working, normalizedOld);
        if (occurrences === 0) {
          throw new Error(
            `old_text not found in ${fileName}${label}. ` +
              "Make sure the text matches exactly, including whitespace and indentation.",
          );
        }
        if (occurrences > 1) {
          throw new Error(
            `old_text found ${occurrences} times in ${fileName}${label}. ` +
              "Include more surrounding context to make the match unique.",
          );
        }

        const match = fuzzyFindText(working, normalizedOld);
        if (!match.found) {
          throw new Error(`old_text not found in ${fileName}${label}.`);
        }

        working =
          working.slice(0, match.index) +
          normalizedNew +
          working.slice(match.index + match.matchLength);
      }

      const finalContent = hasCRLF ? working.replace(/\n/g, "\r\n") : working;
      await ops.writeFile(resolved, finalContent);

      const relPath = path.relative(cwd, resolved);
      const diff = generateDiff(originalNormalized, working, relPath);
      const summary =
        edits.length > 1
          ? `Successfully applied ${edits.length} edits to ${relPath}.`
          : `Successfully replaced text in ${relPath}.`;
      return {
        content: summary,
        details: { diff },
      };
    },
  };
}
