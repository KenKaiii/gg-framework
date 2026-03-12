import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";

const WriteParams = z.object({
  file_path: z.string().describe("The file path to write to"),
  content: z.string().describe("The content to write"),
});

export function createWriteTool(
  cwd: string,
  readFiles?: Set<string>,
): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    description:
      "Write content to a file. Creates parent directories if needed. " +
      "Existing files must be read first before overwriting. Use for new files or complete rewrites.",
    parameters: WriteParams,
    async execute({ file_path, content }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      // Block overwriting existing files that haven't been read
      if (readFiles && !readFiles.has(resolved)) {
        const exists = await fs.stat(resolved).then(
          () => true,
          () => false,
        );
        if (exists) {
          throw new Error("File must be read first before overwriting. Use the read tool first.");
        }
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      return `Wrote ${bytes} bytes to ${resolved}`;
    },
  };
}
