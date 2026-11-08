import { promises as fs } from "node:fs";
import path from "node:path";

/** The most of one file handed over; longer files are cut and say so. */
const FILE_LIMIT = 24_000;
/** The most handed over in all; files past it are named but not included. */
const TOTAL_LIMIT = 60_000;

/**
 * A child's brief with files its parent already read appended, so the child
 * starts with their current contents instead of spending turns reading them
 * again. Paths resolve against the child's folder. A file that's missing,
 * binary or past the limits is named with the reason, never fatal: the child
 * can still read it itself. Returns the brief unchanged when there are none.
 */
export async function withContextFiles(
  task: string,
  files: readonly string[],
  cwd: string,
): Promise<string> {
  if (files.length === 0) return task;
  const parts: string[] = [];
  let used = 0;
  for (const file of [...new Set(files)]) {
    const full = path.resolve(cwd, file);
    if (used >= TOTAL_LIMIT) {
      parts.push(`### ${full}\n(not included: over the size limit; read it if you need it)`);
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(full, "utf8");
    } catch {
      parts.push(`### ${full}\n(not included: couldn't be read)`);
      continue;
    }
    if (text.includes("\u0000")) {
      parts.push(`### ${full}\n(not included: binary file)`);
      continue;
    }
    const room = Math.min(FILE_LIMIT, TOTAL_LIMIT - used);
    const cut = text.length > room;
    const shown = cut ? text.slice(0, room) : text;
    used += shown.length;
    const fence = shown.includes("```") ? "````" : "```";
    parts.push(
      `### ${full}${cut ? ` (first ${room} of ${text.length} characters; read the rest if you need it)` : ""}\n${fence}\n${shown}${shown.endsWith("\n") ? "" : "\n"}${fence}`,
    );
  }
  return `${task}\n\n## Files already read for you\nTheir current contents, so you don't need to read them again before working on them.\n\n${parts.join("\n\n")}`;
}
