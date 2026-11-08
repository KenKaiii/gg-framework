import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type sharp from "sharp";
import type { FormatEnum } from "sharp";

const execFileAsync = promisify(execFile);

/**
 * Lazy `sharp` resolver — sharp is a hefty native module (libvips). Loading
 * it at module init pulls it into every consumer's bundle, which forces
 * downstream packages that don't actually need image manipulation (@kleio/manager)
 * to either ship it or break their bundlers. By gating the require behind
 * a function called only by the image-handling helpers, we let unused code
 * paths skip the import entirely — which lets @kleio/manager tsup-bundle cleanly
 * without `sharp` in its dependency tree.
 *
 * Cached after first call so repeated image operations don't re-hit the
 * dynamic import resolver.
 */
type SharpFn = typeof sharp;
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
/**
 * Visual token budget — vision encoders tile an image into fixed-size patches
 * and charge per patch, so pixels beyond the budget are re-scaled away by the
 * provider *after* we paid to upload them. Bounding here instead means fewer
 * bytes on the wire and fewer image tokens billed, with no loss of detail the
 * model would have seen anyway.
 *
 * `VISUAL_PATCH_PX` is the encoder's patch edge; `VISUAL_MAX_PATCHES` the patch
 * budget; `VISUAL_MAX_EDGE` the hard per-side cap (a 3000x400 panorama is well
 * inside the patch budget but still gets downscaled on the long edge).
 */
const VISUAL_PATCH_PX = 28;
const VISUAL_MAX_PATCHES = 1568;
const VISUAL_MAX_EDGE = 1568;

/**
 * Does a `width x height` image fit the visual token budget — both per-side
 * cap and total patch count?
 *
 * Patch count is measured as continuous area (`w*h / patch^2`) rather than
 * `ceil(w/patch) * ceil(h/patch)`: the encoder resizes to a patch-aligned grid
 * before tiling, so area is what actually determines the token cost.
 */
export function fitsVisualBudget(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return true;
  if (width > VISUAL_MAX_EDGE || height > VISUAL_MAX_EDGE) return false;
  return (width * height) / (VISUAL_PATCH_PX * VISUAL_PATCH_PX) <= VISUAL_MAX_PATCHES;
}

/**
 * Largest aspect-preserving size that still satisfies {@link fitsVisualBudget}.
 * Returns the input untouched when it already fits (so ordinary screenshots are
 * never re-encoded).
 *
 * Binary-searches the long edge because the short edge is rounded to whole
 * pixels — the closed-form area scale can overshoot the budget by a patch or
 * two once that rounding is applied.
 */
export function boundedSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { width, height };
  }
  if (fitsVisualBudget(width, height)) return { width, height };

  const landscape = width >= height;
  const longEdge = landscape ? width : height;
  const shortEdge = landscape ? height : width;
  const ratio = shortEdge / longEdge;
  const project = (edge: number): { width: number; height: number } => {
    const long = Math.max(1, Math.round(edge));
    const short = Math.max(1, Math.round(long * ratio));
    return landscape ? { width: long, height: short } : { width: short, height: long };
  };

  let lo = 1;
  let hi = Math.floor(Math.min(longEdge, VISUAL_MAX_EDGE));
  let best = project(1);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = project(mid);
    if (fitsVisualBudget(candidate.width, candidate.height)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt"]);
const ATTACHABLE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...TEXT_EXTENSIONS,
]);

/** Max video size loaded into base64 at attach time (50 MB). Video is routed by
 *  file path, so the bytes are only kept as a fallback for path-less clipboard
 *  clips; larger clips keep `data` empty and rely on the path. Per-model upload
 *  caps live in the model registry (`maxVideoBytes`) and drive compression. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// ── Video compression (fit oversized clips under a per-model cap) ─────────

/** Compression target — 90 MB leaves headroom under the 100 MB upload cap for
 *  container overhead and bitrate overshoot. */
const COMPRESS_TARGET_BYTES = 90 * 1024 * 1024;
const COMPRESS_MAX_WIDTH = 1280; // cap long edge; preserves aspect (height auto)
const COMPRESS_FPS = 5; // plenty for content understanding; shrinks size hard
const COMPRESS_AUDIO_KBPS = 64; // keep speech intelligible
const COMPRESS_MIN_VIDEO_KBPS = 100; // floor so very long clips stay decodable

export type VideoCompressionResult =
  | { ok: true; path: string; originalBytes: number; compressedBytes: number }
  | { ok: false; reason: string };

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Transcode an oversized video down to fit under {@link COMPRESS_TARGET_BYTES}
 * using ffmpeg: downscale to {@link COMPRESS_MAX_WIDTH}px wide, drop to
 * {@link COMPRESS_FPS} fps, and target a bitrate computed from the clip's
 * duration. Video understanding samples frames, so aggressive downsampling
 * keeps the content analyzable while shrinking multi-GB clips to <100 MB.
 *
 * Writes to a temp file and returns its path; the caller owns deleting it.
 * Best-effort: returns `{ ok: false, reason }` if ffmpeg/ffprobe are missing,
 * the probe fails, or the result still exceeds the target.
 */
export async function compressVideoToFit(
  inputPath: string,
  targetBytes: number = COMPRESS_TARGET_BYTES,
  signal?: AbortSignal,
): Promise<VideoCompressionResult> {
  // Probe duration to compute a size-targeted bitrate.
  let durationSec: number;
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inputPath],
      { signal },
    );
    durationSec = Number.parseFloat(stdout.trim());
  } catch (err) {
    return {
      ok: false,
      reason: isMissingBinary(err)
        ? "ffmpeg/ffprobe is not installed"
        : `could not probe video: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, reason: "could not determine video duration" };
  }

  // total kbps budget = target bits / duration, with 90% safety margin; the
  // audio track gets a fixed slice, the rest goes to video (floored).
  const totalKbps = Math.floor(((targetBytes * 8) / durationSec / 1000) * 0.9);
  const videoKbps = Math.max(COMPRESS_MIN_VIDEO_KBPS, totalKbps - COMPRESS_AUDIO_KBPS);
  const outPath = path.join(os.tmpdir(), `ggcoder-compressed-${Date.now()}.mp4`);

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-nostats",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vf",
        `scale='min(${COMPRESS_MAX_WIDTH},iw)':-2,fps=${COMPRESS_FPS}`,
        "-c:v",
        "libx264",
        "-b:v",
        `${videoKbps}k`,
        "-maxrate",
        `${Math.floor(videoKbps * 1.5)}k`,
        "-bufsize",
        `${videoKbps}k`,
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-b:a",
        `${COMPRESS_AUDIO_KBPS}k`,
        outPath,
      ],
      { signal, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    await fs.unlink(outPath).catch(() => {});
    return {
      ok: false,
      reason: isMissingBinary(err)
        ? "ffmpeg is not installed"
        : `ffmpeg compression failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let compressedBytes: number;
  let originalBytes: number;
  try {
    compressedBytes = (await fs.stat(outPath)).size;
    originalBytes = (await fs.stat(inputPath)).size;
  } catch {
    await fs.unlink(outPath).catch(() => {});
    return { ok: false, reason: "compression produced no usable output" };
  }
  if (compressedBytes > targetBytes) {
    await fs.unlink(outPath).catch(() => {});
    return {
      ok: false,
      reason: `compressed video is still ${(compressedBytes / (1024 * 1024)).toFixed(0)} MB`,
    };
  }
  return { ok: true, path: outPath, originalBytes, compressedBytes };
}

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export const VIDEO_MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

// Backwards-compat alias for internal use below
const MEDIA_TYPES = IMAGE_MEDIA_TYPES;

export interface ImageAttachment {
  kind: "image" | "video" | "text";
  fileName: string;
  filePath: string;
  mediaType: string;
  data: string; // base64 for images/video, raw text for text files
}

/** Check if a file path points to an image based on extension. */
export function isImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Check if a file path points to a video based on extension. */
export function isVideoPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
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

/** Alias of {@link extractImagePaths} that also picks up video paths (video
 *  extensions are part of ATTACHABLE_EXTENSIONS). Name reflects the widened scope. */
export const extractMediaPaths = extractImagePaths;

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

/** Media types the Anthropic + OpenAI vision APIs actually accept as image
 *  blocks. Anything else (.ico, .bmp, .svg, .tiff, …) must NOT be sent as an
 *  image or the provider rejects the whole request. */
const VISION_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Validate that a base64-decoded buffer is a REAL, fully-decodable image in a
 * format the vision APIs accept. Returns the corrected media type on success,
 * or `null` when the data is corrupt or an unsupported format.
 *
 * Why this exists: an image content block with corrupt or unsupported bytes
 * (e.g. a malformed `.ico`, or a `.png` with a bad IDAT/CRC) makes the provider
 * reject the ENTIRE turn with "The image data you provided does not represent a
 * valid image" — the agent never gets to respond. Callers use the `null` return
 * to downgrade such an attachment to a plain file note (saved to disk, inspected
 * with tools) so the request still succeeds and the model can diagnose the file.
 *
 * The header sniff alone is insufficient (a corrupt PNG still has PNG magic), so
 * this forces a full pixel decode — resized small to bound memory — which makes
 * libvips surface mid-stream corruption here instead of at the provider.
 */
export async function validateVisionImage(buffer: Buffer): Promise<string | null> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    const mediaType = meta.format ? SHARP_FORMAT_TO_MEDIA[meta.format] : undefined;
    if (!mediaType || !VISION_MEDIA_TYPES.has(mediaType)) return null;
    // Force a full decode (failOn: "error") so a corrupt payload the header check
    // misses is caught here. Resize small so a huge image doesn't balloon memory.
    await sharp(buffer, { failOn: "error" })
      .resize(256, 256, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer();
    return mediaType;
  } catch {
    return null;
  }
}

/**
 * Downscale an image buffer so it fits within both the visual token budget
 * ({@link boundedSize}) and MAX_IMAGE_BYTES. Preserves format (PNG→PNG,
 * JPEG→JPEG, etc.) and aspect ratio — a lossless PNG screenshot of UI stays a
 * lossless PNG with its alpha channel intact.
 */
export async function shrinkToFit(
  buffer: Buffer,
  mediaType: string,
): Promise<{ buffer: Buffer; mediaType: string }> {
  const sharp = await loadSharp();
  const meta = await sharp(buffer).metadata();
  const origW = meta.width ?? 4096;
  const origH = meta.height ?? 4096;
  const bounded = boundedSize(origW, origH);
  const exceedsDim = bounded.width !== origW || bounded.height !== origH;

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
  const formatMap: Record<string, keyof FormatEnum> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "png", // convert BMP to PNG (sharp doesn't output BMP)
  };
  let outFormat = formatMap[mediaType] ?? "png";
  let outMediaType = mediaType === "image/bmp" ? "image/png" : mediaType;

  // Initial target dimensions come from the visual token budget. Explicit
  // width/height (rather than leaning on sharp's fit: "inside") so the byte
  // loop below can shrink them further.
  let width = bounded.width;
  let height = bounded.height;

  // Encode at the budget-capped size first — often this is already under
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
 * WebP quality and effort (0–6) for the app's image previews. On the Mac
 * mini, a chat's 54 screenshots came to 3.7 MB at effort 2 in 1.03 s, 3.6 MB
 * at sharp's default in 1.36 s, and 40.8 MB as the terminal's PNG in 0.76 s.
 */
const APP_PREVIEW_QUALITY = 70;
const APP_PREVIEW_EFFORT = 2;

/**
 * An image's preview for the desktop and phone app: at most PREVIEW_MAX_WIDTH
 * wide, as WebP, about a tenth of the PNG the terminal's preview keeps. A
 * chat's previews cross the network each time it opens, at about 1 MB/s
 * through a shared relay. Every webview the app runs in shows WebP: the
 * sidecar's Node needs macOS 11, and the iPhone app iOS 18.
 *
 * On any sharp failure the image comes back as it was: a preview is cosmetic.
 */
export async function previewForApp(
  buffer: Buffer,
  mediaType: string,
): Promise<{ buffer: Buffer; mediaType: string }> {
  try {
    const sharp = await loadSharp();
    const webp = await sharp(buffer)
      .resize(PREVIEW_MAX_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: APP_PREVIEW_QUALITY, effort: APP_PREVIEW_EFFORT })
      .toBuffer();
    return { buffer: webp, mediaType: "image/webp" };
  } catch {
    return { buffer, mediaType };
  }
}

/**
 * A tool's `details` with its `imagePreviews` (screenshot, read,
 * generate_image) made the app's ([`previewForApp`]), for its tool_call_end
 * event. Anything else comes back as it was.
 */
export async function withAppImagePreviews(details: unknown): Promise<unknown> {
  if (!details || typeof details !== "object") return details;
  const previews: unknown = Reflect.get(details, "imagePreviews");
  if (!Array.isArray(previews) || previews.length === 0) return details;
  const made: unknown[] = [];
  for (const preview of previews) {
    const base64: unknown = preview && typeof preview === "object" ? preview.base64 : undefined;
    const mediaType: unknown =
      preview && typeof preview === "object" ? preview.mediaType : undefined;
    if (typeof base64 !== "string" || typeof mediaType !== "string") {
      made.push(preview);
      continue;
    }
    const app = await previewForApp(Buffer.from(base64, "base64"), mediaType);
    made.push({ ...preview, base64: app.buffer.toString("base64"), mediaType: app.mediaType });
  }
  return { ...details, imagePreviews: made };
}

/** The longest side of an image the app opens full size on a phone. */
export const SCREEN_PREVIEW_MAX = 2048;
/** WebP quality for an image opened full size, at screen size. */
const SCREEN_PREVIEW_QUALITY = 80;

/**
 * An image opened full size, made screen-sized for the phone that asked: at
 * most SCREEN_PREVIEW_MAX on its longest side, as WebP. Null when it's small
 * enough already (it fits, and is no bigger than its WebP would be), or when
 * sharp can't read it: then the original goes as it is.
 */
export async function screenPreview(buffer: Buffer): Promise<Buffer | null> {
  try {
    const sharp = await loadSharp();
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) return null;
    const webp = await sharp(buffer)
      .rotate()
      .resize(SCREEN_PREVIEW_MAX, SCREEN_PREVIEW_MAX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: SCREEN_PREVIEW_QUALITY, effort: APP_PREVIEW_EFFORT })
      .toBuffer();
    return webp.length < buffer.length ? webp : null;
  } catch {
    return null;
  }
}

/** A stored image's id in a chat's history: the SHA-256 of its base64 data. */
export function historyImageRef(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The size of an image's app preview ([`previewForApp`]), read from its
 * header, or null when sharp can't read it.
 */
export async function appPreviewSize(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const sharp = await loadSharp();
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) return null;
    if (width <= PREVIEW_MAX_WIDTH) return { width, height };
    return {
      width: PREVIEW_MAX_WIDTH,
      height: Math.max(1, Math.round((height * PREVIEW_MAX_WIDTH) / width)),
    };
  } catch {
    return null;
  }
}

/**
 * A stored tool result's images as refs, for an app that loads each as it's
 * scrolled to (the sidecar's `GET /history?images=refs`): its ref, its
 * preview's size, and the file's path. `seen` gets each ref's image, for
 * `GET /history-images`.
 */
export async function appToolImageRefs(
  blocks: ReadonlyArray<{ data: string; mediaType: string }>,
  path: string | undefined,
  seen: Map<string, { data: string; mediaType: string }>,
): Promise<Array<{ ref: string; width?: number; height?: number; path?: string }>> {
  const images: Array<{ ref: string; width?: number; height?: number; path?: string }> = [];
  for (const block of blocks) {
    const ref = historyImageRef(block.data);
    seen.set(ref, block);
    const size = await appPreviewSize(Buffer.from(block.data, "base64"));
    images.push({ ref, ...size, path });
  }
  return images;
}

/**
 * A stored tool result's images as a reopened chat shows them (the sidecar's
 * `GET /history`): data URLs of their app previews, with the file's path.
 */
export async function appToolImages(
  blocks: ReadonlyArray<{ data: string; mediaType: string }>,
  path: string | undefined,
): Promise<Array<{ src: string; path?: string }>> {
  const images: Array<{ src: string; path?: string }> = [];
  for (const block of blocks) {
    const app = await previewForApp(Buffer.from(block.data, "base64"), block.mediaType);
    images.push({ src: `data:${app.mediaType};base64,${app.buffer.toString("base64")}`, path });
  }
  return images;
}

/**
 * Pixel dimensions from the image header, or null when it cannot be read.
 * Header only: no pixel decode, so it is cheap on large images.
 */
export async function imageDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const sharp = await loadSharp();
    const { width, height } = await sharp(buffer).metadata();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

/**
 * Re-encode an image as `format`. Unlike the preview helpers this is the saved
 * file itself, so a failure propagates rather than silently keeping the
 * original bytes under a mismatched extension.
 */
export async function convertImageFormat(
  buffer: Buffer,
  format: "png" | "jpeg" | "webp",
): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(buffer).toFormat(format).toBuffer();
}

/**
 * Inline previews (`details.imagePreviews`) for image blocks a tool returns
 * without a file of its own (MCP servers). The chat only
 * renders tool images from these previews, so a tool that skips them shows
 * nothing live and only surfaces its images after a session reload.
 */
export async function previewsForImageBlocks(
  blocks: readonly { type: string; mediaType?: string; data?: string }[],
): Promise<{ base64: string; mediaType: string }[]> {
  const previews: { base64: string; mediaType: string }[] = [];
  for (const block of blocks) {
    if (block.type !== "image" || !block.mediaType || !block.data) continue;
    const preview = await downscaleForPreview(Buffer.from(block.data, "base64"));
    previews.push({ base64: preview.toString("base64"), mediaType: block.mediaType });
  }
  return previews;
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

  if (VIDEO_EXTENSIONS.has(ext)) {
    try {
      const mediaType = VIDEO_MEDIA_TYPES[ext] ?? "video/mp4";
      const stat = await fs.stat(filePath);
      // Always classify as `video` so it routes through the video path (and the
      // UI shows it as a video, not a generic file). Providers that deliver
      // video via an upload/read-tool reference it by `filePath` at any size.
      // Only providers that inline base64 need the bytes in-memory, and only up
      // to MAX_VIDEO_BYTES — so for larger clips we keep `data` empty and let
      // the path-based routes handle it.
      const data =
        stat.size <= MAX_VIDEO_BYTES ? (await fs.readFile(filePath)).toString("base64") : "";
      return { kind: "video", fileName, filePath, mediaType, data };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: "text",
        fileName,
        filePath,
        mediaType: "text/plain",
        data: `[video ${fileName} could not be loaded: ${reason}]`,
      };
    }
  }

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
    const { buffer } = await shrinkToFit(rawBuffer, mediaType);
    // Final guard: confirm the (possibly shrunk) buffer is a real, fully-decodable
    // image in a vision-supported format. shrinkToFit short-circuits without a
    // full decode when the image is already within size limits, so a corrupt or
    // unsupported file (e.g. a malformed .ico) could slip through and make the
    // provider reject the whole turn. On failure, degrade to a text placeholder
    // the model can still read as <file> context — never break the turn.
    const validatedType = await validateVisionImage(buffer);
    if (!validatedType) {
      return {
        kind: "text",
        fileName,
        filePath,
        mediaType: "text/plain",
        data: `[image ${fileName} is not a valid/supported image (corrupt or unsupported format); saved at ${filePath} — inspect it with your tools if needed]`,
      };
    }
    return {
      kind: "image",
      fileName,
      filePath,
      mediaType: validatedType,
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

/** Alias of {@link readImageFile} that also handles video files. Name reflects
 *  the widened scope. */
export const readMediaFile = readImageFile;

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
