import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { messagesToHistoryItems } from "../cli.js";
import { PROMPT_COMMANDS } from "./prompt-commands.js";
import { DISPLAY_ITEM_CUSTOM_KIND, SessionManager, type SessionEntry } from "./session-manager.js";
import { getRestoredMessagesForDisplay } from "./session-compaction.js";

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text" && "text" in block,
    )
    .map((block) => block.text)
    .join("\n");
}

function replayTexts(messages: readonly Message[]): string[] {
  return getRestoredMessagesForDisplay(messages).map((message) => extractText(message.content));
}

function replayHistory(messages: Message[]) {
  return messagesToHistoryItems(getRestoredMessagesForDisplay(messages));
}

describe("continued session replay display filtering", () => {
  it("prefers persisted display items for exact continued-session replay", () => {
    const sessionManager = new SessionManager("/tmp/unused");
    const persisted: SessionEntry[] = [
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: "message fallback" },
      },
      {
        type: "custom",
        kind: DISPLAY_ITEM_CUSTOM_KIND,
        data: {
          version: 1,
          item: {
            kind: "info",
            text: "Session cleared.",
            id: "display-info",
          },
        },
        id: "display-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];

    expect(sessionManager.getDisplayItems(persisted, "msg-1")).toEqual([
      { kind: "info", text: "Session cleared.", id: "display-info" },
    ]);
  });

  it("restores every built-in prompt-template slash command as typed command text", () => {
    for (const command of PROMPT_COMMANDS) {
      const persisted: Message[] = [
        {
          role: "user",
          content: `${command.prompt}\n\n## User Instructions\n\nship the feature`,
        },
      ];

      expect(replayHistory(persisted)).toMatchObject([
        { kind: "user", text: `/${command.name} ship the feature` },
      ]);
    }
  });

  it("keeps compact restore/system control out of display but preserves normal slash-command text", () => {
    const persisted: Message[] = [
      { role: "system", content: "internal system control should remain hidden" },
      { role: "user", content: "/help" },
      { role: "assistant", content: "Here are the available commands." },
    ];

    const replayedText = replayTexts(persisted).join("\n");

    expect(replayedText).not.toContain("internal system control");
    expect(replayedText).toContain("/help");
    expect(replayedText).toContain("Here are the available commands.");
  });
});
