import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { truncateHead } from "./truncate.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { recordRead, type ReadTracker } from "./read-tracker.js";
import { IMAGE_EXTENSIONS, IMAGE_MEDIA_TYPES, shrinkToFit } from "../utils/image.js";

export const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".svg",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".flac",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pyc",
  ".class",
  ".o",
  ".obj",
  ".asar",
  ".node",
  ".wasm",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".snap",
  ".pack",
  ".idx",
]);

const ReadParams = z.object({
  file_path: z.string().describe("The file path to read"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-based)"),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
});

export function createReadTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  onFileRead?: (filePath: string) => void | Promise<void>,
): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    description:
      "Read a file's contents. Returns numbered lines (cat -n style). " +
      "Output is truncated to 2000 lines or 50KB (whichever is hit first). " +
      "If truncated, use offset/limit to read remaining sections. " +
      "Binary files return a notice instead of content.",
    parameters: ReadParams,
    async execute({ file_path, offset, limit }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);
      const ext = path.extname(resolved).toLowerCase();

      // Image: read as binary, shrink to fit provider limits, return as
      // structured content so the model can actually see the pixels.
      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const rawBuffer = await fs.readFile(resolved);
          const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "image/png";
          const { buffer, mediaType: finalMediaType } = await shrinkToFit(rawBuffer, mediaType);
          const resizedNote =
            buffer.length < rawBuffer.length
              ? ` (resized from ${rawBuffer.length} to ${buffer.length} bytes)`
              : "";
          return {
            content: [
              {
                type: "text",
                text: `Read image file ${resolved} [${finalMediaType}]${resizedNote}`,
              },
              { type: "image", mediaType: finalMediaType, data: buffer.toString("base64") },
            ],
          };
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return `File not found: ${resolved}`;
          if (code === "EACCES") return `Permission denied: ${resolved}`;
          const reason = err instanceof Error ? err.message : String(err);
          return `Could not read image ${resolved}: ${reason}`;
        }
      }

      if (BINARY_EXTENSIONS.has(ext)) {
        const stat = await ops.stat(resolved);
        return `Binary file: ${resolved} (${ext}, ${stat.size} bytes)`;
      }

      let raw: string;
      try {
        raw = await ops.readFile(resolved);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return `File not found: ${resolved}`;
        if (code === "EACCES") return `Permission denied: ${resolved}`;
        if (code === "EISDIR") return `Is a directory, not a file: ${resolved}`;
        throw err;
      }
      const stat = await ops.stat(resolved);
      recordRead(readFiles, resolved, raw, stat.mtimeMs);
      await onFileRead?.(resolved);
      let lines = raw.split("\n");

      // Apply offset/limit
      const startLine = offset ? offset - 1 : 0;
      const endLine = limit ? startLine + limit : lines.length;
      lines = lines.slice(startLine, endLine);

      const content = lines.join("\n");
      const result = truncateHead(content);

      // Prepend line numbers (cat -n style)
      const actualStart = startLine + 1;
      const numbered = result.content
        .split("\n")
        .map((line, i) => {
          const lineNum = String(actualStart + i).padStart(6, " ");
          return `${lineNum}\t${line}`;
        })
        .join("\n");

      if (result.truncated) {
        const nextOffset = (offset ?? 1) + result.keptLines;
        const overflowPath = await writeOverflow(content, "read").catch(() => null);
        const overflowNotice = overflowPath ? ` Full output saved to ${overflowPath}.` : "";
        return (
          `${numbered}\n` +
          `[Truncated: showing lines ${offset ?? 1}-${(offset ?? 1) + result.keptLines - 1} of ${result.totalLines}.${overflowNotice} ` +
          `Use offset=${nextOffset} to read more.]`
        );
      }
      return numbered;
    },
  };
}
