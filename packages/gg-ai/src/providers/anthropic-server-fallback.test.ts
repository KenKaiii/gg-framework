import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPart, Message, StreamOptions } from "../types.js";
import {
  anthropicServerFallback,
  isDirectAnthropicApi,
  SERVER_FALLBACK_BETA,
  streamAnthropic,
  sumUsageIterations,
} from "./anthropic.js";
import { applyServerFallbackReplay, toAnthropicMessages, toOpenAIMessages } from "./transform.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function sse(events: Record<string, unknown>[]): Response {
  const text = events
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Fixture built from the doc's "decline happens mid-output" streaming description. */
const MID_OUTPUT_FALLBACK_EVENTS: Record<string, unknown>[] = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 535, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sigA" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Partial " } },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "fallback",
      from: { model: "claude-fable-5" },
      to: { model: "claude-opus-4-8" },
    },
  },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "answer." } },
  { type: "content_block_stop", index: 3 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: {
      input_tokens: 412,
      output_tokens: 264,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: [
        {
          type: "message",
          model: "claude-fable-5",
          input_tokens: 535,
          output_tokens: 20,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
        },
        {
          type: "fallback_message",
          model: "claude-opus-4-8",
          input_tokens: 412,
          output_tokens: 264,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 50,
        },
      ],
    },
  },
  { type: "message_stop" },
];

const SIMPLE_EVENTS: Record<string, unknown>[] = [
  MID_OUTPUT_FALLBACK_EVENTS[0]!,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
];

function recorder(responder: (call: number, captured: Captured) => Response): {
  calls: Captured[];
  fetch: typeof fetch;
} {
  const calls: Captured[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers: headersOf(init),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(captured);
    return responder(calls.length, captured);
  }) as typeof fetch;
  return { calls, fetch: fn };
}

const HISTORY_WITH_FALLBACK: Message[] = [
  { role: "user", content: "hi" },
  {
    role: "assistant",
    content: [
      { type: "thinking", text: "plan", signature: "sigA" },
      { type: "text", text: "Partial " },
      { type: "raw", data: { type: "fallback", from: { model: "a" }, to: { model: "b" } } },
      { type: "text", text: "answer." },
    ],
  },
  { role: "user", content: "next" },
];

function baseOptions(extra: Partial<StreamOptions>): StreamOptions {
  return {
    provider: "anthropic",
    model: "claude-fable-5",
    apiKey: "sk-ant-api-test",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  } as StreamOptions;
}

beforeEach(() => {
  anthropicServerFallback.reset();
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDirectAnthropicApi", () => {
  it.each<[string | undefined, boolean]>([
    [undefined, true],
    ["https://api.anthropic.com", true],
    ["https://api.anthropic.com/", true],
    ["http://api.anthropic.com", false],
    ["https://api.anthropic.com.evil.example", false],
    ["https://bedrock-runtime.us-east-1.amazonaws.com", false],
    ["https://us-east5-aiplatform.googleapis.com/v1", false],
    ["https://my-resource.services.ai.azure.com/anthropic", false],
    ["https://api.minimax.io/anthropic", false],
    ["http://localhost:4000", false],
    ["not a url", false],
  ])("%s → %s", (baseUrl, expected) => {
    expect(isDirectAnthropicApi(baseUrl)).toBe(expected);
  });

  it("honours ANTHROPIC_BASE_URL when no baseUrl is passed", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com");
    expect(isDirectAnthropicApi(undefined)).toBe(false);
  });
});

describe("server-side fallback request", () => {
  it.each<[string, Partial<StreamOptions>, boolean]>([
    ["direct API (default)", {}, true],
    ["direct API (explicit)", { baseUrl: "https://api.anthropic.com" }, true],
    ["OAuth on direct API", { apiKey: "sk-ant-oat-x" }, true],
    ["Bedrock", { baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" }, false],
    ["Vertex", { baseUrl: "https://us-east5-aiplatform.googleapis.com/v1" }, false],
    ["custom proxy", { baseUrl: "https://llm-proxy.internal" }, false],
    [
      "MiniMax",
      {
        provider: "minimax",
        baseUrl: "https://api.minimax.io/anthropic",
      } as Partial<StreamOptions>,
      false,
    ],
  ])("%s → fallbacks sent: %s", async (_label, extra, expected) => {
    const rec = recorder(() => sse(SIMPLE_EVENTS));
    await streamAnthropic(baseOptions({ ...extra, fetch: rec.fetch }));
    const call = rec.calls[0]!;
    expect(call.body.fallbacks).toBe(expected ? "default" : undefined);
    const betas = (call.headers["anthropic-beta"] ?? "").split(",");
    expect(betas.includes(SERVER_FALLBACK_BETA)).toBe(expected);
  });

  it("merges the beta with existing betas", async () => {
    const rec = recorder(() => sse(SIMPLE_EVENTS));
    await streamAnthropic(
      baseOptions({ apiKey: "sk-ant-oat-x", compaction: true, fetch: rec.fetch }),
    );
    const betas = rec.calls[0]!.headers["anthropic-beta"]!.split(",");
    expect(betas).toEqual(
      expect.arrayContaining([
        "claude-code-20250219",
        "oauth-2025-04-20",
        "compact-2026-01-12",
        SERVER_FALLBACK_BETA,
      ]),
    );
  });

  it("also applies to the non-streaming path", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-8",
            content: [
              {
                type: "fallback",
                from: { model: "claude-fable-5" },
                to: { model: "claude-opus-4-8" },
              },
              { type: "text", text: "Hi" },
            ],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 412,
              output_tokens: 264,
              iterations: [
                { type: "message", model: "claude-fable-5", input_tokens: 535, output_tokens: 0 },
                {
                  type: "fallback_message",
                  model: "claude-opus-4-8",
                  input_tokens: 412,
                  output_tokens: 264,
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const response = await streamAnthropic(baseOptions({ streaming: false, fetch: rec.fetch }));
    expect(rec.calls[0]!.body.fallbacks).toBe("default");
    expect(response.message.content).toEqual([
      {
        type: "raw",
        data: {
          type: "fallback",
          from: { model: "claude-fable-5" },
          to: { model: "claude-opus-4-8" },
        },
      },
      { type: "text", text: "Hi" },
    ]);
    expect(response.usage).toMatchObject({ inputTokens: 947, outputTokens: 264 });
  });
});

describe("server-side fallback 400 fail-safe", () => {
  const reject400 = (): Response =>
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "fallbacks: Extra inputs are not permitted",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  it("retries once without fallbacks/beta/fallback blocks and remembers for the process", async () => {
    const rec = recorder((n) => (n === 1 ? reject400() : sse(SIMPLE_EVENTS)));
    const response = await streamAnthropic(
      baseOptions({ messages: HISTORY_WITH_FALLBACK, fetch: rec.fetch }),
    );
    expect(response.message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]!.body.fallbacks).toBe("default");
    expect(JSON.stringify(rec.calls[0]!.body.messages)).toContain('"fallback"');
    const retry = rec.calls[1]!;
    expect(retry.body.fallbacks).toBeUndefined();
    expect(retry.headers["anthropic-beta"] ?? "").not.toContain(SERVER_FALLBACK_BETA);
    expect(JSON.stringify(retry.body.messages)).not.toContain('"fallback"');

    // Same config: never sent again this process.
    const rec2 = recorder(() => sse(SIMPLE_EVENTS));
    await streamAnthropic(baseOptions({ fetch: rec2.fetch }));
    expect(rec2.calls).toHaveLength(1);
    expect(rec2.calls[0]!.body.fallbacks).toBeUndefined();

    // A different auth kind is tracked separately.
    const rec3 = recorder(() => sse(SIMPLE_EVENTS));
    await streamAnthropic(baseOptions({ apiKey: "sk-ant-oat-x", fetch: rec3.fetch }));
    expect(rec3.calls[0]!.body.fallbacks).toBe("default");
  });

  it("does not retry an unrelated 400", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "max_tokens: too large" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(streamAnthropic(baseOptions({ fetch: rec.fetch }))).rejects.toThrow(/max_tokens/);
    expect(rec.calls).toHaveLength(1);
    expect(anthropicServerFallback.disabled.size).toBe(0);
  });

  it("a refusal that survives fallback still surfaces as stop_reason refusal", async () => {
    const rec = recorder(() =>
      sse([
        MID_OUTPUT_FALLBACK_EVENTS[0]!,
        {
          type: "message_delta",
          delta: { stop_reason: "refusal", stop_sequence: null },
          usage: { output_tokens: 0 },
        },
        { type: "message_stop" },
      ]),
    );
    const response = await streamAnthropic(baseOptions({ fetch: rec.fetch }));
    expect(response.stopReason).toBe("refusal");
  });
});

describe("streaming parse of a mid-output fallback", () => {
  it("keeps the fallback block at its exact position and sums iteration usage", async () => {
    const rec = recorder(() => sse(MID_OUTPUT_FALLBACK_EVENTS));
    const response = await streamAnthropic(baseOptions({ fetch: rec.fetch }));
    expect(response.message.content).toEqual([
      { type: "thinking", text: "plan", signature: "sigA" },
      { type: "text", text: "Partial " },
      {
        type: "raw",
        data: {
          type: "fallback",
          from: { model: "claude-fable-5" },
          to: { model: "claude-opus-4-8" },
        },
      },
      { type: "text", text: "answer." },
    ]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      inputTokens: 947,
      outputTokens: 284,
      cacheRead: 100,
      cacheWrite: 50,
    });
  });
});

describe("sumUsageIterations", () => {
  it("returns null without iterations", () => {
    expect(sumUsageIterations({ input_tokens: 1 })).toBeNull();
    expect(sumUsageIterations({ iterations: [] })).toBeNull();
    expect(sumUsageIterations(undefined)).toBeNull();
  });
  it("sums all four counters, tolerating missing fields", () => {
    expect(
      sumUsageIterations({
        iterations: [
          { input_tokens: 10, output_tokens: 1 },
          {
            input_tokens: 5,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          },
        ],
      }),
    ).toEqual({ inputTokens: 15, outputTokens: 3, cacheRead: 3, cacheWrite: 4 });
  });
});

describe("fallback replay rules", () => {
  const FB: ContentPart = {
    type: "raw",
    data: { type: "fallback", from: { model: "a" }, to: { model: "b" } },
  };
  const FB2: ContentPart = {
    type: "raw",
    data: { type: "fallback", from: { model: "b" }, to: { model: "c" } },
  };
  const turn: ContentPart[] = [
    { type: "thinking", text: "t1", signature: "s1" },
    { type: "raw", data: { type: "redacted_thinking", data: "x" } },
    { type: "raw", data: { type: "connector_text", text: "between" } },
    { type: "text", text: "before" },
    { type: "tool_call", id: "c1", name: "read", args: {} },
    { type: "server_tool_call", id: "s_paired", name: "web_search", input: {} },
    {
      type: "server_tool_result",
      toolUseId: "s_paired",
      resultType: "web_search_tool_result",
      data: {},
    },
    { type: "server_tool_call", id: "s_orphan", name: "web_search", input: {} },
    FB,
    { type: "text", text: "middle" },
    FB2,
    { type: "thinking", text: "t2", signature: "s2" },
    { type: "text", text: "after" },
    { type: "tool_call", id: "c2", name: "read", args: {} },
  ];

  it("applies the doc table relative to the final fallback block", () => {
    const dropped = new Set<string>();
    expect(applyServerFallbackReplay(turn, true, dropped)).toEqual([
      { type: "text", text: "before" },
      turn[5],
      turn[6],
      FB,
      { type: "text", text: "middle" },
      FB2,
      { type: "thinking", text: "t2", signature: "s2" },
      { type: "text", text: "after" },
      { type: "tool_call", id: "c2", name: "read", args: {} },
    ]);
    expect([...dropped]).toEqual(["c1"]);
  });

  it("strips the markers (after the same filtering) when the route can't take them", () => {
    const out = applyServerFallbackReplay(turn, false);
    expect(out.some((p) => p.type === "raw" && p.data.type === "fallback")).toBe(false);
    expect(out.filter((p) => p.type === "thinking")).toEqual([
      { type: "thinking", text: "t2", signature: "s2" },
    ]);
  });

  it("drops a turn left with only fallback markers", () => {
    const refusalTurn: ContentPart[] = [{ type: "thinking", text: "t", signature: "s" }, FB, FB2];
    expect(applyServerFallbackReplay(refusalTurn, true)).toEqual([]);
    const { messages } = toAnthropicMessages(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: refusalTurn },
        { role: "user", content: "again" },
      ],
      undefined,
      { fallbackBlocks: true },
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("returns the same array for a turn without fallback", () => {
    const plain: ContentPart[] = [
      { type: "thinking", text: "t", signature: "s" },
      { type: "text", text: "x" },
    ];
    expect(applyServerFallbackReplay(plain, true)).toBe(plain);
  });

  const history: Message[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "t1", signature: "s1" },
        { type: "tool_call", id: "c1", name: "read", args: {} },
        FB,
        { type: "thinking", text: "t2", signature: "s2" },
        { type: "text", text: "after" },
        { type: "tool_call", id: "c2", name: "read", args: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "c1", content: "r1" },
        { type: "tool_result", toolCallId: "c2", content: "r2" },
      ],
    },
  ];

  it("toAnthropicMessages keeps the marker in place and drops the paired tool_result", () => {
    const { messages } = toAnthropicMessages(history, undefined, { fallbackBlocks: true });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "fallback", from: { model: "a" }, to: { model: "b" } },
        { type: "thinking", thinking: "t2", signature: "s2" },
        { type: "text", text: "after" },
        { type: "tool_use", id: "c2", name: "read", input: {} },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c2", content: "r2", is_error: undefined }],
    });
  });

  it("toAnthropicMessages strips markers by default (non-fallback routes)", () => {
    const { messages } = toAnthropicMessages(history);
    expect(JSON.stringify(messages)).not.toContain('"fallback"');
    expect(JSON.stringify(messages)).not.toContain('"c1"');
    expect(JSON.stringify(messages)).toContain('"t2"');
  });

  it("drops a tool message left empty by the drop", () => {
    const h: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "read", args: {} },
          FB,
          { type: "text", text: "sorry" },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "r1" }] },
      { role: "user", content: "next" },
    ];
    const { messages } = toAnthropicMessages(h, undefined, { fallbackBlocks: true });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("other providers never forward fallback blocks", () => {
    const out = toOpenAIMessages(HISTORY_WITH_FALLBACK);
    expect(JSON.stringify(out)).not.toContain('"fallback"');
    expect(JSON.stringify(out)).toContain("answer.");
  });
});
