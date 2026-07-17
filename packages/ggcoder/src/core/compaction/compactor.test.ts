import { describe, it, expect, vi } from "vitest";
import {
  shouldCompact,
  getCompactionReserveTokens,
  findRecentCutPoint,
  prepareMessagesForSummary,
  selectMessagesInBudget,
  buildFallbackSummary,
  extractSummaryText,
  compact,
  compactHistoricalToolCallArgs,
  HISTORICAL_TOOL_ARG_MAX_CHARS,
  SUMMARY_ATTEMPT_TIMEOUT_MS,
} from "./compactor.js";
import { estimateConversationTokens } from "./token-estimator.js";
import { MODELS, getContextWindow } from "@kenkaiiii/gg-core";
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
    const messages = [
      makeMessage("system", bigContent),
      makeMessage("user", bigContent),
      makeMessage("assistant", bigContent),
      makeMessage("user", bigContent),
    ];
    expect(shouldCompact(messages, 500, 0.8)).toBe(true);
  });

  it("uses default threshold of 0.8", () => {
    const content = "x".repeat(400);
    const messages = [
      makeMessage("system", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
    ];
    const estimated = estimateConversationTokens(messages);
    expect(shouldCompact(messages, Math.ceil(estimated / 0.7))).toBe(false);
    expect(shouldCompact(messages, Math.ceil(estimated / 0.9))).toBe(true);
  });

  it("handles custom threshold", () => {
    const content = "x".repeat(200);
    const messages = [
      makeMessage("system", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
    ];
    const estimated = estimateConversationTokens(messages);
    expect(shouldCompact(messages, estimated * 3, 0.5)).toBe(false);
    expect(shouldCompact(messages, estimated, 0.5)).toBe(true);
  });

  it("respects per-model context window for compaction threshold", () => {
    // Each message: ~10000 chars / 3.5 ≈ 2857 tokens + 4 overhead ≈ 2861 tokens
    // 160 pairs ≈ 160 × 2 × 2861 ≈ 916k tokens
    const messages: Message[] = [makeMessage("system", "sys")];
    for (let i = 0; i < 160; i++) {
      messages.push(makeMessage("user", `msg ${i} ${"x".repeat(10_000)}`));
      messages.push(makeMessage("assistant", `response ${i}`));
    }
    const estimated = estimateConversationTokens(messages);

    const opusContext = getContextWindow("claude-opus-4-8");
    const kimiContext = getContextWindow("kimi-k2.7-code");

    // Sanity: Opus has 1M, Kimi has 256k
    expect(opusContext).toBe(1_000_000);
    expect(kimiContext).toBe(262_144);

    // Under Opus (1M): conversation is under 80% threshold (800k) — no compaction
    expect(shouldCompact(messages, opusContext, 0.8)).toBe(false);
    expect(estimated).toBeLessThan(opusContext * 0.8);

    // Under Kimi (256k): same conversation exceeds 80% threshold (~210k) — must compact
    expect(shouldCompact(messages, kimiContext, 0.8)).toBe(true);
    expect(estimated).toBeGreaterThan(kimiContext * 0.8);
  });

  it("prefers actual API tokens over char-based estimate", () => {
    const messages = [makeMessage("system", "sys"), makeMessage("user", "hello")];
    // Char-based estimate is tiny, but actualTokens says we're over
    expect(shouldCompact(messages, 200_000, 0.8, 170_000)).toBe(true);
    // actualTokens under threshold — no compact despite same messages
    expect(shouldCompact(messages, 200_000, 0.8, 100_000)).toBe(false);
  });

  it("falls back to char-based estimate when actualTokens is undefined", () => {
    const content = "x".repeat(1000);
    // Need >= COMPACTION_MIN_MESSAGES (4) to pass the message count guard
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
    ];
    const estimated = estimateConversationTokens(messages);
    // Set contextWindow so estimated is just over 80%
    const contextWindow = Math.floor(estimated / 0.85);
    expect(shouldCompact(messages, contextWindow, 0.8)).toBe(true);
    expect(shouldCompact(messages, contextWindow, 0.8, undefined)).toBe(true);
  });

  it("skips compaction with too few messages when using char-based estimate", () => {
    const content = "x".repeat(10000);
    const messages = [makeMessage("user", content)];
    // Even if estimated tokens exceed threshold, too few messages → skip
    const contextWindow = 100;
    expect(shouldCompact(messages, contextWindow, 0.8)).toBe(false);
    // But with explicit actualTokens, the guard is bypassed
    expect(shouldCompact(messages, contextWindow, 0.8, 200)).toBe(true);
  });

  it("keeps the deprecated reserve helper source-compatible", () => {
    expect(getCompactionReserveTokens(4_096)).toBe(16_384);
    expect(getCompactionReserveTokens(16_384)).toBe(21_384);
  });

  it("does not let an output-token reserve move the percentage boundary", () => {
    const messages = [makeMessage("user", "x")];
    const contextWindow = 272_000;
    const boundary = Math.ceil(contextWindow * 0.8);

    expect(shouldCompact(messages, contextWindow, 0.8, boundary - 1, 128_000)).toBe(false);
    expect(shouldCompact(messages, contextWindow, 0.8, boundary, 128_000)).toBe(true);
  });
});

// ── Cross-model compaction thresholds ─────────────────────

describe("compaction thresholds across all models", () => {
  const messages = [makeMessage("user", "x")];

  it.each(MODELS)("$id crosses the default boundary at exactly 80%", (model) => {
    const contextWindow = getContextWindow(model.id, { provider: model.provider });
    const boundary = Math.ceil(contextWindow * 0.8);

    expect(contextWindow).toBe(model.contextWindow);
    expect(shouldCompact(messages, contextWindow, undefined, boundary - 1)).toBe(false);
    expect(shouldCompact(messages, contextWindow, undefined, boundary)).toBe(true);
  });

  it.each(MODELS)("$id honors a custom threshold", (model) => {
    const contextWindow = getContextWindow(model.id, { provider: model.provider });
    const customBoundary = Math.ceil(contextWindow * 0.65);

    expect(shouldCompact(messages, contextWindow, 0.65, customBoundary - 1)).toBe(false);
    expect(shouldCompact(messages, contextWindow, 0.65, customBoundary)).toBe(true);
  });

  it.each(MODELS)("$id ignores theoretical output size at the boundary", (model) => {
    const contextWindow = getContextWindow(model.id, { provider: model.provider });
    const boundary = Math.ceil(contextWindow * 0.8);

    expect(shouldCompact(messages, contextWindow, 0.8, boundary - 1, model.maxOutputTokens)).toBe(
      false,
    );
    expect(shouldCompact(messages, contextWindow, 0.8, boundary, model.maxOutputTokens)).toBe(true);
  });

  it("unknown models fall back to a 200k context window", () => {
    expect(getContextWindow("some-unknown-model")).toBe(200_000);
  });

  const openAITransportCases = [
    { id: "gpt-5.6-sol", publicWindow: 1_050_000, codexWindow: 372_000 },
    { id: "gpt-5.6-terra", publicWindow: 1_050_000, codexWindow: 372_000 },
    { id: "gpt-5.6-luna", publicWindow: 1_050_000, codexWindow: 372_000 },
    { id: "gpt-5.5", publicWindow: 1_050_000, codexWindow: 272_000 },
  ] as const;

  it.each(openAITransportCases)("$id uses its public API window without accountId", (testCase) => {
    const contextWindow = getContextWindow(testCase.id, { provider: "openai" });
    const boundary = Math.ceil(testCase.publicWindow * 0.8);

    expect(contextWindow).toBe(testCase.publicWindow);
    expect(shouldCompact(messages, contextWindow, 0.8, boundary - 1)).toBe(false);
    expect(shouldCompact(messages, contextWindow, 0.8, boundary)).toBe(true);
  });

  it.each(openAITransportCases)("$id uses its Codex OAuth window with accountId", (testCase) => {
    const contextWindow = getContextWindow(testCase.id, {
      provider: "openai",
      accountId: "chatgpt-account",
    });
    const boundary = Math.ceil(testCase.codexWindow * 0.8);

    expect(contextWindow).toBe(testCase.codexWindow);
    expect(shouldCompact(messages, contextWindow, 0.8, boundary - 1)).toBe(false);
    expect(shouldCompact(messages, contextWindow, 0.8, boundary)).toBe(true);
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

  it("keeps at least last user→assistant exchange when budget is 0", () => {
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", "hello"),
      makeMessage("assistant", "hi"),
    ];
    const cut = findRecentCutPoint(messages, 0);
    // Budget 0 means nothing fits, but the guard ensures we always keep
    // the last user→assistant pair so compaction never produces empty recent messages.
    expect(cut).toBe(1);
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

  it("converts tool results to truncated user text", () => {
    const longContent = "x".repeat(5000);
    const msgs = [makeToolResultMessage("t1", longContent)];
    const prepared = prepareMessagesForSummary(msgs);

    // Tool messages are converted to user text messages for the summarizer
    expect(prepared[0].role).toBe("user");
    const text = prepared[0].content as string;
    expect(text.length).toBeLessThan(longContent.length);
    expect(text).toContain("truncated");
  });

  it("truncates very long user messages but preserves moderately long ones", () => {
    // Moderately long user messages (under the 8k user cap) are kept verbatim —
    // user turns are the highest-signal content for resuming work.
    const moderate = "x".repeat(5000);
    const keptUnchanged = prepareMessagesForSummary([makeMessage("user", moderate)]);
    expect(keptUnchanged[0].content as string).toBe(moderate);

    // Pathologically long user messages are still capped.
    const huge = "x".repeat(20000);
    const truncated = prepareMessagesForSummary([makeMessage("user", huge)]);
    expect((truncated[0].content as string).length).toBeLessThan(huge.length);
    expect(truncated[0].content as string).toContain("truncated");
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

// ── historical tool-call compaction ───────────────────────

describe("compactHistoricalToolCallArgs", () => {
  it("caps large string arguments without mutating the session history", () => {
    const largeContent = "x".repeat(HISTORICAL_TOOL_ARG_MAX_CHARS * 4);
    const original = makeToolCallMessage("write", { file_path: "large.ts", content: largeContent });

    const [compacted] = compactHistoricalToolCallArgs([original]);
    const compactedCall = (compacted.content as ContentPart[])[0] as ContentPart & {
      type: "tool_call";
      args: { file_path: string; content: string };
    };
    const originalCall = (original.content as ContentPart[])[0] as ContentPart & {
      type: "tool_call";
      args: { content: string };
    };

    expect(compactedCall.args.file_path).toBe("large.ts");
    expect(compactedCall.args.content.length).toBeLessThan(largeContent.length);
    expect(compactedCall.args.content).toContain("more characters truncated");
    expect(originalCall.args.content).toBe(largeContent);
  });

  it("caps large strings nested inside edit arrays", () => {
    const largeEdit = "x".repeat(HISTORICAL_TOOL_ARG_MAX_CHARS * 4);
    const original = makeToolCallMessage("edit", {
      file_path: "large.ts",
      edits: [{ old_text: "before", new_text: largeEdit }],
    });

    const [compacted] = compactHistoricalToolCallArgs([original]);
    const compactedCall = (compacted.content as ContentPart[])[0] as ContentPart & {
      type: "tool_call";
      args: { edits: Array<{ old_text: string; new_text: string }> };
    };

    expect(compactedCall.args.edits[0].old_text).toBe("before");
    expect(compactedCall.args.edits[0].new_text.length).toBeLessThan(largeEdit.length);
    expect(compactedCall.args.edits[0].new_text).toContain("more characters truncated");
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
    model: "claude-sonnet-5",
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
    expect(result.result.compacted).toBe(false);
    expect(result.result.reason).toBe("too_few_messages");
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
    expect(result.result.compacted).toBe(true);
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

  it("uses fallback summary when summary response wait times out", async () => {
    vi.useFakeTimers();
    try {
      const mockStream = vi.mocked(stream);
      mockStream.mockClear();
      mockStream.mockReturnValue(mockStreamResult(new Promise(() => {})) as never);

      const messages = buildConversation(30);
      const promise = compact(messages, baseOptions);
      await vi.advanceTimersByTimeAsync(SUMMARY_ATTEMPT_TIMEOUT_MS + 1);
      const result = await promise;

      expect(mockStream).toHaveBeenCalledTimes(1);
      const summaryMsg = result.messages[1];
      expect(summaryMsg.role).toBe("user");
      expect(summaryMsg.content as string).toContain("## Goal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting past the deadline while the stream is actively emitting events", async () => {
    // Regression: the 30s deadline used to be a HARD total cap, killing every
    // large summary mid-generation (they stream for well over 30s) and forcing
    // the extractive fallback. It is now an INACTIVITY deadline — each stream
    // event re-arms it — so a response that takes 2.5× the timeout but never
    // goes silent longer than the window must produce the REAL summary.
    vi.useFakeTimers();
    try {
      const mockStream = vi.mocked(stream);
      mockStream.mockClear();

      const eventGap = SUMMARY_ATTEMPT_TIMEOUT_MS * 0.66; // each gap < timeout
      const totalDuration = SUMMARY_ATTEMPT_TIMEOUT_MS * 2.5; // total ≫ timeout
      const response = new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              message: { role: "assistant", content: "Real streamed summary." },
              stopReason: "end_turn",
              usage: { inputTokens: 1000, outputTokens: 200 },
            }),
          totalDuration,
        );
      });
      let emitted = 0;
      const iterator = () => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            if (emitted >= 3) {
              resolve({ done: true, value: undefined });
              return;
            }
            emitted++;
            setTimeout(() => resolve({ done: false, value: { type: "text_delta" } }), eventGap);
          }),
      });
      mockStream.mockReturnValue({
        response,
        events: { [Symbol.asyncIterator]: iterator },
        [Symbol.asyncIterator]: iterator,
      } as never);

      const messages = buildConversation(30);
      const promise = compact(messages, baseOptions);
      await vi.advanceTimersByTimeAsync(totalDuration + 1);
      const result = await promise;

      const summaryMsg = result.messages[1];
      expect(summaryMsg.role).toBe("user");
      expect(summaryMsg.content as string).toContain("Real streamed summary.");
      expect(summaryMsg.content as string).not.toContain("## Goal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes AbortSignal to summary stream and rejects without compacting on abort", async () => {
    const mockStream = vi.mocked(stream);
    const ac = new AbortController();
    mockStream.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal).not.toBe(ac.signal);
      return mockStreamResult(
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }) as never,
      ) as never;
    });

    const messages = buildConversation(30);
    const promise = compact(messages, { ...baseOptions, signal: ac.signal });
    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(messages[0]).toEqual(makeMessage("system", "You are a helpful assistant."));
    expect(messages).toHaveLength(62);
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
