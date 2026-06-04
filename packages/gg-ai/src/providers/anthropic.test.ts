import { describe, expect, it, vi } from "vitest";
import type { ProviderError } from "../errors.js";
import { streamAnthropic } from "./anthropic.js";

const createMock = vi.fn();
const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number | undefined;
    error: unknown;
    requestID: string | null | undefined;
    type: string | null;

    constructor(
      status: number | undefined,
      error: unknown,
      message: string,
      requestID?: string | null,
      type?: string | null,
    ) {
      super(message);
      this.status = status;
      this.error = error;
      this.requestID = requestID;
      this.type = type ?? null;
    }
  }

  class AnthropicMock {
    static APIError = APIError;
    static nextError: Error | null = null;
    static nextEvents: unknown[] | null = null;
    messages = {
      create: createMock.mockImplementation((params: { stream?: boolean }) => {
        const error = AnthropicMock.nextError;
        const events = AnthropicMock.nextEvents;
        if (!error && !events) {
          throw new Error("test did not configure AnthropicMock.nextError or nextEvents");
        }
        if (params.stream === false) {
          if (error) throw error;
          throw new Error("test did not configure a non-streaming message response");
        }
        if (error) throw error;
        return (async function* () {
          for (const event of events ?? []) yield event;
        })();
      }),
      stream: streamMock,
    };
  }

  return { default: AnthropicMock };
});

describe("streamAnthropic request shaping", () => {
  it("sends thinking, cache, image, and tool transform params", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextError = null;
    AnthropicMock.nextEvents = [{ type: "message_stop" }];

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "stable\n<!-- uncached -->\nnow" },
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image", mediaType: "image/png", data: "abc" },
          ],
        },
      ],
      apiKey: "sk-ant-test",
      thinking: "high",
      cacheRetention: "short",
      temperature: 0.7,
    });
    for await (const _event of result) {
      /* consume */
    }

    const params = createMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ thinking: { type: "enabled" }, stream: true });
    expect(params.temperature).toBeUndefined();
    expect(params.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "now" },
    ]);
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "abc" },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });
});

describe("streamAnthropic error normalization", () => {
  it("extracts streamed api_error details and request ID", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      APIError: new (
        status: number | undefined,
        error: unknown,
        message: string,
        requestID?: string | null,
        type?: string | null,
      ) => Error;
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextEvents = null;
    AnthropicMock.nextError = new AnthropicMock.APIError(
      undefined,
      {
        type: "error",
        error: {
          details: null,
          type: "api_error",
          message: "Internal server error",
        },
        request_id: "req_011Cb6hYLp9bbMmkqdo2yTWL",
      },
      '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"},"request_id":"req_011Cb6hYLp9bbMmkqdo2yTWL"}',
      null,
      "api_error",
    );

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "anthropic",
      message: "api_error: Internal server error",
      requestId: "req_011Cb6hYLp9bbMmkqdo2yTWL",
    } satisfies Partial<ProviderError>);
  });

  it("maps an OAuth usage-window 429 to a usage-limit error with reset time", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      APIError: new (
        status: number | undefined,
        error: unknown,
        message: string,
        requestID?: string | null,
        type?: string | null,
      ) => Error;
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextEvents = null;
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const err = new AnthropicMock.APIError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited." } },
      "429 Too Many Requests",
      "req_usage_limit",
      "rate_limit_error",
    );
    Object.assign(err, {
      headers: new Headers({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(resetsAt),
      }),
    });
    AnthropicMock.nextError = err;

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-oat-test",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 429,
      message: "Claude usage limit reached",
      resetsAt,
    } satisfies Partial<ProviderError>);
  });

  it("treats a 429 without unified-rejected headers as a plain provider error", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      APIError: new (
        status: number | undefined,
        error: unknown,
        message: string,
        requestID?: string | null,
        type?: string | null,
      ) => Error;
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextEvents = null;
    const err = new AnthropicMock.APIError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited." } },
      "429 Too Many Requests",
      "req_throttle",
      "rate_limit_error",
    );
    Object.assign(err, { headers: new Headers({ "retry-after": "5" }) });
    AnthropicMock.nextError = err;

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-oat-test",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 429,
      message: "rate_limit_error: Rate limited.",
    } satisfies Partial<ProviderError>);
  });

  it("stamps a MiniMax 500 insufficient-balance body as a usage limit", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      APIError: new (
        status: number | undefined,
        error: unknown,
        message: string,
        requestID?: string | null,
        type?: string | null,
      ) => Error;
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextEvents = null;
    const err = new AnthropicMock.APIError(
      500,
      { type: "api_error", message: "insufficient balance (1008)" },
      "500 Internal Server Error",
      "req_minimax_balance",
      "api_error",
    );
    AnthropicMock.nextError = err;

    const result = streamAnthropic({
      provider: "anthropic",
      model: "minimax-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 500,
    } satisfies Partial<ProviderError>);
    await expect(result.response).rejects.toThrow(/usage limit reached/i);
  });

  it("preserves tool arguments carried on the streamed content block start", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextError = null;
    AnthropicMock.nextEvents = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 7 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "bash",
          input: { command: "echo ok" },
        },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    const events = [];
    for await (const event of result) {
      events.push(event);
    }

    await expect(result.response).resolves.toMatchObject({
      message: {
        content: [
          {
            type: "tool_call",
            id: "toolu_123",
            name: "bash",
            args: { command: "echo ok" },
          },
        ],
      },
      stopReason: "tool_use",
    });
    expect(events).toContainEqual({
      type: "toolcall_done",
      id: "toolu_123",
      name: "bash",
      args: { command: "echo ok" },
    });
  });

  it("reconstructs server tool input from streamed input_json_delta", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextError = null;
    // Native web_search: the content_block_start carries an empty input `{}`
    // and the real query streams in afterward via input_json_delta. The
    // provider must reconstruct the query from the accumulated argsJson, not
    // the empty block-start input -- otherwise Anthropic rejects the call with
    // `invalid_tool_input`.
    AnthropicMock.nextEvents = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 7 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_123",
          name: "web_search",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"opus ' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'clip pricing"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
      webSearch: true,
    });

    const events = [];
    for await (const event of result) {
      events.push(event);
    }

    await expect(result.response).resolves.toMatchObject({
      message: {
        content: [
          {
            type: "server_tool_call",
            id: "srvtoolu_123",
            name: "web_search",
            input: { query: "opus clip pricing" },
          },
        ],
      },
      stopReason: "tool_use",
    });
    expect(events).toContainEqual({
      type: "server_toolcall",
      id: "srvtoolu_123",
      name: "web_search",
      input: { query: "opus clip pricing" },
    });
  });
});
