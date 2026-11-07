import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { GG_CODER_USER_AGENT } from "@kenkaiiii/gg-ai";
import type { AgentTool, StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import {
  IMAGE_MEDIA_TYPES,
  convertImageFormat,
  animatedPreview,
  downscaleForPreview,
  imageDimensions,
  shrinkToFit,
} from "../utils/image.js";

/**
 * Structural subset of AuthStorage the tool needs at execute time. Using a
 * structural type avoids importing the full class (and its gg-core dependency
 * chain) into the tool module — the caller satisfies this with its real
 * AuthStorage instance.
 */
export type GenerateImageAuth = {
  /** The OpenAI API key; image generation isn't available on the ChatGPT plan. */
  resolveApiKey(provider: string): Promise<{ accessToken: string }>;
};

/**
 * OpenAI's public Image API (developers.openai.com/api/docs/guides/image-generation):
 * a JSON POST to `images/generations` or `images/edits` with `{ prompt,
 * background, model, quality, size }` (edits add `images: [{ image_url }]`,
 * GIFs add `output_format: "gif"` + frame controls), answered with
 * `data[].b64_json`. It needs an OpenAI API key: the ChatGPT plan route
 * doesn't serve image generation.
 */
const IMAGES_BASE = "https://api.openai.com/v1/images";
/** The endpoint answers in PNG by default; other formats are re-encoded locally. */
const RESPONSE_FORMAT = "png";
/** GPT Image 2.6: Flare for fast everyday generation, Sunburst where edit precision matters. */
const GENERATION_MODEL = "gpt-image-2.6-flare";
const EDIT_MODEL = "gpt-image-2.6-sunburst";
/** GIF output bounds (`frame_count` 2–16, default 9; 200ms frames). */
const GIF_MIN_FRAMES = 2;
const GIF_MAX_FRAMES = 16;
const GIF_DEFAULT_FRAMES = 9;
const GIF_DEFAULT_FRAME_MS = 200;
/** An edit takes one to five reference images. */
const MAX_EDIT_IMAGES = 5;
/**
 * Retry policy for image requests: up to 4 retries (5 attempts) on a 5xx or a
 * failed connection, never on a 4xx such as 429. The wait honours
 * `Retry-After`; otherwise it doubles from 200ms with ±10% jitter (200, 400,
 * 800, 1600ms).
 */
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 200;

/** Timing seams for the retry policy, so tests can check the exact waits. */
export type ImageRetryDeps = {
  /** Wait `ms`, rejecting early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Uniform in [0, 1): the jitter source. */
  random: () => number;
  /** Wall-clock ms, for an HTTP-date `Retry-After`. */
  now: () => number;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_RETRY_DEPS: ImageRetryDeps = {
  sleep: abortableSleep,
  random: Math.random,
  now: Date.now,
};

/**
 * Wait before retry number `retry` (1-based): the server's `Retry-After` (whole seconds or an HTTP date) when present,
 * otherwise exponential backoff from 200ms with ±10% jitter.
 */
export function retryDelayMs(
  retry: number,
  retryAfter: string | null,
  deps: Pick<ImageRetryDeps, "random" | "now">,
): number {
  const value = retryAfter?.trim();
  if (value) {
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - deps.now());
  }
  const jitter = 0.9 + deps.random() * 0.2;
  return Math.floor(RETRY_BASE_DELAY_MS * 2 ** (retry - 1) * jitter);
}

const GenerateImageParams = z.object({
  prompt: z.string().describe("Text description of the image to generate or the edit to apply"),
  image: z
    .string()
    .optional()
    .describe(
      "Path to an existing image file to edit (use the path returned by a previous " +
        "generate_image call, or a user-attached image path). When omitted, a new " +
        "image is generated from scratch. Use `images` instead for several references.",
    ),
  images: z
    .array(z.string())
    .min(1)
    .max(MAX_EDIT_IMAGES)
    .optional()
    .describe(
      `Up to ${MAX_EDIT_IMAGES} image paths to edit from or combine (for example a subject ` +
        "and a style reference). Do not pass both `image` and `images`.",
    ),
  size: z
    .string()
    .optional()
    .describe(
      "Output resolution: `auto` (default) or WIDTHxHEIGHT with both edges multiples of " +
        "16px, max edge 3840px, long:short ratio at most 3:1, and 655,360 to 8,294,400 " +
        "total pixels. Common: 1024x1024, 1536x1024, 1024x1536. The result always reports " +
        "the size actually delivered.",
    ),
  quality: z
    .enum(["low", "medium", "high", "auto"])
    .optional()
    .describe(
      "Rendering quality. Use 'low' for fast drafts, 'high' for final assets. Default: auto.",
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Number of images to generate (1–4, default 1)"),
  out_path: z
    .string()
    .optional()
    .describe(
      "Where to save the generated image (relative to cwd or absolute). " +
        "Defaults to .gg/generated/<timestamp>.png",
    ),
  output_format: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe("Output file format for a still image (default png). Leave unset with `gif`."),
  gif: z
    .object({
      frame_count: z
        .number()
        .int()
        .min(GIF_MIN_FRAMES)
        .max(GIF_MAX_FRAMES)
        .optional()
        .describe(`Number of frames (${GIF_MIN_FRAMES}–${GIF_MAX_FRAMES}). Default 9.`),
      frame_duration_ms: z
        .number()
        .int()
        .min(20)
        .max(2000)
        .optional()
        .describe("Milliseconds per frame (20–2000). Default 200."),
    })
    .optional()
    .describe(
      "Set to make a simple looping animated GIF instead of a still image; use {} for the " +
        `defaults (9 frames, 200ms each). Only for simple animations of ${GIF_MIN_FRAMES}–` +
        `${GIF_MAX_FRAMES} frames. Describe the motion and the loop in the prompt. To change ` +
        "an existing GIF, pass a spritesheet of its frames (equal cells in a regular grid) " +
        "as `image`, never the GIF itself.",
    ),
  background: z
    .enum(["opaque", "transparent"])
    .optional()
    .describe(
      "Use 'transparent' when the request calls for a transparent background, including " +
        "background removal or a cutout (png or webp output). Default: opaque. For edits, " +
        "keep existing transparency unless the user asks to change it.",
    ),
});

type GenerateImageArgs = z.infer<typeof GenerateImageParams>;

type SavedFormat = "png" | "jpeg" | "webp" | "gif";

function defaultOutPath(cwd: string, format: SavedFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = format === "jpeg" ? "jpg" : format;
  return path.join(cwd, ".gg", "generated", `${stamp}.${ext}`);
}

/** Format → media type for StructuredToolResult. */
function mediaTypeFor(format: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  return "image/png";
}

/** GIF87a / GIF89a magic: the backend's reply, not the request, decides the format. */
function isGif(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString("latin1") === "GIF8";
}

/** Same path with another extension, for a still image returned to a GIF request. */
function withExtension(filePath: string, ext: string): string {
  return filePath.slice(0, filePath.length - path.extname(filePath).length) + ext;
}

export function createGenerateImageTool(
  cwd: string,
  auth: GenerateImageAuth,
  retryDeps: Partial<ImageRetryDeps> = {},
): AgentTool<typeof GenerateImageParams> {
  const retry: ImageRetryDeps = { ...DEFAULT_RETRY_DEPS, ...retryDeps };
  return {
    name: "generate_image",
    description:
      "Generate or edit images with OpenAI's Image API. Works even when a different chat " +
      "provider is active; needs an OpenAI API key. Only use this tool when the user explicitly asks to " +
      "create, generate, or edit an image. Pass `image` (or up to five `images`) to edit " +
      "existing files, such as a previous result or a user attachment. Set `background` to " +
      "'transparent' for cutouts and transparent artwork. Set `gif` for a short looping " +
      "animation. Generation can take a minute or " +
      "more. Use `out_path` to save to a specific location (defaults to .gg/generated/).",
    parameters: GenerateImageParams,
    async execute(
      args: GenerateImageArgs,
      context: ToolContext,
    ): Promise<string | StructuredToolResult> {
      if (context.signal.aborted) return "Image generation aborted before start.";
      // JPEG has no alpha channel: a transparent result saved as JPEG would
      // silently come back opaque, after spending the user's image quota.
      if (args.background === "transparent" && args.output_format === "jpeg") {
        return (
          "Transparent backgrounds need png or webp output; JPEG cannot store transparency. " +
          "No request was sent. Use output_format png or webp."
        );
      }
      if (args.image && args.images) {
        return "Pass either `image` or `images`, not both. No request was sent.";
      }
      if (args.gif && args.output_format) {
        return "A GIF is always saved as .gif; leave `output_format` unset with `gif`. No request was sent.";
      }

      // The API key only: the ChatGPT plan route doesn't serve image generation.
      let token: string;
      try {
        token = (await auth.resolveApiKey("openai")).accessToken;
      } catch {
        return (
          "Image generation needs an OpenAI API key; it isn't available on the ChatGPT plan. " +
          "No request was sent. Tell the user to add a key from platform.openai.com/api-keys " +
          "under OpenAI in Providers (or `ggcoder login`)."
        );
      }

      const outputFormat: SavedFormat = args.gif ? "gif" : (args.output_format ?? "png");
      const mediaType = mediaTypeFor(outputFormat);
      const outPath = args.out_path
        ? resolvePath(cwd, args.out_path)
        : defaultOutPath(cwd, outputFormat);

      try {
        // Quality and size default to "auto", background to opaque unless
        // transparency is asked for.
        const referencePaths = args.images ?? (args.image ? [args.image] : []);
        const request: Record<string, unknown> = {
          prompt: args.prompt,
          background: args.background ?? "opaque",
          model: referencePaths.length > 0 ? EDIT_MODEL : GENERATION_MODEL,
          quality: args.quality ?? "auto",
          size: args.size ?? "auto",
        };
        if (args.gif) {
          // Frame controls sit beside `output_format`; unset ones are omitted.
          request.output_format = "gif";
          if (args.gif.frame_count !== undefined) request.frame_count = args.gif.frame_count;
          if (args.gif.frame_duration_ms !== undefined) {
            request.frame_duration_ms = args.gif.frame_duration_ms;
          }
        }

        if (referencePaths.length > 0) {
          // Edit mode: each reference travels inline as a data URL of the
          // original bytes.
          const references: Array<{ image_url: string }> = [];
          for (const reference of referencePaths) {
            const imagePath = resolvePath(cwd, reference);
            const refMediaType = IMAGE_MEDIA_TYPES[path.extname(imagePath).toLowerCase()];
            if (!refMediaType) {
              return `Cannot edit ${reference}: only PNG, JPEG, GIF, WebP and BMP images are supported.`;
            }
            let fileBuffer: Buffer;
            try {
              fileBuffer = await readFile(imagePath);
            } catch {
              return `Could not read the image at ${reference}. Check the path is correct.`;
            }
            references.push({
              image_url: `data:${refMediaType};base64,${fileBuffer.toString("base64")}`,
            });
          }
          request.images = references;
        }
        const endpoint = `${IMAGES_BASE}/${request.images ? "edits" : "generations"}`;

        // One request per image: each output is its own generation, and a
        // later failure keeps the earlier ones.
        const requestedCount = args.n ?? 1;
        const imageBuffers: Buffer[] = [];
        // Set once OpenAI refuses native GIF output: every GIF is then drawn as one
        // sprite sheet and its frames stitched into a GIF locally.
        let sheetGrid: SpriteGrid | undefined;
        // The size OpenAI's response says it produced, per image (when given).
        const reportedSizes: Array<string | undefined> = [];
        for (
          let index = 0;
          index < requestedCount && imageBuffers.length < requestedCount;
          index++
        ) {
          const call = (body: Record<string, unknown>) =>
            callImageEndpoint(endpoint, body, token, context.signal, retry);
          let generated: Awaited<ReturnType<typeof callImageEndpoint>>;
          try {
            generated = await call(sheetGrid ? spriteSheetRequest(request, sheetGrid) : request);
          } catch (err) {
            if (!args.gif || sheetGrid || !(err instanceof GifRefusedError)) throw err;
            sheetGrid = spriteGrid(args.gif.frame_count ?? GIF_DEFAULT_FRAMES, args.size);
            generated = await call(spriteSheetRequest(request, sheetGrid));
          }
          for (const png of generated.images.slice(0, requestedCount - imageBuffers.length)) {
            // PNG and GIF output are saved byte for byte as OpenAI sent them
            // (alpha and frames and all); only another format is re-encoded. Never resized.
            imageBuffers.push(
              sheetGrid
                ? // Not a usable grid: keep the still, saved and reported as a PNG.
                  ((await gifFromSpriteSheet(
                    png,
                    sheetGrid,
                    args.gif?.frame_duration_ms ?? GIF_DEFAULT_FRAME_MS,
                  )) ?? png)
                : outputFormat === RESPONSE_FORMAT || outputFormat === "gif"
                  ? png
                  : await convertImageFormat(png, outputFormat),
            );
            reportedSizes.push(generated.reportedSize);
          }
          if (generated.images.length === 0) break;
        }

        if (imageBuffers.length === 0) {
          return "Image generation returned no results. The prompt may have been blocked by content moderation.";
        }

        // Save each image and build preview content.
        const savedPaths: string[] = [];
        let stillInsteadOfGif = false;

        for (let i = 0; i < imageBuffers.length; i++) {
          const buf = imageBuffers[i]!;
          let savePath = imageBuffers.length === 1 ? outPath : insertIndex(outPath, i);
          if (outputFormat === "gif" && !isGif(buf)) {
            // A still came back for a GIF request: keep it, under its true extension.
            stillInsteadOfGif = true;
            savePath = withExtension(savePath, ".png");
          }
          await mkdir(path.dirname(savePath), { recursive: true });
          await writeFile(savePath, buf);
          savedPaths.push(savePath);
        }

        // The primary image (first) gets the full treatment: model-visible
        // image + inline preview. Additional images are previewed only.
        const primary = imageBuffers[0]!;
        const primaryPath = savedPaths[0]!;

        // Shrink for the model (provider image limits) and a smaller copy for
        // the inline terminal/webview preview. The model sees a GIF as its
        // first frame, while the preview keeps the animation.
        const { buffer: shrunk, mediaType: detectedType } = await shrinkToFit(
          isGif(primary) ? await convertImageFormat(primary, "png") : primary,
          mediaType,
        );
        const primaryPreview = isGif(primary)
          ? await animatedPreview(primary)
          : { buffer: await downscaleForPreview(shrunk), mediaType: detectedType };

        const imagePreviews = [
          {
            base64: primaryPreview.buffer.toString("base64"),
            mediaType: primaryPreview.mediaType,
            path: primaryPath,
          },
        ];

        // Include additional images as previews too.
        for (let i = 1; i < imageBuffers.length; i++) {
          const extraBuf = imageBuffers[i]!;
          const extraPath = savedPaths[i]!;
          if (isGif(extraBuf)) {
            const extraPreview = await animatedPreview(extraBuf);
            imagePreviews.push({
              base64: extraPreview.buffer.toString("base64"),
              mediaType: extraPreview.mediaType,
              path: extraPath,
            });
            continue;
          }
          const extraShrunk = await shrinkToFit(extraBuf, mediaType);
          const extraPreview = await downscaleForPreview(extraShrunk.buffer);
          imagePreviews.push({
            base64: extraPreview.toString("base64"),
            mediaType: extraShrunk.mediaType,
            path: extraPath,
          });
        }

        const summary =
          savedPaths.length === 1
            ? `Generated image → ${primaryPath}`
            : `Generated ${savedPaths.length} images → ${savedPaths.join(", ")}`;

        const dimensions = await Promise.all(imageBuffers.map((buf) => imageDimensions(buf)));
        const sizeText =
          sheetGrid && !stillInsteadOfGif
            ? `Frame size: ${dimensions[0] ? formatDimensions(dimensions[0]) : "unknown"}. ` +
              `Assembled locally from a ${sheetGrid.cols}x${sheetGrid.rows} sprite sheet of ` +
              `${sheetGrid.frames} frames, because OpenAI's native GIF output isn't enabled ` +
              "for this API key yet."
            : sizeReport(args.size, savedPaths, dimensions, reportedSizes);

        // The summary stays the FIRST text block, on its own: restored history
        // reads the image paths from exactly that line (extractToolImagePaths).
        const allContent: StructuredToolResult["content"] = [
          { type: "text", text: summary },
          { type: "text", text: sizeText },
          ...(stillInsteadOfGif
            ? [
                {
                  type: "text" as const,
                  text: sheetGrid
                    ? "The frames OpenAI drew did not line up into an animation, so the " +
                      "picture was saved as a still PNG. Tell the user, and offer to try again."
                    : "OpenAI returned a still PNG instead of an animated GIF, saved with a " +
                      ".png extension. Tell the user.",
                },
              ]
            : []),
          {
            type: "image",
            mediaType: detectedType,
            data: shrunk.toString("base64"),
          },
        ];

        return {
          content: allContent,
          details: { imagePreviews },
        };
      } catch (err) {
        if (context.signal.aborted) return "Image generation aborted.";
        if (err instanceof ImageAccessError) return imageAccessMessage(err.message);
        if (err instanceof ImageLimitError) return imageLimitMessage();
        const reason = err instanceof Error ? err.message : String(err);
        return `Image generation failed: ${reason}`;
      }
    },
  };
}

type Dimensions = { width: number; height: number } | null;

const formatDimensions = (d: { width: number; height: number }): string => `${d.width}x${d.height}`;

/**
 * Requested versus delivered size, for the agent to relay. OpenAI can return
 * a different size than asked (a user asked for 2048x2048
 * and got 1254x1254), so a mismatch is reported plainly instead of the call
 * reading as a clean success. Nothing is resized and nothing is re-requested:
 * each request spends the user's image quota.
 */
export function sizeReport(
  requested: string | undefined,
  paths: readonly string[],
  dimensions: readonly Dimensions[],
  reportedSizes: ReadonlyArray<string | undefined>,
): string {
  const explicit = requested && requested !== "auto" ? requested : undefined;
  const actual = dimensions.map((d) => (d ? formatDimensions(d) : undefined));
  // What OpenAI's response claimed, when it disagrees with the pixels.
  const claims = actual
    .map((size, i) => {
      const reported = reportedSizes[i];
      return reported && size && reported !== size ? reported : undefined;
    })
    .filter((claim): claim is string => claim !== undefined);
  const claimNote =
    claims.length > 0 ? ` OpenAI's response reported ${[...new Set(claims)].join(", ")}.` : "";

  if (actual.some((size) => size === undefined)) {
    return explicit
      ? `Requested ${explicit}, but the saved image could not be measured to confirm its size.`
      : "The saved image could not be measured to report its size.";
  }
  const unique = [...new Set(actual)];
  const delivered =
    unique.length === 1
      ? (unique[0] ?? "")
      : actual.map((size, i) => `${paths[i] ?? `image ${i + 1}`}: ${size}`).join(", ");

  if (!explicit) return `Size: ${delivered} (size auto, chosen by OpenAI).${claimNote}`;
  if (unique.length === 1 && unique[0] === explicit) {
    return `Size: ${explicit}, as requested.${claimNote}`;
  }
  return (
    `Size mismatch: requested ${explicit}, but OpenAI returned ${delivered}.${claimNote} ` +
    "The file was saved at its native size with no resizing. Tell the user. OpenAI does not " +
    "always honour the requested size, so asking again is unlikely to change it and would " +
    "spend more of their credit."
  );
}

/** Insert a numeric index before the extension for multi-image output. */
function insertIndex(filePath: string, index: number): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}_${index}${ext}`;
}

/** OpenAI refused the image request outright (HTTP 403): the account has no access. */
class ImageAccessError extends Error {}

/** The account's image quota is used up (HTTP 429 `usage_limit_reached`). */
class ImageLimitError extends Error {}

/** The backend turned down GIF output (HTTP 400 naming GIF), before generating anything. */
class GifRefusedError extends Error {
  constructor(readonly detail: string) {
    super(`OpenAI Image API (400): ${detail}`);
  }
}

/** Frames of a sprite sheet, laid out left to right, top to bottom. */
export type SpriteGrid = {
  frames: number;
  cols: number;
  rows: number;
  /** Sheet size to ask for, so each cell keeps the requested frame shape. */
  size: string;
};

const SHEET_LONG_EDGE = 1536;

/** The most square grid that holds `frames` cells, sized for the requested frame shape. */
export function spriteGrid(frames: number, frameSize: string | undefined): SpriteGrid {
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);
  const match = frameSize ? /^(\d+)x(\d+)$/.exec(frameSize) : null;
  const frameAspect = match ? Number(match[1]) / Number(match[2]) : 1;
  // The backend caps the long:short ratio at 3:1.
  const aspect = Math.min(3, Math.max(1 / 3, (cols * frameAspect) / rows));
  const snap = (edge: number): number => Math.max(16, Math.round(edge / 16) * 16);
  const width = aspect >= 1 ? SHEET_LONG_EDGE : snap(SHEET_LONG_EDGE * aspect);
  const height = aspect >= 1 ? snap(SHEET_LONG_EDGE / aspect) : SHEET_LONG_EDGE;
  return { frames, cols, rows, size: `${width}x${height}` };
}

/** The still request that asks for every frame of the animation on one sheet. */
export function spriteSheetRequest(
  request: Record<string, unknown>,
  grid: SpriteGrid,
): Record<string, unknown> {
  const { output_format: _format, frame_count: _count, frame_duration_ms: _ms, ...still } = request;
  const spare =
    grid.cols * grid.rows > grid.frames
      ? ` Fill only the first ${grid.frames} cells; leave the rest plain background.`
      : "";
  return {
    ...still,
    size: grid.size,
    prompt:
      `A sprite sheet for a looping animation: ${grid.frames} frames in a ${grid.cols}x` +
      `${grid.rows} grid of equal cells, read left to right, top to bottom.${spare} No gaps, ` +
      "borders, gutters, labels or numbers. Every cell shares the exact same background, " +
      "framing and scale so the frames line up when played in order, and the last frame " +
      `leads smoothly back into the first.\n\nAnimation: ${String(request.prompt)}`,
  };
}

/** Cut a sprite sheet into its cells and play them as a looping GIF. */
export async function gifFromSpriteSheet(
  sheet: Buffer,
  grid: SpriteGrid,
  frameMs: number,
): Promise<Buffer | null> {
  const sharp = (await import("sharp")).default;
  const { width = 0, height = 0 } = await sharp(sheet).metadata();
  const asked = /^(\d+)x(\d+)$/.exec(grid.size);
  // A sheet whose shape is far from the one asked for was not drawn on the grid.
  if (asked) {
    const askedAspect = Number(asked[1]) / Number(asked[2]);
    const gotAspect = height > 0 ? width / height : 0;
    if (Math.abs(Math.log(gotAspect / askedAspect)) > Math.log(1.25)) return null;
  }
  const cellW = Math.floor(width / grid.cols);
  const cellH = Math.floor(height / grid.rows);
  // Crop a hair off every edge: the model often draws faint lines between cells.
  const inset = Math.max(2, Math.round(Math.min(cellW, cellH) * 0.012));
  if (cellW <= inset * 2 || cellH <= inset * 2) {
    throw new Error(`The sprite sheet (${width}x${height}) is too small to cut into frames.`);
  }
  const frames: Buffer[] = [];
  for (let i = 0; i < grid.frames; i++) {
    frames.push(
      await sharp(sheet)
        .extract({
          left: (i % grid.cols) * cellW + inset,
          top: Math.floor(i / grid.cols) * cellH + inset,
          width: cellW - inset * 2,
          height: cellH - inset * 2,
        })
        .png()
        .toBuffer(),
    );
  }
  // Identical cells mean one picture rather than frames of a motion: no animation.
  const [first, ...rest] = await Promise.all(
    frames.map((frame) =>
      sharp(frame).resize(16, 16, { fit: "fill" }).greyscale().raw().toBuffer(),
    ),
  );
  const moves = rest.some((cell) => cell.some((v, j) => Math.abs(v - (first![j] ?? 0)) > 24));
  if (!moves) return null;
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: Array<number>(grid.frames).fill(frameMs), loop: 0 })
    .toBuffer();
}

/** What to tell the agent when the API key has no credit left for images. */
function imageLimitMessage(): string {
  return (
    "The OpenAI API key has no credit left for image generation (or its billing limit is reached). " +
    "Tell the user to check billing at platform.openai.com; retrying will not help."
  );
}

/**
 * What to tell the agent when OpenAI refuses image generation for the key. GPT
 * Image models can require a verified organization; say that plainly instead
 * of passing the opaque status through.
 */
function imageAccessMessage(detail: string): string {
  const reason = detail ? ` OpenAI said: ${detail.slice(0, 300)}` : "";
  return (
    "OpenAI refused the image request (403 Forbidden). The API key's organization may need " +
    "verification for GPT Image models (platform.openai.com/settings/organization/general)." +
    `${reason} Tell the user; retrying, or changing size, quality or format, will not help.`
  );
}

/** POST one request to the Image API and return the decoded images. */
async function callImageEndpoint(
  url: string,
  request: Record<string, unknown>,
  token: string,
  signal: AbortSignal,
  retry: ImageRetryDeps,
): Promise<{ images: Buffer[]; reportedSize?: string }> {
  const body = JSON.stringify(request);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": GG_CODER_USER_AGENT,
        },
        body,
        signal,
      });
      text = await response.text();
    } catch (err) {
      // A failed connection or a body cut off mid-read. An abort is the
      // user stopping the run, never something to retry.
      if (signal.aborted || attempt >= MAX_RETRIES) throw err;
      await retry.sleep(retryDelayMs(attempt + 1, null, retry), signal);
      continue;
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const wait = retryDelayMs(attempt + 1, response.headers.get("retry-after"), retry);
      await retry.sleep(wait, signal);
      continue;
    }
    return parseImageResponse(response.status, text, attempt + 1);
  }
}

/** Turn one image endpoint reply into images, or the error it describes. */
function parseImageResponse(
  status: number,
  text: string,
  attempts: number,
): { images: Buffer[]; reportedSize?: string } {
  const response = { status, ok: status >= 200 && status < 300 };
  if (!response.ok) {
    let detail = text;
    let errorCode: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        detail?: string;
        error?: { message?: string; type?: string; code?: string };
      };
      errorCode = parsed.error?.code ?? parsed.error?.type;
      if (parsed.detail) detail = parsed.detail;
      else if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Keep raw text
    }
    if (response.status === 403) throw new ImageAccessError(detail);
    if (
      response.status === 429 &&
      (errorCode === "insufficient_quota" || errorCode === "billing_hard_limit_reached")
    ) {
      throw new ImageLimitError(detail);
    }
    // Only "GIF is not available here"; other 400s (bad input, policy) surface as they are.
    if (
      response.status === 400 &&
      /\bgif\b/i.test(detail) &&
      /\b(not|unsupported|unavailable|disabled)\b/i.test(detail)
    ) {
      throw new GifRefusedError(detail);
    }
    const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
    throw new Error(`OpenAI Image API (${response.status})${tries}: ${detail}`);
  }

  let parsed: { data?: Array<{ b64_json?: unknown }>; size?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("OpenAI Image API returned a response that is not JSON.");
  }
  const images = (parsed.data ?? [])
    .map((item) => item.b64_json)
    .filter((b64): b64 is string => typeof b64 === "string" && b64.length > 0)
    .map((b64) => Buffer.from(b64, "base64"));
  // The response carries the size OpenAI says it produced.
  const reportedSize = typeof parsed.size === "string" ? parsed.size : undefined;
  return { images, ...(reportedSize ? { reportedSize } : {}) };
}
