import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type SharpNamespace from "sharp";

/**
 * Lazy `sharp` resolver — sharp is a hefty native module (libvips). Loading
 * it at module init pulls it into every consumer's bundle, which forces
 * downstream packages that don't actually need image manipulation (gg-boss)
 * to either ship it or break their bundlers. By gating the require behind
 * a function called only by the image-handling helpers, we let unused code
 * paths skip the import entirely — which lets gg-boss tsup-bundle cleanly
 * without `sharp` in its dependency tree.
 *
 * Cached after first call so repeated image operations don't re-hit the
 * dynamic import resolver.
 */
type SharpFn = typeof SharpNamespace;
let sharpFn: SharpFn | null = null;
async function loadSharp(): Promise<SharpFn> {
  if (sharpFn) return sharpFn;
  // Sharp publishes as CJS where `module.exports = sharpFunction`. Under
  // ESM dynamic import, that lands on `.default` — but some tooling normalises
  // it onto the namespace object directly. Try `.default` first, fall back
  // to the namespace if not present.
  const mod = (await import("sharp")) as unknown as { default?: SharpFn } & SharpFn;
  sharpFn = mod.default ?? mod;
  return sharpFn;
}

/** Anthropic's maximum image size in bytes (5 MB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max width (px) for inline terminal-graphics previews so scrollback stays small. */
const PREVIEW_MAX_WIDTH = 480;
/** Anthropic's hard per-dimension cap for many-image requests. Exceeding this
 *  in either dimension causes a 400 even if the byte size is fine. */
const MAX_IMAGE_DIMENSION = 2000;

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt"]);
const ATTACHABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS]);

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

// Backwards-compat alias for internal use below
const MEDIA_TYPES = IMAGE_MEDIA_TYPES;

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

/** Map sharp's detected format string to an Anthropic-compatible media type. */
const SHARP_FORMAT_TO_MEDIA: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Downscale an image buffer so it fits within both MAX_IMAGE_DIMENSION per side
 * (Anthropic's hard pixel cap for many-image requests) and MAX_IMAGE_BYTES.
 * Preserves format (PNG→PNG, JPEG→JPEG, etc.) and aspect ratio.
 */
export async function shrinkToFit(
  buffer: Buffer,
  mediaType: string,
): Promise<{ buffer: Buffer; mediaType: string }> {
  const sharp = await loadSharp();
  const meta = await sharp(buffer).metadata();
  const origW = meta.width ?? 4096;
  const origH = meta.height ?? 4096;
  const exceedsDim = origW > MAX_IMAGE_DIMENSION || origH > MAX_IMAGE_DIMENSION;

  // Trust the buffer over the caller-supplied mediaType: if a file was named
  // foo.png but is actually a JPEG, sharp tells the truth and Anthropic
  // rejects mismatched media types with a 400.
  const detected = meta.format ? SHARP_FORMAT_TO_MEDIA[meta.format] : undefined;
  if (detected && detected !== mediaType) {
    mediaType = detected;
  }

  // Short-circuit: within both limits — return as-is.
  if (!exceedsDim && buffer.length <= MAX_IMAGE_BYTES) {
    return { buffer, mediaType };
  }

  // Determine output format from mediaType
  const formatMap: Record<string, keyof SharpNamespace.FormatEnum> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "png", // convert BMP to PNG (sharp doesn't output BMP)
  };
  let outFormat = formatMap[mediaType] ?? "png";
  let outMediaType = mediaType === "image/bmp" ? "image/png" : mediaType;

  // Compute the initial target dimensions: fit within MAX_IMAGE_DIMENSION,
  // preserving aspect ratio. Sharp's fit: "inside" does the same math but we
  // want explicit width/height so we can shrink them further in the byte loop.
  const scale = exceedsDim ? Math.min(MAX_IMAGE_DIMENSION / origW, MAX_IMAGE_DIMENSION / origH) : 1;
  let width = Math.max(1, Math.round(origW * scale));
  let height = Math.max(1, Math.round(origH * scale));

  // Encode at the dimension-capped size first — often this is already under
  // MAX_IMAGE_BYTES and we're done.
  {
    const first = await sharp(buffer)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .toFormat(outFormat)
      .toBuffer();
    if (first.length <= MAX_IMAGE_BYTES) {
      return { buffer: first, mediaType: outMediaType };
    }
  }

  // Still too large — progressively shrink by 25% per step.
  for (let attempt = 0; attempt < 10; attempt++) {
    width = Math.max(1, Math.round(width * 0.75));
    height = Math.max(1, Math.round(height * 0.75));
    if (width < 1 || height < 1) break;

    const result = await sharp(buffer)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .toFormat(outFormat)
      .toBuffer();

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

/**
 * Downscale an image buffer for an inline terminal preview, capping its width
 * at PREVIEW_MAX_WIDTH so previews stay small in scrollback. The full-resolution
 * copy is kept separately for the model. Preserves format and aspect ratio.
 *
 * On any sharp failure the original buffer is returned unchanged — a preview is
 * cosmetic and must never break the turn.
 */
export async function downscaleForPreview(buffer: Buffer): Promise<Buffer> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 0;
    if (width > 0 && width <= PREVIEW_MAX_WIDTH) return buffer;
    return await sharp(buffer)
      .resize(PREVIEW_MAX_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
      .toBuffer();
  } catch {
    return buffer;
  }
}

/**
 * Read a file and return an attachment (base64 for images, raw text for text files).
 *
 * Image decode / shrink failures degrade to a text placeholder instead of throwing,
 * so a corrupt or unsupported image doesn't crash the turn. The caller sees a
 * `kind: "text"` attachment the model can read as `<file>…</file>` context.
 */
export async function readImageFile(filePath: string): Promise<ImageAttachment> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return { kind: "text", fileName, filePath, mediaType: "text/plain", data: content };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: "text",
        fileName,
        filePath,
        mediaType: "text/plain",
        data: `[file ${fileName} could not be read: ${reason}]`,
      };
    }
  }

  try {
    const mediaType = MEDIA_TYPES[ext] ?? "image/png";
    const rawBuffer = await fs.readFile(filePath);
    const { buffer, mediaType: finalMediaType } = await shrinkToFit(rawBuffer, mediaType);
    return {
      kind: "image",
      fileName,
      filePath,
      mediaType: finalMediaType,
      data: buffer.toString("base64"),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "text",
      fileName,
      filePath,
      mediaType: "text/plain",
      data: `[image ${fileName} could not be loaded: ${reason}]`,
    };
  }
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
