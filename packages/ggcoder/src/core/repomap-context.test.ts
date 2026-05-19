import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  REPO_MAP_CONTEXT_ACK,
  REPO_MAP_MARKER,
  getLatestUserText,
  injectRepoMapContextMessages,
  isRepoMapAckMessage,
  isRepoMapMessage,
  stripRepoMapContextMessages,
} from "./repomap-context.js";

describe("repomap context messages", () => {
  it("injects repo map context immediately before the latest real user prompt", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "previous request" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "current request" },
    ];

    const injected = injectRepoMapContextMessages(messages, `${REPO_MAP_MARKER}\nmap`);

    expect(injected.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(injected[3]).toMatchObject({ role: "user", content: `${REPO_MAP_MARKER}\nmap` });
    expect(injected[4]).toMatchObject({ role: "assistant", content: REPO_MAP_CONTEXT_ACK });
    expect(injected[5]).toMatchObject({ role: "user", content: "current request" });
  });

  it("strips repo map and acknowledgement messages without removing real chat", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: `${REPO_MAP_MARKER}\nmap` },
      { role: "assistant", content: REPO_MAP_CONTEXT_ACK },
      { role: "user", content: "current request" },
    ];

    expect(stripRepoMapContextMessages(messages)).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "current request" },
    ]);
    expect(isRepoMapMessage(messages[1]!)).toBe(true);
    expect(isRepoMapAckMessage(messages[2]!)).toBe(true);
  });

  it("uses the latest non-repomap user text as focus context", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "current request" },
      { role: "user", content: `${REPO_MAP_MARKER}\nmap` },
    ];

    expect(getLatestUserText(messages)).toBe("current request");
  });
});
