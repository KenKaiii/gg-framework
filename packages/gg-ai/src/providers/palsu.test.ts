import { describe, it, expect, afterEach } from "vitest";
import {
  registerPalsuProvider,
  palsuText,
  palsuThinking,
  palsuToolCall,
  palsuAssistantMessage,
} from "./palsu.js";
import type { PalsuProviderHandle } from "./palsu.js";
import type { Message, StreamEvent } from "../types.js";
import { providerRegistry } from "../provider-registry.js";

// Collect all events from a StreamResult
async function collectEvents(result: ReturnType<typeof providerRegistry.get>): Promise<{
  events: StreamEvent[];
  response: Awaited<ReturnType<NonNullable<typeof result>["stream"]>["response"]>;
}> {
  const sr = result!.stream({
    provider: "palsu",
    model: "test",
    messages: [{ role: "user", content: "hi" }],
  });
  const events: StreamEvent[] = [];
  for await (const event of sr) {
    events.push(event);
  }
  const response = await sr.response;
  return { events, response };
}

describe("palsu provider", () => {
  let handle: PalsuProviderHandle;

  afterEach(() => {
    handle?.unregister();
  });

  it("registers and streams a text response", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("Hello!"));

    const entry = providerRegistry.get("palsu");
    const { events, response } = await collectEvents(entry);

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(response.stopReason).toBe("end_turn");
    expect(response.message.content).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("consumes responses in FIFO order", async () => {
    handle = registerPalsuProvider();
    handle.setResponses([palsuText("first"), palsuText("second"), palsuText("third")]);

    expect(handle.getPendingResponseCount()).toBe(3);

    const entry = providerRegistry.get("palsu")!;

    const r1 = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp1 = await r1.response;
    expect(resp1.message.content).toEqual([{ type: "text", text: "first" }]);

    const r2 = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp2 = await r2.response;
    expect(resp2.message.content).toEqual([{ type: "text", text: "second" }]);

    expect(handle.getPendingResponseCount()).toBe(1);
  });

  it("uses factory responses with state access", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses((_msgs, _opts, state) => palsuText(`call #${state.callCount}`));

    const entry = providerRegistry.get("palsu")!;
    const r = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp = await r.response;
    // callCount increments before factory is called, so first call = 1
    expect(resp.message.content).toEqual([{ type: "text", text: "call #1" }]);
  });

  it("streams tool call events", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuToolCall("read_file", { path: "/test.ts" }, "tc_1"));

    const entry = providerRegistry.get("palsu")!;
    const sr = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const events: StreamEvent[] = [];
    for await (const e of sr) events.push(e);
    const resp = await sr.response;

    expect(events.some((e) => e.type === "toolcall_delta")).toBe(true);
    expect(events.some((e) => e.type === "toolcall_done")).toBe(true);
    expect(resp.stopReason).toBe("tool_use");
  });

  it("streams thinking events", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuThinking("Let me think...", "The answer is 42"));

    const entry = providerRegistry.get("palsu")!;
    const sr = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const events: StreamEvent[] = [];
    for await (const e of sr) events.push(e);

    expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("handles AbortSignal", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("should not complete"));

    const controller = new AbortController();
    controller.abort();

    const entry = providerRegistry.get("palsu")!;
    const sr = entry.stream({
      provider: "palsu",
      model: "t",
      messages: [],
      signal: controller.signal,
    });

    await expect(sr.response).rejects.toThrow("aborted");
  });

  it("falls back to default response when queue is empty", async () => {
    handle = registerPalsuProvider({ defaultResponse: palsuText("default") });

    const entry = providerRegistry.get("palsu")!;
    const r = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp = await r.response;

    expect(resp.message.content).toEqual([{ type: "text", text: "default" }]);
  });

  it("tracks call count", async () => {
    handle = registerPalsuProvider();
    handle.setResponses([palsuText("a"), palsuText("b"), palsuText("c")]);

    const entry = providerRegistry.get("palsu")!;

    expect(handle.state.callCount).toBe(0);
    await entry.stream({ provider: "palsu", model: "t", messages: [] }).response;
    expect(handle.state.callCount).toBe(1);
    await entry.stream({ provider: "palsu", model: "t", messages: [] }).response;
    expect(handle.state.callCount).toBe(2);
    await entry.stream({ provider: "palsu", model: "t", messages: [] }).response;
    expect(handle.state.callCount).toBe(3);
  });

  it("unregister removes provider from registry", () => {
    handle = registerPalsuProvider();
    expect(providerRegistry.has("palsu")).toBe(true);
    handle.unregister();
    expect(providerRegistry.has("palsu")).toBe(false);
  });

  it("supports custom provider name", async () => {
    handle = registerPalsuProvider({ name: "test-llm" });
    handle.appendResponses(palsuText("custom"));

    expect(providerRegistry.has("test-llm")).toBe(true);
    expect(providerRegistry.has("palsu")).toBe(false);

    const entry = providerRegistry.get("test-llm")!;
    const r = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp = await r.response;
    expect(resp.message.content).toEqual([{ type: "text", text: "custom" }]);

    // Cleanup with custom name
    handle.unregister();
    expect(providerRegistry.has("test-llm")).toBe(false);
  });

  it("palsuAssistantMessage with explicit stop reason", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(
      palsuAssistantMessage([{ type: "text", text: "paused" }], { stopReason: "max_tokens" }),
    );

    const entry = providerRegistry.get("palsu")!;
    const r = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp = await r.response;
    expect(resp.stopReason).toBe("max_tokens");
  });

  // ── Mixed content / multi-tool / async / error ──────────

  it("streams mixed content blocks (thinking + tool call + text)", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(
      palsuAssistantMessage([
        { type: "thinking", text: "Let me analyze..." },
        { type: "tool_call", id: "tc_1", name: "read_file", args: { path: "/f.ts" } },
        { type: "text", text: "Here is my analysis" },
      ]),
    );

    const entry = providerRegistry.get("palsu")!;
    const sr = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const events: StreamEvent[] = [];
    for await (const e of sr) events.push(e);
    const resp = await sr.response;

    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_delta");
    expect(types).toContain("toolcall_delta");
    expect(types).toContain("toolcall_done");
    expect(types).toContain("text_delta");
    expect(resp.stopReason).toBe("tool_use");
  });

  it("streams multiple tool calls in one message", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(
      palsuAssistantMessage([
        { type: "tool_call", id: "tc_a", name: "read_file", args: { path: "/a.ts" } },
        {
          type: "tool_call",
          id: "tc_b",
          name: "write_file",
          args: { path: "/b.ts", content: "x" },
        },
      ]),
    );

    const entry = providerRegistry.get("palsu")!;
    const sr = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const events: StreamEvent[] = [];
    for await (const e of sr) events.push(e);

    const doneEvents = events.filter((e) => e.type === "toolcall_done");
    expect(doneEvents).toHaveLength(2);
  });

  it("supports async factory responses", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(async (_msgs, _opts, state) => {
      await Promise.resolve();
      return palsuText(`async call #${state.callCount}`);
    });

    const entry = providerRegistry.get("palsu")!;
    const r = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const resp = await r.response;
    expect(resp.message.content).toEqual([{ type: "text", text: "async call #1" }]);
  });

  it("streams error stop reason correctly", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(
      palsuAssistantMessage([{ type: "text", text: "error occurred" }], { stopReason: "error" }),
    );

    const entry = providerRegistry.get("palsu")!;
    const sr = entry.stream({ provider: "palsu", model: "t", messages: [] });
    const events: StreamEvent[] = [];
    for await (const e of sr) events.push(e);
    const resp = await sr.response;

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toEqual({ type: "done", stopReason: "error" });
    expect(resp.stopReason).toBe("error");
  });

  // ── Prompt cache simulation ─────────────────────────────

  it("simulates prompt cache with cacheRead/cacheWrite", async () => {
    handle = registerPalsuProvider({ promptCache: true });
    handle.setResponses([palsuText("first"), palsuText("second")]);

    const entry = providerRegistry.get("palsu")!;
    const msgs: Message[] = [{ role: "user", content: "hello" }];

    const resp1 = await entry.stream({ provider: "palsu", model: "t", messages: msgs }).response;
    expect(resp1.usage.cacheWrite).toBeGreaterThan(0);
    expect(resp1.usage.cacheRead).toBeUndefined();

    const resp2 = await entry.stream({ provider: "palsu", model: "t", messages: msgs }).response;
    expect(resp2.usage.cacheRead).toBeGreaterThan(0);
  });

  // ── Model routing ───────────────────────────────────────

  it("routes responses to model-specific defaults", async () => {
    handle = registerPalsuProvider({
      models: {
        fast: { defaultResponse: palsuText("fast reply") },
        smart: { defaultResponse: palsuText("smart reply") },
      },
    });

    const entry = providerRegistry.get("palsu")!;

    const r1 = await entry.stream({ provider: "palsu", model: "fast", messages: [] }).response;
    expect(r1.message.content).toEqual([{ type: "text", text: "fast reply" }]);

    const r2 = await entry.stream({ provider: "palsu", model: "smart", messages: [] }).response;
    expect(r2.message.content).toEqual([{ type: "text", text: "smart reply" }]);
  });

  it("model queue falls back to shared queue", async () => {
    handle = registerPalsuProvider({ models: { m1: {} } });
    handle.appendResponses(palsuText("from shared"));

    const entry = providerRegistry.get("palsu")!;
    const r = await entry.stream({ provider: "palsu", model: "m1", messages: [] }).response;
    expect(r.message.content).toEqual([{ type: "text", text: "from shared" }]);
  });

  // ── Original tests continued ────────────────────────────

  it("factory receives messages from the stream call", async () => {
    handle = registerPalsuProvider();
    const inputMessages: Message[] = [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "What is 2+2?" },
    ];

    handle.appendResponses((msgs) => {
      return palsuText(`Got ${msgs.length} messages`);
    });

    const entry = providerRegistry.get("palsu")!;
    const r = entry.stream({ provider: "palsu", model: "t", messages: inputMessages });
    const resp = await r.response;
    expect(resp.message.content).toEqual([{ type: "text", text: "Got 2 messages" }]);
  });
});
