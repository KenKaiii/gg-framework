import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { messagesToHistoryItems } from "../cli.js";
import { stripDoneMarkers } from "../utils/plan-steps.js";

function assistantText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("continue replay inventory high-risk classes", () => {
  it("replays persisted DONE markers like live assistant display", () => {
    const persisted: Message[] = [
      {
        role: "assistant",
        content: "Implemented the first step. [DONE:1]\nContinuing with the next one.",
      },
    ];

    const history = messagesToHistoryItems(persisted);

    expect(history).toMatchObject([
      { kind: "assistant", text: "Implemented the first step. " },
      { kind: "step_done", stepNum: 1, description: "" },
      { kind: "assistant", text: "Continuing with the next one." },
    ]);
    expect(JSON.stringify(history)).not.toContain("[DONE:1]");
  });

  it("documents that live plan display strips DONE markers from assistant text", () => {
    const persisted: Message = {
      role: "assistant",
      content: "Implemented the first step. [DONE:1]\nContinuing with the next one.",
    };

    const rawRestoredAssistantText = assistantText(persisted.content);
    const liveDisplayAssistantText = stripDoneMarkers(rawRestoredAssistantText);

    expect(rawRestoredAssistantText).toContain("[DONE:1]");
    expect(liveDisplayAssistantText).not.toContain("[DONE:1]");
    expect(liveDisplayAssistantText).toContain("Implemented the first step.");
  });
});
