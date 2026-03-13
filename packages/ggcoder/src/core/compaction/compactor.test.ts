import { describe, it, expect, vi } from "vitest";
import {
  shouldCompact,
  findRecentCutPoint,
  prepareMessagesForSummary,
  selectMessagesInBudget,
  buildFallbackSummary,
  extractSummaryText,
  compact,
} from "./compactor.js";
import { estimateConversationTokens } from "./token-estimator.js";
import type { Message, ContentPart, ToolResult } from "@kenkaiiii/gg-ai";

// ── Helpers ────────────────────────────────────────────────

function makeMessage(role: "system", content: string): Message;
function makeMessage(role: "user", content: string): Message;
function makeMessage(role: "assistant", content: string): Message;
function makeMessage(role: Message["role"], content: string): Message {
  return { role, content } as Message;
}

function makeToolCallMessage(
  name = "read",
  args: Record<string, unknown> = { file_path: "foo.ts" },
  id = "t1",
): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, args }],
  };
}

function makeToolResultMessage(toolCallId = "t1", content = "file contents"): Message {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId, content }],
  };
}

function makeAssistantWithThinking(text: string, thinking: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "thinking", text: thinking, signature: "sig123" },
      { type: "text", text },
    ] as ContentPart[],
  };
}

// ── shouldCompact ──────────────────────────────────────────

describe("shouldCompact", () => {
  it("returns false when under threshold", () => {
    const messages = [makeMessage("system", "sys"), makeMessage("user", "hello")];
    expect(shouldCompact(messages, 200_000, 0.8)).toBe(false);
  });

  it("returns true when over threshold", () => {
    const bigContent = "x".repeat(1000);
    const messages = [makeMessage("system", bigContent), makeMessage("user", bigContent)];
    expect(shouldCompact(messages, 500, 0.8)).toBe(true);
  });

  it("uses default threshold of 0.8", () => {
    const content = "x".repeat(400);
    const messages = [makeMessage("user", content)];
    const estimated = estimateConversationTokens(messages);
    expect(shouldCompact(messages, Math.ceil(estimated / 0.7))).toBe(false);
    expect(shouldCompact(messages, Math.ceil(estimated / 0.9))).toBe(true);
  });

  it("handles custom threshold", () => {
    const content = "x".repeat(200);
    const messages = [makeMessage("user", content)];
    const estimated = estimateConversationTokens(messages);
    expect(shouldCompact(messages, estimated * 3, 0.5)).toBe(false);
    expect(shouldCompact(messages, estimated, 0.5)).toBe(true);
  });
});

// ── findRecentCutPoint ─────────────────────────────────────

describe("findRecentCutPoint", () => {
  it("keeps all messages when total tokens are under budget", () => {
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", "hello"),
      makeMessage("assistant", "hi"),
    ];
    const cut = findRecentCutPoint(messages, 100_000);
    expect(cut).toBe(1);
  });

  it("keeps only recent messages when total exceeds budget", () => {
    const big = "x".repeat(400);
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", big),
      makeMessage("assistant", big),
      makeMessage("user", big),
      makeMessage("assistant", big),
      makeMessage("user", "last"),
    ];
    const cut = findRecentCutPoint(messages, 120);
    expect(cut).toBeGreaterThan(1);
    expect(cut).toBeLessThan(messages.length);
  });

  it("never cuts at index 0 (system message)", () => {
    const messages = [makeMessage("system", "sys"), makeMessage("user", "hi")];
    const cut = findRecentCutPoint(messages, 100_000);
    expect(cut).toBeGreaterThanOrEqual(1);
  });

  it("does not split tool_call and tool_result pairs", () => {
    const big = "x".repeat(400);
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", big),
      makeToolCallMessage(),
      makeToolResultMessage(),
      makeMessage("user", "thanks"),
    ];
    const cut = findRecentCutPoint(messages, 50);
    if (cut < messages.length) {
      expect(messages[cut].role).not.toBe("tool");
    }
  });

  it("handles conversation with only system message", () => {
    const messages = [makeMessage("system", "sys")];
    const cut = findRecentCutPoint(messages, 100);
    expect(cut).toBe(1);
  });

  it("returns length when budget is 0", () => {
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", "hello"),
      makeMessage("assistant", "hi"),
    ];
    const cut = findRecentCutPoint(messages, 0);
    expect(cut).toBe(messages.length);
  });
});

// ── prepareMessagesForSummary ──────────────────────────────

describe("prepareMessagesForSummary", () => {
  it("strips thinking blocks from assistant messages", () => {
    const msgs = [makeAssistantWithThinking("Hello there", "Let me think about this...")];
    const prepared = prepareMessagesForSummary(msgs);

    const content = prepared[0].content as ContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("truncates long tool results", () => {
    const longContent = "x".repeat(5000);
    const msgs = [makeToolResultMessage("t1", longContent)];
    const prepared = prepareMessagesForSummary(msgs);

    const results = prepared[0].content as ToolResult[];
    expect(results[0].content.length).toBeLessThan(longContent.length);
    expect(results[0].content).toContain("truncated");
  });

  it("truncates long user messages", () => {
    const longContent = "x".repeat(5000);
    const msgs = [makeMessage("user", longContent)];
    const prepared = prepareMessagesForSummary(msgs);

    expect((prepared[0].content as string).length).toBeLessThan(longContent.length);
    expect(prepared[0].content as string).toContain("truncated");
  });

  it("truncates long assistant text parts", () => {
    const longText = "x".repeat(5000);
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "text", text: longText }] as ContentPart[] },
    ];
    const prepared = prepareMessagesForSummary(msgs);

    const content = prepared[0].content as ContentPart[];
    const textPart = content[0] as { type: "text"; text: string };
    expect(textPart.text.length).toBeLessThan(longText.length);
    expect(textPart.text).toContain("truncated");
  });

  it("does not mutate original messages", () => {
    const longContent = "x".repeat(5000);
    const original = makeToolResultMessage("t1", longContent);
    const originalContent = (original.content as ToolResult[])[0].content;

    prepareMessagesForSummary([original]);

    // Original should be unchanged
    expect((original.content as ToolResult[])[0].content).toBe(originalContent);
    expect((original.content as ToolResult[])[0].content.length).toBe(5000);
  });

  it("passes through short messages unchanged", () => {
    const msgs = [makeMessage("user", "hello")];
    const prepared = prepareMessagesForSummary(msgs);
    expect(prepared[0].content).toBe("hello");
  });

  it("returns empty string content when all parts are thinking blocks", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", text: "deep thoughts", signature: "sig" }] as ContentPart[],
      },
    ];
    const prepared = prepareMessagesForSummary(msgs);
    expect(prepared[0].content).toBe("");
  });
});

// ── selectMessagesInBudget ─────────────────────────────────

describe("selectMessagesInBudget", () => {
  it("selects all messages when budget is large", () => {
    const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "hi")];
    const selected = selectMessagesInBudget(msgs, 100_000);
    expect(selected).toHaveLength(2);
  });

  it("selects no messages when budget is 0", () => {
    const msgs = [makeMessage("user", "hello")];
    const selected = selectMessagesInBudget(msgs, 0);
    expect(selected).toHaveLength(0);
  });

  it("stops when budget is exceeded", () => {
    const big = "x".repeat(2000); // ~500 tokens each + overhead
    const msgs = [
      makeMessage("user", big),
      makeMessage("assistant", big),
      makeMessage("user", big),
      makeMessage("assistant", big),
    ];
    const selected = selectMessagesInBudget(msgs, 600);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(msgs.length);
  });

  it("walks forward from start", () => {
    const msgs = [
      makeMessage("user", "first"),
      makeMessage("assistant", "second"),
      makeMessage("user", "third"),
    ];
    const selected = selectMessagesInBudget(msgs, 100_000);
    expect(selected[0].content as string).toBe("first");
    expect(selected[2].content as string).toBe("third");
  });
});

// ── buildFallbackSummary ───────────────────────────────────

describe("buildFallbackSummary", () => {
  it("includes goal from first user message", () => {
    const msgs = [
      makeMessage("user", "Fix the login bug"),
      makeMessage("assistant", "I'll look into it"),
    ];
    const summary = buildFallbackSummary(msgs, { read: new Set(), modified: new Set() });
    expect(summary).toContain("Fix the login bug");
    expect(summary).toContain("## Goal");
  });

  it("includes message and tool call counts", () => {
    const msgs = [
      makeMessage("user", "Fix it"),
      makeToolCallMessage(),
      makeToolResultMessage(),
      makeMessage("assistant", "Done"),
    ];
    const summary = buildFallbackSummary(msgs, { read: new Set(), modified: new Set() });
    expect(summary).toContain("## Progress");
    expect(summary).toContain("4 messages exchanged");
    expect(summary).toContain("1 tool calls executed");
  });

  it("includes read files", () => {
    const fileOps = {
      read: new Set(["src/foo.ts", "src/bar.ts"]),
      modified: new Set<string>(),
    };
    const summary = buildFallbackSummary([makeMessage("user", "Check files")], fileOps);
    expect(summary).toContain("## Files Read");
    expect(summary).toContain("src/foo.ts");
    expect(summary).toContain("src/bar.ts");
  });

  it("includes modified files", () => {
    const fileOps = {
      read: new Set<string>(),
      modified: new Set(["src/main.ts"]),
    };
    const summary = buildFallbackSummary([makeMessage("user", "Edit main")], fileOps);
    expect(summary).toContain("## Files Modified");
    expect(summary).toContain("src/main.ts");
  });

  it("handles no user messages gracefully", () => {
    const summary = buildFallbackSummary([makeMessage("assistant", "Something")], {
      read: new Set(),
      modified: new Set(),
    });
    expect(summary).toContain("could not determine");
  });

  it("truncates very long first user message", () => {
    const longMsg = "x".repeat(1000);
    const summary = buildFallbackSummary([makeMessage("user", longMsg)], {
      read: new Set(),
      modified: new Set(),
    });
    expect(summary.length).toBeLessThan(longMsg.length);
  });
});

// ── extractSummaryText ─────────────────────────────────────

describe("extractSummaryText", () => {
  it("returns string content directly", () => {
    expect(extractSummaryText("Hello summary")).toBe("Hello summary");
  });

  it("extracts text from ContentPart array", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Part one. " },
      { type: "text", text: "Part two." },
    ];
    expect(extractSummaryText(parts)).toBe("Part one. Part two.");
  });

  it("filters out non-text parts", () => {
    const parts: ContentPart[] = [
      { type: "thinking", text: "hmm", signature: "sig" },
      { type: "text", text: "The summary." },
    ];
    expect(extractSummaryText(parts)).toBe("The summary.");
  });

  it("returns empty string for empty array", () => {
    expect(extractSummaryText([])).toBe("");
  });

  it("returns empty string for array with only thinking parts", () => {
    const parts: ContentPart[] = [{ type: "thinking", text: "hmm", signature: "sig" }];
    expect(extractSummaryText(parts)).toBe("");
  });
});

// ── compact (integration) ──────────────────────────────────

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stream: vi.fn(),
  };
});

// Must import stream AFTER mock setup
import { stream } from "@kenkaiiii/gg-ai";

describe("compact", () => {
  const baseOptions = {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6-20250514",
    apiKey: "test-key",
    contextWindow: 200_000,
  };

  // Each user message: ~20 + 10000 chars ≈ 2504 tokens + 4 overhead ≈ 2508 tokens
  // Each assistant: ~12 chars ≈ 7 tokens
  // 30 pairs ≈ 30 × 2515 ≈ 75K tokens total (well over 20K recent budget)
  function buildConversation(middleCount: number): Message[] {
    const msgs: Message[] = [makeMessage("system", "You are a helpful assistant.")];
    for (let i = 0; i < middleCount; i++) {
      const big = `Message content ${i} ${"x".repeat(10_000)}`;
      msgs.push(makeMessage("user", big));
      msgs.push(makeMessage("assistant", `Response ${i}`));
    }
    // Add a recent small message
    msgs.push(makeMessage("user", "latest question"));
    return msgs;
  }

  /** Build a mock StreamResult-like object that resolves to the given response. */
  function mockStreamResult(
    response: Promise<{
      message: { role: string; content: string };
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }>,
  ) {
    // Suppress unhandled rejection for error mocks
    response.catch(() => {});
    return {
      response,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true as const, value: undefined }),
        }),
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    };
  }

  it("skips compaction when too few middle messages", async () => {
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", "hi"),
      makeMessage("assistant", "hello"),
    ];

    const result = await compact(messages, baseOptions);
    expect(result.result.originalCount).toBe(3);
    expect(result.result.newCount).toBe(3);
    expect(result.messages).toHaveLength(3);
  });

  it("produces summary message with LLM response", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "This is a great summary of the conversation." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 200 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);

    // Should have: system + summary + assistant ack + recent messages
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.result.originalCount).toBe(messages.length);

    // The summary message should contain the LLM's summary
    const summaryMsg = result.messages[1];
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.content as string).toContain("[Previous conversation summary]");
    expect(summaryMsg.content as string).toContain("great summary");
  });

  it("uses fallback summary when LLM returns empty", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "" },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 0 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);

    const summaryMsg = result.messages[1];
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.content as string).toContain("[Previous conversation summary]");
    expect(summaryMsg.content as string).toContain("## Goal");
    expect(summaryMsg.content as string).toContain("## Progress");
  });

  it("uses fallback summary when LLM throws error", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(mockStreamResult(Promise.reject(new Error("API error"))) as never);

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);

    const summaryMsg = result.messages[1];
    expect(summaryMsg.content as string).toContain("## Goal");
  });

  it("preserves system message", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary text here." },
          stopReason: "end_turn",
          usage: { inputTokens: 500, outputTokens: 100 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);

    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("does not end with an assistant message", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 500, outputTokens: 50 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);

    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).not.toBe("assistant");
  });

  it("retries on empty response before falling back", async () => {
    const mockStream = vi.mocked(stream);
    let callCount = 0;
    mockStream.mockImplementation(() => {
      callCount++;
      const content = callCount <= 2 ? "" : "Summary on third try.";
      return mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content },
          stopReason: "end_turn",
          usage: { inputTokens: 500, outputTokens: callCount <= 2 ? 0 : 100 },
        }),
      ) as never;
    });

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);

    // Should have retried and gotten the summary on the 3rd attempt
    expect(callCount).toBe(3);
    const summaryMsg = result.messages[1];
    expect(summaryMsg.content as string).toContain("Summary on third try");
  });
});
