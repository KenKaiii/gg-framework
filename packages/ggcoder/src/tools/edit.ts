import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { fuzzyFindText, countOccurrences, generateDiff } from "./edit-diff.js";

const EditParams = z.object({
  file_path: z.string().describe("The file path to edit"),
  old_text: z.string().describe("The exact text to find and replace"),
  new_text: z.string().describe("The replacement text"),
});

export function createEditTool(cwd: string, readFiles?: Set<string>): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    description:
      "Replace a specific text string in a file. The file must be read first before editing. " +
      "The old_text must uniquely match exactly one location in the file. Returns a unified diff of the change.",
    parameters: EditParams,
    async execute({ file_path, old_text, new_text }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      if (readFiles && !readFiles.has(resolved)) {
        throw new Error("File must be read first before editing. Use the read tool first.");
      }

      const content = await fs.readFile(resolved, "utf-8");

      // Detect line endings
      const hasCRLF = content.includes("\r\n");

      // Normalize for matching
      const normalized = hasCRLF ? content.replace(/\r\n/g, "\n") : content;
      const normalizedOld = hasCRLF ? old_text.replace(/\r\n/g, "\n") : old_text;
      const normalizedNew = hasCRLF ? new_text.replace(/\r\n/g, "\n") : new_text;

      // Check uniqueness
      const occurrences = countOccurrences(normalized, normalizedOld);
      if (occurrences === 0) {
        throw new Error(
          `old_text not found in ${path.basename(resolved)}. ` +
            "Make sure the text matches exactly, including whitespace and indentation.",
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_text found ${occurrences} times in ${path.basename(resolved)}. ` +
            "Include more surrounding context to make the match unique.",
        );
      }

      // Find and replace
      const match = fuzzyFindText(normalized, normalizedOld);
      if (!match.found) {
        throw new Error(`old_text not found in ${path.basename(resolved)}.`);
      }

      const newContent =
        normalized.slice(0, match.index) +
        normalizedNew +
        normalized.slice(match.index + match.matchLength);

      // Restore line endings if needed
      const finalContent = hasCRLF ? newContent.replace(/\n/g, "\r\n") : newContent;

      await fs.writeFile(resolved, finalContent, "utf-8");

      const relPath = path.relative(cwd, resolved);
      const diff = generateDiff(normalized, newContent, relPath);
      return diff;
    },
  };
}
