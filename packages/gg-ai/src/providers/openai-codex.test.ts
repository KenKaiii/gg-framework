import * as zstd from "@bokuweb/zstd-wasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamOpenAICodex } from "./openai-codex.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";

function createSseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("streamOpenAICodex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves streamed function call arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "call_1", id: "item_1", name: "bash" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item_1",
            delta: '{"command":"echo ok"}',
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_1", id: "item_1" },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    const events = [];
    for await (const event of result) events.push(event);

    await expect(result.response).resolves.toMatchObject({
      message: {
        content: [
          {
            type: "tool_call",
            id: "call_1|item_1",
            name: "bash",
            args: { command: "echo ok" },
          },
        ],
      },
      stopReason: "tool_use",
    });
    expect(events).toContainEqual({
      type: "toolcall_done",
      id: "call_1|item_1",
      name: "bash",
      args: { command: "echo ok" },
    });
  });

  it("sanitizes continued-session tool call IDs for Codex input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "fc_tasks:153", name: "tasks", args: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "fc_tasks:153", content: "done" }],
        },
      ],
      apiKey: "token",
      accountId: "acct",
    });

    for await (const _event of result) {
      /* consume */
    }

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { input: unknown[] };
    expect(body.input).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        id: "fc_tasks_153",
        call_id: "fc_tasks_153",
      }),
    );
    expect(body.input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "fc_tasks_153" }),
    );
  });

  it("does not send an output token cap because the ChatGPT Codex backend rejects it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      maxTokens: 16384,
    });

    for await (const _event of result) {
      // consume stream
    }

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    await expect(result.response).resolves.toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it.each([
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["ultra", "max"],
  ] as const)(
    "maps %s to %s reasoning effort through Codex transport",
    async (thinking, effort) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createSseResponse([
            {
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            },
          ]),
        ),
      );

      const fetchMock = vi.mocked(fetch);
      const result = streamOpenAICodex({
        provider: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "token",
        accountId: "acct",
        thinking,
      });

      for await (const _event of result) {
        /* consume */
      }

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
        string,
        { effort?: string }
      >;
      expect(body.reasoning).toMatchObject({ effort });
    },
  );

  it("shapes Codex transport request with endpoint, cache headers, reasoning include, and no rejected token caps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      transportSessionId: "transport 1",
      maxTokens: 999,
      promptCacheKey: "cache family 1",
      cacheRetention: "long",
      thinking: "high",
    });

    for await (const _event of result) {
      /* consume */
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token",
      "OpenAI-Beta": "responses=experimental",
      "chatgpt-account-id": "acct",
      session_id: "transport 1",
      "x-client-request-id": "transport 1",
    });
    expect(body).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "cache family 1",
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it("zstd-compresses large Codex request bodies like the official CLI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
      ),
    );
    const longMessage = "const compressedRequestPayload = true;\n".repeat(4_000);
    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: longMessage }],
      apiKey: "test-credential",
      accountId: "acct",
    });

    for await (const _event of result) {
      /* consume */
    }

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "Content-Encoding": "zstd" });
    const compressedBody = init.body as Uint8Array;
    expect(compressedBody).toBeInstanceOf(Uint8Array);
    expect([...compressedBody.slice(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);

    const decoded = new TextDecoder().decode(zstd.decompress(compressedBody));
    const body = JSON.parse(decoded) as { input: Array<{ content: Array<{ text: string }> }> };
    expect(body.input[0]?.content[0]?.text).toBe(longMessage);
    expect(compressedBody.byteLength).toBeLessThan(new TextEncoder().encode(decoded).byteLength);
  });

  it.each([["a".repeat(64)], ["b".repeat(65)], ["long-session-".repeat(30)], ["会".repeat(65)]])(
    "normalizes transport identity once for both Codex headers",
    async (transportSessionId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createSseResponse([
            {
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            },
          ]),
        ),
      );
      const fetchMock = vi.mocked(fetch);
      const result = streamOpenAICodex({
        provider: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "token",
        accountId: "acct",
        transportSessionId,
        promptCacheKey: "independent-cache-key",
      });
      for await (const _event of result) {
        /* consume */
      }

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const expected = normalizePromptCacheKey(transportSessionId);
      expect(headers.session_id).toBe(expected);
      expect(headers["x-client-request-id"]).toBe(expected);
      expect(headers.session_id.length).toBeLessThanOrEqual(64);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.prompt_cache_key).toBe("independent-cache-key");
    },
  );

  it("omits transport headers when no transport identity is supplied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
      ),
    );
    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
    for await (const _event of result) {
      /* consume */
    }
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.session_id).toBeUndefined();
    expect(headers["x-client-request-id"]).toBeUndefined();
  });

  it.each(["auto", "none", "required"] as const)(
    "forwards the %s Codex tool choice",
    async (toolChoice) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createSseResponse([
            {
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } },
            },
          ]),
        ),
      );
      const fetchMock = vi.mocked(fetch);
      const result = streamOpenAICodex({
        provider: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "token",
        accountId: "acct",
        toolChoice,
        ...(toolChoice === "required"
          ? {
              tools: [
                {
                  name: "read",
                  description: "read",
                  parameters: z.object({}),
                },
              ],
            }
          : {}),
      });
      for await (const _event of result) {
        /* consume */
      }
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.tool_choice).toBe(toolChoice);
      if (toolChoice !== "required") expect(body.tools).toBeUndefined();
    },
  );

  it("defaults to auto when no tools or tool choice are configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
      ),
    );
    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
    for await (const _event of result) {
      /* consume */
    }
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toBeUndefined();
  });

  it("rejects named Codex tool selection locally", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      toolChoice: { name: "read" },
    });
    await expect(result.response).rejects.toThrow("does not support selecting the named tool");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects required tool choice locally when no tools exist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      toolChoice: "required",
    });
    await expect(result.response).rejects.toThrow("when no tools are configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports GPT-5.6 cache reads and writes separately from uncached input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 4096,
                output_tokens: 8,
                input_tokens_details: { cached_tokens: 2048, cache_write_tokens: 1024 },
              },
            },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    for await (const _event of result) {
      /* consume */
    }

    await expect(result.response).resolves.toMatchObject({
      usage: { inputTokens: 1024, outputTokens: 8, cacheRead: 2048, cacheWrite: 1024 },
    });
  });

  it("uses the official Codex Responses-Lite identity and request shape for GPT-5.6", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "low",
    });

    for await (const _event of result) {
      /* consume */
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(init.headers).toMatchObject({
      originator: "codex_cli_rs",
      version: "0.144.1",
      "User-Agent": "codex_cli_rs/0.144.1",
      "X-OpenAI-Internal-Codex-Responses-Lite": "true",
    });
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      parallel_tool_calls: false,
      reasoning: { effort: "low", summary: "auto", context: "all_turns" },
    });
  });

  it("surfaces JSON detail fields from Codex HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }), {
            status: 400,
            headers: { "content-type": "application/json", "x-oai-request-id": "req_123" },
          }),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    await expect(result.response).rejects.toMatchObject({
      message: "Unsupported parameter: max_output_tokens",
      statusCode: 400,
      requestId: "req_123",
    });
  });

  it("replaces an HTML Codex HTTP error with a clean provider message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<html><head><meta name="viewport" content="width=device-width"></head></html>',
            {
              status: 500,
              headers: { "content-type": "text/html", "x-request-id": "req_html" },
            },
          ),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    await expect(result.response).rejects.toMatchObject({
      message: "The provider returned an HTML error page (HTTP 500) instead of an API response.",
      statusCode: 500,
      requestId: "req_html",
    });
  });
  it("maps a ChatGPT usage-limit 429 to a usage-limit error with reset time", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "usage_limit_reached",
                message: "You've hit your usage limit.",
                plan_type: "plus",
                resets_at: resetsAt,
              },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json", "x-request-id": "req_usage" },
            },
          ),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    await expect(result.response).rejects.toMatchObject({
      provider: "openai",
      statusCode: 429,
      message: "ChatGPT usage limit reached",
      resetsAt,
    });
  });

  it("reads the usage reset time from a nested rate_limits snapshot", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "rate_limit_exceeded",
                message: "Rate limit reached.",
                rate_limits: { primary: { resets_at: resetsAt } },
              },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    await expect(result.response).rejects.toMatchObject({
      message: "ChatGPT usage limit reached",
      statusCode: 429,
      resetsAt,
    });
  });

  it("leaves a bare transient 429 (no reset info) as a retriable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    await expect(result.response).rejects.toMatchObject({
      message: "Too Many Requests",
      statusCode: 429,
    });
  });

  it("requests no reasoning and suppresses reasoning events when thinking is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "rs_1",
            delta: "private reasoning",
          },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            delta: "visible answer",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    const events = [];
    for await (const event of result) events.push(event);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
    expect(events).not.toContainEqual({ type: "thinking_delta", text: "" });
    expect(events).not.toContainEqual({ type: "thinking_delta", text: "private reasoning" });
    expect(events).not.toContainEqual({ type: "text_delta", text: "private reasoning" });
    expect(events).toContainEqual({ type: "text_delta", text: "visible answer" });
    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "visible answer" }] },
    });
  });

  it("suppresses reasoning item output text when thinking is on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "rs_1",
            delta: "private reasoning delta",
          },
          {
            type: "response.output_text.done",
            item_id: "rs_1",
            text: "private reasoning delta plus done",
          },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            delta: "visible answer",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "high",
    });

    const events = [];
    for await (const event of result) events.push(event);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "" });
    expect(events).not.toContainEqual({ type: "thinking_delta", text: "private reasoning delta" });
    expect(events).not.toContainEqual({ type: "thinking_delta", text: " plus done" });
    expect(events).not.toContainEqual({ type: "text_delta", text: "private reasoning delta" });
    expect(events).not.toContainEqual({ type: "text_delta", text: " plus done" });
    expect(events).toContainEqual({ type: "text_delta", text: "visible answer" });
    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "visible answer" }] },
    });
  });

  it("buffers output text until Codex identifies whether the item is visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_text.delta",
            item_id: "rs_1",
            delta: "private reasoning before item metadata",
          },
          {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            delta: "visible before item metadata",
          },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            delta: " plus visible after metadata",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "high",
    });

    const events = [];
    for await (const event of result) events.push(event);

    expect(events).not.toContainEqual({
      type: "thinking_delta",
      text: "private reasoning before item metadata",
    });
    expect(events).not.toContainEqual({
      type: "text_delta",
      text: "private reasoning before item metadata",
    });
    expect(events).toContainEqual({ type: "text_delta", text: "visible before item metadata" });
    expect(events).toContainEqual({ type: "text_delta", text: " plus visible after metadata" });
    await expect(result.response).resolves.toMatchObject({
      message: {
        content: [
          { type: "text", text: "visible before item metadata plus visible after metadata" },
        ],
      },
    });
  });

  it("handles alternate reasoning delta event variants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          { type: "response.reasoning_text.delta", delta: "a" },
          { type: "response.reasoning.delta", delta: "b" },
          { type: "response.reasoning_summary.delta", delta: "c" },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "high",
    });

    const events = [];
    for await (const event of result) events.push(event);

    expect(events).toContainEqual({ type: "thinking_delta", text: "a" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "b" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "c" });
  });

  it("emits only missing final text from output_text.done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_1" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            content_index: 0,
            delta: "hello",
          },
          {
            type: "response.output_text.done",
            item_id: "msg_1",
            content_index: 0,
            text: "hello world",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    const events = [];
    for await (const event of result) events.push(event);

    expect(events).toContainEqual({ type: "text_delta", text: "hello" });
    expect(events).toContainEqual({ type: "text_delta", text: " world" });
    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "hello world" }] },
    });
  });

  it("keeps reasoning output_text.done hidden with late reasoning metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_text.done",
            item_id: "rs_late",
            content_index: 0,
            text: "private done-only reasoning",
          },
          {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_late" },
          },
          {
            type: "response.output_text.done",
            item_id: "msg_late",
            content_index: 0,
            text: "visible done-only answer",
          },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_late" },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "high",
    });

    const events = [];
    for await (const event of result) events.push(event);

    expect(events).not.toContainEqual({ type: "text_delta", text: "private done-only reasoning" });
    expect(events).not.toContainEqual({
      type: "thinking_delta",
      text: "private done-only reasoning",
    });
    expect(events).toContainEqual({ type: "text_delta", text: "visible done-only answer" });
    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "visible done-only answer" }] },
    });
  });

  it("keeps output_text hidden forever when item metadata never arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_text.delta",
            item_id: "unknown_1",
            content_index: 0,
            delta: "unclassified text",
          },
          {
            type: "response.output_text.done",
            item_id: "unknown_1",
            content_index: 0,
            text: "unclassified text plus done",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "high",
    });

    const events = [];
    for await (const event of result) events.push(event);

    expect(events).not.toContainEqual({ type: "text_delta", text: "unclassified text" });
    expect(events).not.toContainEqual({ type: "text_delta", text: " plus done" });
    expect(events).not.toContainEqual({ type: "thinking_delta", text: "unclassified text" });
    expect(events).not.toContainEqual({ type: "thinking_delta", text: " plus done" });
    await expect(result.response).resolves.toMatchObject({
      message: { content: "" },
    });
  });

  it("captures encrypted reasoning and round-trips it before the function_call", async () => {
    // First request: the stream returns an encrypted reasoning item followed by
    // a tool call. The reasoning item must be captured on the assistant message.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.done",
            item: {
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "ENC_ABC",
              summary: [],
            },
          },
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "call_1", id: "item_1", name: "bash" },
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "item_1",
            arguments: '{"command":"echo ok"}',
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_1", id: "item_1" },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const first = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "medium",
    });
    for await (const _event of first) {
      // consume
    }
    const firstResponse = await first.response;
    const assistantContent = firstResponse.message.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(assistantContent[0]).toEqual({
      type: "raw",
      data: { type: "reasoning", id: "rs_1", encrypted_content: "ENC_ABC", summary: [] },
    });

    // Second request: feed the assistant turn (with captured reasoning) back in
    // and assert the request body re-emits the reasoning item before the
    // function_call in `input`.
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return createSseResponse([
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]);
      }),
    );

    const second = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "hi" },
        firstResponse.message,
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_1|item_1", content: "ok" }],
        },
      ],
      apiKey: "token",
      accountId: "acct",
      thinking: "medium",
    });
    for await (const _event of second) {
      // consume
    }

    const input = capturedBody?.input as Array<Record<string, unknown>>;
    const reasoningIdx = input.findIndex((i) => i.type === "reasoning");
    const callIdx = input.findIndex((i) => i.type === "function_call");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(reasoningIdx);
    expect(input[reasoningIdx]).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "ENC_ABC",
      summary: [],
    });
  });

  it("preserves per-call reasoning order for interleaved parallel tool calls", async () => {
    // reasoning A → call A → reasoning B → call B. Each reasoning item must keep
    // its position immediately before the function_call it reasoned about.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.done",
            item: { type: "reasoning", id: "rs_a", encrypted_content: "ENC_A", summary: [] },
          },
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "call_a", id: "item_a", name: "bash" },
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "item_a",
            arguments: '{"command":"a"}',
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_a", id: "item_a" },
          },
          {
            type: "response.output_item.done",
            item: { type: "reasoning", id: "rs_b", encrypted_content: "ENC_B", summary: [] },
          },
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "call_b", id: "item_b", name: "bash" },
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "item_b",
            arguments: '{"command":"b"}',
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_b", id: "item_b" },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "medium",
    });
    for await (const _event of result) {
      // consume
    }
    const response = await result.response;
    const content = response.message.content as unknown as Array<Record<string, unknown>>;
    expect(
      content.map((p) => (p.type === "raw" ? `r:${(p.data as { id: string }).id}` : `t:${p.id}`)),
    ).toEqual(["r:rs_a", "t:call_a|item_a", "r:rs_b", "t:call_b|item_b"]);
  });

  it("unwraps double-encoded function call arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.output_item.added",
            item: { type: "function_call", call_id: "call_1", id: "item_1", name: "bash" },
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "item_1",
            arguments: JSON.stringify('{"command":"echo ok"}'),
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    for await (const _event of result) {
      // consume stream
    }

    await expect(result.response).resolves.toMatchObject({
      message: {
        content: [
          {
            type: "tool_call",
            id: "call_1|item_1",
            name: "bash",
            args: { command: "echo ok" },
          },
        ],
      },
    });
  });
});
