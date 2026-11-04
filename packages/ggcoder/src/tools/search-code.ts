import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { resolvePath, toPosixPath } from "./path-utils.js";
import { truncateTail } from "./truncate.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { chunkFile, bm25Rank, CHUNKABLE_EXTENSIONS, type Chunk } from "../core/code-retrieval.js";

const SearchCodeParams = z.object({
  query: z.string(),
  path: z.string().optional(),
  max_results: z.number().int().min(1).optional().describe("Default 8"),
});

const DEFAULT_MAX_RESULTS = 8;
/** Every language with a symbol chunker; anything else has no symbols to rank. */
const SOURCE_GLOB = `**/*.{${CHUNKABLE_EXTENSIONS.join(",")}}`;
const MAX_CANDIDATE_FILES = 5000;

export function createSearchCodeTool(
  cwd: string,
  ops: ToolOperations = localOperations,
): AgentTool<typeof SearchCodeParams> {
  return {
    name: "code_search",
    description: "Find functions/classes by what they do; returns whole symbols.",
    parameters: SearchCodeParams,
    async execute({ query, path: searchPath, max_results }) {
      const dir = searchPath ? resolvePath(cwd, searchPath) : cwd;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;

      const fg = await import("fast-glob");
      const ignore = await import("ignore");

      const ig = ignore.default();
      ig.add(await loadGitignore(dir));

      const entries = await fg.default(SOURCE_GLOB, {
        cwd: dir,
        dot: false,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
        suppressErrors: true,
        followSymbolicLinks: false,
      });

      const files = entries.filter((entry) => !ig.ignores(entry)).slice(0, MAX_CANDIDATE_FILES);
      if (files.length === 0) {
        return "No indexable source files here. code_search covers TypeScript/JavaScript, Python, Go, Rust, Java and C# — use grep for other languages.";
      }

      const chunks: Chunk[] = [];
      for (const entry of files) {
        const abs = path.join(dir, entry);
        let source: string;
        try {
          source = await ops.readFile(abs);
        } catch {
          continue; // unreadable file — skip
        }
        // cwd-relative so headers are stable regardless of `path` scope, and
        // forward-slashed so the `file:line → symbol` headers the model reads
        // (and echoes back into read/edit calls) are identical on every OS.
        const rel = toPosixPath(path.relative(cwd, abs));
        for (const chunk of chunkFile(rel, source)) chunks.push(chunk);
      }

      if (chunks.length === 0) {
        return `No top-level symbols found in ${files.length} TS/JS file(s) under ${toPosixPath(path.relative(cwd, dir)) || "."}.`;
      }

      const ranked = bm25Rank(query, chunks, maxResults);
      if (ranked.length === 0) {
        return `No matching symbols found for "${query}".`;
      }

      const body = ranked
        .map((c) => `// ${c.file}:${c.startLine} → ${c.symbol}\n${c.text}`)
        .join("\n\n");
      const result = truncateTail(body);
      if (result.truncated) {
        return (
          `${result.content}\n\n` +
          `[Truncated: showing ${result.keptLines} of ${result.totalLines} lines. ` +
          `Lower max_results or refine the query for fewer chunks.]`
        );
      }
      return body;
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
