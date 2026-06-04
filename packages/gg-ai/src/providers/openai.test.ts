import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Provider } from "../types.js";
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
});
