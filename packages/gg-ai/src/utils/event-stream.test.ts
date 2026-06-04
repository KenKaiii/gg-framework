import { describe, it, expect } from "vitest";
import { EventStream, StreamResult } from "./event-stream.js";
import type { StreamEvent, StreamResponse } from "../types.js";

function makeEvent(text: string): StreamEvent {
  return { type: "text_delta", text } as unknown as StreamEvent;
}

function makeResponse(stopReason = "end_turn"): StreamResponse {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    },
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as StreamResponse;
}

describe("EventStream", () => {
  it("push and iterate collects all events", async () => {
    const stream = new EventStream<StreamEvent>();
    stream.push(makeEvent("a"));
    stream.push(makeEvent("b"));
    stream.push(makeEvent("c"));
    stream.close();

    const collected: StreamEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect((collected[0] as unknown as { text: string }).text).toBe("a");
    expect((collected[1] as unknown as { text: string }).text).toBe("b");
    expect((collected[2] as unknown as { text: string }).text).toBe("c");
  });

  it("close stops iteration", async () => {
    const stream = new EventStream<StreamEvent>();
    stream.push(makeEvent("x"));
    stream.close();

    const collected: StreamEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect((collected[0] as unknown as { text: string }).text).toBe("x");
  });

  it("abort throws error during iteration", async () => {
    const stream = new EventStream<StreamEvent>();
    const error = new Error("stream aborted");

    stream.push(makeEvent("before"));
    stream.abort(error);

    const collected: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of stream) {
        collected.push(event);
      }
    }).rejects.toThrow("stream aborted");

    // The event pushed before abort should still be yielded
    expect(collected).toHaveLength(1);
    expect((collected[0] as unknown as { text: string }).text).toBe("before");
  });

  it("events pushed before iteration are available", async () => {
    const stream = new EventStream<StreamEvent>();

    // Push all events before consuming
    stream.push(makeEvent("1"));
    stream.push(makeEvent("2"));
    stream.push(makeEvent("3"));
    stream.close();

    const collected: StreamEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect((collected[0] as unknown as { text: string }).text).toBe("1");
    expect((collected[2] as unknown as { text: string }).text).toBe("3");
  });

  it("events pushed after iteration starts are received", async () => {
    const stream = new EventStream<StreamEvent>();

    const collected: StreamEvent[] = [];
    const iterating = (async () => {
      for await (const event of stream) {
        collected.push(event);
      }
    })();

    // Push events after iteration has started
    await Promise.resolve(); // let the iterator start waiting
    stream.push(makeEvent("late1"));
    await Promise.resolve();
    stream.push(makeEvent("late2"));
    await Promise.resolve();
    stream.close();

    await iterating;

    expect(collected).toHaveLength(2);
    expect((collected[0] as unknown as { text: string }).text).toBe("late1");
    expect((collected[1] as unknown as { text: string }).text).toBe("late2");
  });

  it("queue overflow drops oldest events when exceeding 10k", async () => {
    const stream = new EventStream<number>();

    // Push more than 10,000 events without consuming
    for (let i = 0; i < 10_002; i++) {
      stream.push(i);
    }
    stream.close();

    const collected: number[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    // After overflow at 10,001 items, queue is trimmed to 5,000 + new item
    // Then at 10,002 items (since 5,001 + more pushes), it may trim again
    // The key assertion: we should NOT have all 10,002 events
    expect(collected.length).toBeLessThan(10_002);
    // The last event should always be present
    expect(collected[collected.length - 1]).toBe(10_001);
  });
});

describe("StreamResult", () => {
  it("async iteration works with for-await", async () => {
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("hello");
      yield makeEvent("world");
      return makeResponse();
    }
    const result = new StreamResult(gen());

    const collected: StreamEvent[] = [];
    for await (const event of result) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect((collected[0] as unknown as { text: string }).text).toBe("hello");
    expect((collected[1] as unknown as { text: string }).text).toBe("world");
  });

  it("thenable - await directly returns response", async () => {
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("data");
      return makeResponse("end_turn");
    }
    const result = new StreamResult(gen());

    const response = await result;

    expect((response as unknown as { stopReason: string }).stopReason).toBe("end_turn");
    expect((response as unknown as { usage: { inputTokens: number } }).usage.inputTokens).toBe(10);
  });

  it("complete resolves the response promise", async () => {
    const mockResponse = makeResponse("stop");
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("x");
      return mockResponse;
    }
    const result = new StreamResult(gen());

    const response = await result.response;

    expect(response).toBe(mockResponse);
  });

  it("generator error rejects the response promise", async () => {
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("partial");
      throw new Error("provider error");
    }
    const result = new StreamResult(gen());

    // Consume iterator to trigger the error
    const collected: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of result) {
        collected.push(event);
      }
    }).rejects.toThrow("provider error");

    await expect(result.response).rejects.toThrow("provider error");
  });

  it("then returns response when awaited directly without a consumer", async () => {
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("a");
      yield makeEvent("b");
      yield makeEvent("c");
      return makeResponse();
    }
    const result = new StreamResult(gen());

    // Await directly (uses .then) — pump runs eagerly, no drain needed
    const response = await result;

    expect(response).toBeDefined();
    expect((response as unknown as { stopReason: string }).stopReason).toBe("end_turn");
  });
});

describe("StreamResult - stall regression tests", () => {
  it("does not stall when events arrive between drain and wait", async () => {
    // Reproduce the old "lost wakeup" bug:
    // In the push-based EventStream, events pushed between queue splice
    // and promise registration could be lost, causing a permanent hang.
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("first");
      // Microtask gap — in old EventStream, push() during this gap could be lost
      await Promise.resolve();
      yield makeEvent("second");
      await Promise.resolve();
      yield makeEvent("third");
      return makeResponse();
    }
    const result = new StreamResult(gen());

    const collected: StreamEvent[] = [];
    for await (const event of result) {
      collected.push(event);
    }

    // Old push-based code could hang here — pull-based completes reliably
    expect(collected).toHaveLength(3);
    expect((collected[0] as unknown as { text: string }).text).toBe("first");
    expect((collected[2] as unknown as { text: string }).text).toBe("third");
  });

  it("for-await and response promise do not interfere", async () => {
    // Reproduce the old "dual consumer" bug:
    // In the push-based EventStream, both for-await and then() would
    // create iterators sharing a single resolve field, causing one to hang.
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("a");
      yield makeEvent("b");
      return makeResponse();
    }
    const result = new StreamResult(gen());

    const collected: StreamEvent[] = [];
    for await (const event of result) {
      collected.push(event);
    }

    // Old code: then() would overwrite resolve, hanging the iterator
    const response = await result.response;
    expect(collected).toHaveLength(2);
    expect((response as unknown as { stopReason: string }).stopReason).toBe("end_turn");
  });

  it("generator error surfaces without hanging", async () => {
    // Reproduce: provider throws mid-stream. Must not hang — must propagate.
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      yield makeEvent("partial");
      throw new Error("server stall");
    }
    const result = new StreamResult(gen());

    const collected: StreamEvent[] = [];
    await expect(async () => {
      for await (const event of result) {
        collected.push(event);
      }
    }).rejects.toThrow("server stall");

    expect(collected).toHaveLength(1);
    await expect(result.response).rejects.toThrow("server stall");
  });

  it("stream completes without stalling (timeout guard)", async () => {
    // Real-ish delay pattern: if the stream infrastructure has a stall bug,
    // this test will hang and hit the timeout.
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      for (let i = 0; i < 10; i++) {
        yield makeEvent(`chunk-${i}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return makeResponse();
    }
    const result = new StreamResult(gen());

    const collected: StreamEvent[] = [];
    for await (const event of result) {
      collected.push(event);
    }

    expect(collected).toHaveLength(10);
    const response = await result.response;
    expect(response).toBeDefined();
  }, 10_000);

  it("aborts a hung generator when signal fires", async () => {
    async function* gen(): AsyncGenerator<StreamEvent, StreamResponse> {
      await new Promise(() => {}); // never resolves
      yield makeEvent("never");
      return makeResponse();
    }
    const ac = new AbortController();
    const result = new StreamResult(gen(), ac.signal);

    setTimeout(() => ac.abort(), 50);

    await expect(async () => {
      for await (const _event of result) {
        // should never reach here
      }
    }).rejects.toThrow("Aborted");

    await expect(result.response).rejects.toThrow("Aborted");
  });
});
