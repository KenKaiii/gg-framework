import type { ImageContent, Message } from "@kenkaiiii/gg-ai";
import { shrinkToFit } from "../utils/image.js";

function imageBlocks(message: Message): ImageContent[] {
  if (message.role === "system" || typeof message.content === "string") return [];

  const images: ImageContent[] = [];
  if (message.role === "tool") {
    for (const result of message.content) {
      if (typeof result.content === "string") continue;
      for (const block of result.content) {
        if (block.type === "image") images.push(block);
      }
    }
    return images;
  }

  for (const block of message.content) {
    if (block.type === "image") images.push(block);
  }
  return images;
}

/**
 * Repair images restored from older sessions that predate attachment resizing.
 *
 * Anthropic accepts images up to 8000 px normally, but lowers the limit to
 * 2000 px per side once the full request history contains more than 20 images.
 * Mutating the in-memory blocks prevents an old oversized image from poisoning
 * every later turn; malformed blocks are left alone so session loading remains
 * best-effort.
 */
export async function normalizeMessageImages(messages: Message[]): Promise<number> {
  let normalizedCount = 0;

  for (const message of messages) {
    for (const block of imageBlocks(message)) {
      try {
        const original = Buffer.from(block.data, "base64");
        const resized = await shrinkToFit(original, block.mediaType);
        if (resized.buffer !== original || resized.mediaType !== block.mediaType) {
          block.data = resized.buffer.toString("base64");
          block.mediaType = resized.mediaType;
          normalizedCount++;
        }
      } catch {
        // A bad historical image should not make the entire session unloadable.
      }
    }
  }

  return normalizedCount;
}
