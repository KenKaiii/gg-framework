import { describe, it, expect, vi, beforeEach } from "vitest";
import { isContextOverflow, agentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentResult } from "./types.js";
import type { Message } from "@kenkaiiii/gg-ai";

// ── Mock stream ────────────────────────────────────────────

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await importOriginal<typeof import("@kenkaiiii/gg-ai")>();
  return { ...mod, stream: vi.fn() };
});

import { stream } from "@kenkaiiii/gg-ai";
const mockStream = vi.mocked(stream);

function makeResponse(text: string, stopReason = "end_turn") {
  return {
    message: {
      role: "assistant" as const,
      content: text ? [{ type: "text" as const, text }] : "",
    },
    stopReason,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function mockOkResult(text: string) {
  const resp = makeResponse(text);
  const events = text ? [{ type: "text_delta" as const, text }] : [];
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    response: Promise.resolve(resp),
  };
}

function mockErrorResult(error: Error) {
  const p = Promise.reject(error);
  p.catch(() => {}); // prevent unhandled rejection
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* []; // satisfy require-yield
      throw error;
    },
    response: p,
  };
}

async function collectLoop(
  messages: Message[],
  opts: Parameters<typeof agentLoop>[1],
): Promise<{ events: AgentEvent[]; result: AgentResult }> {
  const gen = agentLoop(messages, opts);
  const events: AgentEvent[] = [];
  let result: AgentResult | undefined;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value as AgentResult;
      break;
    }
    events.push(next.value);
  }
  return { events, result: result! };
}

// ── Tests ──────────────────────────────────────────────────

describe("isContextOverflow", () => {
  it("detects Anthropic overflow error", () => {
    const err = new Error("[anthropic] prompt is too long: 203456 tokens > 200000 maximum");
    expect(isContextOverflow(err)).toBe(true);
  });

  it("detects OpenAI overflow error", () => {
    const err = new Error(
      "[openai] This model's maximum context length is 128000 tokens. " +
        "However, your messages resulted in 130000 tokens.",
    );
    expect(isContextOverflow(err)).toBe(true);
  });

  it("detects context_length_exceeded code", () => {
    const err = new Error("context_length_exceeded");
    expect(isContextOverflow(err)).toBe(true);
  });

  it("detects token exceed pattern", () => {
    const err = new Error("Request token count exceeds the limit");
    expect(isContextOverflow(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isContextOverflow(new Error("network timeout"))).toBe(false);
    expect(isContextOverflow(new Error("authentication failed"))).toBe(false);
    expect(isContextOverflow(new Error("rate limit exceeded"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isContextOverflow("some string")).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });
});

describe("agentLoop", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("yields text_delta, turn_end, and agent_done for a simple response", async () => {
    mockStream.mockReturnValueOnce(mockOkResult("Hello!") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];

    const { events, result } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("turn_end");
    expect(types).toContain("agent_done");
    expect(result.totalTurns).toBe(1);
    expect(result.totalUsage.inputTokens).toBe(100);
    expect(result.totalUsage.outputTokens).toBe(50);
  });

  it("calls transformContext before each LLM call", async () => {
    mockStream.mockReturnValueOnce(mockOkResult("Done") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      transformContext,
    });

    expect(transformContext).toHaveBeenCalledTimes(1);
    expect(transformContext).toHaveBeenCalledWith(messages);
  });

  it("replaces messages when transformContext returns a new array", async () => {
    mockStream.mockReturnValueOnce(mockOkResult("Ok") as unknown as ReturnType<typeof stream>);

    const original: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "lots of old context" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new question" },
    ];

    const compacted: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "new question" },
    ];

    const transformContext = vi.fn().mockReturnValueOnce(compacted);

    await collectLoop(original, {
      provider: "anthropic",
      model: "test",
      transformContext,
    });

    // Original array should have been replaced in-place
    expect(original.length).toBe(compacted.length + 1); // +1 for pushed assistant message
    expect(original[0]).toEqual(compacted[0]);
    expect(original[1]).toEqual(compacted[1]);
  });

  it("throws immediately on context overflow without retrying or compacting", async () => {
    const overflowErr = new Error("prompt is too long: 250000 tokens > 200000 maximum");

    mockStream.mockReturnValueOnce(
      mockErrorResult(overflowErr) as unknown as ReturnType<typeof stream>,
    );

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    await expect(
      collectLoop(messages, {
        provider: "anthropic",
        model: "test",
        transformContext,
      }),
    ).rejects.toThrow("prompt is too long");

    // Should NOT have called transformContext with force: true
    const forceCalls = transformContext.mock.calls.filter(
      (c: unknown[]) => (c[1] as { force?: boolean })?.force === true,
    );
    expect(forceCalls.length).toBe(0);
    // Should only have been called once (the pre-turn check)
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("throws on context overflow when no transformContext is provided", async () => {
    const overflowErr = new Error("prompt is too long: 250000 tokens > 200000 maximum");
    mockStream.mockReturnValueOnce(
      mockErrorResult(overflowErr) as unknown as ReturnType<typeof stream>,
    );

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    await expect(collectLoop(messages, { provider: "anthropic", model: "test" })).rejects.toThrow(
      "prompt is too long",
    );
  });

  it("polls getSteeringMessages before the first LLM call", async () => {
    mockStream.mockReturnValueOnce(mockOkResult("Reply") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    let callCount = 0;
    const getSteeringMessages = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return [{ role: "user" as const, content: "extra context" }];
      }
      return null;
    });

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      getSteeringMessages,
    });

    // Steering should be called at least once (initial poll)
    expect(getSteeringMessages).toHaveBeenCalled();
    // The steering message should be in the conversation
    expect(messages.some((m) => m.role === "user" && m.content === "extra context")).toBe(true);
    expect(events.some((e) => e.type === "steering_message")).toBe(true);
  });

  it("injects follow-up messages when agent would stop", async () => {
    // First call: agent responds with text (would stop)
    // Second call: after follow-up, agent responds again
    mockStream
      .mockReturnValueOnce(mockOkResult("First reply") as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("After follow-up") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    let followUpCalled = false;
    const getFollowUpMessages = vi.fn().mockImplementation(() => {
      if (!followUpCalled) {
        followUpCalled = true;
        return [{ role: "user" as const, content: "follow up" }];
      }
      return null;
    });

    const { events, result } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      getFollowUpMessages,
    });

    expect(getFollowUpMessages).toHaveBeenCalled();
    expect(events.some((e) => e.type === "follow_up_message")).toBe(true);
    expect(result.totalTurns).toBe(2);
  });

  it("steering takes priority over follow-up at pre-completion", async () => {
    // First call: agent responds (would stop) -> steering fires
    // Second call: agent responds (would stop) -> no steering, no follow-up
    mockStream
      .mockReturnValueOnce(mockOkResult("First") as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("Second") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    let steeringCallCount = 0;
    const getSteeringMessages = vi.fn().mockImplementation(() => {
      steeringCallCount++;
      // Return steering only on the pre-completion check (2nd call — after initial poll)
      if (steeringCallCount === 2) {
        return [{ role: "user" as const, content: "steering" }];
      }
      return null;
    });

    // Follow-up should never fire because steering takes priority
    const getFollowUpMessages = vi.fn().mockReturnValue(null);

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      getSteeringMessages,
      getFollowUpMessages,
    });

    expect(events.some((e) => e.type === "steering_message")).toBe(true);
    expect(events.some((e) => e.type === "follow_up_message")).toBe(false);
    // Follow-up was only checked on the second stop (after steering was consumed)
    expect(getFollowUpMessages).toHaveBeenCalled();
  });

  it("throws on non-overflow errors even with transformContext", async () => {
    const otherErr = new Error("authentication failed");
    mockStream.mockReturnValueOnce(
      mockErrorResult(otherErr) as unknown as ReturnType<typeof stream>,
    );

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    await expect(
      collectLoop(messages, { provider: "anthropic", model: "test", transformContext }),
    ).rejects.toThrow("authentication failed");
  });

  it("respects maxTurns", async () => {
    // Return tool_use to force looping, but cap at 2 turns
    const toolResponse = {
      message: {
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, id: "t1", name: "test_tool", args: {} }],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 25 },
    };

    // Keep returning tool_use — loop should stop at maxTurns
    mockStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        // no text events
      },
      response: Promise.resolve(toolResponse),
    } as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const { result } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      maxTurns: 2,
      tools: [
        {
          name: "test_tool",
          description: "test",
          parameters: { parse: () => ({}) } as never,
          execute: () => "result",
        },
      ],
    });

    expect(result.totalTurns).toBe(2);
  });
});
