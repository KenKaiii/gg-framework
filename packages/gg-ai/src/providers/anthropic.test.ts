import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import type { StreamEvent } from "../types.js";
import { streamAnthropic, fineGrainedToolStreamingEnabled } from "./anthropic.js";

const createMock = vi.fn();
const streamMock = vi.fn();
const withOptionsMock = vi.fn();

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
    static nextMessage: unknown = null;
    messages = {
      create: createMock.mockImplementation((params: { stream?: boolean }) => {
        const error = AnthropicMock.nextError;
        const events = AnthropicMock.nextEvents;
        if (params.stream === false) {
          if (error) throw error;
          if (AnthropicMock.nextMessage) return AnthropicMock.nextMessage;
          throw new Error("test did not configure a non-streaming message response");
        }
        if (!error && !events) {
          throw new Error("test did not configure AnthropicMock.nextError or nextEvents");
        }
        if (error) throw error;
        return (async function* () {
          for (const event of events ?? []) yield event;
        })();
      }),
      stream: streamMock,
    };
    // Mirrors the real SDK: a clone that shares auth state but carries per-call
    // option overrides (e.g. an explicit timeout). The non-streaming fallback
    // uses this to suppress the SDK's client-side "Streaming is required…" throw.
    withOptions = withOptionsMock.mockImplementation((_options: unknown) => this);
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
    // A realistic terminal sequence: the protocol always emits message_delta
    // (carrying stop_reason) before message_stop. Omitting it now trips the
    // silent-partial truncation guard, so keep the fixture protocol-accurate.
    AnthropicMock.nextEvents = [
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];

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

describe("streamAnthropic non-streaming fallback", () => {
  it("sets a client timeout (bypassing the SDK long-request guard) and synthesizes a response", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
      nextMessage: unknown;
    };
    AnthropicMock.nextError = null;
    AnthropicMock.nextEvents = null;
    AnthropicMock.nextMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello from fallback" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 9 },
    };
    withOptionsMock.mockClear();

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
      // A large max_tokens is exactly what tripped the SDK's client-side
      // "Streaming is required for operations that may take longer than 10
      // minutes" throw on the non-streaming path before this fix.
      maxTokens: 32000,
      streaming: false,
    });

    const events = [];
    for await (const event of result) {
      events.push(event);
    }

    // The fallback must clone the client with an explicit (non-null) timeout so
    // the SDK skips its pre-flight long-request guard.
    expect(withOptionsMock).toHaveBeenCalledTimes(1);
    const opts = withOptionsMock.mock.calls.at(-1)?.[0] as { timeout?: number };
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);

    // The non-streaming Message is replayed as stream events + a final response.
    const params = createMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.stream).toBe(false);
    expect(events.some((e) => (e as { type?: string }).type === "text_delta")).toBe(true);
    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "hello from fallback" }] },
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 9 },
    });
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

  it("replaces an empty-body error's raw JSON echo with a clean message", async () => {
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
    // Anthropic-shaped body (mirrors the first test above) but every field is an
    // EMPTY STRING rather than absent — e.g. a provider on the Anthropic
    // transport (MiniMax) returning `{ error: { type: "", message: "" } }`. Both
    // the empty-string guard (bodyMessage/bodyType must be non-blank to count as
    // "usable") and the raw-JSON-echo fallback are exercised here: without the
    // guard, the blank `message: ""` would win and the user would see nothing
    // at all instead of the clean fallback.
    AnthropicMock.nextError = new AnthropicMock.APIError(
      400,
      { type: "error", error: { type: "", message: "" } },
      '400 {"type":"error","error":{"type":"","message":""}}',
      null,
      null,
    );

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 400,
    } satisfies Partial<ProviderError>);
    await expect(result.response).rejects.toThrow(/HTTP 400/);
    await expect(result.response).rejects.not.toThrow(/"message"/);
  });

  it("replaces a raw HTML response body with a clean provider message", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      APIError: new (status: number, error: unknown, message: string) => Error;
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextEvents = null;
    AnthropicMock.nextError = new AnthropicMock.APIError(
      500,
      {},
      "500 <!DOCTYPE html><html><body>Internal Server Error</body></html>",
    );

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 500,
      message: "The provider returned an HTML error page (HTTP 500) instead of an API response.",
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

  it("surfaces a truncated tool_use JSON stream as a parse error instead of emitting args:{}", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextError = null;
    // Large `edit` call whose input_json_delta stream is cut off mid-payload
    // (the classic failure: the SSE connection drops before the closing braces
    // arrive). The accumulated argsJson is unparseable. The provider must NOT
    // swallow it into `{}` — that produced phantom `edit` calls with no
    // file_path/edits that the tool layer rejected as "Invalid arguments".
    AnthropicMock.nextEvents = [
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_trunc", name: "edit", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"file_path":"src/app.ts","edits":[{"old',
        },
      },
      // stream is truncated here — no more deltas, then the block/message close
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    // Attach the response handler up front so its rejection is never orphaned
    // (StreamResult drives the iterator and the `.response` promise from one
    // pump; both observe the same throw).
    const caught = result.response.catch((err: unknown) => err);

    const events: StreamEvent[] = [];
    try {
      for await (const event of result) {
        events.push(event);
      }
    } catch {
      // Iterator re-throws the same failure; asserted via `caught` below.
    }

    const error = await caught;
    // It must throw, not resolve.
    expect(error).toBeInstanceOf(ProviderError);
    // No statusCode on purpose: a 5xx would route this into classifyOverload's
    // plain streaming-backoff path (which re-truncates). Status-less keeps it
    // out of the overload bucket so agent-loop uses the malformed-stream path.
    expect((error as ProviderError).statusCode).toBeUndefined();
    // The SyntaxError cause is what agent-loop's isMalformedStream() walks to
    // classify this as a retryable transport failure (flips to non-streaming).
    // Asserting the shape here (rather than importing the gg-agent classifiers,
    // which sit above gg-ai) keeps the package dependency direction intact.
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    expect(((error as { cause?: Error }).cause as Error).name).toBe("SyntaxError");

    // Crucially: no tool call with empty args ever leaked out.
    const emptyArgsCall = events.find(
      (e) =>
        e.type === "toolcall_done" &&
        e.name === "edit" &&
        Object.keys((e as { args: Record<string, unknown> }).args).length === 0,
    );
    expect(emptyArgsCall).toBeUndefined();
  });

  it("does not send eager tool-input streaming by default (fine-grained flag off)", () => {
    const prev = process.env.GG_FINE_GRAINED_TOOL_STREAMING;
    const prevCC = process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING;
    delete process.env.GG_FINE_GRAINED_TOOL_STREAMING;
    delete process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING;
    try {
      expect(fineGrainedToolStreamingEnabled()).toBe(false);
      process.env.GG_FINE_GRAINED_TOOL_STREAMING = "1";
      expect(fineGrainedToolStreamingEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GG_FINE_GRAINED_TOOL_STREAMING;
      else process.env.GG_FINE_GRAINED_TOOL_STREAMING = prev;
      if (prevCC === undefined) delete process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING;
      else process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = prevCC;
    }
  });

  it("rejects with a 504 when the stream ends before a stop_reason (silent partial)", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextError = null;
    // Valid prefix, then a CLEAN end with NO message_delta / message_stop --
    // as if the provider hung up early but politely (the truncate-silent mode).
    AnthropicMock.nextEvents = [
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial-" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "text" } },
      { type: "content_block_stop", index: 0 },
    ];

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    // Attach the response handler up front so its rejection is never orphaned.
    // StreamResult's background pump rejects the `.response` promise independently
    // of the async iterator; swallow on both the thenable and `.response` so an
    // iterator-throws-first race can't surface as a process-level unhandled
    // rejection (the same footgun the 08 baseline flagged).
    const caught = result.response.catch((err: unknown) => err);
    const events: StreamEvent[] = [];
    const error = await caught;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe("anthropic");
    // 504 routes into the agent-loop retry bucket via classifyOverload --
    // the same retryable path a mid-stream socket destroy already takes.
    expect((error as ProviderError).statusCode).toBe(504);
    expect((error as ProviderError).message).toMatch(/before completion/i);
    // The raw partial is preserved on cause for debugging, never returned as a
    // phantom-complete response.
    const cause = (error as { cause?: { partialContent?: unknown } }).cause;
    expect(cause).toBeTruthy();
    expect(Array.isArray(cause?.partialContent)).toBe(true);
    // No "done" event with a phantom end_turn ever leaked out.
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("resolves normally on a full sequence (guard does not false-positive)", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const AnthropicMock = Anthropic as unknown as {
      nextError: Error | null;
      nextEvents: unknown[] | null;
    };
    AnthropicMock.nextError = null;
    AnthropicMock.nextEvents = [
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
      { type: "message_stop" },
    ];

    const result = streamAnthropic({
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-ant-test",
    });

    let text = "";
    for await (const event of result) {
      if (event.type === "text_delta") text += event.text;
    }

    await expect(result.response).resolves.toMatchObject({
      stopReason: "end_turn",
      usage: { outputTokens: 6 },
    });
    expect(text).toBe("Hello");
  });
});
