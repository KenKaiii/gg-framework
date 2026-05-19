import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { assertFresh, recordWrite, type ReadTracker } from "./read-tracker.js";

const WriteParams = z.object({
  file_path: z.string().describe("The file path to write to"),
  content: z.string().describe("The content to write"),
});

export function createWriteTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  onFileMutated?: (filePath: string) => void | Promise<void>,
): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    description:
      "Write content to a file. Creates parent directories if needed. " +
      "Existing files must be read first before overwriting. Use for new files or complete rewrites.",
    parameters: WriteParams,
    executionMode: "sequential",
    async execute({ file_path, content }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      // In plan mode, only allow writing to .gg/plans/
      if (planModeRef?.current) {
        const plansDir = path.join(cwd, ".gg", "plans");
        if (!resolved.startsWith(plansDir)) {
          return (
            "Error: write is restricted in plan mode. You can only write to .gg/plans/. Got: " +
            file_path
          );
        }
        // Ensure .gg/plans/ directory exists
        await fs.mkdir(plansDir, { recursive: true });
      }

      // Block overwriting existing files that haven't been read, or that
      // changed since the last read.
      if (readFiles) {
        const exists = await ops.stat(resolved).then(
          () => true,
          () => false,
        );
        if (exists) {
          await assertFresh(readFiles, resolved, ops);
        }
      }
      await ops.writeFile(resolved, content);
      await recordWrite(readFiles, resolved, content, ops);
      await onFileMutated?.(resolved);
      const lines = content.split("\n").length;
      return `Wrote ${lines} lines to ${resolved}`;
    },
  };
}
