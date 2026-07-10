import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamGemini } from "./gemini.js";
import { formatError } from "../errors.js";

const originalFetch = globalThis.fetch;
const originalCodeAssistEndpoint = process.env.CODE_ASSIST_ENDPOINT;
const originalCodeAssistApiVersion = process.env.CODE_ASSIST_API_VERSION;

describe("streamGemini", () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalCodeAssistEndpoint === undefined) {
      delete process.env.CODE_ASSIST_ENDPOINT;
    } else {
      process.env.CODE_ASSIST_ENDPOINT = originalCodeAssistEndpoint;
    }
    if (originalCodeAssistApiVersion === undefined) {
      delete process.env.CODE_ASSIST_API_VERSION;
    } else {
      process.env.CODE_ASSIST_API_VERSION = originalCodeAssistApiVersion;
    }
    vi.restoreAllMocks();
  });

  it("clamps client-only Ultra to high in Code Assist requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      projectId: "test-project",
      apiKey: "access-token",
      streaming: false,
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
    expect(url.toString()).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Content-Type": "application/json",
      "User-Agent": "google-gemini-cli",
      "X-Goog-Api-Client": "gemini-cli/0.0.0",
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "gemini-3-flash-preview",
      project: "test-project",
      request: {
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
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } },
        session_id: "ggcoder:test-session",
      },
    });
  });

  it("delivers tool-result video as an inlineData part (read on a .mp4)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      projectId: "test-project",
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
      request: { contents: Array<{ role: string; parts: unknown[] }> };
    };
    const toolTurn = body.request.contents.find((c) => c.role === "user");
    // functionResponse carries the text marker; the video rides as inlineData.
    expect(toolTurn?.parts).toContainEqual({
      inlineData: { mimeType: "video/mp4", data: "QUJD" },
    });
  });

  it("still sends Code Assist requests for Code Assist-only preview models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      projectId: "test-project",
      apiKey: "access-token",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
    });

    await result.response;

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "User-Agent": "google-gemini-cli",
      "X-Goog-Api-Client": "gemini-cli/0.0.0",
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "gemini-3-flash-preview",
      project: "test-project",
      request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    });
  });

  it("honors Gemini CLI Code Assist endpoint overrides", async () => {
    process.env.CODE_ASSIST_ENDPOINT = "https://code-assist.example.test";
    process.env.CODE_ASSIST_API_VERSION = "v2test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      projectId: "test-project",
      apiKey: "access-token",
      streaming: false,
      messages: [{ role: "user", content: "hi" }],
    });

    await result.response;

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://code-assist.example.test/v2test:generateContent");
  });

  it("retries non-streaming Code Assist requests on upstream retryable statuses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      projectId: "test-project",
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
      projectId: "test-project",
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
      projectId: "test-project",
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

  it("explains unsupported Gemini OAuth models without calling paid endpoints", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = streamGemini({
      provider: "gemini",
      model: "gemini-1.5-flash",
      projectId: "test-project",
      apiKey: "access-token",
      messages: [{ role: "user", content: "hi" }],
    });

    await expect(result.response).rejects.toThrow(
      'Gemini OAuth is configured to use the Gemini Code Assist subscription endpoint only. That endpoint does not currently expose model "gemini-1.5-flash".',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an account-gated 404 as an entitlement error with actionable guidance", async () => {
    const body = JSON.stringify({
      error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" },
    });

    for (const model of ["gemini-3-flash", "gemini-3.1-pro-preview"]) {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 404 }));
      const result = streamGemini({
        provider: "gemini",
        model,
        projectId: "test-project",
        apiKey: "access-token",
        messages: [{ role: "user", content: "hi" }],
      });

      const err = await result.response.then(
        () => {
          throw new Error("expected rejection");
        },
        (e: unknown) => e,
      );

      // The clean message names the model and frames it as an entitlement gap,
      // never the raw "Requested entity was not found" body.
      const formatted = formatError(err);
      expect(formatted.message).toMatch(/isn't entitled to/i);
      expect(formatted.message).toContain(model);
      expect(formatted.message).not.toMatch(/Requested entity was not found/i);
      // The guidance line carries the fix.
      expect(formatted.guidance).toMatch(/Gemini 3\.1 Flash Lite/i);
      expect(formatted.guidance).toMatch(/Code Assist Standard\/Enterprise/i);
    }
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
      projectId: "test-project",
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
      usage: { inputTokens: 5, outputTokens: 3, cacheRead: 2 },
    });
  });
});
