import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodex } from "./openai-codex.js";

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

  it("routes reasoning item output text to thinking deltas", async () => {
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

    const result = streamOpenAICodex({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "token",
      accountId: "acct",
    });

    const events = [];
    for await (const event of result) events.push(event);

    expect(events).toContainEqual({ type: "thinking_delta", text: "private reasoning" });
    expect(events).not.toContainEqual({ type: "text_delta", text: "private reasoning" });
    expect(events).toContainEqual({ type: "text_delta", text: "visible answer" });
    await expect(result.response).resolves.toMatchObject({
      message: { content: [{ type: "text", text: "visible answer" }] },
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
