import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ProviderError } from "@kenkaiiii/gg-ai";
import {
  agentLoop,
  classifyOverload,
  extractContextOverflowDetails,
  isContextOverflow,
  isThinkingBlockError,
  isUsageLimitError,
} from "./agent-loop.js";
import type { AgentEvent, AgentResult, AgentTool } from "./types.js";
import type { Message, StreamOptions } from "@kenkaiiii/gg-ai";

// ── Mock stream ────────────────────────────────────────────

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await importOriginal<typeof import("@kenkaiiii/gg-ai")>();
  return { ...mod, stream: vi.fn() };
});

import { stream } from "@kenkaiiii/gg-ai";
const mockStream = vi.mocked(stream);
const emptyParams = z.object({});

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

describe("isThinkingBlockError", () => {
  it("detects the latest-assistant-message modification error", () => {
    expect(
      isThinkingBlockError(
        new Error(
          "messages.3.content.257: `thinking` or `redacted_thinking` blocks in the latest " +
            "assistant message cannot be modified. These blocks must remain as they were " +
            "in the original response.",
        ),
      ),
    ).toBe(true);
  });

  it("detects an invalid thinking signature error", () => {
    expect(isThinkingBlockError(new Error("Invalid `signature` in `thinking` block"))).toBe(true);
  });

  it("detects a thinking block type/position error", () => {
    expect(
      isThinkingBlockError(
        new Error("Expected `thinking` or `redacted_thinking`, but found `text`"),
      ),
    ).toBe(true);
  });

  it("returns false for unrelated errors and non-Error values", () => {
    expect(isThinkingBlockError(new Error("tool_use ids found without tool_result"))).toBe(false);
    expect(isThinkingBlockError(new Error("rate limit exceeded"))).toBe(false);
    expect(isThinkingBlockError("cannot be modified")).toBe(false);
    expect(isThinkingBlockError(null)).toBe(false);
  });
});

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

  it("extracts provider-reported overflow token counts", () => {
    expect(
      extractContextOverflowDetails(
        new Error(
          "[openai] This model's maximum context length is 128000 tokens. " +
            "However, your messages resulted in 130000 tokens.",
        ),
      ),
    ).toEqual({ observedTokens: 130000, observedLimit: 128000 });
    expect(
      extractContextOverflowDetails(
        new Error("[anthropic] prompt is too long: 203,456 tokens > 200,000 maximum"),
      ),
    ).toEqual({ observedTokens: 203456, observedLimit: 200000 });
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

describe("classifyOverload", () => {
  it("classifies provider 5xx and api_error as transient provider errors", () => {
    const cases = [
      new ProviderError("anthropic", "api_error: Internal server error", { statusCode: undefined }),
      new ProviderError("anthropic", "Internal server error", { statusCode: 500 }),
      new ProviderError("anthropic", "Bad Gateway", { statusCode: 502 }),
      new ProviderError("anthropic", "Service Unavailable", { statusCode: 503 }),
      new ProviderError("anthropic", "Gateway Timeout", { statusCode: 504 }),
    ];

    for (const error of cases) {
      expect(classifyOverload(error)).toBe("provider_error");
    }
  });

  it("keeps rate limits and overloads distinct", () => {
    expect(
      classifyOverload(new ProviderError("anthropic", "rate_limit_error", { statusCode: 429 })),
    ).toBe("rate_limit");
    expect(
      classifyOverload(new ProviderError("anthropic", "overloaded_error", { statusCode: 529 })),
    ).toBe("overloaded");
  });

  it("does not treat a usage-window 429 as a retriable rate limit", () => {
    expect(
      classifyOverload(
        new ProviderError("anthropic", "Claude usage limit reached", {
          statusCode: 429,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    ).toBeNull();
  });
});

describe("isUsageLimitError", () => {
  it("matches the canonical usage-limit message", () => {
    expect(
      isUsageLimitError(
        new ProviderError("anthropic", "Claude usage limit reached", { statusCode: 429 }),
      ),
    ).toBe(true);
  });

  it("does not match a transient rate-limit error", () => {
    expect(
      isUsageLimitError(
        new ProviderError("anthropic", "rate_limit_error: Rate limited.", { statusCode: 429 }),
      ),
    ).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isUsageLimitError("Claude usage limit reached")).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
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

  it("calls transformContext with force=true on context overflow, then throws if compaction can't reduce", async () => {
    const overflowErr = new Error("prompt is too long: 250000 tokens > 200000 maximum");

    mockStream.mockReturnValueOnce(
      mockErrorResult(overflowErr) as unknown as ReturnType<typeof stream>,
    );

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    // No-op compaction — returns same array, so the loop must give up and throw
    // after one force-attempt (no retry stream call).
    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    await expect(
      collectLoop(messages, {
        provider: "anthropic",
        model: "test",
        transformContext,
      }),
    ).rejects.toThrow("prompt is too long");

    const forceCalls = transformContext.mock.calls.filter(
      (c: unknown[]) => (c[1] as { force?: boolean })?.force === true,
    );
    expect(forceCalls.length).toBe(1);
    // Stream should only have been called once — no retry, since compaction was a no-op
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("retries the turn after force-compaction reduces the messages on context overflow", async () => {
    const overflowErr = new Error(
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    );
    mockStream
      .mockReturnValueOnce(mockErrorResult(overflowErr) as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("recovered") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const transformContext = vi
      .fn()
      .mockImplementation((msgs: Message[], opts?: { force?: boolean }) => {
        if (opts?.force && msgs.length > 1) {
          return msgs.slice(0, msgs.length - 1);
        }
        return msgs;
      });

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      transformContext,
    });

    const retry = events.find((e) => e.type === "retry" && e.reason === "overflow_compact");
    expect(retry).toBeDefined();
    expect(retry && "observedTokens" in retry ? retry.observedTokens : undefined).toBe(130000);
    expect(retry && "observedLimit" in retry ? retry.observedLimit : undefined).toBe(128000);
    expect(mockStream).toHaveBeenCalledTimes(2);
    const forceCalls = transformContext.mock.calls.filter(
      (c: unknown[]) => (c[1] as { force?: boolean })?.force === true,
    );
    expect(forceCalls.length).toBe(1);
  });

  it("truncates oversized tool results once before force-compacting on context overflow", async () => {
    const overflowErr = new Error("prompt is too long: 250000 tokens > 200000 maximum");
    mockStream
      .mockReturnValueOnce(mockErrorResult(overflowErr) as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("recovered") as unknown as ReturnType<typeof stream>);

    const oversized = "x".repeat(250);
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "tc1", name: "read", args: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "tc1", content: oversized }],
      },
    ];
    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      transformContext,
      maxToolResultChars: 120,
    });

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(transformContext).toHaveBeenCalledTimes(2);
    expect(
      transformContext.mock.calls.every(
        (c) => (c[1] as { force?: boolean } | undefined)?.force !== true,
      ),
    ).toBe(true);
    const toolMessage = messages.find((m) => m.role === "tool");
    const result = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(typeof result?.content === "string" ? result.content.length : 0).toBeLessThan(
      oversized.length,
    );
    expect(events.some((e) => e.type === "retry" && e.reason === "overflow_compact")).toBe(true);
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

  it("surfaces a usage-window 429 immediately without retrying", async () => {
    const usageErr = new ProviderError("anthropic", "Claude usage limit reached", {
      statusCode: 429,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    });
    mockStream.mockReturnValue(mockErrorResult(usageErr) as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    await expect(collectLoop(messages, { provider: "anthropic", model: "test" })).rejects.toThrow(
      "Claude usage limit reached",
    );
    // No retry bucket — the stream is attempted exactly once.
    expect(mockStream).toHaveBeenCalledTimes(1);
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

  it("flips to non-streaming fallback after repeated stream stalls", async () => {
    vi.useFakeTimers();

    // First 2 calls stall (never yield, never resolve) and abort when signal fires.
    // 3rd call returns a real response -- we assert it was made with streaming: false.
    const capturedOpts: StreamOptions[] = [];
    let callIndex = 0;
    mockStream.mockImplementation((opts: StreamOptions) => {
      capturedOpts.push(opts);
      callIndex++;
      if (callIndex <= 2) {
        // Stalling stream: aborts only when the per-attempt signal fires
        const abortPromise = new Promise<never>((_, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
        abortPromise.catch(() => {});
        return {
          [Symbol.asyncIterator]: async function* () {
            yield* [];
            await abortPromise;
          },
          response: abortPromise,
        } as unknown as ReturnType<typeof stream>;
      }
      return mockOkResult("Recovered!") as unknown as ReturnType<typeof stream>;
    });

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];

    const loopPromise = collectLoop(messages, { provider: "anthropic", model: "test" });

    // Advance past first-event idle timeout (45s) three times to drive through
    // the two stalls + their exponential-backoff retry delays.
    // 1st stall: 45s idle -> abort -> 1s retry delay
    // 2nd stall: 45s idle -> abort -> 2s retry delay -> flag flips -> 3rd call succeeds
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
    }

    const { events, result } = await loopPromise;
    vi.useRealTimers();

    expect(mockStream).toHaveBeenCalledTimes(3);
    // First two calls: streaming mode (flag undefined => default true)
    expect(capturedOpts[0].streaming).toBeUndefined();
    expect(capturedOpts[1].streaming).toBeUndefined();
    // Third call: non-streaming fallback explicitly set
    expect(capturedOpts[2].streaming).toBe(false);

    expect(events.some((e) => e.type === "agent_done")).toBe(true);
    expect(result.totalTurns).toBe(1); // stall retries don't count as turns
  }, 30_000);

  it("runs parallel tools concurrently by default", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];

    mockStream
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve({
          message: {
            role: "assistant" as const,
            content: [
              { type: "tool_call" as const, id: "t1", name: "slow", args: {} },
              { type: "tool_call" as const, id: "t2", name: "fast", args: {} },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 25 },
        }),
      } as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("done") as unknown as ReturnType<typeof stream>);

    const slowTool: AgentTool<typeof emptyParams> = {
      name: "slow",
      description: "slow test tool",
      parameters: emptyParams,
      async execute() {
        calls.push("slow:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        calls.push("slow:end");
        return "slow done";
      },
    };
    const fastTool: AgentTool<typeof emptyParams> = {
      name: "fast",
      description: "fast test tool",
      parameters: emptyParams,
      async execute() {
        await firstStarted.promise;
        calls.push("fast");
        releaseFirst.resolve();
        return "fast done";
      },
    };

    await collectLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "test" },
      ],
      {
        provider: "anthropic",
        model: "test",
        tools: [slowTool, fastTool],
      },
    );

    expect(calls).toEqual(["slow:start", "fast", "slow:end"]);
  });

  it("runs the entire tool batch sequentially when any tool opts in", async () => {
    const calls: string[] = [];

    mockStream
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve({
          message: {
            role: "assistant" as const,
            content: [
              { type: "tool_call" as const, id: "t1", name: "mutate", args: {} },
              { type: "tool_call" as const, id: "t2", name: "read_after", args: {} },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 25 },
        }),
      } as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("done") as unknown as ReturnType<typeof stream>);

    const mutateTool: AgentTool<typeof emptyParams> = {
      name: "mutate",
      description: "mutating test tool",
      parameters: emptyParams,
      executionMode: "sequential",
      async execute() {
        calls.push("mutate:start");
        await Promise.resolve();
        calls.push("mutate:end");
        return "mutated";
      },
    };
    const readAfterTool: AgentTool<typeof emptyParams> = {
      name: "read_after",
      description: "read-after test tool",
      parameters: emptyParams,
      async execute() {
        calls.push("read_after");
        return "read";
      },
    };

    await collectLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "test" },
      ],
      {
        provider: "anthropic",
        model: "test",
        tools: [mutateTool, readAfterTool],
      },
    );

    expect(calls).toEqual(["mutate:start", "mutate:end", "read_after"]);
  });

  it("stops after repeated invalid tool arguments", async () => {
    const toolResponse = (id: string) => ({
      message: {
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, id, name: "bash", args: {} }],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    mockStream
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve(toolResponse("t1")),
      } as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve(toolResponse("t2")),
      } as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve(toolResponse("t3")),
      } as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const { events, result } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      tools: [
        {
          name: "bash",
          description: "test",
          parameters: z.object({ command: z.string() }),
          execute: () => "should not execute",
        },
      ],
    });

    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === "tool_call_end" && e.isError)).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          message: expect.stringContaining("repeatedly issued invalid arguments"),
        }),
      }),
    );
    expect(result.totalTurns).toBe(3);
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
