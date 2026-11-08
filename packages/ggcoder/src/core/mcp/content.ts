import type { ToolExecuteResult } from "@kleio/agent";
import { log } from "../logger.js";
import { previewsForImageBlocks, shrinkToFit } from "../../utils/image.js";
import { stripInvisibleUnicode } from "../../utils/text.js";

/** Media types a provider will accept as an image part. */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Cap on image parts forwarded from a single tool call. An MCP server is
 * third-party code and can return an unbounded array; each image costs real
 * tokens, so keep the rest as a counted note rather than silently blowing up
 * the turn.
 */
const MAX_IMAGES_PER_RESULT = 4;

interface McpImagePart {
  data: string;
  mimeType: string;
}

function record(item: unknown): Record<string, unknown> | null {
  if (item == null || typeof item !== "object") return null;
  return item as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * An MCP image part, per spec: `{ type: "image", data: <base64>, mimeType }`.
 * Validated structurally because the payload crosses a trust boundary — a
 * server can send anything, including a `type` that lies about the shape.
 */
function asImagePart(item: unknown): McpImagePart | null {
  const part = record(item);
  if (!part || part.type !== "image") return null;
  const data = str(part.data);
  if (!data) return null;
  return { data, mimeType: str(part.mimeType) ?? "image/png" };
}

/**
 * An image delivered as an embedded resource rather than an `image` block:
 * `{ type: "resource", resource: { uri, mimeType: "image/png", blob } }`. Servers
 * use this shape when the image also has a URI, and it is just as viewable, so
 * it must not be reduced to a note.
 */
function asEmbeddedImage(item: unknown): McpImagePart | null {
  const part = record(item);
  if (!part || part.type !== "resource") return null;
  const resource = record(part.resource);
  if (!resource) return null;
  const mimeType = str(resource.mimeType);
  const blob = str(resource.blob);
  if (!blob || !mimeType?.startsWith("image/")) return null;
  return { data: blob, mimeType };
}

/**
 * Render a non-image block as text.
 *
 * Every branch returns *something*: a block this function drops is a block the
 * model never learns existed, which is the defect this module exists to fix.
 * `null` means "carries no information" (an empty text block), not "unsupported".
 */
function asText(item: unknown, toolName: string): string | null {
  const part = record(item);
  if (!part) return null;

  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? part.text : null;

    // Audio is not viewable by any provider we target; name it so the model can
    // say what it received rather than behaving as though nothing came back.
    case "audio":
      return `[${toolName} returned audio (${str(part.mimeType) ?? "unknown format"})]`;

    // A link is a reference, not content: pass the address through so the model
    // can fetch or cite it.
    case "resource_link": {
      const label = str(part.title) ?? str(part.name);
      const uri = str(part.uri) ?? "(no uri)";
      return label ? `[resource link: ${label}] ${uri}` : `[resource link] ${uri}`;
    }

    case "resource": {
      const resource = record(part.resource);
      if (!resource) return null;
      const uri = str(resource.uri) ?? "(no uri)";
      // An embedded text resource carries its content inline — this is usually
      // the substantive answer (a file, a query result), so surface it in full
      // under a header rather than describing it.
      const text = typeof resource.text === "string" ? resource.text : undefined;
      if (text !== undefined) return `[resource ${uri}]\n${text}`;
      const blob = str(resource.blob);
      if (blob) {
        // Non-image binary: unusable by the model, but its existence and size
        // are what let it reason about what the server actually returned.
        const kind = str(resource.mimeType) ?? "binary";
        return `[resource ${uri} (${kind}, ${Buffer.byteLength(blob, "base64")} bytes) omitted]`;
      }
      return `[resource ${uri}]`;
    }

    default:
      // Unknown block type: a future spec addition. Prefer a fallback over
      // silence, but only when it actually carries text.
      return typeof part.text === "string" ? part.text : null;
  }
}

/**
 * Convert an MCP tool's content array into a result the model can actually
 * consume, covering the whole `ContentBlock` union rather than text alone.
 *
 * Text-only results stay plain strings so the overwhelmingly common path keeps
 * its existing shape (and the agent loop's string budgeting still applies).
 * Images are re-encoded through {@link shrinkToFit}, the same helper the `read`
 * tool uses: an unbounded screenshot from a third-party server would otherwise
 * exceed provider size limits and fail the whole turn. A media type the buffer
 * contradicts is corrected there too, since providers reject mismatches.
 *
 * Anything not viewable — audio, a resource link, a binary blob, an unreadable
 * image — becomes a text note instead of vanishing. A block silently dropped is
 * one the model never learns existed, so it answers as though the server
 * returned nothing; a note lets it say what it actually got.
 *
 * All text is stripped of invisible Unicode tag characters first. This is the
 * single point every MCP server's output passes through on its way into the
 * model's context, and a third-party server is exactly the party that would
 * hide instructions where neither the user nor the transcript can show them.
 */
export async function toToolResult(
  content: unknown[],
  toolName: string,
): Promise<ToolExecuteResult> {
  const texts: string[] = [];
  const rawImages: McpImagePart[] = [];
  let hiddenChars = 0;

  for (const item of content) {
    const image = asImagePart(item) ?? asEmbeddedImage(item);
    if (image) {
      rawImages.push(image);
      continue;
    }
    const text = asText(item, toolName);
    if (text === null) continue;
    const clean = stripInvisibleUnicode(text);
    hiddenChars += clean.stripped;
    texts.push(clean.text);
  }

  if (hiddenChars > 0) {
    // Never silent: a stripped payload is an attempted injection, and the user
    // deserves to know which server sent it.
    log("WARN", "mcp", "Stripped invisible Unicode tag characters from MCP tool output", {
      tool: toolName,
      stripped: hiddenChars,
    });
  }

  if (rawImages.length === 0) {
    return texts.join("\n") || "(empty response)";
  }

  const dropped = rawImages.length - MAX_IMAGES_PER_RESULT;
  const kept = dropped > 0 ? rawImages.slice(0, MAX_IMAGES_PER_RESULT) : rawImages;

  const parts: (
    | { type: "text"; text: string }
    | {
        type: "image";
        mediaType: string;
        data: string;
      }
  )[] = [];

  for (const image of kept) {
    try {
      const raw = Buffer.from(image.data, "base64");
      if (raw.length === 0) {
        parts.push({ type: "text", text: `[${toolName} returned an empty image]` });
        continue;
      }
      const { buffer, mediaType } = await shrinkToFit(raw, image.mimeType);
      if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        parts.push({
          type: "text",
          text: `[${toolName} returned an image in unsupported format ${mediaType}]`,
        });
        continue;
      }
      parts.push({ type: "image", mediaType, data: buffer.toString("base64") });
    } catch (err) {
      // A malformed or undecodable image must not fail the tool call: the text
      // parts of the same response are often the substantive answer.
      const reason = err instanceof Error ? err.message : String(err);
      log("WARN", "mcp", "Dropping unreadable MCP image part", { tool: toolName, reason });
      parts.push({ type: "text", text: `[${toolName} returned an unreadable image]` });
    }
  }

  const notes: string[] = [...texts];
  if (dropped > 0) {
    notes.push(`[${dropped} further image${dropped === 1 ? "" : "s"} omitted]`);
  }

  // Text first: it frames the images for the model, and matches `read`'s order.
  const leading = notes.join("\n");
  const imagePreviews = await previewsForImageBlocks(parts);
  return {
    content: leading ? [{ type: "text", text: leading }, ...parts] : parts,
    ...(imagePreviews.length > 0 ? { details: { imagePreviews } } : {}),
  };
}
