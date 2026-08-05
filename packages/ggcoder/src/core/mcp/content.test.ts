import { describe, expect, it, vi } from "vitest";
import { mcpContentToToolResult } from "./client.js";

// A 1x1 PNG. Small enough that shrinkToFit is a no-op if sharp is present, and
// harmless if it is not (the helper falls back to the original bytes).
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("mcpContentToToolResult", () => {
  it("returns a plain string for text-only content", async () => {
    const result = await mcpContentToToolResult([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(result).toBe("first\nsecond");
  });

  it("forwards an image-only response as image content", async () => {
    const result = await mcpContentToToolResult([
      { type: "image", data: PNG_1X1, mimeType: "image/png" },
    ]);
    expect(typeof result).toBe("object");
    const content = (result as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("keeps text and image parts in order when both are present", async () => {
    const result = await mcpContentToToolResult([
      { type: "text", text: "screenshot of the frame" },
      { type: "image", data: PNG_1X1, mimeType: "image/jpeg" },
    ]);
    const content = (result as { content: Array<{ type: string }> }).content;
    expect(content.map((p) => p.type)).toEqual(["text", "image"]);
  });

  it("reads text out of an embedded resource", async () => {
    const result = await mcpContentToToolResult([
      { type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
    ]);
    expect(result).toBe("body");
  });

  it("forwards an image blob carried by an embedded resource", async () => {
    const result = await mcpContentToToolResult([
      {
        type: "resource",
        resource: { uri: "file:///a.png", mimeType: "image/png", blob: PNG_1X1 },
      },
    ]);
    const content = (result as { content: Array<{ type: string }> }).content;
    expect(content[0]?.type).toBe("image");
  });

  it("notes an unsupported image type instead of dropping it", async () => {
    const result = await mcpContentToToolResult([
      { type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" },
    ]);
    expect(result).toContain("image/svg+xml");
  });

  it("still reports an empty response when nothing is mappable", async () => {
    expect(await mcpContentToToolResult([])).toBe("(empty response)");
    expect(await mcpContentToToolResult([{ type: "audio", data: "x" }])).toBe("(empty response)");
  });

  it("ignores malformed entries without throwing", async () => {
    const result = await mcpContentToToolResult([null, 42, { type: "image" }, { text: "ok" }]);
    expect(result).toBe("ok");
  });

  it("does not lose the image when downscaling fails", async () => {
    vi.resetModules();
    const result = await mcpContentToToolResult([
      { type: "image", data: "not-valid-base64-image", mimeType: "image/png" },
    ]);
    const content = (result as { content: Array<{ type: string; data: string }> }).content;
    expect(content[0]?.type).toBe("image");
    expect(content[0]?.data).toBe("not-valid-base64-image");
  });
});
