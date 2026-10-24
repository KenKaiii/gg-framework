import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { z } from "zod";
import type { Message, StreamOptions } from "../types.js";

const chatCreateMock = vi.fn();
const responsesCreateMock = vi.fn();
/** Constructor options each `new OpenAI(...)` was built with, in call order. */
const clientOptions: Record<string, unknown>[] = [];

vi.mock("openai", () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status?: number, message = "api error") {
      super(message);
      this.status = status;
    }
  }
  class OpenAIMock {
    static APIError = APIError;
    chat = { completions: { create: chatCreateMock } };
    responses = { create: responsesCreateMock };
    constructor(options: Record<string, unknown>) {
      clientOptions.push(options);
    }
  }
  return { default: OpenAIMock };
});

type Event = Record<string, unknown>;

const readTool = {
  name: "read",
  description: "read a file",
  parameters: z.object({ path: z.string() }),
};

/** A Responses stream: optional reasoning, then text and/or one tool call. */
function responsesStream(opts: {
  reasoning?: { id: string; encrypted: string };
  text?: string;
  toolCall?: { callId: string; itemId: string; name: string; args: string };
  status?: "completed" | "incomplete";
}): AsyncIterable<Event> {
  return (async function* () {
    if (opts.reasoning) {
      const item = { type: "reasoning", id: opts.reasoning.id, summary: [] };
      yield { type: "response.output_item.added", item };
      yield { type: "response.reasoning_summary_text.delta", delta: "Considering." };
      yield {
        type: "response.output_item.done",
        item: { ...item, encrypted_content: opts.reasoning.encrypted },
      };
    }
    if (opts.text) {
      yield { type: "response.output_item.added", item: { type: "message", id: "msg_1" } };
      yield {
        type: "response.output_text.delta",
        item_id: "msg_1",
        content_index: 0,
        delta: opts.text,
      };
      yield { type: "response.output_item.done", item: { type: "message", id: "msg_1" } };
    }
    if (opts.toolCall) {
      const { callId, itemId, name, args } = opts.toolCall;
      const item = { type: "function_call", id: itemId, call_id: callId, name, arguments: "" };
      yield { type: "response.output_item.added", item };
      yield { type: "response.function_call_arguments.delta", item_id: itemId, delta: args };
      yield { type: "response.function_call_arguments.done", item_id: itemId, arguments: args };
      yield { type: "response.output_item.done", item: { ...item, arguments: args } };
    }
    yield {
      type: opts.status === "incomplete" ? "response.incomplete" : "response.completed",
      response: {
        status: opts.status ?? "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 60 },
        },
      },
    };
  })();
}

async function run(options: Partial<StreamOptions> = {}) {
  const { stream } = await import("../stream.js");
  const result = stream({
    provider: "xai",
    model: "grok-4.7",
    messages: [{ role: "user", content: "hi" }],
    apiKey: "tok" + "en",
    ...options,
  });
  const events: { type: string }[] = [];
  for await (const event of result) events.push(event);
  return { events, response: await result.response };
}

function lastBody(): Record<string, unknown> {
  return responsesCreateMock.mock.lastCall?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  chatCreateMock.mockReset();
  responsesCreateMock.mockReset();
  clientOptions.length = 0;
});

// Grok subscription OAuth routes to the Grok CLI chat proxy, which only serves
// recognized Grok-CLI clients. Injecting that identity in the transport (not at
// each call site) is what makes compaction, title-gen and sub-agents work too —
// they build their own streams and would otherwise be rejected.
describe("xai provider transport", () => {
  it("defaults to the public API host with no client-identity headers", async () => {
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "ok" }));
    await run({ model: "grok-4.5" });
    const options = clientOptions[0] ?? {};
    expect(options.baseURL).toBe("https://api.x.ai/v1");
    const headers = (options.defaultHeaders ?? {}) as Record<string, string>;
    // An API key is not a Grok CLI client — sending CLI identity to api.x.ai
    // would misrepresent the caller.
    expect(headers["X-XAI-Token-Auth"]).toBeUndefined();
  });

  it("attaches Grok CLI identity when routed to the OAuth chat proxy", async () => {
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "ok" }));
    await run({ model: "grok-4.5", baseUrl: "https://cli-chat-proxy.grok.com/v1" });
    const options = clientOptions[0] ?? {};
    expect(options.baseURL).toBe("https://cli-chat-proxy.grok.com/v1");
    const headers = (options.defaultHeaders ?? {}) as Record<string, string>;
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(headers["x-grok-client-version"]).toMatch(/^\d+\.\d+/);
    // The proxy 426s every request below its 1.0.13 floor (unless overridden).
    if (process.env.GROK_CLI_VERSION === undefined) {
      const [major = 0, minor = 0, patch = 0] = (headers["x-grok-client-version"] ?? "")
        .split(".")
        .map(Number);
      expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_000_013);
    }
    // The proxy routes by override header, so the model must travel in it.
    expect(headers["x-grok-model-override"]).toBe("grok-4.5");
  });

  // xAI caches per server: the key keeps a conversation on one cache-warm
  // server. Responses routes by prompt_cache_key; the header stays for parity.
  it("routes the session's cache key on every request", async () => {
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "ok" }));
    await run({ promptCacheKey: "ggcoder:session-1" });
    expect(lastBody().prompt_cache_key).toBe("ggcoder:session-1");
    const requestOptions = responsesCreateMock.mock.lastCall?.[1] as {
      headers?: Record<string, string>;
    };
    expect(requestOptions.headers?.["x-grok-conv-id"]).toBe("ggcoder:session-1");
  });

  it("does not send x-grok-conv-id to other OpenAI-compatible providers", async () => {
    const { stream } = await import("../stream.js");
    chatCreateMock.mockResolvedValueOnce(
      (async function* () {
        yield {
          id: "c",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        } as OpenAI.ChatCompletionChunk;
      })(),
    );
    for await (const _event of stream({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "tok" + "en",
      promptCacheKey: "ggcoder:session-1",
    })) {
      /* consume */
    }
    const requestOptions = chatCreateMock.mock.lastCall?.[1] as {
      headers?: Record<string, string>;
    };
    expect(requestOptions.headers?.["x-grok-conv-id"]).toBeUndefined();
  });
});

// xAI deprecates Chat Completions for Grok reasoning models: Chat can't carry
// the encrypted reasoning, so every tool round threw Grok's thinking away.
describe("xai Responses API", () => {
  it("uses the Responses API with stateless encrypted-reasoning replay", async () => {
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "ok" }));
    await run({ thinking: "high", maxTokens: 4096 });
    expect(chatCreateMock).not.toHaveBeenCalled();
    expect(lastBody()).toMatchObject({
      model: "grok-4.7",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      max_output_tokens: 4096,
    });
  });

  it("captures reasoning stamped with its model and replays it on the next turn", async () => {
    responsesCreateMock.mockResolvedValueOnce(
      responsesStream({
        reasoning: { id: "rs_1", encrypted: "ENC1" },
        toolCall: { callId: "call_1", itemId: "fc_1", name: "read", args: '{"path":"a"}' },
      }),
    );
    const first = await run({ tools: [readTool] });
    const content = first.response.message.content;
    expect(Array.isArray(content) && content[0]).toMatchObject({
      type: "raw",
      origin: "xai:grok-4.7",
      data: { type: "reasoning", id: "rs_1", encrypted_content: "ENC1" },
    });
    expect(first.response.stopReason).toBe("tool_use");
    expect(first.response.usage).toMatchObject({ inputTokens: 40, cacheRead: 60 });

    const history: Message[] = [
      { role: "user", content: "hi" },
      first.response.message,
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call_1|fc_1", content: "file a" }],
      },
    ];
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "done" }));
    await run({ messages: history });
    const input = lastBody().input as Record<string, unknown>[];
    // Reasoning, the call it led to, then the result — in that order, verbatim.
    expect(input.slice(1).map((item) => item.type)).toEqual([
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(input[1]).toMatchObject({ id: "rs_1", encrypted_content: "ENC1" });
    expect(input[1]).not.toHaveProperty("origin");
    expect(input[2]).toMatchObject({ id: "fc_1", call_id: "call_1" });
    expect(input[3]).toMatchObject({ call_id: "call_1", output: "file a" });
  });

  // Sessions from the Chat era or another provider carry ids like `call_*` and
  // `toolu_*`. Only ids xAI itself issued go back as item ids; assistant text
  // uses the documented `{ role, content }` form.
  it("replays foreign history in the minimal documented input form", async () => {
    const history: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          { type: "tool_call", id: "toolu_01abc", name: "read", args: { path: "a" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "toolu_01abc", content: "A" }] },
      { role: "user", content: "next" },
    ];
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "ok" }));
    await run({ messages: history });
    const input = lastBody().input as Record<string, unknown>[];
    expect(input[1]).toEqual({ role: "assistant", content: "Reading it." });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "toolu_01abc",
      name: "read",
      arguments: '{"path":"a"}',
    });
    expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "toolu_01abc" });
  });

  // If a stream ever skips output_item.added, the reply must not vanish: the
  // terminal payload types every item, and a done-only call is still complete.
  it("recovers text and calls whose items were never announced", async () => {
    responsesCreateMock.mockResolvedValueOnce(
      (async function* () {
        yield { type: "response.output_text.delta", item_id: "m1", content_index: 0, delta: "Hi" };
        yield {
          type: "response.output_item.done",
          item: { type: "function_call", id: "f1", call_id: "c1", name: "read", arguments: "{}" },
        };
        yield {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              { type: "message", id: "m1" },
              { type: "function_call", id: "f1" },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      })(),
    );
    const { response } = await run({ tools: [readTool] });
    expect(response.message.content).toEqual([
      { type: "text", text: "Hi" },
      { type: "tool_call", id: "c1|f1", name: "read", args: {} },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("never replays reasoning from another model or transport", async () => {
    const history: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "raw",
            origin: "xai:grok-4.6",
            data: { type: "reasoning", id: "a", encrypted_content: "X" },
          },
          // Codex reasoning carries no origin stamp.
          { type: "raw", data: { type: "reasoning", id: "b", encrypted_content: "Y" } },
          { type: "text", text: "earlier" },
        ],
      },
      { role: "user", content: "again" },
    ];
    responsesCreateMock.mockResolvedValueOnce(responsesStream({ text: "ok" }));
    await run({ messages: history });
    const types = (lastBody().input as Record<string, unknown>[]).map((item) => item.type);
    expect(types).not.toContain("reasoning");
  });

  it("retries once without replayed reasoning when xAI rejects it", async () => {
    const OpenAI = (await import("openai")).default as unknown as {
      APIError: new (status?: number, message?: string) => Error;
    };
    const history: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "raw",
            origin: "xai:grok-4.7",
            data: { type: "reasoning", id: "r", encrypted_content: "OLD" },
          },
          { type: "text", text: "earlier" },
        ],
      },
      { role: "user", content: "again" },
    ];
    responsesCreateMock
      .mockRejectedValueOnce(new OpenAI.APIError(400, "invalid encrypted content"))
      .mockResolvedValueOnce(responsesStream({ text: "recovered" }));
    const { response } = await run({ messages: history });
    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
    const retried = (lastBody().input as Record<string, unknown>[]).map((item) => item.type);
    expect(retried).not.toContain("reasoning");
    expect(response.message.content).toContainEqual({ type: "text", text: "recovered" });
    // The caller's history is never edited.
    expect((history[1] as { content: unknown[] }).content).toHaveLength(2);
  });

  it("keeps the agent loop's watchdog fed while hidden reasoning streams", async () => {
    responsesCreateMock.mockResolvedValueOnce(
      responsesStream({ reasoning: { id: "rs", encrypted: "E" }, text: "ok" }),
    );
    const { events } = await run();
    const types = events.map((e) => e.type);
    expect(types.indexOf("keepalive")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("keepalive")).toBeLessThan(types.indexOf("text_delta"));
    expect(types).not.toContain("thinking_delta");
  });

  it("honours the agent loop's non-streaming fallback", async () => {
    responsesCreateMock.mockResolvedValueOnce({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_n", summary: [], encrypted_content: "ENC" },
        {
          type: "function_call",
          id: "fc_n",
          call_id: "call_n",
          name: "read",
          arguments: '{"path":"b"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { response } = await run({ streaming: false, tools: [readTool] });
    expect(lastBody().stream).toBe(false);
    expect(response.stopReason).toBe("tool_use");
    expect(response.message.content).toEqual([
      expect.objectContaining({ type: "raw", origin: "xai:grok-4.7" }),
      { type: "tool_call", id: "call_n|fc_n", name: "read", args: { path: "b" } },
    ]);
  });
});
