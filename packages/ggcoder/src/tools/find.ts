import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";

const FindParams = z.object({
  pattern: z.string().describe("Glob, e.g. '**/*.ts'"),
  path: z.string().optional(),
});

const MAX_RESULTS = 100;

export function createFindTool(cwd: string): AgentTool<typeof FindParams> {
  return {
    name: "find",
    description: "Find files by glob (respects .gitignore, max 100).",
    parameters: FindParams,
    async execute({ pattern, path: searchPath }) {
      const dir = searchPath ? resolvePath(cwd, searchPath) : cwd;

      // Dynamic import for ESM-only fast-glob
      const fg = await import("fast-glob");
      const ignore = await import("ignore");

      // Load .gitignore patterns
      const ignorePatterns = await loadGitignore(dir);
      const ig = ignore.default();
      ig.add(ignorePatterns);

      // fast-glob (picomatch) treats "\" as an ESCAPE character, never a path
      // separator — so a Windows-shaped pattern like `src\**\*.ts` silently
      // matches nothing. Glob syntax is always forward-slash.
      const entries = await fg.default(pattern.replace(/\\/g, "/"), {
        cwd: dir,
        dot: false,
        onlyFiles: true,
        // Ignored directories are pruned from the walk itself rather than only
        // filtered afterwards: a build tree (`target/`, `dist/`) can hold far
        // more files than the source. The `ig` filter below stays the source
        // of truth; pruning only skips work whose results it would drop.
        ignore: ["**/node_modules/**", "**/.git/**", ...gitignoreDirGlobs(ignorePatterns)],
        suppressErrors: true,
        followSymbolicLinks: false,
      });

      // Filter by .gitignore
      const filtered = entries.filter((entry) => !ig.ignores(entry));
      filtered.sort();

      const truncated = filtered.length > MAX_RESULTS;
      const shown = truncated ? filtered.slice(0, MAX_RESULTS) : filtered;

      let output = shown.join("\n");
      if (truncated) {
        output += `\n\n[Truncated: showing ${MAX_RESULTS} of ${filtered.length} matches]`;
      } else {
        output += `\n\n${filtered.length} file(s) found`;
      }

      return output;
    },
  };
}

async function loadGitignore(dir: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * fast-glob ignore globs for the directories a root .gitignore excludes.
 * Git never re-includes anything under an excluded directory, so pruning
 * these is result-neutral. Only simple lines convert; escapes and odd forms
 * are left to the post-filter, and any negation disables pruning (it could
 * re-include a directory). A dir-only line (`dist/`) prunes only below the
 * directory, so a FILE of that name is still listed.
 */
export function gitignoreDirGlobs(lines: readonly string[]): string[] {
  if (lines.some((line) => line.startsWith("!"))) return [];
  const globs: string[] = [];
  for (const line of lines) {
    if (line.includes("\\") || /\s/.test(line)) continue;
    const dirOnly = line.endsWith("/");
    const body = line.replace(/\/+$/, "");
    if (!body || body === "/" || /^\*+$/.test(body.replace(/^\//, ""))) continue;
    const anchored = body.startsWith("/") || body.slice(0, -1).includes("/");
    const rel = body.replace(/^\//, "");
    if (!rel || rel.startsWith("..")) continue;
    const glob = anchored ? rel : `**/${rel}`;
    // `x/**` also matches a file named x; `x/*/**` + `x/.*/**` still prune
    // every subdirectory but leave such a file alone.
    if (dirOnly) globs.push(`${glob}/*/**`, `${glob}/.*/**`);
    else globs.push(`${glob}/**`);
  }
  return globs;
}
