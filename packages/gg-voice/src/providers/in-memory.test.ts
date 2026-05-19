import { describe, expect, it } from "vitest";
import { createInMemoryVoiceProvider } from "./in-memory.js";
import type { InMemoryVoiceSession } from "./in-memory.js";

describe("in-memory voice provider", () => {
  it("records lifecycle events and sent tool results", async () => {
    const provider = createInMemoryVoiceProvider({
      now: () => new Date("2026-05-18T00:00:00.000Z"),
      idFactory: () => "session_1",
    });
    const session: InMemoryVoiceSession = await provider.connect({
      session: { model: "test-realtime" },
    });
    const events: string[] = [];
    session.onEvent((event) => {
      events.push(event.type);
    });

    await session.sendText("hello");
    session.triggerToolCall({ id: "call_1", name: "lookup", args: { query: "x" } });
    await session.sendToolResult({ toolCallId: "call_1", name: "lookup", content: "ok" });
    await session.close("done");

    expect(session.sentText).toEqual(["hello"]);
    expect(session.sentToolResults).toEqual([
      { toolCallId: "call_1", name: "lookup", content: "ok" },
    ]);
    expect(events).toEqual(["input_transcript_done", "tool_call", "tool_result_sent", "closed"]);
    expect(session.state).toBe("closed");
  });
});
