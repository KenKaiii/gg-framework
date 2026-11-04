import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { resolvePath } from "./path-utils.js";
import { localOperations, type ToolOperations } from "./operations.js";

const LsParams = z.object({
  path: z.string().optional(),
  all: z.boolean().optional().describe("Include hidden files"),
});

export function createLsTool(
  cwd: string,
  ops: ToolOperations = localOperations,
): AgentTool<typeof LsParams> {
  return {
    name: "ls",
    description: "List a directory with types and sizes.",
    parameters: LsParams,
    async execute({ path: dirPath, all }) {
      const resolved = dirPath ? resolvePath(cwd, dirPath) : cwd;
      const entries = await ops.readdir(resolved, { withFileTypes: true });

      // Filter hidden files unless --all
      const filtered = all ? entries : entries.filter((e) => !e.name.startsWith("."));

      // Separate dirs and files, then sort each alphabetically
      const dirs = filtered
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = filtered
        .filter((e) => !e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));

      const lines: string[] = [];

      for (const dir of dirs) {
        lines.push(`d  -        ${dir.name}/`);
      }

      // Stat all files in parallel — each stat() is an independent syscall,
      // so batching them avoids serial I/O latency on large directories.
      const fileLines = await Promise.all(
        files.map(async (file) => {
          try {
            const stat = await ops.stat(path.join(resolved, file.name));
            const size = formatSize(stat.size);
            const type = file.isSymbolicLink() ? "l" : "f";
            return `${type}  ${size.padStart(8)}  ${file.name}`;
          } catch {
            return `?  -        ${file.name}`;
          }
        }),
      );
      lines.push(...fileLines);

      if (lines.length === 0) return "Empty directory.";
      return lines.join("\n");
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}
