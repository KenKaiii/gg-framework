import fs from "node:fs/promises";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { BINARY_EXTENSIONS } from "./read.js";

const GrepParams = z.object({
  pattern: z.string().describe("Search pattern (regex supported)"),
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

export function createGrepTool(cwd: string): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    description:
      "Search file contents using regex. Returns filepath:line_number:content for matches. " +
      "Respects .gitignore. Skips binary files.",
    parameters: GrepParams,
    async execute({ pattern, path: searchPath, include, max_results, case_insensitive }) {
      const dir = searchPath ? resolvePath(cwd, searchPath) : cwd;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const flags = case_insensitive ? "gi" : "g";

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags);
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`, { cause: err });
      }

      // Check if dir is a file
      const stat = await fs.stat(dir);
      if (stat.isFile()) {
        const results = await searchFile(dir, regex, cwd, maxResults);
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
      });

      const results: string[] = [];
      for (const entry of entries) {
        if (results.length >= maxResults) break;

        const ext = path.extname(entry).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const filePath = path.join(dir, entry);
        const fileResults = await searchFile(filePath, regex, cwd, maxResults - results.length);
        results.push(...fileResults);
      }

      return formatResults(results, maxResults);
    },
  };
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  cwd: string,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];
  const relPath = path.relative(cwd, filePath);

  const stream = createReadStream(filePath, { encoding: "utf-8" });
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

function formatResults(results: string[], maxResults: number): string {
  if (results.length === 0) return "No matches found.";

  let output = results.join("\n");
  if (results.length >= maxResults) {
    output += `\n\n[Truncated at ${maxResults} matches]`;
  } else {
    output += `\n\n${results.length} match(es) found`;
  }
  return output;
}
