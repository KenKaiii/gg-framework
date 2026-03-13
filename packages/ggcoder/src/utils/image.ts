import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import sharp from "sharp";

/** Anthropic's maximum image size in bytes (5 MB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt"]);
const ATTACHABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS]);

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export interface ImageAttachment {
  kind: "image" | "text";
  fileName: string;
  filePath: string;
  mediaType: string;
  data: string; // base64 for images, raw text for text files
}

/** Check if a file path points to an image based on extension. */
export function isImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Check if a file path points to an attachable file (image or text). */
export function isAttachablePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ATTACHABLE_EXTENSIONS.has(ext);
}

function resolvePath(filePath: string, cwd: string): string {
  let resolved = filePath.trim();
  // Strip surrounding quotes
  if (
    (resolved.startsWith("'") && resolved.endsWith("'")) ||
    (resolved.startsWith('"') && resolved.endsWith('"'))
  ) {
    resolved = resolved.slice(1, -1);
  }
  // Strip file:// prefix
  if (resolved.startsWith("file://")) {
    resolved = resolved.slice(7);
  }
  // Unescape backslash-escaped characters (e.g. "\ " → " ")
  resolved = resolved.replace(/\\(.)/g, "$1");
  // Resolve home dir
  if (resolved.startsWith("~/")) {
    resolved = path.join(process.env.HOME ?? "/", resolved.slice(2));
  } else if (!path.isAbsolute(resolved)) {
    resolved = path.join(cwd, resolved);
  }
  return resolved;
}

/**
 * Check if a token looks like an intentional file path rather than a bare filename
 * mentioned in conversation. Bare names like "claude.md" should not be auto-attached;
 * only explicit paths like "./claude.md", "/tmp/file.md", "~/notes.md", etc.
 */
function looksLikePath(token: string): boolean {
  const stripped = token.replace(/^['"]|['"]$/g, "");
  return (
    stripped.includes("/") ||
    stripped.includes("\\") ||
    stripped.startsWith("~") ||
    stripped.startsWith("file://")
  );
}

/**
 * Extract attachable file paths from input text by checking if tokens resolve
 * to existing files on disk. Returns verified paths and the remaining text.
 *
 * Only tokens that look like explicit paths (contain `/`, `~`, `\`, or `file://`)
 * are considered. Bare filenames like "readme.md" are left as text.
 */
export async function extractImagePaths(
  text: string,
  cwd: string,
): Promise<{ imagePaths: string[]; cleanText: string }> {
  const imagePaths: string[] = [];
  const cleanParts: string[] = [];

  // Try the entire input as a single path first (only if it looks like a path)
  if (looksLikePath(text)) {
    const wholePath = resolvePath(text, cwd);
    if (isAttachablePath(wholePath) && (await fileExists(wholePath))) {
      return { imagePaths: [wholePath], cleanText: "" };
    }
  }

  // Split on unescaped whitespace (respect backslash-escaped spaces like "file\ name.png")
  const tokens = text.match(/(?:[^\s\\]|\\.)+/g) ?? [];
  for (const token of tokens) {
    if (!token) continue;
    if (looksLikePath(token)) {
      const resolved = resolvePath(token, cwd);
      if (isAttachablePath(resolved) && (await fileExists(resolved))) {
        imagePaths.push(resolved);
        continue;
      }
    }
    cleanParts.push(token);
  }

  return { imagePaths, cleanText: cleanParts.join(" ") };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Downscale an image buffer so it fits within MAX_IMAGE_BYTES.
 * Preserves format (PNG→PNG, JPEG→JPEG, etc.) and aspect ratio.
 * Progressively reduces dimensions by 25% until under the limit.
 */
async function shrinkToFit(
  buffer: Buffer,
  mediaType: string,
): Promise<{ buffer: Buffer; mediaType: string }> {
  if (buffer.length <= MAX_IMAGE_BYTES) return { buffer, mediaType };

  let img = sharp(buffer);
  const meta = await img.metadata();
  let width = meta.width ?? 4096;
  let height = meta.height ?? 4096;

  // Determine output format from mediaType
  const formatMap: Record<string, keyof sharp.FormatEnum> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "png", // convert BMP to PNG (sharp doesn't output BMP)
  };
  let outFormat = formatMap[mediaType] ?? "png";
  let outMediaType = mediaType === "image/bmp" ? "image/png" : mediaType;

  // Try progressively smaller sizes (75% each step)
  for (let attempt = 0; attempt < 10; attempt++) {
    width = Math.round(width * 0.75);
    height = Math.round(height * 0.75);
    if (width < 1 || height < 1) break;

    img = sharp(buffer).resize(width, height, { fit: "inside", withoutEnlargement: true });
    const result = await img.toFormat(outFormat).toBuffer();

    if (result.length <= MAX_IMAGE_BYTES) {
      return { buffer: result, mediaType: outMediaType };
    }

    // If PNG is still too big after 3 attempts, switch to JPEG for better compression
    if (attempt === 2 && outFormat === "png") {
      outFormat = "jpeg";
      outMediaType = "image/jpeg";
    }
  }

  // Last resort: aggressive JPEG compression at small size
  const result = await sharp(buffer)
    .resize(Math.round(width * 0.5), Math.round(height * 0.5), {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 60 })
    .toBuffer();
  return { buffer: result, mediaType: "image/jpeg" };
}

/** Read a file and return an attachment (base64 for images, raw text for text files). */
export async function readImageFile(filePath: string): Promise<ImageAttachment> {
  const ext = path.extname(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      kind: "text",
      fileName: path.basename(filePath),
      filePath,
      mediaType: "text/plain",
      data: content,
    };
  }

  let mediaType = MEDIA_TYPES[ext] ?? "image/png";
  const rawBuffer = await fs.readFile(filePath);

  const { buffer, mediaType: finalMediaType } = await shrinkToFit(rawBuffer, mediaType);
  mediaType = finalMediaType;

  const data = buffer.toString("base64");
  return {
    kind: "image",
    fileName: path.basename(filePath),
    filePath,
    mediaType,
    data,
  };
}

/**
 * Try to read image data from the system clipboard (macOS only).
 * Returns null if no image is on the clipboard.
 */
export function getClipboardImage(): Promise<ImageAttachment | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);

  return new Promise((resolve) => {
    // Check if clipboard has image data
    execFile("osascript", ["-e", "clipboard info"], (err, stdout) => {
      if (err || (!stdout.includes("PNGf") && !stdout.includes("TIFF"))) {
        resolve(null);
        return;
      }

      // Determine format — prefer PNG
      const isPng = stdout.includes("PNGf");
      const clipClass = isPng ? "PNGf" : "TIFF";
      const ext = isPng ? "png" : "tiff";
      const mediaType = isPng ? "image/png" : "image/tiff";

      // Write clipboard image to temp file, then read as base64
      const tmpPath = `/tmp/ggcoder-clipboard-${Date.now()}.${ext}`;
      const writeScript = [
        `set imgData to the clipboard as «class ${clipClass}»`,
        `set filePath to POSIX file "${tmpPath}"`,
        `set fileRef to open for access filePath with write permission`,
        `write imgData to fileRef`,
        `close access fileRef`,
      ].join("\n");

      execFile("osascript", ["-e", writeScript], async (writeErr) => {
        if (writeErr) {
          resolve(null);
          return;
        }
        try {
          const rawBuffer = await fs.readFile(tmpPath);
          await fs.unlink(tmpPath).catch(() => {});
          const { buffer: finalBuffer, mediaType: finalMediaType } = await shrinkToFit(
            rawBuffer,
            mediaType,
          );
          resolve({
            kind: "image",
            fileName: `clipboard.${ext}`,
            filePath: tmpPath,
            mediaType: finalMediaType,
            data: finalBuffer.toString("base64"),
          });
        } catch {
          resolve(null);
        }
      });
    });
  });
}
