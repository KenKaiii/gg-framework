import { describe, it, expect, vi } from "vitest";
import {
  shouldCompact,
  getCompactionReserveTokens,
  findRecentCutPoint,
  prepareMessagesForSummary,
  selectMessagesInBudget,
  classifyMessagesForSummary,
  findLatestPreviousSummary,
  buildFallbackSummary,
  extractSummaryText,
  compact,
  compactHistoricalToolCallArgs,
  extractFileOperations,
  splitTrackedModifiedFiles,
  buildModifiedFilesSection,
  extractFailingTests,
  extractTestSignals,
  splitTrackedFailingTests,
  buildFailingTestsSection,
  MAX_TRACKED_FAILING_TESTS,
  resolveSummaryOutputTokens,
  HISTORICAL_TOOL_ARG_MAX_CHARS,
  MAX_TRACKED_MODIFIED_FILES,
  MIN_SUMMARY_OUTPUT_TOKENS,
  MAX_SUMMARY_OUTPUT_TOKENS,
  SUMMARY_ATTEMPT_TIMEOUT_MS,
} from "./compactor.js";
import { remapAnchorForCompaction } from "../session-history.js";
import { estimateConversationTokens } from "./token-estimator.js";
import {
  MODELS,
  getContextWindow,
  registerRuntimeModels,
  clearRuntimeModels,
  toModelInfo,
  DEFAULT_LOCAL_ENDPOINTS,
} from "@kenkaiiii/gg-core";
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

  it("uses default threshold of 0.85", () => {
    const content = "x".repeat(400);
    const messages = [
      makeMessage("system", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
    ];
    const estimated = estimateConversationTokens(messages);
    // estimated ≈ 0.7 × window → under the 0.85 default boundary
    expect(shouldCompact(messages, Math.ceil(estimated / 0.7))).toBe(false);
    // estimated ≈ 0.9 × window → over the 0.85 default boundary
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

    const opusContext = getContextWindow("claude-opus-5");
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

  it.each(MODELS)("$id crosses the default boundary at exactly 85%", (model) => {
    const contextWindow = getContextWindow(model.id, { provider: model.provider });
    const boundary = Math.ceil(contextWindow * 0.85);

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
    { id: "gpt-6-astra", publicWindow: 1_050_000, codexWindow: 272_000 },
    { id: "gpt-5.6-sol", publicWindow: 1_050_000, codexWindow: 272_000 },
    { id: "gpt-5.6-terra", publicWindow: 1_050_000, codexWindow: 272_000 },
    { id: "gpt-5.6-luna", publicWindow: 1_050_000, codexWindow: 272_000 },
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

  it("keeps only the latest atomic tool group when its result exceeds the budget", () => {
    const messages = [
      makeMessage("system", "sys"),
      makeMessage("user", "one long task"),
      makeToolCallMessage("read", { file_path: "old.ts" }, "old"),
      makeToolResultMessage("old", "old result"),
      makeToolCallMessage("bash", { command: "generate" }, "latest"),
      makeToolResultMessage("latest", "x".repeat(100_000)),
    ];

    const cut = findRecentCutPoint(messages, 8_000);

    expect(cut).toBe(4);
    expect(messages.slice(cut).map((message) => message.role)).toEqual(["assistant", "tool"]);
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

  it("pins the earliest request and fills the remaining budget from newest messages", () => {
    const msgs = [
      makeMessage("user", `first ${"a".repeat(2_000)}`),
      makeMessage("assistant", `old ${"b".repeat(2_000)}`),
      makeMessage("user", `latest ${"c".repeat(2_000)}`),
    ];
    const budget = estimateConversationTokens([msgs[0], msgs[2]]);
    const selected = selectMessagesInBudget(msgs, budget);
    expect(selected).toEqual([msgs[0], msgs[2]]);
  });
});

describe("summary provenance classification", () => {
  it("anchors the latest previous summary and excludes low-value runtime controls", () => {
    const previous = {
      role: "user" as const,
      content: "[Previous conversation summary]\n\nold memory",
      provenance: {
        source: "runtime" as const,
        kind: "compaction_summary" as const,
        visibility: "summary" as const,
      },
    };
    const messages: Message[] = [
      previous,
      {
        role: "user",
        content: "keep this correction",
        provenance: { source: "human", kind: "steering", visibility: "transcript" },
      },
      {
        role: "user",
        content: "continue",
        provenance: { source: "runtime", kind: "continuation", visibility: "hidden" },
      },
      {
        role: "user",
        content: "model changed",
        provenance: { source: "runtime", kind: "model_switch", visibility: "hidden" },
      },
    ];

    expect(findLatestPreviousSummary(messages)).toEqual({ index: 0, text: "old memory" });
    const classified = classifyMessagesForSummary(messages);
    expect(classified.map((message) => message.content)).toEqual([
      "[Human steering]\nkeep this correction",
      "[Runtime fact: model_switch]\nmodel changed",
    ]);
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
import { stream, StreamResult } from "@kenkaiiii/gg-ai";

describe("compact", () => {
  const baseOptions = {
    provider: "anthropic" as const,
    model: "claude-sonnet-5",
    apiKey: "test-key",
    contextWindow: 200_000,
  };

  // Each user message: ~20 + 10000 chars ≈ 2504 tokens + 4 overhead ≈ 2508 tokens
  // Each assistant: ~12 chars ≈ 7 tokens
  // 30 pairs ≈ 30 × 2515 ≈ 75K tokens total (well over the 8K recent budget)
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

  it("caps local summaries at the discovered model output allowance", async () => {
    const model = toModelInfo(
      {
        rawId: "small-context",
        endpointId: "ollama",
        contextWindow: 4096,
        contextWindowKnown: true,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: false,
      },
      DEFAULT_LOCAL_ENDPOINTS[0]!,
    );
    registerRuntimeModels([model]);
    const mockStream = vi.mocked(stream);
    mockStream.mockClear();
    mockStream.mockImplementation(
      () =>
        new StreamResult(
          (async function* () {
            yield { type: "text_delta", text: "Conversation summary." };
            return {
              message: { role: "assistant", content: "Conversation summary." },
              stopReason: "end_turn",
              usage: { inputTokens: 100, outputTokens: 10 },
            };
          })(),
        ),
    );
    try {
      await compact(buildConversation(30), {
        ...baseOptions,
        provider: "local",
        model: model.id,
        contextWindow: model.contextWindow,
      });
      expect(mockStream).toHaveBeenCalled();
      for (const [options] of mockStream.mock.calls) {
        expect(options.maxTokens).toBe(model.maxOutputTokens);
        expect(options.maxTokens).toBeLessThan(MIN_SUMMARY_OUTPUT_TOKENS);
      }
    } finally {
      clearRuntimeModels();
      mockStream.mockReset();
    }
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
    expect(result.result.reductionStatus).toBe("material");
    expect(result.result.summarizedCount).toBeGreaterThan(0);
    expect(result.result.retainedCount).toBeGreaterThanOrEqual(0);
    expect(result.result.tokensAfterEstimate).toBeLessThan(result.result.targetTokens);
  });

  it("feeds query-relevant older evidence to the summarizer when its prompt budget is constrained", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockImplementation((request) => {
      const requestText = (request.messages as Message[])
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
        .join("\n");
      expect(requestText).toContain("OLD_EVIDENCE_MARKER");
      return mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Relevant summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never;
    });

    const messages: Message[] = [makeMessage("system", "sys")];
    messages.push(makeMessage("user", `Original account task ${"a".repeat(10_000)}`));
    for (let index = 0; index < 100; index++) {
      const detail =
        index === 5
          ? "OAuth verifier mismatch root cause OLD_EVIDENCE_MARKER"
          : `Unrelated dashboard detail ${index}`;
      messages.push(makeMessage("user", `${detail} ${"x".repeat(10_000)}`));
      messages.push(makeMessage("assistant", `Handled detail ${index}`));
    }
    messages.push(makeMessage("user", "Fix the OAuth verifier mismatch."));

    const result = await compact(messages, baseOptions);
    expect(mockStream).toHaveBeenCalled();
    expect(result.result.contextSelection).toMatchObject({
      strategy: "query_aware",
      queryTerms: expect.any(Number),
      selectedTokens: expect.any(Number),
      droppedMessages: expect.any(Number),
    });
  });

  it("updates an anchored prior summary and preserves the approved plan reference", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockImplementation((request) => {
      const requestMessages = request.messages as Message[];
      expect(requestMessages[0].content).toContain("/tmp/approved-plan.md");
      expect(requestMessages[0].content).toContain("Update the anchored <previous-summary>");
      expect(requestMessages[1].content).toContain("<previous-summary>\nold durable memory");
      expect(requestMessages[1].content).toContain("</previous-summary>");
      expect(
        requestMessages.filter(
          (message) =>
            typeof message.content === "string" && message.content.includes("old durable memory"),
        ),
      ).toHaveLength(1);
      return mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Updated summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never;
    });

    const messages = buildConversation(30);
    messages.splice(1, 0, {
      role: "user",
      content: "[Previous conversation summary]\n\nold durable memory",
      provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
    });
    const result = await compact(messages, {
      ...baseOptions,
      approvedPlanPath: "/tmp/approved-plan.md",
    });
    expect(result.result.compacted).toBe(true);
  });

  it("rejects a rewrite that cannot land below the configured target", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, { ...baseOptions, targetTokens: 1 });
    expect(result.result.compacted).toBe(false);
    expect(result.result.reason).toBe("above_target");
    expect(result.result.reductionStatus).toBe("above_target");
    expect(result.messages).toEqual(messages);
  });

  it("caps the preserved recent tail at ~8K tokens", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);
    expect(result.result.compacted).toBe(true);

    // Recent tail = everything after system + summary + assistant ack.
    const tail = result.messages.slice(3);
    const tailTokens = estimateConversationTokens(tail);
    // Budget is 8K; one ≈2.5K-token conversation pair of slack covers the
    // never-split-a-pair / always-keep-last-user-exchange guards.
    expect(tailTokens).toBeLessThanOrEqual(8_000 + 3_000);
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

  it("preserves previous compacted memory in the fallback summary", async () => {
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
    messages[1] = {
      role: "user",
      content:
        "[Previous conversation summary]\n\nCritical earlier decision: retain durable lineage.",
      provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
    };
    const result = await compact(messages, baseOptions);

    expect(result.messages[1]?.content as string).toContain(
      "Critical earlier decision: retain durable lineage.",
    );
    expect(result.messages[1]?.content as string).toContain("## Update since the previous summary");
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

  // anchorRemap is what lets callers move transcript markers (Ken turns,
  // autopilot verdicts, error rows) onto the rewritten message list. If it
  // disagrees with the actual collapse, restored markers land in the wrong
  // place — the "everything bunched at the bottom" bug.
  it("reports an anchorRemap that matches the real collapse (ack skipped)", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    const result = await compact(messages, baseOptions);
    const remap = result.result.anchorRemap;
    expect(remap).toBeDefined();
    // This fixture's retained tail starts with an assistant message, so the
    // ack is skipped and the summary block is a single message.
    expect(remap!.prefixCount).toBe(1);

    const newNonSystem = result.messages.filter((m) => m.role !== "system").length;
    const oldNonSystem = messages.filter((m) => m.role !== "system").length;

    // The reported new length must be the real one — everything downstream
    // clamps against it.
    expect(remap!.newNonSystemCount).toBe(newNonSystem);

    // The summary block replaces the summarized head; the untouched tail is
    // exactly what remains after it.
    const keptTail = oldNonSystem - remap!.summarizedCount;
    expect(remap!.prefixCount + keptTail).toBe(newNonSystem);

    // That tail really is the ORIGINAL trailing messages, so an anchor in that
    // region only shifts — it never needs re-interpreting.
    expect(result.messages.slice(-keptTail)).toEqual(messages.slice(-keptTail));

    // Remapping the last pre-compaction anchor must land exactly at the end of
    // the new transcript — never past it (past-the-end is what gets dropped or
    // clamped to the bottom on resume).
    expect(remapAnchorForCompaction(oldNonSystem, remap!)).toBe(newNonSystem);
    for (let anchor = 0; anchor <= oldNonSystem; anchor++) {
      const moved = remapAnchorForCompaction(anchor, remap!);
      expect(moved).toBeGreaterThanOrEqual(0);
      expect(moved).toBeLessThanOrEqual(newNonSystem);
    }
  });

  it("keeps anchorRemap correct when the ack IS emitted", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never,
    );

    // A huge trailing assistant message pushes the cut point past it, so the
    // retained tail starts with a user message and the ack is emitted — the
    // summary block is 2 messages, and the remap must account for both.
    const messages = buildConversation(30);
    messages.push(makeMessage("assistant", `tail ${"y".repeat(40_000)}`));
    messages.push(makeMessage("user", "and finally this"));

    const result = await compact(messages, baseOptions);
    const remap = result.result.anchorRemap;
    expect(remap).toBeDefined();
    expect(remap!.prefixCount).toBe(2);

    const newNonSystem = result.messages.filter((m) => m.role !== "system").length;
    const oldNonSystem = messages.filter((m) => m.role !== "system").length;
    expect(remap!.newNonSystemCount).toBe(newNonSystem);
    expect(remap!.prefixCount + (oldNonSystem - remap!.summarizedCount)).toBe(newNonSystem);
    expect(remapAnchorForCompaction(oldNonSystem, remap!)).toBe(newNonSystem);
  });

  // repairToolPairing and the trailing-assistant pop can shorten the retained
  // tail AFTER the collapse is decided. Deriving the new length from
  // summarizedCount alone then overshoots, pushing tail anchors past the end —
  // where markers get dropped and Ken turns clamp to the bottom, which is the
  // exact symptom this remap exists to prevent.
  it("never maps an anchor past the end when the trailing assistant is popped", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never,
    );

    // Ends with an assistant message, so the pop loop fires and trims the tail.
    const messages = buildConversation(30);
    messages.push(makeMessage("assistant", "trailing assistant reply"));
    expect(messages[messages.length - 1].role).toBe("assistant");

    const result = await compact(messages, baseOptions);
    const remap = result.result.anchorRemap;
    expect(remap).toBeDefined();

    const newNonSystem = result.messages.filter((m) => m.role !== "system").length;
    const oldNonSystem = messages.filter((m) => m.role !== "system").length;
    expect(remap!.newNonSystemCount).toBe(newNonSystem);

    // Every anchor — especially the last one — stays inside the new transcript.
    for (let anchor = 0; anchor <= oldNonSystem; anchor++) {
      expect(remapAnchorForCompaction(anchor, remap!)).toBeLessThanOrEqual(newNonSystem);
    }
  });

  it("appends one merged modified-files block and never lists read files", async () => {
    const mockStream = vi.mocked(stream);
    mockStream.mockReturnValue(
      mockStreamResult(
        Promise.resolve({
          message: { role: "assistant", content: "Fresh summary." },
          stopReason: "end_turn",
          usage: { inputTokens: 1000, outputTokens: 50 },
        }),
      ) as never,
    );

    const messages = buildConversation(30);
    // Prior compacted memory already carrying tracked edits from a collapsed segment.
    messages.splice(1, 0, {
      role: "user",
      content:
        "[Previous conversation summary]\n\nOlder work.\n\n" +
        "<read-files>\nsrc/legacy-read.ts\n</read-files>\n" +
        "<modified-files>\nsrc/carried.ts\n</modified-files>",
      provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
    } as Message);
    messages.splice(2, 0, makeToolCallMessage("edit", { file_path: "src/fresh.ts" }, "e1"));
    messages.splice(3, 0, makeToolCallMessage("grep", { path: "src/" }, "g1"));

    const result = await compact(messages, baseOptions);
    const summary = result.messages[1].content as string;

    expect(summary).not.toContain("<read-files>");
    expect(summary).not.toContain("src/legacy-read.ts");
    // Exactly one block, carrying both the pre-collapse and the fresh edit.
    expect(summary.match(/<modified-files>/gu)).toHaveLength(1);
    expect(summary).toContain("src/carried.ts");
    expect(summary).toContain("src/fresh.ts");
    // grep's path argument is a directory, not a file the agent opened.
    expect(summary).not.toContain("src/\n");

    // The prior block is stripped from the prose handed back to the summarizer,
    // so it cannot be transcribed into the new summary a second time.
    // Mocks are not reset between tests in this file — inspect this test's call.
    const lastCall = vi.mocked(stream).mock.calls.at(-1)!;
    const sentText = (lastCall[0].messages as Message[])
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(sentText).toContain("<previous-summary>");
    expect(sentText).not.toContain("<modified-files>");
    expect(sentText).toContain("SUPERSEDES");
  });
});

// ── extractFileOperations ──────────────────────────────────

describe("extractFileOperations", () => {
  it("counts only the read tool as a read, not grep/find directory scans", () => {
    const ops = extractFileOperations([
      makeToolCallMessage("read", { file_path: "src/opened.ts" }, "r1"),
      makeToolCallMessage("grep", { path: "src/components" }, "g1"),
      makeToolCallMessage("find", { path: "packages" }, "f1"),
      makeToolCallMessage("edit", { file_path: "src/changed.ts" }, "e1"),
    ]);

    expect([...ops.read]).toEqual(["src/opened.ts"]);
    expect([...ops.modified]).toEqual(["src/changed.ts"]);
  });
});

// ── modified-file tracking ─────────────────────────────────

describe("splitTrackedModifiedFiles", () => {
  it("extracts tracked paths and strips both tracking blocks from the prose", () => {
    const { text, files } = splitTrackedModifiedFiles(
      "Prose body.\n\n<read-files>\nsrc/a.ts\n</read-files>\n" +
        "<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>",
    );

    expect(text).toBe("Prose body.");
    expect(files).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("leaves prose without tracking blocks untouched", () => {
    const { text, files, omitted } = splitTrackedModifiedFiles("Just a summary.");
    expect(text).toBe("Just a summary.");
    expect(files).toEqual([]);
    expect(omitted).toBe(0);
  });

  it("reads the overflow note as a count, never as a file path", () => {
    const { files, omitted } = splitTrackedModifiedFiles(
      "Prose.\n\n<modified-files>\nsrc/a.ts\n[... 7 earlier modified files omitted]\n</modified-files>",
    );

    expect(files).toEqual(["src/a.ts"]);
    expect(omitted).toBe(7);
  });
});

describe("buildModifiedFilesSection", () => {
  it("returns empty string when nothing was modified", () => {
    expect(buildModifiedFilesSection([])).toBe("");
    expect(buildModifiedFilesSection(["  ", ""])).toBe("");
  });

  it("dedupes carried and fresh paths into a single block", () => {
    const section = buildModifiedFilesSection(["src/a.ts", "src/b.ts", "src/a.ts"]);
    expect(section.match(/src\/a\.ts/gu)).toHaveLength(1);
    expect(section).toContain("src/b.ts");
  });

  it("keeps the most recent paths when the list overflows", () => {
    const paths = Array.from({ length: MAX_TRACKED_MODIFIED_FILES + 5 }, (_v, i) => `src/f${i}.ts`);
    const section = buildModifiedFilesSection(paths);

    expect(section).toContain(`src/f${paths.length - 1}.ts`);
    expect(section).not.toContain("src/f0.ts\n");
    expect(section).toContain("[... 5 earlier modified files omitted]");
  });

  it("accumulates the omitted count across generations instead of resetting", () => {
    const section = buildModifiedFilesSection(["src/a.ts"], 7);
    expect(section).toContain("[... 7 earlier modified files omitted]");

    const overflowing = Array.from(
      { length: MAX_TRACKED_MODIFIED_FILES + 5 },
      (_v, i) => `src/f${i}.ts`,
    );
    expect(buildModifiedFilesSection(overflowing, 7)).toContain(
      "[... 12 earlier modified files omitted]",
    );
  });

  it("still reports prior omissions when nothing survives the merge", () => {
    expect(buildModifiedFilesSection([], 4)).toContain("[... 4 earlier modified files omitted]");
  });

  it("survives repeated build/split generations without stacking notes", () => {
    // Generation 1: overflow by 5.
    let section = buildModifiedFilesSection(
      Array.from({ length: MAX_TRACKED_MODIFIED_FILES + 5 }, (_v, i) => `src/f${i}.ts`),
    );

    // Three further generations, each adding two fresh edits.
    let carried = splitTrackedModifiedFiles(`Prose.${section}`);
    for (let gen = 0; gen < 3; gen++) {
      expect(carried.files).toHaveLength(MAX_TRACKED_MODIFIED_FILES);
      // The note must never be mistaken for a path.
      expect(carried.files.some((f) => f.startsWith("[..."))).toBe(false);

      section = buildModifiedFilesSection(
        [...carried.files, `src/new-${gen}-a.ts`, `src/new-${gen}-b.ts`],
        carried.omitted,
      );
      carried = splitTrackedModifiedFiles(`Prose.${section}`);
    }

    // Exactly one note line, with the running total (5 + 2 + 2 + 2).
    expect(section.match(/earlier modified files omitted/gu)).toHaveLength(1);
    expect(section).toContain("[... 11 earlier modified files omitted]");
    expect(carried.omitted).toBe(11);
    expect(carried.files).toHaveLength(MAX_TRACKED_MODIFIED_FILES);
    expect(section).toContain("src/new-2-b.ts");
  });
});

// ── resolveSummaryOutputTokens ─────────────────────────────

describe("resolveSummaryOutputTokens", () => {
  it("floors at the minimum for small or unknown windows", () => {
    expect(resolveSummaryOutputTokens(32_000)).toBe(MIN_SUMMARY_OUTPUT_TOKENS);
    expect(resolveSummaryOutputTokens(0)).toBe(MIN_SUMMARY_OUTPUT_TOKENS);
    expect(resolveSummaryOutputTokens(Number.NaN)).toBe(MIN_SUMMARY_OUTPUT_TOKENS);
  });

  it("scales with the window and caps at the maximum", () => {
    expect(resolveSummaryOutputTokens(200_000)).toBe(6000);
    expect(resolveSummaryOutputTokens(1_000_000)).toBe(MAX_SUMMARY_OUTPUT_TOKENS);
  });
});

// ── failing-test carry-forward ─────────────────────────────

function resultMessage(content: string, isError = false): Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolCallId: "call_1",
        content,
        ...(isError ? { isError: true } : {}),
      },
    ],
  };
}

describe("extractFailingTests", () => {
  it("recognises jest/vitest, pytest, and Go test failure lines", () => {
    const failing = extractFailingTests([
      resultMessage(
        "FAIL src/auth/refresh.test.ts\n" +
          "  ✕ refresh::rejects-expired-token (42 ms)\n" +
          "FAILED tests/payments.py::test_refund_partial\n" +
          "--- FAIL: TestQueueConsumer\n" +
          "1 failed",
        true,
      ),
    ]);

    expect(failing).toContain("refresh::rejects-expired-token");
    expect(failing).toContain("tests/payments.py::test_refund_partial");
    expect(failing).toContain("TestQueueConsumer");
  });

  it("strips the jest duration suffix from the test name", () => {
    const failing = extractFailingTests([resultMessage("✕ parses nested config (1.5 ms)", true)]);
    expect(failing).toEqual(["parses nested config"]);
  });

  it("reverses a failure when a later result shows the test passing", () => {
    const failing = extractFailingTests([
      resultMessage("✕ refresh::rejects-expired-token (42 ms)", true),
      resultMessage("✓ refresh::rejects-expired-token (38 ms)"),
    ]);
    expect(failing).toEqual([]);
  });

  it("keeps the failure when the pass came before it", () => {
    const failing = extractFailingTests([
      resultMessage("✓ refresh::rejects-expired-token"),
      resultMessage("✕ refresh::rejects-expired-token (42 ms)", true),
    ]);
    expect(failing).toEqual(["refresh::rejects-expired-token"]);
  });

  it("ignores ordinary error output that is not a test report", () => {
    const signals = extractTestSignals([
      resultMessage("Error: ECONNREFUSED 127.0.0.1:5432\n    at connect (net.js:1:1)", true),
    ]);
    expect(signals.failing).toEqual([]);
    expect(signals.passed).toEqual([]);
  });

  it("reads text parts inside array tool-result content", () => {
    const failing = extractFailingTests([
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_1",
            content: [{ type: "text", text: "✕ array-case fails" }],
          },
        ],
      } as Message,
    ]);
    expect(failing).toEqual(["array-case fails"]);
  });
});

describe("splitTrackedFailingTests", () => {
  it("extracts carried names and strips the block from the prose", () => {
    const { text, tests, omitted } = splitTrackedFailingTests(
      "Prose body.\n\n<failing-tests>\nrefresh::rejects-expired-token\n[... 3 earlier failing tests omitted]\n</failing-tests>",
    );
    expect(text).toBe("Prose body.");
    expect(tests).toEqual(["refresh::rejects-expired-token"]);
    expect(omitted).toBe(3);
  });

  it("leaves prose without a failing-tests block untouched", () => {
    const { text, tests, omitted } = splitTrackedFailingTests("Just a summary.");
    expect(text).toBe("Just a summary.");
    expect(tests).toEqual([]);
    expect(omitted).toBe(0);
  });
});

describe("buildFailingTestsSection", () => {
  it("returns empty string when nothing fails", () => {
    expect(buildFailingTestsSection([])).toBe("");
  });

  it("dedupes carried and fresh names into a single block", () => {
    const section = buildFailingTestsSection(["test-a", "test-b", "test-a"]);
    expect(section.match(/test-a/gu)).toHaveLength(1);
    expect(section).toContain("test-b");
  });

  it("keeps the most recent names on overflow and reports the count", () => {
    const names = Array.from({ length: MAX_TRACKED_FAILING_TESTS + 5 }, (_v, i) => `test-${i}`);
    const section = buildFailingTestsSection(names);
    expect(section).toContain(`test-${names.length - 1}`);
    expect(section).toContain("[... 5 earlier failing tests omitted]");
  });

  it("still reports prior omissions when nothing survives the merge", () => {
    expect(buildFailingTestsSection([], 4)).toContain("[... 4 earlier failing tests omitted]");
  });

  it("survives repeated build/split generations without stacking notes", () => {
    let section = buildFailingTestsSection(
      Array.from({ length: MAX_TRACKED_FAILING_TESTS + 5 }, (_v, i) => `test-${i}`),
    );
    let carried = splitTrackedFailingTests(`Prose.${section}`);
    for (let gen = 0; gen < 3; gen++) {
      expect(carried.tests).toHaveLength(MAX_TRACKED_FAILING_TESTS);
      expect(carried.tests.some((t) => t.startsWith("[..."))).toBe(false);
      section = buildFailingTestsSection([...carried.tests, `fresh-${gen}`], carried.omitted);
      carried = splitTrackedFailingTests(`Prose.${section}`);
    }
    expect(section.match(/earlier failing tests omitted/gu)).toHaveLength(1);
    expect(section).toContain("[... 8 earlier failing tests omitted]");
  });
});
