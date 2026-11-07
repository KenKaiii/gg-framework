import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamOpenAIResponses } from "./openai-responses.js";
import { stream } from "../stream.js";

function createSseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("streamOpenAIResponses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["invalid_encrypted_content", undefined])(
    "recovers rejected reasoning (%s) without changing history",
    async (code) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                code,
                message:
                  "The encrypted content for item rs_old could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
              },
            }),
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(createSseResponse([{ type: "response.completed", response: {} }]));
      vi.stubGlobal("fetch", fetchMock);
      const messages = [
        {
          role: "assistant" as const,
          content: [
            {
              type: "raw" as const,
              data: { type: "reasoning", id: "rs_old", encrypted_content: "ENC_OLD", summary: [] },
            },
            { type: "text" as const, text: "Keep this answer" },
            { type: "tool_call" as const, id: "call_1|fc_1", name: "read", args: {} },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool_result" as const,
              toolCallId: "call_1|fc_1",
              content: "Keep this result",
            },
          ],
        },
        { role: "user" as const, content: "Continue" },
      ];
      const original = structuredClone(messages);
      const result = streamOpenAIResponses({
        provider: "openai",
        model: "gpt-6-astra",
        apiKey: "test",
        messages,
      });
      await expect(result.response).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = JSON.parse(fetchMock.mock.calls[0][1].body);
      const second = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(first.input[0].type).toBe("reasoning");
      expect(second).toEqual({ ...first, input: first.input.slice(1) });
      expect(messages).toEqual(original);
    },
  );

  it.each([
    { status: 400, code: "invalid_encrypted_content", reasoning: true, attempts: 2 },
    { status: 400, code: "invalid_encrypted_content", reasoning: false, attempts: 1 },
    { status: 401, code: "invalid_encrypted_content", reasoning: true, attempts: 1 },
    { status: 400, code: "invalid_request_error", reasoning: true, attempts: 1 },
  ])(
    "bounds reasoning recovery: $status $code reasoning=$reasoning",
    async ({ status, code, reasoning, attempts }) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code, message: "Rejected" } }), { status }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = streamOpenAIResponses({
        provider: "openai",
        model: "gpt-6-astra",
        apiKey: "test",
        messages: [
          ...(reasoning
            ? [
                {
                  role: "assistant" as const,
                  content: [
                    {
                      type: "raw" as const,
                      data: { type: "reasoning", id: "rs_old", encrypted_content: "ENC" },
                    },
                  ],
                },
              ]
            : []),
          { role: "user", content: "Continue" },
        ],
      });
      await expect(result.response).rejects.toMatchObject({
        statusCode: status,
        message: "Rejected",
      });
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
    },
  );

  it.each([
    { model: "gpt-6-luna-fast", tier: "priority" },
    { model: "gpt-6.1-sol-fast", tier: "priority" },
    { model: "gpt-6.1-terra-fast", tier: "priority" },
    { model: "gpt-6-luna", tier: undefined },
  ])("sends Codex Fast mode as service_tier priority: $model", async ({ model, tier }) => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      createSseResponse([{ type: "response.completed", response: {} }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = stream({
      provider: "openai",
      model,
      apiKey: "test",
      accountId: "acct",
      messages: [{ role: "user", content: "hi" }],
    });
    await result.response;
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    expect(body.model).toBe(model.replace(/-fast$/, ""));
    expect(body.service_tier).toBe(tier);
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

    const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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
    ["gpt-5.5", "medium", "medium"],
    ["gpt-5.5", "high", "high"],
    ["gpt-5.5", "xhigh", "xhigh"],
    ["gpt-6-sol", "ultra", "max"],
    ["gpt-6-astra", "ultra", "xhigh"],
    ["gpt-6.1-sol", "ultra", "xhigh"],
    ["gpt-6.1-terra", "ultra", "xhigh"],
    ["gpt-6-astra", "max", "max"],
    ["gpt-6.1-sol", "max", "max"],
  ] as const)(
    "maps %s %s to %s reasoning effort through Codex transport",
    async (model, thinking, effort) => {
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
      const result = streamOpenAIResponses({
        provider: "openai",
        model,
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

  it("sends the ChatGPT plan request to the public Responses API with GG Coder's own identity", async () => {
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
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "You are GG Coder." },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "call_1|fc_1", name: "read", args: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_1|fc_1", content: "ok" }],
        },
      ],
      apiKey: "token",
      accountId: "acct",
      transportSessionId: "transport 1",
      maxTokens: 999,
      temperature: 0.2,
      promptCacheKey: "cache family 1",
      cacheRetention: "long",
      tools: [
        { name: "read", description: "Read a file", parameters: z.object({ path: z.string() }) },
      ],
    });

    for await (const _event of result) {
      /* consume */
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(headers).toMatchObject({ Authorization: "Bearer token" });
    expect(headers["User-Agent"]).toMatch(/^ggcoder/);
    for (const codexHeader of [
      "originator",
      "version",
      "chatgpt-account-id",
      "session_id",
      "x-client-request-id",
      "OpenAI-Beta",
      "Content-Encoding",
      "X-OpenAI-Internal-Codex-Responses-Lite",
    ]) {
      expect(headers, codexHeader).not.toHaveProperty(codexHeader);
    }
    expect(body).toMatchObject({
      model: "gpt-5.5",
      store: false,
      stream: true,
      instructions: "You are GG Coder.",
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "cache family 1",
      parallel_tool_calls: true,
    });
    // Fields the plan route rejects.
    for (const field of [
      "temperature",
      "max_output_tokens",
      "max_tokens",
      "prompt_cache_retention",
      "previous_response_id",
      "metadata",
      "user",
    ]) {
      expect(body, field).not.toHaveProperty(field);
    }
    // Function tools go in a namespace, and replayed calls name it.
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "gg",
        tools: [expect.objectContaining({ type: "function", name: "read" })],
      }),
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.find((item) => item.type === "function_call")).toMatchObject({
      name: "read",
      namespace: "gg",
    });
    expect(input.some((item) => item.role === "system")).toBe(false);
  });

  it("sends an API-key request with top-level tools and the caller's temperature", async () => {
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
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-key",
      temperature: 0.2,
      tools: [
        { name: "read", description: "Read a file", parameters: z.object({ path: z.string() }) },
      ],
    });
    for await (const _event of result) {
      /* consume */
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body.temperature).toBe(0.2);
    expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "read" })]);
  });

  it("sends large request bodies as plain JSON", async () => {
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
    const longMessage = "const plainRequestPayload = true;\n".repeat(4_000);
    const fetchMock = vi.mocked(fetch);
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: longMessage }],
      apiKey: "test-credential",
      accountId: "acct",
    });
    for await (const _event of result) {
      /* consume */
    }
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    expect(body.input[0]?.content[0]?.text).toBe(longMessage);
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
      const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-6-luna",
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

  it.each([
    ["gpt-5.5", "none"],
    ["gpt-6-luna", "low"],
    ["gpt-6.1-sol", "low"],
    ["gpt-6-astra", "low"],
    ["gpt-5.6-terra", "low"],
  ])("uses a supported default effort for %s without explicit thinking", async (model, effort) => {
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
    const result = streamOpenAIResponses({
      provider: "openai",
      model,
      messages: [{ role: "user", content: "Rewrite this prompt" }],
      apiKey: "test-key",
      accountId: "acct",
    });
    await result;
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
    expect(body.reasoning.effort).toBe(effort);
  });

  it("sends the GPT-6 request shape: parallel tool calls, low verbosity, no Codex extras", async () => {
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
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-6-luna",
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
    expect(init.headers).not.toHaveProperty("X-OpenAI-Internal-Codex-Responses-Lite");
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
      text: { verbosity: "low" },
    });
    expect(body.reasoning).not.toHaveProperty("context");
  });

  it("sends tools without strict schemas when strictTools is false", async () => {
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
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: z.object({ file_path: z.string(), limit: z.number().optional() }),
      },
    ];
    const send = async (strictTools: boolean | undefined): Promise<Record<string, unknown>> => {
      const result = streamOpenAIResponses({
        provider: "openai",
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "token",
        tools,
        ...(strictTools === undefined ? {} : { strictTools }),
      });
      for await (const _event of result) {
        /* consume */
      }
      const [, init] = vi.mocked(fetch).mock.calls.at(-1) as [string, RequestInit];
      return (JSON.parse(init.body as string) as { tools: Record<string, unknown>[] }).tools[0]!;
    };

    const strict = await send(undefined);
    const loose = await send(false);

    expect(strict.strict).toBe(true);
    expect((strict.parameters as { required: string[] }).required).toEqual(["file_path", "limit"]);
    // Non-strict keeps optional fields optional, so calls omit them instead of
    // spelling each one out as null.
    expect(loose.strict).toBeNull();
    expect((loose.parameters as { required: string[] }).required).toEqual(["file_path"]);
  });

  it("passes a plain 400 through without plan guidance", async () => {
    const message =
      "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status: 400 })),
    );
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "Review this work" }],
      apiKey: "test-key",
      accountId: "acct",
    });
    await expect(result.response).rejects.toMatchObject({
      message,
      hint: undefined,
      statusCode: 400,
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

    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-6.1-sol",
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
  it.each([
    ["subscription_sharing_usage_limit_exceeded", 429, /chatgpt\.com\/settings\/usage/],
    ["subscription_sharing_usage_unavailable", 503, /couldn't check/],
  ] as const)("maps the plan's %s error to a usage-limit stop", async (code, status, hint) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code, message: "Plan usage." } }), {
            status,
            headers: { "content-type": "application/json", "x-request-id": "req_usage" },
          }),
      ),
    );
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
    const err = await result.response.catch((e: unknown) => e);
    expect(err).toMatchObject({
      provider: "openai",
      statusCode: status,
      message: "ChatGPT usage limit reached",
      requestId: "req_usage",
    });
    expect((err as { hint: string }).hint).toMatch(hint);
    // OpenAI says not to infer a reset time from this code.
    expect((err as { resetsAt?: number }).resetsAt).toBeUndefined();
  });

  it("maps a plan usage limit that arrives mid-stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          {
            type: "response.failed",
            response: {
              error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit." },
            },
          },
        ]),
      ),
    );
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
    await expect(result.response).rejects.toMatchObject({ message: "ChatGPT usage limit reached" });
  });

  it("explains a ChatGPT account that isn't eligible for plan use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "subscription_sharing_user_not_eligible", message: "Not eligible." },
            }),
            { status: 403 },
          ),
      ),
    );
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
    await expect(result.response).rejects.toMatchObject({
      statusCode: 403,
      message: "ChatGPT plan use isn't available for this account or workspace.",
      hint: expect.stringMatching(/OpenAI API key/),
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

    const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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
    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
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

  it("separates reasoning summary sections with a blank line", async () => {
    // Real gpt-6-luna stream shape: one bold headline per summary part, across
    // two reasoning items. Glued together they render as "**A****B**".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponse([
          { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
          { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
          { type: "response.reasoning_summary_text.delta", delta: "**Comparing plans**" },
          { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
          { type: "response.reasoning_summary_text.delta", delta: "**Checking costs**" },
          { type: "response.output_item.added", item: { id: "rs_2", type: "reasoning" } },
          { type: "response.reasoning_summary_part.added", item_id: "rs_2", summary_index: 0 },
          { type: "response.reasoning_summary_text.delta", delta: "**Verifying**" },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          },
        ]),
      ),
    );

    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
      thinking: "high",
    });

    let thinking = "";
    for await (const event of result) {
      if (event.type === "thinking_delta") thinking += event.text;
    }

    expect(thinking).toBe("**Comparing plans**\n\n**Checking costs**\n\n**Verifying**");
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

    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
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

    const first = streamOpenAIResponses({
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

    const second = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
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

    const result = streamOpenAIResponses({
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

describe("streamOpenAIResponses cut-off replies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function run(events: Record<string, unknown>[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createSseResponse(events)),
    );
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
    const seen: Array<{ type: string }> = [];
    try {
      for await (const event of result) seen.push(event);
    } catch {
      // the response promise carries the failure
    }
    return { result, seen };
  }

  const cutOffCall = [
    {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "call_1", id: "item_1", name: "bash" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item_1",
      delta: '{"command":"rm -rf build && npm run bui',
    },
  ];

  it("fails a stream that stops before the reply finishes instead of running a cut-off tool call", async () => {
    const { result, seen } = await run(cutOffCall);

    await expect(result.response).rejects.toMatchObject({
      statusCode: 504,
      message: expect.stringContaining("ended before completion"),
    });
    expect(seen.some((event) => event.type === "toolcall_done")).toBe(false);
  });

  it("refuses a completed reply that still holds an unfinished tool call", async () => {
    const { result } = await run([
      ...cutOffCall,
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);

    await expect(result.response).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("unfinished tool call: bash"),
    });
  });

  it("reports a reply cut off at the output limit as max_tokens, keeping its text", async () => {
    const { result } = await run([
      { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        content_index: 0,
        delta: "The fix is to change the",
      },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "The fix is to change the" }] },
      stopReason: "max_tokens",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("reports a reply stopped by the content filter as a refusal", async () => {
    const { result } = await run([
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      },
    ]);

    await expect(result.response).resolves.toMatchObject({ stopReason: "refusal" });
  });

  it("keeps finished tool calls and drops the cut-off one when the reply hits the output limit", async () => {
    const { result } = await run([
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_0", id: "item_0", name: "read" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_0",
        delta: '{"file_path":"a.ts"}',
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_0", id: "item_0" },
      },
      ...cutOffCall,
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
    ]);

    const response = await result.response;
    expect(response.stopReason).toBe("max_tokens");
    expect(response.message.content).toEqual([
      { type: "tool_call", id: "call_0|item_0", name: "read", args: { file_path: "a.ts" } },
    ]);
  });

  // Encrypted reasoning round-trips into the next request, where the server
  // expects an item after each reasoning item. The reasoning that led into the
  // dropped call would otherwise be left dangling at the end of the message.
  it("drops reasoning that only led into the cut-off tool call", async () => {
    const reasoning = (id: string) => ({
      type: "response.output_item.done",
      item: { type: "reasoning", id, encrypted_content: `ENC_${id}`, summary: [] },
    });
    const { result } = await run([
      reasoning("rs_1"),
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_0", id: "item_0", name: "read" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_0",
        delta: '{"file_path":"a.ts"}',
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_0", id: "item_0" },
      },
      reasoning("rs_2"),
      ...cutOffCall,
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
    ]);

    const response = await result.response;
    expect(response.stopReason).toBe("max_tokens");
    expect(response.message.content).toEqual([
      {
        type: "raw",
        data: { type: "reasoning", id: "rs_1", encrypted_content: "ENC_rs_1", summary: [] },
      },
      { type: "tool_call", id: "call_0|item_0", name: "read", args: { file_path: "a.ts" } },
    ]);
  });
});

describe("Responses tool strict sampling", () => {
  it("marks strictifiable tools strict:true and falls back to strict:null otherwise", async () => {
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
    const raw = {
      type: "object",
      properties: { mode: { oneOf: [{ type: "string" }, { type: "number" }] } },
      required: ["mode"],
    };
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "k",
      tools: [
        {
          name: "read",
          description: "read",
          parameters: z.object({ path: z.string(), offset: z.number().optional() }),
        },
        {
          name: "mcp_tool",
          description: "mcp",
          parameters: z.record(z.string(), z.unknown()),
          rawInputSchema: raw,
        },
      ],
    });
    for await (const _event of result) {
      /* consume */
    }
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(body.tools[0]).toMatchObject({ name: "read", strict: true });
    expect(body.tools[0].parameters).toMatchObject({
      required: ["path", "offset"],
      additionalProperties: false,
    });
    expect(body.tools[1]).toMatchObject({ name: "mcp_tool", strict: null });
    expect(body.tools[1].parameters).toEqual(raw);
  });
});

describe("ChatGPT plan: what the plan doesn't include", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function planRequest(model: string) {
    return streamOpenAIResponses({
      provider: "openai",
      model,
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });
  }

  it("says a model isn't in the user's plan instead of echoing OpenAI's Codex wording", async () => {
    // The live answer for gpt-6.1-sol on a plan that serves only Luna (2026-11-07).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "model_not_found",
                message:
                  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
              },
            }),
            { status: 400 },
          ),
      ),
    );
    await expect(planRequest("gpt-6.1-sol").response).rejects.toMatchObject({
      statusCode: 400,
      message: "gpt-6.1-sol isn't included in your ChatGPT plan.",
      hint: expect.stringMatching(/model your plan includes/),
    });
  });

  it("says Fast mode isn't in the plan when the service tier is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "subscription_sharing_unsupported_capability",
                param: "service_tier",
                message: "Unsupported.",
              },
            }),
            { status: 400 },
          ),
      ),
    );
    await expect(planRequest("gpt-6-luna-fast").response).rejects.toMatchObject({
      message: "Fast mode isn't included in your ChatGPT plan.",
    });
  });

  it("leaves model_not_found alone on an API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "model_not_found", message: "Nope." } }), {
            status: 404,
          }),
      ),
    );
    const result = streamOpenAIResponses({
      provider: "openai",
      model: "gpt-x",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk",
    });
    await expect(result.response).rejects.toMatchObject({ message: "Nope." });
  });
});
