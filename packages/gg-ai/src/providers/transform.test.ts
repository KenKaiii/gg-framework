import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clampProviderContextImages,
  downgradeUnsupportedVideos,
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

const image = (data: string) => ({ type: "image" as const, mediaType: "image/png", data });

describe("provider image budgeting", () => {
  it.each([
    ["anthropic", 90],
    ["minimax", 90],
    ["openai", 200],
    ["gemini", 200],
    ["openrouter", 90],
    ["palsu", 5],
  ] as const)("caps %s context at %i images", (provider, budget) => {
    const messages: Message[] = [
      {
        role: "user",
        content: Array.from({ length: budget + 2 }, (_, index) => image(String(index))),
      },
    ];
    const result = clampProviderContextImages(messages, provider, true);
    const user = result[0];
    expect(user?.role).toBe("user");
    expect(
      user?.role === "user" && Array.isArray(user.content)
        ? user.content.filter((part) => part.type === "image").length
        : 0,
    ).toBe(budget);
  });

  it("is a no-op while supported context is within budget", () => {
    const messages: Message[] = [{ role: "user", content: [image("one"), image("two")] }];
    expect(clampProviderContextImages(messages, "openai", true)).toBe(messages);
  });

  it("removes oldest user/tool images first and preserves newest attachments", () => {
    const messages: Message[] = [
      { role: "user", content: [image("old-user")] },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: [image("old-tool")] }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "new" },
          image("new-1"),
          image("new-2"),
          image("new-3"),
          image("new-4"),
          image("new-5"),
        ],
      },
    ];

    const result = clampProviderContextImages(messages, "palsu", true);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[image omitted: provider image limit]" }],
    });
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "t1",
          content: [{ type: "text", text: "[image omitted: provider image limit]" }],
        },
      ],
    });
    expect(JSON.stringify(result)).toContain("new-1");
    expect(JSON.stringify(result)).toContain("new-5");
  });

  it("does not mutate persisted source messages", () => {
    const messages: Message[] = Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      content: [image(`image-${index}`)],
    }));
    const before = structuredClone(messages);
    const result = clampProviderContextImages(messages, "palsu", true);
    expect(messages).toEqual(before);
    expect(result).not.toBe(messages);
    expect(JSON.stringify(result)).not.toContain("image-0");
    expect(JSON.stringify(result)).toContain("image-5");
  });

  it("leaves unsupported-image history for the existing downgrade pass", () => {
    const messages: Message[] = Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      content: [image(`image-${index}`)],
    }));
    expect(clampProviderContextImages(messages, "palsu", false)).toBe(messages);
  });
});

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

  it("drops foreign raw blocks (e.g. Codex reasoning) Anthropic would reject", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "raw",
            data: { type: "reasoning", id: "rs_1", encrypted_content: "abc", summary: [] },
          },
          { type: "text", text: "answer" },
          { type: "tool_call", id: "toolu_3", name: "read_file", args: { filePath: "c.ts" } },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(["text", "tool_use"]);
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

  it("preserves signed thinking across every assistant turn in the active trajectory", () => {
    // A multi-step tool loop has no user message between steps, so every
    // assistant turn from the last user message forward is part of the same
    // active trajectory and must keep its signed thinking (cookbook rule).
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "step one reasoning", signature: "sig-1" },
          { type: "tool_call", id: "call_1", name: "read_file", args: { filePath: "a.ts" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "ok" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "step two reasoning", signature: "sig-2" },
          { type: "tool_call", id: "call_2", name: "read_file", args: { filePath: "b.ts" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_2", content: "ok" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "final reasoning", signature: "sig-3" },
          { type: "text", text: "done" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const assistants = out.filter((m) => m.role === "assistant");
    const [first, second, third] = assistants.map(
      (m) => m.content as unknown as Array<Record<string, unknown>>,
    );

    expect(first).toEqual([
      { type: "thinking", thinking: "step one reasoning", signature: "sig-1" },
      {
        type: "tool_use",
        id: "call_1",
        name: "read_file",
        input: { filePath: "a.ts" },
      },
    ]);
    expect(second?.[0]).toEqual({
      type: "thinking",
      thinking: "step two reasoning",
      signature: "sig-2",
    });
    expect(third).toEqual([
      { type: "thinking", thinking: "final reasoning", signature: "sig-3" },
      { type: "text", text: "done" },
    ]);
  });

  it("strips thinking from settled turns but preserves the post-user trajectory", () => {
    // Two trajectories separated by a real user message. The pre-user assistant
    // turns are settled history (thinking stripped, tool_use survives); the
    // post-user trajectory keeps signed thinking on every turn.
    const messages: Message[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "settled reasoning", signature: "sig-old" },
          { type: "tool_call", id: "call_a", name: "read_file", args: { filePath: "a.ts" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_a", content: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", text: "settled answer", signature: "sig-old2" }],
      },
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "active reasoning", signature: "sig-new" },
          { type: "tool_call", id: "call_b", name: "read_file", args: { filePath: "b.ts" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_b", content: "ok" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "active answer", signature: "sig-new2" },
          { type: "text", text: "done" },
        ],
      },
    ];

    const { messages: out } = toAnthropicMessages(messages);
    const assistants = out.filter((m) => m.role === "assistant");
    const contents = assistants.map((m) => m.content as unknown as Array<Record<string, unknown>>);

    // Settled trajectory: thinking stripped (tool_use survives on the first;
    // the second is thinking-only so it is dropped entirely).
    expect(contents[0]?.map((b) => b.type)).toEqual(["tool_use"]);
    // The thinking-only settled turn collapses to nothing and is skipped, so the
    // next assistant content is the active trajectory's first turn.
    expect(contents[1]).toEqual([
      { type: "thinking", thinking: "active reasoning", signature: "sig-new" },
      {
        type: "tool_use",
        id: "call_b",
        name: "read_file",
        input: { filePath: "b.ts" },
      },
    ]);
    expect(contents[2]).toEqual([
      { type: "thinking", thinking: "active answer", signature: "sig-new2" },
      { type: "text", text: "done" },
    ]);
  });

  it("strips redacted_thinking (raw) from settled assistant turns", () => {
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
      { role: "user", content: "again" },
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

  // Baseline #20 (empty-parts): Anthropic rejects empty text blocks with a 400
  // ("text content blocks must be non-empty"). The serializer must never emit one.
  it("drops a user message whose string content is empty (case A)", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "prev" }] },
      { role: "user", content: "" },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    // The empty user turn is gone; the real ones survive.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[0]?.content).toBe("hi");
  });

  it("filters empty text parts from a user content array (case B)", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real" },
        ],
      },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([{ type: "text", text: "real" }]);
  });

  it("drops a user message whose only text part is empty", () => {
    const messages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("drops a settled assistant message with empty string content (case D)", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "next" },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    // The empty assistant turn is dropped; both user turns remain.
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
    expect(out.map((m) => m.content)).toEqual(["hi", "next"]);
  });

  it("keeps whitespace-only user text intact (API accepts non-empty text)", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "  \n " }] }];
    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content).toEqual([{ type: "text", text: "  \n " }]);
  });

  it("keeps a non-text user part (image) even with no text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image", mediaType: "image/png", data: "abc" },
        ],
      },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    const content = out[0]?.content as unknown as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(["image"]);
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

  // Baseline #5: `toolu_*` -> OpenAI must strip the FULL `toolu_` prefix. The old
  // `slice(5)` left the trailing underscore, producing `call__<id>` (double
  // underscore; lossy). Pairing must survive: the tool_result references the
  // same remapped id.
  it("remaps a toolu_ id to a single-underscore call_ id and preserves pairing", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "toolu_01ABC", name: "bash", args: { cmd: "ls" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "toolu_01ABC", content: "ok" }],
      },
    ];
    const out = toOpenAIMessages(messages) as unknown as Array<Record<string, unknown>>;
    const assistant = out.find((m) => m.role === "assistant") as {
      tool_calls: Array<{ id: string }>;
    };
    const toolMsg = out.find((m) => m.role === "tool") as { tool_call_id: string };
    expect(assistant.tool_calls[0]?.id).toBe("call_01ABC");
    expect(assistant.tool_calls[0]?.id).not.toContain("call__");
    // Pairing intact: the result points at the identical remapped id.
    expect(toolMsg.tool_call_id).toBe("call_01ABC");
  });

  it("passes through non-anthropic tool ids unchanged", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call_xyz", name: "bash", args: {} }],
      },
    ];
    const out = toOpenAIMessages(messages) as Array<{ tool_calls?: Array<{ id: string }> }>;
    expect(out[0]?.tool_calls?.[0]?.id).toBe("call_xyz");
  });
});

describe("toAnthropicThinking", () => {
  // Opus 4.8 is no longer in ggcoder's model picker, but gg-ai is a standalone
  // library and Anthropic still serves that ID — keep the wire format correct.
  it("passes Anthropic adaptive effort levels through for Opus 5 (and legacy 4.8)", () => {
    for (const model of ["claude-opus-5", "claude-opus-4-8"]) {
      for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
        const result = toAnthropicThinking(level, MAX_TOKENS, model);
        expect(result.outputConfig).toEqual({ effort: level });
        expect((result.thinking as { type: string }).type).toBe("adaptive");
      }
    }
  });

  it("clamps xhigh to high on adaptive Anthropic models that do not support xhigh", () => {
    expect(toAnthropicThinking("xhigh", MAX_TOKENS, "claude-sonnet-5").outputConfig).toEqual({
      effort: "high",
    });
    expect(toAnthropicThinking("max", MAX_TOKENS, "claude-sonnet-5").outputConfig).toEqual({
      effort: "max",
    });
  });

  it("treats Fable 5 and Mythos 5 as adaptive thinking models (max, xhigh clamps to high)", () => {
    for (const model of ["claude-fable-5", "claude-mythos-5"]) {
      const result = toAnthropicThinking("max", MAX_TOKENS, model);
      expect(result.outputConfig).toEqual({ effort: "max" });
      expect((result.thinking as { type: string }).type).toBe("adaptive");
      expect(toAnthropicThinking("xhigh", MAX_TOKENS, model).outputConfig).toEqual({
        effort: "high",
      });
    }
  });

  it("keeps budget-based max_tokens within the model ceiling (no doubling)", () => {
    // Haiku 4.5 is a legacy budget model. max_tokens is the total response
    // envelope and must stay ≤ the ceiling (64K here); budget_tokens must be
    // strictly less than max_tokens. Previously this returned maxTokens +
    // budget (128K), which exceeds the provider's output-token cap.
    const CEILING = 64_000;
    for (const level of ["low", "medium", "high", "xhigh", "max", "ultra"] as const) {
      const result = toAnthropicThinking(level, CEILING, "claude-haiku-4-5");
      expect(result.maxTokens).toBeLessThanOrEqual(CEILING);
      const budget = (result.thinking as { budget_tokens?: number }).budget_tokens!;
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThan(result.maxTokens);
      // Visible output floor always reserved.
      expect(result.maxTokens - budget).toBeGreaterThanOrEqual(1024);
    }
  });
});

describe("toOpenAIReasoningEffort", () => {
  it("clamps client-only max and ultra levels to OpenAI's xhigh effort", () => {
    expect(toOpenAIReasoningEffort("max", "gpt-5.5")).toBe("xhigh");
    expect(toOpenAIReasoningEffort("ultra", "gpt-5.6-sol")).toBe("xhigh");
  });
});

describe("video content transforms", () => {
  const videoMessage: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "What happens here?" },
        { type: "video", mediaType: "video/mp4", data: "AAAA" },
      ],
    },
  ];

  it("emits an Anthropic-style base64 video block (MiniMax M3)", () => {
    const result = toAnthropicMessages(videoMessage);
    expect(result.messages[0]!.content).toEqual([
      { type: "text", text: "What happens here?" },
      { type: "video", source: { type: "base64", media_type: "video/mp4", data: "AAAA" } },
    ]);
  });

  it("emits an OpenAI video_url content part (Moonshot/Kimi)", () => {
    const result = toOpenAIMessages(videoMessage);
    expect(result[0]!.content).toEqual([
      { type: "text", text: "What happens here?" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
    ]);
  });

  it("downgrades video to a text placeholder when the model lacks video support", () => {
    const downgraded = downgradeUnsupportedVideos(videoMessage, false);
    expect(downgraded[0]!.content).toEqual([
      { type: "text", text: "What happens here?" },
      { type: "text", text: "(video omitted: model does not support video)" },
    ]);
    // After downgrade, the Anthropic transform never sees a video block.
    const result = toAnthropicMessages(downgraded);
    expect(result.messages[0]!.content).toEqual([
      { type: "text", text: "What happens here?" },
      { type: "text", text: "(video omitted: model does not support video)" },
    ]);
  });

  it("keeps video untouched when the model supports it", () => {
    expect(downgradeUnsupportedVideos(videoMessage, true)).toEqual(videoMessage);
  });
});
