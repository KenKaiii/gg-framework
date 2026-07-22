import readline from "node:readline";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { BINARY_EXTENSIONS } from "./read.js";
import { localOperations, type ToolOperations } from "./operations.js";

const GrepParams = z.object({
  pattern: z.string().describe("Search pattern (JavaScript regex; leading (?i) is supported)"),
  path: z.string().optional().describe("File or directory to search (defaults to cwd)"),
  include: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
  max_results: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum matches to return (default: 50)"),
  case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
});

const DEFAULT_MAX_RESULTS = 50;
const MAX_LINE_LENGTH = 500;
/** Skip files larger than 10 MB — single-line files (minified JS, data blobs) can OOM readline */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CANDIDATE_FILES = 10_000;

export function createGrepTool(
  cwd: string,
  ops: ToolOperations = localOperations,
): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    description:
      "Search file contents using regex. Returns filepath:line_number:content for matches. " +
      "Respects .gitignore. Skips binary files.",
    parameters: GrepParams,
    async execute({ pattern, path: searchPath, include, max_results, case_insensitive }) {
      const dir = searchPath ? resolvePath(cwd, searchPath) : cwd;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      // Models commonly emit the RE2/PCRE-style leading `(?i)` flag. JavaScript
      // rejects it as an invalid group, so translate that safe, unambiguous form
      // to the equivalent RegExp flag while preserving the explicit tool option.
      const hasInlineCaseInsensitiveFlag = pattern.startsWith("(?i)");
      const normalizedPattern = hasInlineCaseInsensitiveFlag ? pattern.slice(4) : pattern;
      const flags = case_insensitive || hasInlineCaseInsensitiveFlag ? "gi" : "g";

      let regex: RegExp;
      try {
        regex = new RegExp(normalizedPattern, flags);
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`, { cause: err });
      }

      // Check if dir is a file
      const stat = await ops.stat(dir);
      if (stat.isFile()) {
        const results = await searchFile(dir, regex, cwd, maxResults, ops);
        return formatResults(results, maxResults);
      }

      // Enumerate files
      const fg = await import("fast-glob");
      const globPattern = include ?? "**/*";
      const entries = await fg.default(globPattern, {
        cwd: dir,
        dot: false,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
        suppressErrors: true,
        followSymbolicLinks: false,
        objectMode: true,
        stats: false,
      });

      const results: string[] = [];
      let scannedCandidates = 0;
      let candidateLimitHit = false;
      for (const item of entries) {
        if (results.length >= maxResults) break;
        if (scannedCandidates >= MAX_CANDIDATE_FILES) {
          candidateLimitHit = true;
          break;
        }
        scannedCandidates += 1;

        const entry = typeof item === "string" ? item : item.path;
        const ext = path.extname(entry).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const filePath = path.join(dir, entry);
        const fileResults = await searchFile(
          filePath,
          regex,
          cwd,
          maxResults - results.length,
          ops,
        );
        results.push(...fileResults);
      }

      return formatResults(results, maxResults, candidateLimitHit);
    },
  };
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  cwd: string,
  maxResults: number,
  ops: ToolOperations,
): Promise<string[]> {
  const results: string[] = [];
  const relPath = path.relative(cwd, filePath);

  // Skip oversized files — readline buffers entire lines in memory, so a single-line
  // file (minified JS, data blobs) can exceed V8's max string length and crash.
  try {
    const fileStat = await ops.stat(filePath);
    if (fileStat.size > MAX_FILE_SIZE) return results;
  } catch {
    return results;
  }

  const stream = ops.createReadStream(filePath, "utf-8");
  try {
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineNum = 0;
    try {
      for await (const line of rl) {
        lineNum++;

        // Bail out if line contains null bytes (binary file not caught by extension check)
        if (lineNum <= 5 && line.includes("\0")) {
          break;
        }

        // Reset lastIndex for global regex
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // Truncate long lines to prevent massive output from binary/minified files
          const truncatedLine =
            line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "…" : line;
          results.push(`${relPath}:${lineNum}:${truncatedLine}`);
          if (results.length >= maxResults) {
            break;
          }
        }
      }
    } finally {
      rl.close();
    }
  } catch {
    // Skip unreadable files
  } finally {
    stream.destroy();
  }

  return results;
}

function formatResults(results: string[], maxResults: number, candidateLimitHit = false): string {
  if (results.length === 0) {
    return candidateLimitHit
      ? `No matches found. [Stopped after scanning ${MAX_CANDIDATE_FILES} candidate files]`
      : "No matches found.";
  }

  let output = results.join("\n");
  if (results.length >= maxResults) {
    output += `\n\n[Truncated at ${maxResults} matches]`;
  } else {
    output += `\n\n${results.length} match(es) found`;
  }
  if (candidateLimitHit) {
    output += `\n[Stopped after scanning ${MAX_CANDIDATE_FILES} candidate files]`;
  }
  return output;
}
