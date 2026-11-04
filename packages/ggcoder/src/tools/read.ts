import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { truncateHead, describeOmitted } from "./truncate.js";
import { writeOverflow } from "./overflow.js";
import {
  FileTooLargeError,
  NotRegularFileError,
  SymlinkRefusedError,
  localOperations,
  readFileBounded,
  type ToolOperations,
} from "./operations.js";
import { countLines, recordRead, type ReadTracker } from "./read-tracker.js";
import { lineHash } from "../core/hashline.js";
import {
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  VIDEO_EXTENSIONS,
  VIDEO_MEDIA_TYPES,
  compressVideoToFit,
  downscaleForPreview,
  shrinkToFit,
} from "../utils/image.js";

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

// Models sometimes pass a line range such as "[98, 242]" as `offset`. Zod's
// default "expected number, received string" did not teach Haiku the right
// shape: it repeated the range until three identical invalid calls stopped the
// whole run. Name the fix. A schema-level `error` also covers `.int()`/`.min()`,
// so each message must hold for every way the field can be wrong.
const ReadParams = z.object({
  file_path: z.string().describe("The file path to read"),
  offset: z
    .number({
      error:
        "offset must be ONE line number (an integer >= 1), not a range or string. " +
        "To read lines 98-242, pass offset: 98 and limit: 145.",
    })
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-based)"),
  limit: z
    .number({ error: "limit must be ONE line count (an integer >= 1), not a range or string." })
    .int()
    .min(1)
    .optional()
    .describe("Maximum number of lines to read"),
  anchors: z
    .boolean()
    .optional()
    .describe(
      "Prefix each line with a stable `hash│` content anchor so a later `edit` can target lines " +
        "by anchor and reject stale edits. Default false.",
    ),
});

/**
 * Turn a refused bounded read into a message the model can act on.
 *
 * Both cases are dead ends for `read`, so the text names the tool that still
 * works — otherwise the agent retries `read` with an offset and burns turns on
 * a file it can never load.
 */
function describeBoundedReadError(err: unknown): string | null {
  if (err instanceof FileTooLargeError) {
    return (
      `${err.message}. Use \`grep\` to search it, or \`bash\` with ` +
      `\`sed -n '1,200p'\` / \`tail\` to view part of it.`
    );
  }
  if (err instanceof NotRegularFileError) {
    return `${err.message}. Reading it could block forever; use \`bash\` if you really need its stream.`;
  }
  if (err instanceof SymlinkRefusedError) {
    return `${err.message}. Read the file it points at directly, if that path is one you should be reading.`;
  }
  return null;
}

export function createReadTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  onFileRead?: (filePath: string) => void | Promise<void>,
  /** Max video payload (bytes) the active model accepts, or `undefined` for
   *  models without video support. When set, video files are returned as a
   *  native `video` content part (compressed to fit this cap); when undefined
   *  they fall through to the generic binary-file notice. */
  videoByteLimit?: number,
): AgentTool<typeof ReadParams> {
  const returnVideoNatively = videoByteLimit !== undefined;
  return {
    name: "read",
    description:
      "Read a file's contents. Returns numbered lines (cat -n style). " +
      "Output is truncated to 2000 lines or 50KB (whichever is hit first). " +
      "If truncated, use offset/limit to read remaining sections. " +
      "Reads images natively. " +
      (returnVideoNatively
        ? "Reads video files natively too — you CAN watch and analyze a video by " +
          "calling read on its path (.mp4/.mov/.webm/.mkv/.avi); large clips are " +
          "auto-compressed for you. When a user attaches a video, read it; never " +
          "claim you cannot watch video. "
        : "") +
      "Other binary files return a notice instead of content.",
    parameters: ReadParams,
    async execute({ file_path, offset, limit, anchors }, context) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);
      const ext = path.extname(resolved).toLowerCase();

      // Image: read as binary, shrink to fit provider limits, return as
      // structured content so the model can actually see the pixels.
      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          // Bounded + opened once: an unbounded read here OOM-kills the shared
          // daemon (every window's session with it) on a huge or non-regular
          // file wearing an image extension.
          const rawBuffer = await readFileBounded(resolved);
          const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "image/png";
          const { buffer, mediaType: finalMediaType } = await shrinkToFit(rawBuffer, mediaType);
          const resizedNote =
            buffer.length < rawBuffer.length
              ? ` (resized from ${rawBuffer.length} to ${buffer.length} bytes)`
              : "";
          // Smaller copy for the inline terminal preview (kitty/iTerm2). Kept
          // separate from the full-res copy the model sees. Cosmetic — a
          // preview failure must never break the read.
          const previewBuffer = await downscaleForPreview(buffer);
          return {
            content: [
              {
                type: "text",
                text: `Read image file ${resolved} [${finalMediaType}]${resizedNote}`,
              },
              { type: "image", mediaType: finalMediaType, data: buffer.toString("base64") },
            ],
            details: {
              imagePreviews: [
                {
                  base64: previewBuffer.toString("base64"),
                  mediaType: finalMediaType,
                  path: resolved,
                },
              ],
            },
          };
        } catch (err: unknown) {
          const bounded = describeBoundedReadError(err);
          if (bounded) return bounded;
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return `File not found: ${resolved}`;
          if (code === "EACCES") return `Permission denied: ${resolved}`;
          const reason = err instanceof Error ? err.message : String(err);
          return `Could not read image ${resolved}: ${reason}`;
        }
      }

      // Video: when the active model can watch video natively, return the clip
      // as a `video` content part. Each provider's transport delivers it (Kimi
      // uploads + references; Gemini inlineData; MiniMax base64). Otherwise fall
      // through to the binary notice. The byte cap is per-model (videoByteLimit).
      if (returnVideoNatively && videoByteLimit !== undefined && VIDEO_EXTENSIONS.has(ext)) {
        let compressedPath: string | undefined;
        try {
          // Clips over the model's cap can't be sent directly (and reading multi-GB
          // into base64 would OOM). Auto-compress down to fit: downscale + drop
          // fps/bitrate, which keeps the video analyzable. If ffmpeg is missing or
          // it's still too large, surface a clear message steering to ffmpeg.
          const limitMb = Math.round(videoByteLimit / (1024 * 1024));
          const stat = await ops.stat(resolved);
          let videoPath = resolved;
          let note = "";
          if (stat.size > videoByteLimit) {
            const result = await compressVideoToFit(resolved, videoByteLimit, context?.signal);
            if (!result.ok) {
              const mb = (stat.size / (1024 * 1024)).toFixed(1);
              return (
                `Video ${resolved} is ${mb} MB, over the ${limitMb} MB ` +
                `limit for native analysis, and auto-compression failed (${result.reason}). ` +
                `Use ffmpeg to downscale it (lower resolution/fps) under that size, then read the result.`
              );
            }
            compressedPath = result.path;
            videoPath = result.path;
            note =
              ` (auto-compressed from ${(result.originalBytes / (1024 * 1024)).toFixed(0)} MB to ` +
              `${(result.compressedBytes / (1024 * 1024)).toFixed(0)} MB for analysis)`;
          }
          const rawBuffer = await readFileBounded(videoPath, videoByteLimit);
          const mediaType = VIDEO_MEDIA_TYPES[ext] ?? "video/mp4";
          return {
            content: [
              { type: "text", text: `Read video file ${resolved} [${mediaType}]${note}` },
              { type: "video", mediaType, data: rawBuffer.toString("base64") },
            ],
          };
        } catch (err: unknown) {
          const bounded = describeBoundedReadError(err);
          if (bounded) return bounded;
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return `File not found: ${resolved}`;
          if (code === "EACCES") return `Permission denied: ${resolved}`;
          const reason = err instanceof Error ? err.message : String(err);
          return `Could not read video ${resolved}: ${reason}`;
        } finally {
          // The compressed copy is now in base64 in the result; drop the temp file.
          if (compressedPath) await fs.unlink(compressedPath).catch(() => {});
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
        const bounded = describeBoundedReadError(err);
        if (bounded) return bounded;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return `File not found: ${resolved}`;
        if (code === "EACCES") return `Permission denied: ${resolved}`;
        if (code === "EISDIR") return `Is a directory, not a file: ${resolved}`;
        throw err;
      }
      const stat = await ops.stat(resolved);
      let lines = raw.split("\n");

      // Apply offset/limit
      const startLine = offset ? offset - 1 : 0;
      const endLine = limit ? startLine + limit : lines.length;
      lines = lines.slice(startLine, endLine);

      const content = lines.join("\n");
      const result = truncateHead(content);
      // A line longer than the byte cap can never be shown, and truncateHead
      // keeps nothing when it opens the window. Name it and point past it,
      // counting it as seen: otherwise a full-file write could never proceed.
      if (result.truncated && result.keptLines === 0) {
        const lineNo = startLine + 1;
        const bytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
        recordRead(readFiles, resolved, raw, stat.mtimeMs, [lineNo, lineNo]);
        await onFileRead?.(resolved);
        const next =
          lineNo < countLines(raw)
            ? `Use offset=${lineNo + 1} to read the rest, or bash`
            : "Use bash";
        return `[Line ${lineNo} is too long to show (${bytes} bytes). ${next} (e.g. cut -c1-2000) to inspect it.]`;
      }
      // Record exactly which lines the model is shown: a full-file write is only
      // allowed once it has seen every line (see assertFullySeen).
      recordRead(readFiles, resolved, raw, stat.mtimeMs, [
        startLine + 1,
        startLine + result.keptLines,
      ]);
      await onFileRead?.(resolved);

      // Prepend line numbers (cat -n style). With `anchors`, also prefix each
      // line with a `hash│` content anchor. The hash is computed from the REAL
      // file line content and its REAL 0-based file index (startLine + i) so it
      // matches exactly what edit's anchor guard verifies against the file bytes
      // — anchors are display-only and never touch the tracked content.
      const actualStart = startLine + 1;
      const numbered = result.content
        .split("\n")
        .map((line, i) => {
          const lineNum = String(actualStart + i).padStart(6, " ");
          const numberedLine = `${lineNum}\t${line}`;
          return anchors ? `${lineHash(line, startLine + i)}│${numberedLine}` : numberedLine;
        })
        .join("\n");

      if (result.truncated) {
        const nextOffset = (offset ?? 1) + result.keptLines;
        const overflowPath = await writeOverflow(content, "read").catch(() => null);
        const overflowNotice = overflowPath ? ` Full output saved to ${overflowPath}.` : "";
        const what = describeOmitted(lines.slice(result.keptLines), result.content);
        return (
          `${numbered}\n` +
          `[Truncated: showing lines ${offset ?? 1}-${(offset ?? 1) + result.keptLines - 1} of ${result.totalLines}.${what ? ` ${what}` : ""}${overflowNotice} ` +
          `Use offset=${nextOffset} to read more.]`
        );
      }
      return numbered;
    },
  };
}
