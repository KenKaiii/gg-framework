import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Provider, ThinkingLevel } from "../types.js";
import { streamOpenAI } from "./openai.js";

const createMock = vi.fn();

interface APIErrorArgs {
  status?: number;
  code?: string;
  type?: string;
  headers?: Record<string, string>;
  message?: string;
  error?: unknown;
}

vi.mock("openai", () => {
  class APIError extends Error {
    status: number | undefined;
    code: string | undefined;
    type: string | undefined;
    headers: Headers | undefined;
    error: unknown;
    constructor(args: APIErrorArgs) {
      super(args.message ?? "api error");
      this.name = "APIError";
      this.status = args.status;
      this.code = args.code;
      this.type = args.type;
      this.headers = args.headers ? new Headers(args.headers) : undefined;
      this.error = args.error ?? { message: args.message };
    }
  }
  class OpenAIMock {
    static APIError = APIError;
    chat = {
      completions: {
        create: createMock,
      },
    };
  }
  return { default: OpenAIMock };
});

async function makeApiError(args: APIErrorArgs): Promise<Error> {
  const { default: OpenAI } = await import("openai");
  const Ctor = (OpenAI as unknown as { APIError: new (a: APIErrorArgs) => Error }).APIError;
  return new Ctor(args);
}

function createStreamingResult(argsJson: string): AsyncIterable<OpenAI.ChatCompletionChunk> {
  return (async function* () {
    yield {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: argsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    yield {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  })() as AsyncIterable<OpenAI.ChatCompletionChunk>;
}

async function collectResponse(provider: Provider, argsJson: string) {
  createMock.mockResolvedValueOnce(createStreamingResult(argsJson));
  const result = streamOpenAI({
    provider,
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    apiKey: "token",
  });

  const events = [];
  for await (const event of result) events.push(event);
  return { events, response: await result.response };
}

describe("streamOpenAI request shaping", () => {
  afterEach(() => {
    createMock.mockReset();
  });

  it.each<[Provider, Record<string, unknown>]>([
    ["openai", { reasoning_effort: "high", prompt_cache_key: "ggcoder", thinking: undefined }],
    [
      "glm",
      { thinking: { type: "enabled" }, reasoning_effort: undefined, prompt_cache_key: undefined },
    ],
    [
      "moonshot",
      { thinking: { type: "enabled" }, reasoning_effort: undefined, prompt_cache_key: "ggcoder" },
    ],
    [
      "xiaomi",
      { thinking: { type: "enabled" }, reasoning_effort: undefined, prompt_cache_key: undefined },
    ],
  ])("sends provider-specific thinking params for %s", async (provider, expected) => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      thinking: "high",
    });
    for await (const _event of result) {
      /* consume */
    }
    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(params[key]).toEqual(value);
    }
  });

  it("uses max reasoning_effort for Kimi K3 and omits K2.x/fixed sampling params", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "moonshot",
      model: "kimi-k3",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "t" + "est",
      thinking: "max",
      temperature: 0.4,
      topP: 0.8,
      cacheRetention: "long",
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ reasoning_effort: "max", prompt_cache_key: "ggcoder" });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("prompt_cache_retention");
  });

  it("uses the managed Kimi Code thinking shape for K3 over OAuth", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "moonshot",
      model: "kimi-k3",
      baseUrl: "https://api.kimi.com/coding/v1",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "t" + "est",
      thinking: "max",
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      thinking: { type: "enabled", effort: "max", keep: "all" },
      prompt_cache_key: "ggcoder",
    });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("disables Kimi K3 reasoning via the nested toggle when thinking is off", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "moonshot",
      model: "kimi-k3",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "history_call", name: "bash", args: { command: "pwd" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "history_call", content: "project root" }],
        },
      ],
      apiKey: "test-key",
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ thinking: { type: "disabled" } });
    expect(params).not.toHaveProperty("reasoning_effort");
    // A disabled K3 must not carry placeholder reasoning_content in history.
    expect((params.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it.each(["low", "high"] as const)(
    "sends Kimi K3's declared %s effort on both endpoints",
    async (effort) => {
      // Public API: top-level reasoning_effort.
      createMock.mockResolvedValueOnce(createStreamingResult(""));
      const pub = streamOpenAI({
        provider: "moonshot",
        model: "kimi-k3",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "t" + "est",
        thinking: effort,
      });
      for await (const _event of pub) {
        /* consume */
      }
      const pubParams = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(pubParams).toMatchObject({ reasoning_effort: effort });
      expect(pubParams).not.toHaveProperty("thinking");

      // Kimi Code OAuth: nested managed shape with preserved reasoning.
      createMock.mockResolvedValueOnce(createStreamingResult(""));
      const managed = streamOpenAI({
        provider: "moonshot",
        model: "kimi-k3",
        baseUrl: "https://api.kimi.com/coding/v1",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "t" + "est",
        thinking: effort,
      });
      for await (const _event of managed) {
        /* consume */
      }
      const managedParams = createMock.mock.calls[1]?.[0] as Record<string, unknown>;
      expect(managedParams).toMatchObject({
        thinking: { type: "enabled", effort, keep: "all" },
      });
      expect(managedParams).not.toHaveProperty("reasoning_effort");
    },
  );

  it("disables Kimi K3 on the managed endpoint with the nested toggle", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "moonshot",
      model: "kimi-k3",
      baseUrl: "https://api.kimi.com/coding/v1",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "t" + "est",
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ thinking: { type: "disabled" } });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("maps out-of-ladder Kimi K3 efforts per the official alias table", async () => {
    // Official mapping: ultra/max/xhigh → max, high/medium → high, low → low.
    const cases: Array<[ThinkingLevel, string]> = [
      ["medium", "high"],
      ["xhigh", "max"],
      ["ultra", "max"],
    ];
    for (const [given, sent] of cases) {
      createMock.mockResolvedValueOnce(createStreamingResult(""));
      const result = streamOpenAI({
        provider: "moonshot",
        model: "kimi-k3",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "t" + "est",
        thinking: given,
      });
      for await (const _event of result) {
        /* consume */
      }
      const params = createMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(params).toMatchObject({ reasoning_effort: sent });
    }
  });

  it("omits invalid reasoning and thinking controls for always-thinking Kimi K2.7", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "moonshot",
      model: "kimi-k2.7-code",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "t" + "est",
      thinking: "high",
      temperature: 0.4,
      topP: 0.8,
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("uses GPT-5.6 cache options instead of deprecated retention", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "openai",
      model: "gpt-5.6",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      cacheRetention: "long",
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      prompt_cache_key: "ggcoder",
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    });
    expect(params).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps 24h retention for pre-GPT-5.6 OpenAI models", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      cacheRetention: "long",
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ prompt_cache_retention: "24h" });
    expect(params).not.toHaveProperty("prompt_cache_options");
  });

  it("passes xhigh reasoning effort through for OpenAI GPT models", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      thinking: "xhigh",
    });
    for await (const _event of result) {
      /* consume */
    }
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("disables Xiaomi thinking explicitly when thinking is off", async () => {
    createMock.mockResolvedValueOnce(createStreamingResult(""));
    const result = streamOpenAI({
      provider: "xiaomi",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
    });
    for await (const _event of result) {
      /* consume */
    }
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ thinking: { type: "disabled" } });
  });
});

describe("streamOpenAI tool argument parsing", () => {
  afterEach(() => {
    createMock.mockReset();
  });

  it.each<Provider>(["openai", "glm", "moonshot", "xiaomi", "deepseek", "openrouter"])(
    "preserves streamed function call arguments for %s",
    async (provider) => {
      const { events, response } = await collectResponse(provider, '{"command":"echo ok"}');

      expect(response).toMatchObject({
        message: {
          content: [
            {
              type: "tool_call",
              id: "call_1",
              name: "bash",
              args: { command: "echo ok" },
            },
          ],
        },
        stopReason: "tool_use",
      });
      expect(events).toContainEqual({
        type: "toolcall_done",
        id: "call_1",
        name: "bash",
        args: { command: "echo ok" },
      });
    },
  );

  it("unwraps double-encoded streamed function call arguments", async () => {
    const { response } = await collectResponse("glm", JSON.stringify('{"command":"echo ok"}'));

    expect(response.message.content).toMatchObject([
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: { command: "echo ok" },
      },
    ]);
  });
});

describe("streamOpenAI hard/transient limit classification", () => {
  afterEach(() => {
    createMock.mockReset();
  });

  function streamWithError(provider: Provider, err: unknown) {
    createMock.mockRejectedValueOnce(err);
    return streamOpenAI({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
    });
  }

  function streamWithIteratorError(provider: Provider, err: unknown) {
    createMock.mockResolvedValueOnce({
      [Symbol.asyncIterator](): AsyncIterator<OpenAI.ChatCompletionChunk> {
        return {
          async next(): Promise<IteratorResult<OpenAI.ChatCompletionChunk>> {
            throw err;
          },
        };
      },
    });
    return streamOpenAI({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
    });
  }

  it("stamps DeepSeek 402 Insufficient Balance as a usage limit", async () => {
    const err = await makeApiError({ status: 402, message: "Insufficient Balance" });
    const result = streamWithError("deepseek", err);
    await expect(result.response).rejects.toThrow(/usage limit reached/i);
  });

  it("stamps OpenRouter 402 requires-more-credits as a usage limit", async () => {
    const err = await makeApiError({
      status: 402,
      message: "This request requires more credits, or fewer max_tokens.",
    });
    const result = streamWithError("openrouter", err);
    await expect(result.response).rejects.toThrow(/usage limit reached/i);
  });

  it("stamps OpenAI insufficient_quota 429 as a usage limit", async () => {
    const err = await makeApiError({
      status: 429,
      type: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    });
    const result = streamWithError("openai", err);
    await expect(result.response).rejects.toThrow(/usage limit reached/i);
  });

  it("normalizes OpenAI-compatible errors thrown while consuming the stream", async () => {
    const err = await makeApiError({
      status: 429,
      type: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    });
    const result = streamWithIteratorError("openai", err);
    await expect(result.response).rejects.toMatchObject({
      provider: "openai",
      statusCode: 429,
    });
    await expect(result.response).rejects.toThrow(/usage limit reached/i);
  });

  it("keeps a plain 429 retriable and stamps resetsAt from Retry-After", async () => {
    const now = Math.floor(Date.now() / 1000);
    const err = await makeApiError({
      status: 429,
      type: "rate_limit_exceeded",
      message: "Rate limit reached for requests",
      headers: { "retry-after": "30" },
    });
    const result = streamWithError("openai", err);
    await result.response.then(
      () => {
        throw new Error("expected rejection");
      },
      (caught: unknown) => {
        const e = caught as Error & { resetsAt?: number };
        expect(e.message).not.toMatch(/usage limit reached/i);
        expect(e.resetsAt).toBeGreaterThanOrEqual(now + 29);
        expect(e.resetsAt).toBeLessThanOrEqual(now + 32);
      },
    );
  });

  it("keeps a 429 rate_limit_exceeded with no Retry-After retriable and unstamped", async () => {
    const err = await makeApiError({
      status: 429,
      type: "rate_limit_exceeded",
      message: "Rate limit reached for requests",
    });
    const result = streamWithError("glm", err);
    await result.response.then(
      () => {
        throw new Error("expected rejection");
      },
      (caught: unknown) => {
        const e = caught as Error & { resetsAt?: number };
        expect(e.message).not.toMatch(/usage limit reached/i);
        expect(e.resetsAt).toBeUndefined();
      },
    );
  });

  it("replaces an empty-body error's raw JSON echo with a clean message", async () => {
    // Mirrors the exact shape Xiaomi's MiMo endpoint returns on a bare 400: every
    // field empty, so the real SDK's err.message becomes a stringified JSON blob
    // (`APIError.makeMessage` JSON.stringifies the body when it has no usable
    // string `message`). The mock constructs `message` directly rather than
    // reimplementing that logic, so pass the blob it would have produced.
    const err = await makeApiError({
      status: 400,
      error: { code: "400", message: "", param: "", type: "" },
      message: '400 {"code":"400","message":"","param":"","type":""}',
    });
    const result = streamWithError("xiaomi", err);
    await result.response.then(
      () => {
        throw new Error("expected rejection");
      },
      (caught: unknown) => {
        const e = caught as Error;
        expect(e.message).not.toContain('"code"');
        expect(e.message).toContain("HTTP 400");
      },
    );
  });

  it("replaces a raw HTML response body with a clean provider message", async () => {
    const err = await makeApiError({
      status: 500,
      error: {},
      message: "500 <html><head><title>Internal Server Error</title></head></html>",
    });
    const result = streamWithError("openai", err);

    await result.response.then(
      () => {
        throw new Error("expected rejection");
      },
      (caught: unknown) => {
        const e = caught as Error;
        expect(e.message).toBe(
          "The provider returned an HTML error page (HTTP 500) instead of an API response.",
        );
        expect(e.message).not.toContain("<html>");
      },
    );
  });
});
