import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  toAnthropicMessages,
  toAnthropicThinking,
  toAnthropicTools,
  toOpenAIMessages,
  toOpenAIReasoningEffort,
} from "./transform.js";
import type { Message, Tool } from "../types.js";

const exampleTools: Tool[] = [
  {
    name: "read_file",
    description: "Read a file.",
    parameters: z.object({ filePath: z.string() }),
  },
  {
    name: "write_file",
    description: "Write a file.",
    parameters: z.object({ filePath: z.string(), content: z.string() }),
  },
];

const MAX_TOKENS = 16_000;

describe("Anthropic transform", () => {
  it("splits system prompt into cached and uncached blocks at the marker", () => {
    const cacheControl = { type: "ephemeral" as const };
    const messages: Message[] = [
      {
        role: "system",
        content: "Stable prompt\n\n<!-- uncached -->\nToday's date: 17 May 2026",
      },
      { role: "user", content: "Hello" },
    ];

    const result = toAnthropicMessages(messages, cacheControl);

    expect(result.system).toEqual([
      { type: "text", text: "Stable prompt", cache_control: cacheControl },
      { type: "text", text: "Today's date: 17 May 2026" },
    ]);
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Hello", cache_control: cacheControl }],
      },
    ]);
  });

  it("leaves the date block uncached when Anthropic cache control is enabled", () => {
    const result = toAnthropicMessages(
      [
        {
          role: "system",
          content: "Reusable prefix\n<!-- uncached -->\nToday's date: 17 May 2026",
        },
      ],
      { type: "ephemeral" },
    );

    expect(result.system).toHaveLength(2);
    expect(result.system?.[0]).toHaveProperty("cache_control");
    expect(result.system?.[1]).not.toHaveProperty("cache_control");
    expect(result.system?.[1]?.text).toBe("Today's date: 17 May 2026");
  });

  it("adds cache_control only to the last tool definition", () => {
    const tools = toAnthropicTools(exampleTools, {
      cacheControl: { type: "ephemeral" },
    }) as unknown as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(2);
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds eager_input_streaming when fine-grained tool streaming is enabled", () => {
    const tools = toAnthropicTools(exampleTools, {
      cacheControl: { type: "ephemeral" },
      enableFineGrainedToolStreaming: true,
    }) as unknown as Array<Record<string, unknown>>;

    expect(tools.map((tool) => tool.eager_input_streaming)).toEqual([true, true]);
  });

  it("preserves empty text blocks that precede a thinking block (no position shift)", () => {
    // Anthropic rejects the request if a thinking block in the latest assistant
    // message moves position. Dropping the leading empty text block would shift
    // the signed thinking block from index 1 to 0 -> "thinking blocks ... cannot
    // be modified". The empty text block must be kept.
    const messages: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "thinking", text: "reasoning", signature: "sig-abc" },
          { type: "tool_call", id: "toolu_1", name: "read_file", args: { filePath: "a.ts" } },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[1]?.content as unknown as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(["text", "thinking", "tool_use"]);
    expect(content[1]).toEqual({ type: "thinking", thinking: "reasoning", signature: "sig-abc" });
  });

  it("keeps empty text before a redacted_thinking (raw) block", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "raw", data: { type: "redacted_thinking", data: "encrypted" } },
          { type: "tool_call", id: "toolu_2", name: "read_file", args: { filePath: "b.ts" } },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(["text", "redacted_thinking", "tool_use"]);
  });

  it("still strips empty text blocks when no thinking block is present", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real answer" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([{ type: "text", text: "real answer" }]);
  });

  it("strips empty text blocks that come after the last thinking block", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "reasoning", signature: "sig-xyz" },
          { type: "text", text: "answer" },
          { type: "text", text: "" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("converts unsigned thinking blocks to text instead of dropping them", () => {
    // Cross-provider (GLM/OpenAI) or aborted-stream thinking has no signature.
    // Anthropic rejects empty signatures, so preserve the reasoning as text
    // rather than discarding the content.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "unsigned reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "text", text: "unsigned reasoning" },
      { type: "text", text: "answer" },
    ]);
  });

  it("drops unsigned thinking blocks that carry no text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("does not treat unsigned thinking as position-sensitive (empty text still stripped)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "thinking", text: "unsigned" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    // Leading empty text is dropped because the following thinking block is
    // unsigned (becomes text) and imposes no positional constraint.
    expect(content).toEqual([
      { type: "text", text: "unsigned" },
      { type: "text", text: "answer" },
    ]);
  });

  it("strips thinking from non-latest assistant turns but keeps the latest verbatim", () => {
    // Anthropic only validates the latest assistant turn's thinking blocks.
    // Keeping signed thinking on older turns makes the history fragile, so they
    // are stripped (tool_use survives); the latest turn is preserved.
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "old reasoning", signature: "sig-old" },
          { type: "tool_call", id: "call_1", name: "read_file", args: { filePath: "a.ts" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "ok" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "latest reasoning", signature: "sig-new" },
          { type: "text", text: "done" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const assistants = out.filter((m) => m.role === "assistant");
    const first = assistants[0]?.content as unknown as Array<Record<string, unknown>>;
    const last = assistants[1]?.content as unknown as Array<Record<string, unknown>>;

    // Older assistant: no thinking, tool_use survives.
    expect(first.map((b) => b.type)).toEqual(["tool_use"]);
    // Latest assistant: thinking preserved with its signature.
    expect(last).toEqual([
      { type: "thinking", thinking: "latest reasoning", signature: "sig-new" },
      { type: "text", text: "done" },
    ]);
  });

  it("strips redacted_thinking (raw) from non-latest assistant turns", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "raw", data: { type: "redacted_thinking", data: "encrypted" } },
          { type: "tool_call", id: "c1", name: "read_file", args: { filePath: "a" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const first = out.filter((m) => m.role === "assistant")[0]?.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(first.map((b) => b.type)).toEqual(["tool_use"]);
  });

  it("downgrades a whitespace-only signature to a text block (interrupted-stream guard)", () => {
    // A signature_delta that never fully arrived can leave a blank/whitespace
    // signature. Sending it as a real thinking block triggers Anthropic's
    // "cannot be modified" rejection, so it must become plain text.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "partial reasoning", signature: "   " },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "text", text: "partial reasoning" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("OpenAI transform", () => {
  it("keeps the whole system prompt literal, including the uncached marker", () => {
    const content = "Stable prompt\n\n<!-- uncached -->\nToday's date: 17 May 2026";
    const messages: Message[] = [
      { role: "system", content },
      { role: "user", content: "Hello" },
    ];

    expect(toOpenAIMessages(messages)).toEqual([
      { role: "system", content },
      { role: "user", content: "Hello" },
    ]);
  });
});

describe("toAnthropicThinking", () => {
  it("passes Anthropic adaptive effort levels through for Claude Opus 4.8", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(toAnthropicThinking(level, MAX_TOKENS, "claude-opus-4-8").outputConfig).toEqual({
        effort: level,
      });
    }
  });

  it("clamps xhigh to high on adaptive Anthropic models that do not support xhigh", () => {
    expect(toAnthropicThinking("xhigh", MAX_TOKENS, "claude-sonnet-4-6").outputConfig).toEqual({
      effort: "high",
    });
    expect(toAnthropicThinking("max", MAX_TOKENS, "claude-sonnet-4-6").outputConfig).toEqual({
      effort: "max",
    });
  });
});

describe("toOpenAIReasoningEffort", () => {
  it("clamps shared max thinking level to OpenAI's xhigh effort", () => {
    expect(toOpenAIReasoningEffort("max", "gpt-5.5")).toBe("xhigh");
  });
});
