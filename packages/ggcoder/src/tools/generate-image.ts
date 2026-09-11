import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { downscaleForPreview, shrinkToFit } from "../utils/image.js";

/**
 * Structural subset of AuthStorage the tool needs at execute time. Using a
 * structural type avoids importing the full class (and its gg-core dependency
 * chain) into the tool module — the caller satisfies this with its real
 * AuthStorage instance.
 */
export type GenerateImageAuth = {
  resolveCredentials(provider: string): Promise<{
    accessToken: string;
    accountId?: string;
  }>;
};

/**
 * The Codex backend endpoint — the SAME endpoint our OpenAI Codex streaming
 * provider uses for chat. ChatGPT OAuth tokens (from auth.openai.com PKCE flow)
 * are rejected by api.openai.com/v1/images/* (missing `api.model.images.request`
 * scope), but they work here. Image generation is done via the Responses API's
 * built-in `image_generation` tool, with the image model selected on that tool.
 */
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
/** Model that supports the image_generation Responses API tool. */
const IMAGE_GEN_MODEL = "gpt-5.5";

const GenerateImageParams = z.object({
  prompt: z.string().describe("Text description of the image to generate or the edit to apply"),
  model: z
    .enum(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])
    .optional()
    .describe(
      "Image model. Default: gpt-image-2.5-flare for fast, high-quality generation. " +
        "Use gpt-image-2.5-sunburst when editing precision matters most.",
    ),
  image: z
    .string()
    .optional()
    .describe(
      "Path to an existing image file to edit (use the path returned by a previous " +
        "generate_image call, or a user-attached image path). When omitted, a new " +
        "image is generated from scratch.",
    ),
  size: z
    .string()
    .optional()
    .describe(
      "Output resolution. GPT Image 2.5 accepts any size where both edges are multiples " +
        "of 16px, max edge ≤3840px, long:short ratio ≤3:1, total pixels 655,360–8,294,400. " +
        "Popular: 1024x1024, 1536x1024, 1024x1536, 2048x2048. Default: auto.",
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
    .describe("Output file format (default png)"),
  background: z
    .enum(["opaque", "auto", "transparent"])
    .optional()
    .describe(
      "Background type (default auto). Use auto or opaque. Transparent is currently " +
        "unsupported by the connected ChatGPT/Codex backend for both models and will " +
        "be rejected locally. Do not retry transparent requests or switch models to bypass this.",
    ),
});

type GenerateImageArgs = z.infer<typeof GenerateImageParams>;

function defaultOutPath(cwd: string, format: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = format === "png" ? "png" : format === "jpeg" ? "jpg" : "webp";
  return path.join(cwd, ".gg", "generated", `${stamp}.${ext}`);
}

/** Format → media type for StructuredToolResult. */
function mediaTypeFor(format: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export function createGenerateImageTool(
  cwd: string,
  auth: GenerateImageAuth,
): AgentTool<typeof GenerateImageParams> {
  return {
    name: "generate_image",
    description:
      "Generate or edit images using OpenAI's GPT Image 2.5 models: Flare (default, fast) " +
      "or Sunburst (precise editing). Transparent backgrounds are currently unsupported " +
      "through this tool. Works even when a different " +
      "chat provider is active — only requires OpenAI to be connected. Only use this tool when " +
      "the user explicitly asks to create, generate, or edit an image. Pass `image` with a " +
      "file path to edit an existing image (e.g. a previously generated one or a user attachment). " +
      "Use `out_path` to save to a specific location (defaults to .gg/generated/).",
    parameters: GenerateImageParams,
    async execute(
      args: GenerateImageArgs,
      context: ToolContext,
    ): Promise<string | StructuredToolResult> {
      if (context.signal.aborted) return "Image generation aborted before start.";
      // Keep the legacy parameter value parseable so cached/repeated calls get
      // actionable guidance instead of another backend 400 or schema retry.
      if (args.background === "transparent") {
        return (
          "Transparent backgrounds are currently unsupported by the connected ChatGPT/Codex " +
          "image backend for both Flare and Sunburst, including PNG and WebP output. " +
          "No request was sent. Do not retry with another model or format. " +
          "Explain this limitation to the user; do not silently substitute an opaque background."
        );
      }

      // Resolve OpenAI credentials at execution time (lazy — token refresh
      // happens on use, not at registration).
      let token: string;
      let accountId: string | undefined;
      try {
        const creds = await auth.resolveCredentials("openai");
        token = creds.accessToken;
        accountId = creds.accountId;
      } catch {
        return (
          "OpenAI is not connected. The user needs to connect their OpenAI account " +
          "to use image generation."
        );
      }

      const outputFormat = args.output_format ?? "png";
      const mediaType = mediaTypeFor(outputFormat);
      const outPath = args.out_path
        ? resolvePath(cwd, args.out_path)
        : defaultOutPath(cwd, outputFormat);

      try {
        // Build the image_generation tool definition with the requested params.
        const imageTool: Record<string, unknown> = {
          type: "image_generation",
          model: args.model ?? "gpt-image-2.5-flare",
          output_format: outputFormat,
        };
        if (args.size) imageTool.size = args.size;
        if (args.quality) imageTool.quality = args.quality;
        if (args.background) imageTool.background = args.background;

        // Build the input content — prompt text, optionally with a reference image.
        const inputContent: Array<Record<string, unknown>> = [
          { type: "input_text", text: args.prompt },
        ];

        if (args.image) {
          // Edit mode: read the reference image and include it as input_image.
          const imagePath = resolvePath(cwd, args.image);
          let fileBuffer: Buffer;
          try {
            fileBuffer = await readFile(imagePath);
          } catch {
            return `Could not read the image at ${args.image}. Check the path is correct.`;
          }
          // The Responses API accepts images as data URLs.
          const refMediaType =
            imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg")
              ? "image/jpeg"
              : imagePath.toLowerCase().endsWith(".webp")
                ? "image/webp"
                : "image/png";
          inputContent.push({
            type: "input_image",
            image_url: `data:${refMediaType};base64,${fileBuffer.toString("base64")}`,
          });
          imageTool.action = "edit";
        } else {
          imageTool.action = "generate";
        }

        // Call the Codex responses endpoint (same one our Codex streaming
        // provider uses) with the image_generation built-in tool. ChatGPT OAuth
        // tokens work here, unlike api.openai.com/v1/images/*.
        // The Responses image tool does not accept an `n` property. Generate
        // multiple images with separate requests and merge the results instead.
        const requestedCount = args.n ?? 1;
        const imageBuffers: Buffer[] = [];
        for (
          let index = 0;
          index < requestedCount && imageBuffers.length < requestedCount;
          index++
        ) {
          const generated = await callImageGeneration(
            inputContent,
            imageTool,
            token,
            accountId,
            context.signal,
          );
          imageBuffers.push(...generated.slice(0, requestedCount - imageBuffers.length));
          if (generated.length === 0) break;
        }

        if (imageBuffers.length === 0) {
          return "Image generation returned no results. The prompt may have been blocked by content moderation.";
        }

        // Save each image and build preview content.
        const savedPaths: string[] = [];

        for (let i = 0; i < imageBuffers.length; i++) {
          const buf = imageBuffers[i]!;
          const savePath = imageBuffers.length === 1 ? outPath : insertIndex(outPath, i);
          await mkdir(path.dirname(savePath), { recursive: true });
          await writeFile(savePath, buf);
          savedPaths.push(savePath);
        }

        // The primary image (first) gets the full treatment: model-visible
        // image + inline preview. Additional images are previewed only.
        const primary = imageBuffers[0]!;
        const primaryPath = savedPaths[0]!;

        // Shrink for the model (provider image limits) and a smaller copy for
        // the inline terminal/webview preview.
        const { buffer: shrunk, mediaType: detectedType } = await shrinkToFit(primary, mediaType);
        const previewBuffer = await downscaleForPreview(shrunk);

        const imagePreviews = [
          {
            base64: previewBuffer.toString("base64"),
            mediaType: detectedType,
            path: primaryPath,
          },
        ];

        // Include additional images as previews too.
        for (let i = 1; i < imageBuffers.length; i++) {
          const extraBuf = imageBuffers[i]!;
          const extraPath = savedPaths[i]!;
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

        const allContent: StructuredToolResult["content"] = [
          { type: "text", text: summary },
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
        const reason = err instanceof Error ? err.message : String(err);
        return `Image generation failed: ${reason}`;
      }
    },
  };
}

/** Insert a numeric index before the extension for multi-image output. */
function insertIndex(filePath: string, index: number): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}_${index}${ext}`;
}

/**
 * Call the Codex responses endpoint with the `image_generation` built-in tool.
 * Reads the SSE stream and extracts base64 image data from
 * `response.output_item.done` events where `item.type === "image_generation_call"`.
 *
 * The Codex backend requires `stream: true` and the ChatGPT OAuth token (which
 * our auth.openai.com PKCE flow produces). The top-level model orchestrates the
 * request; imageTool.model selects the GPT Image model separately.
 */
async function callImageGeneration(
  inputContent: Array<Record<string, unknown>>,
  imageTool: Record<string, unknown>,
  token: string,
  accountId: string | undefined,
  signal: AbortSignal,
): Promise<Buffer[]> {
  const body: Record<string, unknown> = {
    model: IMAGE_GEN_MODEL,
    store: false,
    stream: true,
    instructions: "Generate the image the user requested.",
    input: [{ role: "user", content: inputContent }],
    tools: [imageTool],
    tool_choice: "auto",
    reasoning: { effort: "low" },
  };

  const response = await fetch(CODEX_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      originator: "ggcoder",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: string; error?: { message?: string } };
      if (parsed.detail) detail = parsed.detail;
      else if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Keep raw text
    }
    throw new Error(`OpenAI Image API (${response.status}): ${detail}`);
  }

  if (!response.body) {
    throw new Error("OpenAI Image API returned no response body.");
  }

  // Read the SSE stream and extract image_generation_call output items.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const imageBuffers: Buffer[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        const evt = JSON.parse(data) as {
          type: string;
          item?: {
            type: string;
            status: string;
            result?: string;
          };
        };
        // The final image data arrives in `response.output_item.done` where
        // item.type is "image_generation_call" and item.status is "completed"
        // (or "generating" — both carry the result). We capture from either,
        // preferring the last one with actual result data.
        if (
          evt.type === "response.output_item.done" &&
          evt.item?.type === "image_generation_call" &&
          evt.item.result
        ) {
          imageBuffers.push(Buffer.from(evt.item.result, "base64"));
        }
      } catch {
        // Partial JSON — skip, the next chunk will complete it.
      }
    }
  }

  return imageBuffers;
}
