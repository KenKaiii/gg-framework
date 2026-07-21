import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ProviderError } from "@kenkaiiii/gg-ai";
import {
  agentLoop,
  capToolResults,
  capTurnToolResults,
  classifyOverload,
  extractContextOverflowDetails,
  isBillingError,
  isContextOverflow,
  isThinkingBlockError,
  isUsageLimitError,
  serverResetDelayMs,
} from "./agent-loop.js";
import type { AgentEvent, AgentResult, AgentTool, TransformContextOptions } from "./types.js";
import type { Message, StreamOptions, ToolResult, Usage } from "@kenkaiiii/gg-ai";

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

function mockToolCallResult(name: string, usage: Usage, id = "t1") {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* [];
    },
    response: Promise.resolve({
      message: {
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, id, name, args: {} }],
      },
      stopReason: "tool_use" as const,
      usage,
    }),
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
  it("classifies transient provider 5xx and api_error as provider errors", () => {
    const cases = [
      new ProviderError("anthropic", "api_error: Internal server error", { statusCode: undefined }),
      new ProviderError("anthropic", "Internal server error", { statusCode: 500 }),
      new ProviderError("anthropic", "Bad Gateway", { statusCode: 502 }),
      new ProviderError("anthropic", "Service Unavailable", { statusCode: 503 }),
      new ProviderError("anthropic", "Gateway Timeout", { statusCode: 504 }),
      new ProviderError("openai", "exceeded request buffer limit while retrying upstream", {
        statusCode: 507,
      }),
      new ProviderError("openai", "exceeded request buffer limit while retrying upstream"),
    ];

    for (const error of cases) {
      expect(classifyOverload(error)).toBe("provider_error");
    }
  });

  it("does not retry permanent 5xx responses", () => {
    for (const statusCode of [501, 505, 511]) {
      expect(
        classifyOverload(new ProviderError("openai", "Permanent server response", { statusCode })),
      ).toBeNull();
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

  it("treats a Gemini hard quota exhaustion as a non-retriable usage limit", () => {
    const err = new ProviderError(
      "gemini",
      'Gemini quota exhausted — usage limit reached. Gemini API error (429): {"error":{"status":"RESOURCE_EXHAUSTED","message":"You have exhausted your capacity on this model."}}',
      { statusCode: 429 },
    );
    expect(isUsageLimitError(err)).toBe(true);
    // Non-retriable: kept out of the rate-limit backoff bucket.
    expect(classifyOverload(err)).toBeNull();
  });

  it("still treats a transient Gemini per-minute throttle as a retriable rate limit", () => {
    const err = new ProviderError(
      "gemini",
      'Gemini API error (429): {"error":{"status":"RESOURCE_EXHAUSTED"},"details":[{"retryDelay":"18s"}]}',
      { statusCode: 429, resetsAt: Math.floor(Date.now() / 1000) + 18 },
    );
    expect(isUsageLimitError(err)).toBe(false);
    expect(classifyOverload(err)).toBe("rate_limit");
  });
});

describe("serverResetDelayMs", () => {
  it("returns the delay until resetsAt in ms", () => {
    const err = new ProviderError("gemini", "rate limited", {
      statusCode: 429,
      resetsAt: Math.floor(Date.now() / 1000) + 18,
    });
    const delay = serverResetDelayMs(err);
    expect(delay).toBeGreaterThan(15_000);
    expect(delay).toBeLessThanOrEqual(18_000);
  });

  it("returns undefined when resetsAt is absent or already elapsed", () => {
    expect(
      serverResetDelayMs(new ProviderError("gemini", "x", { statusCode: 429 })),
    ).toBeUndefined();
    expect(
      serverResetDelayMs(
        new ProviderError("gemini", "x", {
          statusCode: 429,
          resetsAt: Math.floor(Date.now() / 1000) - 5,
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for non-Error values", () => {
    expect(serverResetDelayMs(null)).toBeUndefined();
    expect(serverResetDelayMs("resetsAt")).toBeUndefined();
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
    const turnEnd = events.find((event) => event.type === "turn_end");
    expect(turnEnd?.type === "turn_end" ? turnEnd.timing : undefined).toMatchObject({
      startedAt: expect.any(Number),
      firstProviderEventAt: expect.any(Number),
      completedAt: expect.any(Number),
      providerDurationMs: expect.any(Number),
      ttftMs: expect.any(Number),
    });
    if (turnEnd?.type === "turn_end") {
      expect(turnEnd.timing.completedAt).toBeGreaterThanOrEqual(turnEnd.timing.startedAt);
      expect(turnEnd.timing.providerDurationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("forwards Codex transport identity separately from prompt cache routing", async () => {
    mockStream.mockReturnValueOnce(mockOkResult("Done") as unknown as ReturnType<typeof stream>);

    await collectLoop([{ role: "user", content: "test" }], {
      provider: "openai",
      model: "gpt-5.6-luna",
      transportSessionId: "transport-session",
      promptCacheKey: "shared-cache-family",
      toolChoice: "none",
    });

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        transportSessionId: "transport-session",
        promptCacheKey: "shared-cache-family",
        toolChoice: "none",
      }),
    );
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
    expect(transformContext).toHaveBeenCalledWith(messages, {
      usage: undefined,
      pendingMessages: [],
    });
  });

  it("passes provider usage and pending tool results to the next transform", async () => {
    const usage: Usage = {
      inputTokens: 70,
      outputTokens: 30,
      cacheRead: 11,
      cacheWrite: 7,
    };
    mockStream
      .mockReturnValueOnce(
        mockToolCallResult("context_probe", usage) as unknown as ReturnType<typeof stream>,
      )
      .mockReturnValueOnce(mockOkResult("done") as unknown as ReturnType<typeof stream>);

    const transformContext = vi.fn((msgs: Message[], _options: TransformContextOptions) => msgs);
    await collectLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "run the tool" },
      ],
      {
        provider: "anthropic",
        model: "test",
        tools: [
          {
            name: "context_probe",
            description: "returns pending context",
            parameters: emptyParams,
            execute: () => "pending tool output",
          },
        ],
        transformContext,
      },
    );

    expect(transformContext).toHaveBeenCalledTimes(2);
    const secondOptions = transformContext.mock.calls[1]![1] as TransformContextOptions;
    expect(secondOptions.usage).toEqual(usage);
    expect(secondOptions.pendingMessages).toHaveLength(1);
    expect(secondOptions.pendingMessages[0]).toMatchObject({ role: "tool" });
    expect(JSON.stringify(secondOptions.pendingMessages[0]?.content)).toContain(
      "pending tool output",
    );
  });

  it("uses transformed history for the next provider call", async () => {
    const providerPrompts: Message[][] = [];
    mockStream
      .mockImplementationOnce((options: StreamOptions) => {
        providerPrompts.push(structuredClone(options.messages));
        return mockToolCallResult("context_probe", {
          inputTokens: 70,
          outputTokens: 30,
        }) as unknown as ReturnType<typeof stream>;
      })
      .mockImplementationOnce((options: StreamOptions) => {
        providerPrompts.push(structuredClone(options.messages));
        return mockOkResult("done") as unknown as ReturnType<typeof stream>;
      });

    const compacted: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "compacted history" },
    ];
    let transformCall = 0;
    const transformContext = vi.fn((msgs: Message[]) => {
      transformCall++;
      return transformCall === 2 ? compacted : msgs;
    });

    await collectLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "old history" },
      ],
      {
        provider: "anthropic",
        model: "test",
        tools: [
          {
            name: "context_probe",
            description: "returns context",
            parameters: emptyParams,
            execute: () => "large pending result",
          },
        ],
        transformContext,
      },
    );

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[1]).toEqual(compacted);
  });

  it("clears the usage anchor when a transform replaces history", async () => {
    const firstUsage: Usage = { inputTokens: 80, outputTokens: 20, cacheRead: 5 };
    const overflow = new Error("prompt is too long: 250000 tokens > 200000 maximum");
    mockStream
      .mockReturnValueOnce(
        mockToolCallResult("context_probe", firstUsage) as unknown as ReturnType<typeof stream>,
      )
      .mockReturnValueOnce(mockErrorResult(overflow) as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("recovered") as unknown as ReturnType<typeof stream>);

    let transformCall = 0;
    const transformContext = vi.fn((msgs: Message[], options: TransformContextOptions) => {
      transformCall++;
      if (transformCall === 2) {
        return [
          { role: "system" as const, content: "sys" },
          { role: "user" as const, content: "compacted history" },
        ];
      }
      if (options.force) return msgs.slice(0, 1);
      return msgs;
    });

    await collectLoop(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "old history" },
      ],
      {
        provider: "anthropic",
        model: "test",
        tools: [
          {
            name: "context_probe",
            description: "returns context",
            parameters: emptyParams,
            execute: () => "pending result",
          },
        ],
        transformContext,
      },
    );

    expect((transformContext.mock.calls[1]![1] as TransformContextOptions).usage).toEqual(
      firstUsage,
    );
    const forcedOptions = transformContext.mock.calls.find(
      (call) => (call[1] as TransformContextOptions).force,
    )?.[1] as TransformContextOptions;
    expect(forcedOptions).toEqual({ force: true, usage: undefined, pendingMessages: [] });
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

  it("surfaces a 402 insufficient-balance error immediately without retrying", async () => {
    const err402 = new ProviderError("deepseek", "usage limit reached: Insufficient Balance", {
      statusCode: 402,
    });
    mockStream.mockReturnValue(mockErrorResult(err402) as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    await expect(collectLoop(messages, { provider: "deepseek", model: "test" })).rejects.toThrow(
      /insufficient balance/i,
    );
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("does not compact an OpenRouter 402 requires-more-credits error", async () => {
    const err402 = new ProviderError(
      "openrouter",
      "This request requires more credits, or fewer max_tokens. You requested up to 225702 tokens.",
      { statusCode: 402 },
    );
    mockStream.mockReturnValue(mockErrorResult(err402) as unknown as ReturnType<typeof stream>);
    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    await expect(
      collectLoop(messages, { provider: "openrouter", model: "test", transformContext }),
    ).rejects.toThrow(/more credits/i);
    expect(mockStream).toHaveBeenCalledTimes(1);
    // The pre-turn transform may run once, but the 402 must NOT trigger the
    // overflow-driven force-compaction retry.
    expect(
      transformContext.mock.calls.some(
        (c) => (c[1] as { force?: boolean } | undefined)?.force === true,
      ),
    ).toBe(false);
  });

  it("classifies a 402 error as non-retriable billing, not overload or overflow", () => {
    const err402 = new ProviderError("openrouter", "This request requires more credits.", {
      statusCode: 402,
    });
    expect(isBillingError(err402)).toBe(true);
    expect(classifyOverload(err402)).toBeNull();
    expect(isContextOverflow(err402)).toBe(false);
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

  it("emits follow-up review before final agent_done", async () => {
    mockStream
      .mockReturnValueOnce(mockOkResult("Draft final") as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("Reviewed final") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    let injected = false;
    const getFollowUpMessages = vi.fn().mockImplementation(() => {
      if (injected) return null;
      injected = true;
      return [{ role: "user" as const, content: "Ideal?" }];
    });

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      getFollowUpMessages,
    });

    const followUpIndex = events.findIndex((event) => event.type === "follow_up_message");
    const doneIndex = events.findIndex((event) => event.type === "agent_done");

    expect(followUpIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(followUpIndex);
    expect(
      messages.some((message) => message.role === "user" && message.content === "Ideal?"),
    ).toBe(true);
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
    const turnEnd = events.find((event) => event.type === "turn_end");
    expect(turnEnd?.type === "turn_end" ? turnEnd.timing.ttftMs : 0).toBeGreaterThanOrEqual(90_000);
    expect(
      turnEnd?.type === "turn_end" ? turnEnd.timing.providerDurationMs : 0,
    ).toBeGreaterThanOrEqual(90_000);
  }, 30_000);

  it("preserves partial streamed text across a transport-failure retry", async () => {
    vi.useFakeTimers();

    // >= 200 chars so the partial clears MIN_PARTIAL_PRESERVE_CHARS.
    const partial = "Here is the first half of the answer. ".repeat(8);
    let callIndex = 0;
    mockStream.mockImplementation((opts: StreamOptions) => {
      callIndex++;
      if (callIndex === 1) {
        // Streams the partial, then stalls until the idle timeout aborts it.
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
            yield { type: "text_delta" as const, text: partial };
            await abortPromise;
          },
          response: abortPromise,
        } as unknown as ReturnType<typeof stream>;
      }
      return mockOkResult("and the second half.") as unknown as ReturnType<typeof stream>;
    });

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];

    const loopPromise = collectLoop(messages, { provider: "anthropic", model: "test" });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
    }
    const { events } = await loopPromise;
    vi.useRealTimers();

    // The retry event advertises the preserved chars so UIs skip the rollback.
    const retry = events.find((e) => e.type === "retry" && e.reason === "stream_stall");
    expect(retry && "preservedChars" in retry ? retry.preservedChars : 0).toBe(partial.length);

    // History keeps the partial as an assistant message, then a continuation
    // instruction, then the retry's completion — nothing regenerated.
    const texts = messages.map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as { type: string; text?: string }[])
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(""),
    );
    const partialIdx = texts.findIndex((t) => t === partial);
    expect(partialIdx).toBeGreaterThan(-1);
    expect(messages[partialIdx].role).toBe("assistant");
    expect(messages[partialIdx + 1].role).toBe("user");
    expect(texts[partialIdx + 1]).toContain("cut off");
    expect(texts.some((t) => t === "and the second half.")).toBe(true);
  }, 30_000);

  it("discards a sub-threshold partial on transport-failure retry", async () => {
    vi.useFakeTimers();

    const tiny = "Short."; // < MIN_PARTIAL_PRESERVE_CHARS — replay is cheaper
    let callIndex = 0;
    mockStream.mockImplementation((opts: StreamOptions) => {
      callIndex++;
      if (callIndex === 1) {
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
            yield { type: "text_delta" as const, text: tiny };
            await abortPromise;
          },
          response: abortPromise,
        } as unknown as ReturnType<typeof stream>;
      }
      return mockOkResult("Full answer.") as unknown as ReturnType<typeof stream>;
    });

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];

    const loopPromise = collectLoop(messages, { provider: "anthropic", model: "test" });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
    }
    const { events } = await loopPromise;
    vi.useRealTimers();

    const retry = events.find((e) => e.type === "retry" && e.reason === "stream_stall");
    expect(retry && "preservedChars" in retry ? retry.preservedChars : undefined).toBeUndefined();
    // No preserved-partial assistant message in history.
    const assistantTexts = messages
      .filter((m) => m.role === "assistant")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : (m.content as { type: string; text?: string }[])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join(""),
      );
    expect(assistantTexts).not.toContain(tiny);
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

  it("redacts successful tool output before events and provider context", async () => {
    const canary = "sk-ant-api03-canarysecret123456";
    mockStream
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve({
          message: {
            role: "assistant" as const,
            content: [{ type: "tool_call" as const, id: "t1", name: "secret", args: {} }],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      } as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("done") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];
    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      tools: [
        {
          name: "secret",
          description: "returns a canary",
          parameters: emptyParams,
          execute: () => ({ content: `result ${canary}`, details: { apiKey: canary } }),
        },
      ],
    });

    const serializedEvents = JSON.stringify(events);
    const serializedMessages = JSON.stringify(messages);
    expect(serializedEvents).not.toContain(canary);
    expect(serializedMessages).not.toContain(canary);
    expect(serializedEvents).toContain("[REDACTED]");
    expect(serializedMessages).toContain("[REDACTED]");
  });

  it("redacts failed tool output before events and provider context", async () => {
    const canary = "sk-ant-api03-failuresecret123456";
    mockStream
      .mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve({
          message: {
            role: "assistant" as const,
            content: [{ type: "tool_call" as const, id: "t1", name: "secret", args: {} }],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      } as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(mockOkResult("done") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];
    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      tools: [
        {
          name: "secret",
          description: "throws a canary",
          parameters: emptyParams,
          execute: () => {
            throw new Error(`request failed with ${canary}`);
          },
        },
      ],
    });

    expect(JSON.stringify(events)).not.toContain(canary);
    expect(JSON.stringify(messages)).not.toContain(canary);
    expect(JSON.stringify(messages)).toContain("[REDACTED]");
  });

  it("stops after repeated invalid tool arguments with non-empty args", async () => {
    // Non-empty (but wrong-typed) args mean the model actually attempted a
    // value -- not a provider stream glitch -- so this stays non-recoverable
    // and stops immediately after 3 identical failures, as before.
    const toolResponse = (id: string) => ({
      message: {
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, id, name: "bash", args: { command: 123 } }],
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
    // Non-recoverable fatal — no auto-continue retry event.
    expect(events.filter((e) => e.type === "retry")).toHaveLength(0);
    expect(result.totalTurns).toBe(3);
  });

  it("auto-continues once after repeated EMPTY tool arguments, then stops if it recurs", async () => {
    // Empty args (`{}`) is the signature of a provider stream that closed the
    // tool_use block before ever sending argument tokens -- recoverable, so
    // the loop gets exactly one bounded auto-continue before treating a
    // repeat as fatal.
    const emptyArgsResponse = (id: string) => ({
      message: {
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, id, name: "bash", args: {} }],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
      mockStream.mockReturnValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield* [];
        },
        response: Promise.resolve(emptyArgsResponse(id)),
      } as unknown as ReturnType<typeof stream>);
    }

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

    // 3 failures trip the recoverable path and auto-continue (no stop yet);
    // 3 more failures after the fresh budget trip the fatal path for real.
    expect(mockStream).toHaveBeenCalledTimes(6);
    expect(events.filter((e) => e.type === "tool_call_end" && e.isError)).toHaveLength(6);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "retry", reason: "tool_argument_glitch" }),
    );
    expect(
      events.filter((e) => e.type === "retry" && e.reason === "tool_argument_glitch"),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          message: expect.stringContaining("repeatedly issued invalid arguments"),
        }),
      }),
    );
    expect(result.totalTurns).toBe(6);
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

  it("emits a terminal max_turns signal when the turn budget is exhausted mid-task", async () => {
    // Model never stops calling tools, so the loop can only end by hitting the cap.
    const toolResponse = {
      message: {
        role: "assistant" as const,
        content: [{ type: "tool_call" as const, id: "t1", name: "test_tool", args: {} }],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 25 },
    };
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

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      maxTurns: 3,
      tools: [
        {
          name: "test_tool",
          description: "test",
          parameters: { parse: () => ({}) } as never,
          execute: () => "result",
        },
      ],
    });

    const maxTurnsEvents = events.filter((e) => e.type === "max_turns");
    expect(maxTurnsEvents).toHaveLength(1);
    expect(maxTurnsEvents[0]).toMatchObject({ type: "max_turns", totalTurns: 3, maxTurns: 3 });

    // It must be terminal: the final agent_done comes AFTER the max_turns signal.
    const maxTurnsIndex = events.findIndex((e) => e.type === "max_turns");
    const doneIndex = events.findIndex((e) => e.type === "agent_done");
    expect(maxTurnsIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(maxTurnsIndex);
  });

  it("does NOT emit max_turns when the agent finishes cleanly under budget", async () => {
    mockStream.mockReturnValue(mockOkResult("done") as unknown as ReturnType<typeof stream>);

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test" },
    ];

    const { events } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
      maxTurns: 5,
    });

    expect(events.some((e) => e.type === "max_turns")).toBe(false);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });
});

describe("agentLoop truncation handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockStopResult(text: string, stopReason: string) {
    const resp = makeResponse(text, stopReason);
    const events = text ? [{ type: "text_delta" as const, text }] : [];
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const e of events) yield e;
      },
      response: Promise.resolve(resp),
    };
  }

  const truncatedEvents = (events: AgentEvent[]) =>
    events.filter((e): e is Extract<AgentEvent, { type: "truncated" }> => e.type === "truncated");

  it("injects a continuation after a max_tokens stop and resumes the output", async () => {
    mockStream
      .mockReturnValueOnce(
        mockStopResult("first half", "max_tokens") as unknown as ReturnType<typeof stream>,
      )
      .mockReturnValueOnce(
        mockStopResult("second half", "end_turn") as unknown as ReturnType<typeof stream>,
      );

    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ];

    const { events, result } = await collectLoop(messages, {
      provider: "anthropic",
      model: "test",
    });

    const truncated = truncatedEvents(events);
    expect(truncated).toEqual([{ type: "truncated", reason: "max_tokens", continued: true }]);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
    expect(result.totalTurns).toBe(2);

    // The continuation user message was injected between the two assistant parts.
    const continuation = messages.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("output-token limit"),
    );
    expect(continuation).toBeDefined();
    // Both parts are preserved in history — no replay.
    const assistantTexts = messages
      .filter((m) => m.role === "assistant")
      .map((m) =>
        Array.isArray(m.content)
          ? m.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("")
          : m.content,
      );
    expect(assistantTexts).toEqual(["first half", "second half"]);
  });

  it("stops continuing after two max_tokens continuations and warns", async () => {
    mockStream.mockReturnValue(
      mockStopResult("partial", "max_tokens") as unknown as ReturnType<typeof stream>,
    );

    const { events } = await collectLoop([{ role: "user", content: "go" }], {
      provider: "anthropic",
      model: "test",
    });

    const truncated = truncatedEvents(events);
    expect(truncated).toEqual([
      { type: "truncated", reason: "max_tokens", continued: true },
      { type: "truncated", reason: "max_tokens", continued: true },
      { type: "truncated", reason: "max_tokens", continued: false },
    ]);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });

  it("emits a provider_error truncated warning on an error stop", async () => {
    mockStream.mockReturnValueOnce(
      mockStopResult("degraded", "error") as unknown as ReturnType<typeof stream>,
    );

    const { events } = await collectLoop([{ role: "user", content: "go" }], {
      provider: "anthropic",
      model: "test",
    });

    const truncated = truncatedEvents(events);
    expect(truncated).toEqual([{ type: "truncated", reason: "provider_error", continued: false }]);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });

  it("emits a refusal truncated warning on a refusal stop", async () => {
    mockStream.mockReturnValueOnce(
      mockStopResult("no", "refusal") as unknown as ReturnType<typeof stream>,
    );

    const { events } = await collectLoop([{ role: "user", content: "go" }], {
      provider: "anthropic",
      model: "test",
    });

    expect(truncatedEvents(events)).toEqual([
      { type: "truncated", reason: "refusal", continued: false },
    ]);
  });

  it("executes tools normally on max_tokens with tool calls — no truncated event", async () => {
    const toolResp = {
      [Symbol.asyncIterator]: async function* () {
        yield* [];
      },
      response: Promise.resolve({
        message: {
          role: "assistant" as const,
          content: [{ type: "tool_call" as const, id: "t1", name: "echo", args: {} }],
        },
        stopReason: "max_tokens" as const,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    };
    mockStream
      .mockReturnValueOnce(toolResp as unknown as ReturnType<typeof stream>)
      .mockReturnValueOnce(
        mockStopResult("done", "end_turn") as unknown as ReturnType<typeof stream>,
      );

    const echo: AgentTool = {
      name: "echo",
      description: "echo",
      parameters: emptyParams,
      execute: vi.fn().mockResolvedValue("ok"),
    };

    const { events } = await collectLoop([{ role: "user", content: "go" }], {
      provider: "anthropic",
      model: "test",
      tools: [echo],
    });

    expect(truncatedEvents(events)).toEqual([]);
    expect(echo.execute).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });
});

describe("capTurnToolResults", () => {
  const result = (id: string, content: string) => ({
    type: "tool_result" as const,
    toolCallId: id,
    content,
  });

  it("leaves results untouched when the turn total fits the budget", () => {
    const toolResults = [result("a", "x".repeat(400)), result("b", "y".repeat(500))];
    capTurnToolResults(toolResults, 1_000);
    expect(toolResults[0].content).toBe("x".repeat(400));
    expect(toolResults[1].content).toBe("y".repeat(500));
  });

  it("is a no-op when no budget is configured", () => {
    const toolResults = [result("a", "x".repeat(5_000))];
    capTurnToolResults(toolResults, undefined);
    expect(toolResults[0].content).toBe("x".repeat(5_000));
  });

  it("trims only the largest results and preserves small ones (water-filling)", () => {
    const small = result("small", "s".repeat(200));
    const medium = result("medium", "m".repeat(2_000));
    const large = result("large", "l".repeat(20_000));
    const toolResults = [large, small, medium];
    capTurnToolResults(toolResults, 6_000);

    expect(small.content).toBe("s".repeat(200));
    expect(medium.content).toBe("m".repeat(2_000));
    expect(large.content).not.toBe("l".repeat(20_000));
    expect(large.content).toContain("characters trimmed");
    expect(large.content).toContain("offset/limit");
    // Trimmed large result keeps head and tail around the notice.
    expect(large.content.startsWith("l")).toBe(true);
    expect(large.content.endsWith("l")).toBe(true);
    // Total payload (minus notices) respects the budget.
    const kept = toolResults.reduce(
      (sum, r) => sum + (r.content as string).replace(/\n\n\[\.\.\..*\.\.\.\]\n\n/s, "").length,
      0,
    );
    expect(kept).toBeLessThanOrEqual(6_000);
  });

  it("splits the budget across several oversized parallel results", () => {
    const toolResults = [
      result("a", "a".repeat(50_000)),
      result("b", "b".repeat(50_000)),
      result("c", "c".repeat(50_000)),
    ];
    capTurnToolResults(toolResults, 30_000);
    for (const r of toolResults) {
      expect((r.content as string).length).toBeLessThan(50_000);
      expect(r.content).toContain("characters trimmed");
    }
  });

  it("ignores structured (non-string) results", () => {
    const structured = {
      type: "tool_result" as const,
      toolCallId: "img",
      content: [{ type: "text" as const, text: "t".repeat(10_000) }],
    };
    const text = result("txt", "x".repeat(10_000));
    capTurnToolResults([structured, text], 5_000);
    expect(structured.content[0].text).toBe("t".repeat(10_000));
    expect(text.content).toContain("characters trimmed");
  });
});

// Fix D (baseline #2): capping mutates the model-input/persistent transcript in
// place while the tool_call_end event already carried the FULL preview. The
// `capped` marker makes that divergence programmatically visible.
describe("tool-result cap divergence marker", () => {
  const result = (id: string, content: string): ToolResult => ({
    type: "tool_result",
    toolCallId: id,
    content,
  });

  it("marks a per-result cap with original + kept char counts", () => {
    const r = result("big", "z".repeat(10_000));
    capToolResults([r], 1_000);
    expect(r.content).toContain("characters omitted");
    expect(r.capped).toEqual({
      originalChars: 10_000,
      keptChars: (r.content as string).length,
      scope: "per-result",
    });
  });

  it("does not mark a result that fits the per-result budget", () => {
    const r = result("small", "z".repeat(500));
    capToolResults([r], 1_000);
    expect(r.capped).toBeUndefined();
    expect(r.content).toBe("z".repeat(500));
  });

  it("marks a per-turn cap with scope 'per-turn'", () => {
    const large = result("large", "l".repeat(20_000));
    capTurnToolResults([large], 6_000);
    expect(large.capped?.scope).toBe("per-turn");
    expect(large.capped?.originalChars).toBe(20_000);
    expect(large.capped?.keptChars).toBe((large.content as string).length);
  });

  it("preserves the true original size when both caps fire in sequence", () => {
    const r = result("huge", "h".repeat(100_000));
    capToolResults([r], 50_000); // per-result trim first
    const afterPerResult = r.capped?.originalChars;
    capTurnToolResults([r], 5_000); // then per-turn trim
    expect(afterPerResult).toBe(100_000);
    // The per-turn marker keeps the FULL pre-any-trim original, not the
    // already-trimmed intermediate size.
    expect(r.capped?.originalChars).toBe(100_000);
    expect(r.capped?.scope).toBe("per-turn");
  });
});
