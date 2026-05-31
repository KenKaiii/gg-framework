import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "../utils/image.js";
import { buildUserContentWithAttachments, routePromptCommandInput } from "./prompt-routing.js";

describe("prompt-template slash commands with attachments", () => {
  it("routes /expand input to a wrapper containing user args", () => {
    const route = routePromptCommandInput("/expand do X");

    expect(route).not.toBeNull();
    expect(route?.cmdName).toBe("expand");
    expect(route?.cmdArgs).toBe("do X");
    expect(route?.fullPrompt).toContain(route?.promptText);
    expect(route?.fullPrompt).toContain("## User Instructions");
    expect(route?.fullPrompt).toContain("do X");
  });

  it("routes markdown and multiline text without losing rendered edge cases", () => {
    const args = "prove **bold** UI renders\n- keep `code` text\n- wrap very long labels";
    const route = routePromptCommandInput(`/expand ${args}`);

    expect(route).toMatchObject({ cmdName: "expand", cmdArgs: args });
    expect(route?.fullPrompt).toContain(`## User Instructions\n\n${args}`);
    expect(route?.fullPrompt).toContain("**bold** UI renders");
    expect(route?.fullPrompt).toContain("`code` text");
  });

  it("does not route an unknown command", () => {
    expect(routePromptCommandInput("/not-a-command do X")).toBeNull();
  });

  it("builds multimodal user content with the full prompt text and image block", () => {
    const fullPrompt = "Command prompt\n\n## User Instructions\n\ndo X";
    const imageAttachment: ImageAttachment = {
      kind: "image",
      fileName: "screenshot.png",
      filePath: "/tmp/screenshot.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    };

    const content = buildUserContentWithAttachments(fullPrompt, [imageAttachment], true);

    expect(content).toEqual([
      { type: "text", text: fullPrompt },
      { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
    ]);
  });

  it("wraps text attachments in file-tag text blocks", () => {
    const textAttachment: ImageAttachment = {
      kind: "text",
      fileName: "notes.txt",
      filePath: "/tmp/notes.txt",
      mediaType: "text/plain",
      data: "important context",
    };

    const content = buildUserContentWithAttachments("Analyze this", [textAttachment], true);

    expect(content).toEqual([
      { type: "text", text: "Analyze this" },
      { type: "text", text: '<file name="notes.txt">\nimportant context\n</file>' },
    ]);
  });

  it("returns the original prompt string when no attachments are provided", () => {
    const fullPrompt = "Command prompt\n\n## User Instructions\n\ndo X";

    expect(buildUserContentWithAttachments(fullPrompt, [], true)).toBe(fullPrompt);
  });
});
