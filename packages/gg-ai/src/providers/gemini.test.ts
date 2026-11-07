import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamGemini } from "./gemini.js";
import { formatError } from "../errors.js";

const originalFetch = globalThis.fetch;

describe("streamGemini", () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it.each(["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"])(
    "wires %s with tools, output cap, and Ultra clamped to high",
    async (model) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      globalThis.fetch = fetchMock;

      const result = streamGemini({
        provider: "gemini",
        model,
        apiKey: "access-token",
        streaming: false,
        maxTokens: 65_536,
        messages: [
          { role: "system", content: "system" },
          {
            role: "assistant",
            content: [{ type: "tool_call", id: "call_1", name: "bash", args: { command: "pwd" } }],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_1", content: "done" }],
          },
          { role: "user", content: "hi" },
        ],
        tools: [
          {
            name: "bash",
            description: "Run a command",
            parameters: z.object({ command: z.string() }),
          },
        ],
        toolChoice: "auto",
        thinking: "ultra",
        promptCacheKey: "ggcoder:test-session",
      });

      await result.response;

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      );
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        "x-goog-api-key": "access-token",
      });
      expect(JSON.parse(init.body as string)).toMatchObject({
        systemInstruction: { parts: [{ text: "system" }] },
        contents: [
          {
            role: "model",
            parts: [
              {
                functionCall: { id: "call_1", name: "bash", args: { command: "pwd" } },
                thoughtSignature: "skip_thought_signature_validator",
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_1",
                  name: "bash",
                  response: { content: "done" },
                },
              },
            ],
          },
          { role: "user", parts: [{ text: "hi" }] },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "bash",
                description: "Run a command",
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: {
          maxOutputTokens: 65_536,
          thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
        },
      });
    },
  );

  it("merges providerOptions into the generate request without overriding core fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "access-token",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
      providerOptions: {
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
        contents: [],
      },
    });
    await result.response;

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.safetySettings).toEqual([
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    ]);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("rewrites exclusive bounds Gemini rejects into inclusive ones", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3.8-flash",
      apiKey: "access-token",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "web_fetch",
          description: "Fetch",
          // .positive() → exclusiveMinimum: 0, which Gemini answers with a 400
          // that fails every request carrying this tool.
          parameters: z.object({
            follow: z.number().int().positive().optional(),
            ratio: z.number().lt(1).optional(),
          }),
        },
      ],
    });
    await result.response;

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = init.body as string;
    expect(body).not.toContain("exclusiveMinimum");
    expect(body).not.toContain("exclusiveMaximum");
    const props = (
      JSON.parse(body) as {
        tools: [{ functionDeclarations: [{ parameters: { properties: Record<string, object> } }] }];
      }
    ).tools[0].functionDeclarations[0].parameters.properties;
    expect(props.follow).toMatchObject({ type: "integer", minimum: 1 });
    expect(props.ratio).toMatchObject({ type: "number", maximum: 1 });
  });

  it("delivers tool-result video as an inlineData part (read on a .mp4)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "access-token",
      streaming: false,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "call_v", name: "read", args: { file_path: "c.mp4" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_v",
              content: [
                { type: "text", text: "Read video file c.mp4 [video/mp4]" },
                { type: "video", mediaType: "video/mp4", data: "QUJD" },
              ],
            },
          ],
        },
      ],
    });

    await result.response;

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    const toolTurn = body.contents.find((c) => c.role === "user");
    // functionResponse carries the text marker; the video rides as inlineData.
    expect(toolTurn?.parts).toContainEqual({
      inlineData: { mimeType: "video/mp4", data: "QUJD" },
    });
  });

  it("retries non-streaming requests on upstream retryable statuses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "access-token",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
    });

    const responsePromise = result.response;
    await vi.advanceTimersByTimeAsync(1_000);
    await responsePromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a hard quota exhaustion 429 as a usage-limit error", async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You have exhausted your capacity on this model.",
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 429 }));

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "access-token",
      messages: [{ role: "user", content: "hi" }],
    });

    await expect(result.response).rejects.toThrow(/usage limit reached/i);
  });

  it("stamps resetsAt from RetryInfo.retryDelay on a transient throttle 429", async () => {
    const body = JSON.stringify({
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota will reset shortly." },
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "18s" }],
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 429 }));

    const before = Math.floor(Date.now() / 1000);
    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "access-token",
      messages: [{ role: "user", content: "hi" }],
    });

    await result.response.then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        // Not a hard usage-limit error — it's retriable.
        expect((err as Error).message).not.toMatch(/usage limit reached/i);
        const resetsAt = (err as Error & { resetsAt?: number }).resetsAt;
        expect(resetsAt).toBeGreaterThanOrEqual(before + 18);
        expect(resetsAt).toBeLessThanOrEqual(before + 20);
      },
    );
  });

  it("sends an AI Studio API key to the public Gemini API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      // The registry id for 3.5 Flash; the public API calls it gemini-3.5-flash.
      model: "gemini-3-flash",
      apiKey: "aistudio-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      promptCacheKey: "ggcoder:session-1",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
    });
    const response = await result.response;
    expect(response.message.content).toEqual([{ type: "text", text: "ok" }]);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("aistudio-key");
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Bare request: no envelope, project or session_id.
    expect(body.contents).toBeDefined();
    expect(body.request).toBeUndefined();
    expect(body.project).toBeUndefined();
    expect(body.session_id).toBeUndefined();
  });

  it("explains an invalid AI Studio key instead of dumping Google's JSON", async () => {
    // Google's real answer to a bad key (verified live, 2026-10-16).
    const body = JSON.stringify({
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
        ],
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 400 }));
    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3.8-flash",
      apiKey: "bad-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      messages: [{ role: "user", content: "hi" }],
    });
    const err = await result.response.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    const formatted = formatError(err);
    expect(formatted.message).toMatch(/Gemini API key: it is not valid/);
    expect(formatted.guidance).toMatch(/aistudio\.google\.com\/apikey/);
    expect(formatted.message).not.toContain("INVALID_ARGUMENT");
  });

  it("emits thoughts, text, and tool calls from SSE chunks", async () => {
    const body = [
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "hello" },
                {
                  functionCall: {
                    id: "call_2",
                    name: "read",
                    args: { file_path: "README.md" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 4,
          cachedContentTokenCount: 2,
        },
      })}\n\n`,
    ].join("");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "access-token",
      messages: [{ role: "user", content: "hi" }],
    });

    const events = [];
    for await (const event of result) events.push(event);
    const response = await result.response;

    expect(events).toContainEqual({ type: "thinking_delta", text: "thinking" });
    expect(events).toContainEqual({ type: "text_delta", text: "hello" });
    expect(events).toContainEqual({
      type: "toolcall_done",
      id: "call_2",
      name: "read",
      args: { file_path: "README.md" },
    });
    expect(response).toMatchObject({
      message: {
        content: [
          { type: "thinking", text: "thinking" },
          { type: "text", text: "hello" },
          { type: "tool_call", id: "call_2", name: "read", args: { file_path: "README.md" } },
        ],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 7, reasoningTokens: 4, cacheRead: 2 },
    });
  });

  it.each([
    {
      name: "ordinary output",
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      expectedUsage: { inputTokens: 5, outputTokens: 3 },
    },
    {
      name: "reasoning-only output",
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, thoughtsTokenCount: 6 },
      expectedUsage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 6 },
    },
  ])("normalizes $name for billing totals", async ({ usageMetadata, expectedUsage }) => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "internal", thought: true }] }, finishReason: "STOP" },
          ],
          usageMetadata,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      apiKey: "test-token",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
    });

    await expect(result.response).resolves.toMatchObject({ usage: expectedUsage });
  });
});
