import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { truncateHead } from "./truncate.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { readImageFile } from "../utils/image.js";
import { log } from "../core/logger.js";

/** Raster image formats the read tool can return as visual content. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
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
  readFiles?: Set<string>,
  ops: ToolOperations = localOperations,
  options?: { supportsImages?: boolean },
): AgentTool<typeof ReadParams> {
  const imageSupport = options?.supportsImages ?? true;
  return {
    name: "read",
    description:
      "Read a file's contents. Returns numbered lines (cat -n style). " +
      "Output is capped at ~25,000 tokens. If truncated, use offset/limit to read remaining sections. " +
      "Image files (.png, .jpg, .gif, .webp, .bmp) return visual content. " +
      "Other binary files return a notice instead of content.",
    parameters: ReadParams,
    async execute({ file_path, offset, limit }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);
      readFiles?.add(resolved);
      const ext = path.extname(resolved).toLowerCase();

      // Return visual content for image files (when the model supports it)
      if (IMAGE_EXTENSIONS.has(ext)) {
        if (!imageSupport) {
          const stat = await ops.stat(resolved);
          log("INFO", "read", `Image skipped (model lacks vision): ${resolved}`);
          return `Image file: ${resolved} (${ext}, ${stat.size} bytes). This model does not support image vision — use bash to extract text or metadata if needed.`;
        }
        const attachment = await readImageFile(resolved);
        log("INFO", "read", `Image attached: ${resolved}`, {
          mediaType: attachment.mediaType,
          base64Bytes: String(attachment.data.length),
        });
        return {
          content: `Image file: ${resolved} (${attachment.mediaType})`,
          images: [{ mediaType: attachment.mediaType, data: attachment.data }],
        };
      }

      if (BINARY_EXTENSIONS.has(ext)) {
        const stat = await ops.stat(resolved);
        return `Binary file: ${resolved} (${ext}, ${stat.size} bytes)`;
      }

      const raw = await ops.readFile(resolved);
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
        return (
          `${numbered}\n` +
          `[Truncated: showing lines ${offset ?? 1}-${(offset ?? 1) + result.keptLines - 1} of ${result.totalLines}. ` +
          `Use offset=${nextOffset} to read more.]`
        );
      }
      return numbered;
    },
  };
}
