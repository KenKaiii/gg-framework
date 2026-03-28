import { describe, it, expect, beforeAll } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateConversationTokens,
  setEstimatorModel,
} from "./token-estimator.js";
import type { Message } from "@kenkaiiii/gg-ai";

// Use a known model so the chars-per-token ratio is deterministic in tests.
// "claude-sonnet-4-6" → ratio = 3.2
beforeAll(() => {
  setEstimatorModel("claude-sonnet-4-6");
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates using model-specific ratio", () => {
    // claude ratio = 3.2
    expect(estimateTokens("abc")).toBe(1); // ceil(3/3.2) = 1
    expect(estimateTokens("abcdefgh")).toBe(3); // ceil(8/3.2) = 3
    expect(estimateTokens("a".repeat(32))).toBe(10); // ceil(32/3.2) = 10
  });

  it("handles long text", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(313); // ceil(1000/3.2) = 313
  });
});

describe("estimateMessageTokens", () => {
  it("estimates string content message", () => {
    const msg: Message = { role: "user", content: "Hello world" };
    const tokens = estimateMessageTokens(msg);
    // ceil(11/3.2) = 4 + 4 overhead = 8
    expect(tokens).toBe(8);
  });

  it("includes per-message overhead", () => {
    const msg: Message = { role: "user", content: "" };
    // 0 content + 4 overhead
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it("estimates text content parts", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    };
    const tokens = estimateMessageTokens(msg);
    // ceil(5/3.2) = 2 + 4 overhead = 6
    expect(tokens).toBe(6);
  });

  it("estimates tool call parts", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "tc1",
          name: "read_file",
          args: { path: "/foo/bar.ts" },
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // name "read_file" = ceil(9/3.2) = 3
    // args JSON '{"path":"/foo/bar.ts"}' = ceil(21/3.2) = 7
    // + 4 overhead = 14
    expect(tokens).toBe(14);
  });

  it("estimates tool result parts", () => {
    const msg: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "tc1",
          content: "file contents here",
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // "file contents here" = ceil(18/3.2) = 6 + 4 overhead = 10
    expect(tokens).toBe(10);
  });

  it("sums multiple content parts", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the result:" },
        { type: "text", text: "Done" },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // ceil(19/3.2) = 6 + ceil(4/3.2) = 2 + 4 overhead = 12
    expect(tokens).toBe(12);
  });
});

describe("estimateConversationTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  it("sums all message estimates", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." }, // ceil(16/3.2)=5 + 4 = 9
      { role: "user", content: "Hi" }, // ceil(2/3.2)=1 + 4 = 5
    ];
    expect(estimateConversationTokens(messages)).toBe(14);
  });

  it("handles a full conversation with tool calls", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "read foo" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: { p: "foo" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "bar" }],
      },
      { role: "assistant", content: "The file contains: bar" },
    ];
    const total = estimateConversationTokens(messages);
    expect(total).toBeGreaterThan(0);
    // Each message has at least 4 overhead tokens
    expect(total).toBeGreaterThanOrEqual(5 * 4);
  });
});

describe("setEstimatorModel", () => {
  it("uses different ratios for different model families", () => {
    const text = "a".repeat(100);

    setEstimatorModel("claude-opus-4-6");
    const claudeTokens = estimateTokens(text); // 100/3.2 = 32

    setEstimatorModel("gpt-4.1");
    const gptTokens = estimateTokens(text); // 100/3.7 = 28

    setEstimatorModel("glm-5.1");
    const glmTokens = estimateTokens(text); // 100/2.5 = 40

    // GLM should estimate MORE tokens (smaller chars/token ratio = more tokens per char)
    expect(glmTokens).toBeGreaterThan(claudeTokens);
    expect(claudeTokens).toBeGreaterThan(gptTokens);

    // Reset for other tests
    setEstimatorModel("claude-sonnet-4-6");
  });
});
