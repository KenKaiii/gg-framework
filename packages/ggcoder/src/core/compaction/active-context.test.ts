import { describe, expect, it } from "vitest";
import type { Message, Usage } from "@kenkaiiii/gg-ai";
import { calculateActiveContextTokens } from "./active-context.js";
import { estimateConversationTokens } from "./token-estimator.js";

describe("calculateActiveContextTokens", () => {
  it("estimates the full history before the first provider response", () => {
    const messages: Message[] = [
      { role: "system", content: "system instructions" },
      { role: "user", content: "hello" },
    ];

    expect(calculateActiveContextTokens(messages)).toBe(estimateConversationTokens(messages));
  });

  it("sums input, cache, output, and pending-message tokens exactly once", () => {
    const usage: Usage = {
      inputTokens: 100,
      cacheRead: 30,
      cacheWrite: 20,
      outputTokens: 40,
    };
    const pendingMessages: Message[] = [
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "pending tool output" }],
      },
    ];
    const pendingTokens = estimateConversationTokens(pendingMessages);

    expect(
      calculateActiveContextTokens([{ role: "user", content: "ignored fallback history" }], {
        usage,
        pendingMessages,
      }),
    ).toBe(100 + 30 + 20 + 40 + pendingTokens);
  });

  it("treats absent cache counters as zero", () => {
    const usage: Usage = { inputTokens: 80, outputTokens: 15 };

    expect(calculateActiveContextTokens([], { usage })).toBe(95);
  });
});
