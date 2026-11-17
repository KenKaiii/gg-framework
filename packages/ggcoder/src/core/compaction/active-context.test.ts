import { describe, expect, it } from "vitest";
import type { Message, Usage } from "@kenkaiiii/gg-ai";
import { calculateActiveContextTokens } from "./active-context.js";
import { shouldCompact } from "./compactor.js";
import { resolveCompactionPolicy } from "./policy.js";
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

  it("triggers Codex compaction at 85% from normalized usage plus pending messages", () => {
    const policy = resolveCompactionPolicy({
      provider: "openai",
      model: "gpt-6.2-sol",
      contextWindow: 272_000,
      accountId: "chatgpt-account",
    });
    const pendingMessages: Message[] = [{ role: "user", content: "x".repeat(3_500) }];
    const usage: Usage = {
      inputTokens: 180_000,
      cacheRead: 30_000,
      cacheWrite: 19_500,
      outputTokens: 1_000,
    };
    const activeTokens = calculateActiveContextTokens([], { usage, pendingMessages });

    expect(policy.targetTokens).toBe(231_200);
    expect(activeTokens).toBeGreaterThanOrEqual(policy.targetTokens);
    expect(shouldCompact([], 272_000, policy.threshold, activeTokens)).toBe(true);
  });
});
