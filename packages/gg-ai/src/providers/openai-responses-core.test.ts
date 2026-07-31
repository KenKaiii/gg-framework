import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamEvent, StreamResponse } from "../types.js";
import { streamAzureOpenAIResponses } from "./azure-openai-responses.js";
import { streamOpenAICodex } from "./openai-codex.js";
import {
  parseEncryptedReasoningPart,
  parseResponsesSse,
  serializeEncryptedReasoningItem,
  serializeResponsesInput,
  serializeResponsesToolChoice,
  serializeResponsesTools,
} from "./openai-responses-core.js";

function rawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectStream(stream: {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  response: Promise<StreamResponse>;
}): Promise<string> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return JSON.stringify({ events, response: await stream.response });
}

describe("provider-neutral Responses parsing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the Codex skip policy and Azure strict policy for malformed frames", async () => {
    const wire =
      'data: {"type":"response.output_text.delta","delta":"one"}\n\n' +
      "data: not-json\n\n" +
      'data: {"type":"response.completed","response":{}}\n\n' +
      "data: [DONE]\n\n";

    const codexEvents = [];
    for await (const event of parseResponsesSse(rawSseResponse(wire).body!)) {
      codexEvents.push(event);
    }
    expect(JSON.stringify(codexEvents)).toBe(
      '[{"type":"response.output_text.delta","delta":"one"},{"type":"response.completed","response":{}}]',
    );

    let azureDiagnostic: unknown;
    const azureEvents = async () => {
      for await (const _event of parseResponsesSse(rawSseResponse(wire).body!, {
        onMalformedJson(diagnostic): never {
          azureDiagnostic = diagnostic;
          throw new Error("stop parsing");
        },
      })) {
        // Consume through the malformed frame.
      }
    };
    await expect(azureEvents()).rejects.toThrow("stop parsing");
    expect(azureDiagnostic).toEqual({
      stage: "json_parse",
      causeKind: "syntax_error",
    });
    expect(JSON.stringify(azureDiagnostic)).not.toContain("not-json");
  });

  it("serializes provider-neutral system, user, assistant, tool-call, and tool-result input", () => {
    const serialized = serializeResponsesInput([
      { role: "system", content: "Be concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
        ],
      },
      { role: "assistant", content: "First answer." },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "private" },
          { type: "text", text: "Then call." },
          {
            type: "tool_call",
            id: "call_1",
            itemId: "fc_1",
            name: "read",
            args: { path: "a.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call_1", content: "contents" }],
      },
    ]);

    expect(JSON.stringify(serialized)).toBe(
      '{"system":"Be concise.","input":[{"role":"user","content":[{"type":"input_text","text":"Inspect this."},{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,aW1hZ2U="}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"First answer.","annotations":[]}],"status":"completed"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Then call.","annotations":[]}],"status":"completed"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"},{"type":"function_call_output","call_id":"call_1","output":"contents"}]}',
    );
  });

  it("validates standard tool choices and encrypted reasoning replay items", () => {
    const tools = [{ name: "read", description: "Read", parameters: z.object({}) }];
    expect(
      serializeResponsesToolChoice({ name: "read" }, tools, {
        transportName: "Azure OpenAI",
        supportsNamedTool: true,
      }),
    ).toEqual({ type: "function", name: "read" });
    expect(() =>
      serializeResponsesToolChoice("required", undefined, {
        transportName: "Azure OpenAI",
        supportsNamedTool: true,
      }),
    ).toThrow("Azure OpenAI cannot require a tool call when no tools are configured.");

    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted",
      summary: [{ type: "summary_text", text: "summary" }],
    };
    expect(serializeEncryptedReasoningItem(reasoning)).toBe(reasoning);
    expect(parseEncryptedReasoningPart(reasoning)).toEqual({ type: "raw", data: reasoning });
    expect(serializeEncryptedReasoningItem({ ...reasoning, encrypted_content: 1 })).toBeUndefined();
  });

  it("serializes Zod tool declarations with explicit transport strictness", () => {
    const tools = serializeResponsesTools(
      [
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ path: z.string() }),
        },
      ],
      { strict: null },
    );

    expect(tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: null,
      },
    ]);
  });

  it("characterizes Codex and Azure request and result bytes at the shared seam", async () => {
    let codexRequestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        codexRequestBody = String(init?.body);
        return rawSseResponse(
          'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}\n\n' +
            'data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"Hello"}\n\n' +
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n',
        );
      }),
    );

    const codex = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Say hello." }],
      apiKey: "test-token",
    });
    const codexTranscript = await collectStream(codex);

    expect(codexRequestBody).toBe(
      '{"model":"gpt-5.5","store":false,"stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"Say hello."}]}],"tool_choice":"auto","parallel_tool_calls":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"ggcoder","reasoning":{"effort":"none","summary":"auto"}}',
    );
    expect(codexTranscript).toBe(
      '{"events":[{"type":"text_delta","text":"Hello"},{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"stopReason":"end_turn","usage":{"inputTokens":7,"outputTokens":2}}}',
    );

    let azureRequestBody = "";
    const azureFetch = vi.fn<typeof fetch>(async (_url, init) => {
      azureRequestBody = String(init?.body);
      return rawSseResponse(
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n',
      );
    });
    const azure = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Say hello." }],
      apiKey: "test-key",
      baseUrl: "https://example.openai.azure.com/openai/v1/responses",
      fetch: azureFetch,
    });
    const azureTranscript = await collectStream(azure);

    expect(azureRequestBody).toBe(
      '{"model":"test-deployment","input":[{"role":"user","content":[{"type":"input_text","text":"Say hello."}]}],"stream":true,"store":false}',
    );
    expect(azureTranscript).toBe(
      '{"events":[{"type":"text_delta","text":"Hello"},{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":"Hello"},"stopReason":"end_turn","usage":{"inputTokens":7,"outputTokens":2}}}',
    );
  });

  it("keeps Codex ID adaptation and unsupported multimodal downgrade bytes unchanged", async () => {
    let requestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body);
        return rawSseResponse(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        );
      }),
    );

    const stream = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test-token",
      supportsImages: false,
      supportsVideo: false,
      messages: [
        { role: "system", content: "System text." },
        {
          role: "user",
          content: [
            { type: "text", text: "User text." },
            { type: "image", mediaType: "image/png", data: "image-data" },
            { type: "video", mediaType: "video/mp4", data: "video-data" },
          ],
        },
        { role: "assistant", content: "Assistant text." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "toolu_tasks:153|item:1",
              name: "read",
              args: { path: "a.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "toolu_tasks:153|item:1",
              content: [
                { type: "image", mediaType: "image/png", data: "tool-image" },
                { type: "video", mediaType: "video/mp4", data: "tool-video" },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ path: z.string() }),
        },
      ],
    });
    for await (const _event of stream) {
      // Consume the characterization response.
    }

    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body.instructions).toBe("System text.");
    expect(JSON.stringify(body.input)).toBe(
      '[{"role":"user","content":[{"type":"input_text","text":"User text."},{"type":"input_text","text":"(image omitted: model does not support images)"},{"type":"input_text","text":"(video omitted: model does not support video)"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Assistant text.","annotations":[]}],"status":"completed"},{"type":"function_call","id":"fc_item_1","call_id":"fc_tasks_153","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"},{"type":"function_call_output","call_id":"fc_tasks_153","output":"(tool image omitted: model does not support images)"}]',
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: null,
      },
    ]);
  });

  it("retains the existing Codex-compatible and Azure-strict terminal policies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rawSseResponse(
          'data: {"type":"response.done","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        ),
      ),
    );
    const codex = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
      apiKey: "test-token",
    });

    expect(await collectStream(codex)).toBe(
      '{"events":[{"type":"done","stopReason":"end_turn"}],"response":{"message":{"role":"assistant","content":""},"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":1}}}',
    );

    const azure = streamAzureOpenAIResponses({
      provider: "azure",
      model: "test-deployment",
      messages: [{ role: "user", content: "Hi" }],
      apiKey: "test-key",
      baseUrl: "https://example.openai.azure.com/openai/v1/responses",
      fetch: vi.fn(async () =>
        rawSseResponse('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
      ),
    });

    await expect(azure.response).rejects.toMatchObject({
      message: "Azure OpenAI response stream ended before response.completed.",
    });
  });
});
