import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { normalizeMessageImages } from "./message-images.js";

async function oversizedPng(): Promise<Buffer> {
  const sharpModule = await import("sharp");
  return sharpModule
    .default({
      create: {
        width: 2400,
        height: 1200,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
    .png()
    .toBuffer();
}

describe("normalizeMessageImages", () => {
  it("repairs oversized images restored in user and tool-result history", async () => {
    const original = await oversizedPng();
    const data = original.toString("base64");
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "tool-1",
            content: [{ type: "image", mediaType: "image/png", data }],
          },
        ],
      },
    ];

    expect(await normalizeMessageImages(messages)).toBe(2);

    const userMessage = messages[0]!;
    const toolMessage = messages[1]!;
    if (userMessage.role !== "user" || toolMessage.role !== "tool") {
      throw new Error("Unexpected test message shape");
    }
    const userContent = userMessage.content;
    if (typeof userContent === "string") throw new Error("Expected user image content");
    const userImage = userContent[0]!;
    const toolResultContent = toolMessage.content[0]!.content;
    if (userImage.type !== "image" || typeof toolResultContent === "string") {
      throw new Error("Expected image blocks");
    }
    const toolImage = toolResultContent[0]!;
    if (toolImage.type !== "image") throw new Error("Expected tool-result image block");

    const sharpModule = await import("sharp");
    for (const image of [userImage, toolImage]) {
      const metadata = await sharpModule.default(Buffer.from(image.data, "base64")).metadata();
      expect(metadata.width).toBeLessThanOrEqual(2000);
      expect(metadata.height).toBeLessThanOrEqual(2000);
    }
  });
});
