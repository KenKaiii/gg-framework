import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { registerPalsuProvider, palsuText, palsuToolCall } from "@kenkaiiii/gg-ai";
import type { Message } from "@kenkaiiii/gg-ai";
import type { PalsuProviderHandle } from "@kenkaiiii/gg-ai";
import { Agent } from "./agent.js";
import type { AgentEvent, AgentTool } from "./types.js";

// ── Helpers ───────────────────────────────────────────────

async function collectEvents(agent: Agent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.prompt(prompt)) {
    events.push(event);
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────

describe("Agent E2E (palsu provider)", () => {
  let handle: PalsuProviderHandle;

  afterEach(() => {
    handle?.unregister();
  });

  it("returns text from a basic prompt", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("Hello from palsu!"));

    const agent = new Agent({ provider: "palsu", model: "test" });
    const result = await agent.prompt("hi");

    expect(result.message.content).toEqual([{ type: "text", text: "Hello from palsu!" }]);
    expect(result.totalTurns).toBe(1);
  });

  it("yields streaming events via async iteration", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("streamed text"));

    const agent = new Agent({ provider: "palsu", model: "test" });
    const events = await collectEvents(agent, "hello");

    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("turn_end");
    expect(types).toContain("agent_done");
  });

  it("executes tool calls and continues to text response", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuToolCall("greet", { name: "World" }, "tc_1"));
    handle.appendResponses(palsuText("Hello World!"));

    const greetTool: AgentTool<typeof greetParams> = {
      name: "greet",
      description: "Greet someone",
      parameters: greetParams,
      execute: (args) => `Greeting: Hello, ${args.name}!`,
    };

    const agent = new Agent({ provider: "palsu", model: "test", tools: [greetTool] });
    const events = await collectEvents(agent, "greet the world");

    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_end")).toBe(true);

    const toolEnd = events.find((e) => e.type === "tool_call_end") as {
      result: string;
    };
    expect(toolEnd.result).toBe("Greeting: Hello, World!");

    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2);
  });

  it("steer() injects a message after tool execution", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuToolCall("slow_tool", {}, "tc_1"));
    handle.appendResponses(palsuText("Done with steering"));

    const slowTool: AgentTool<typeof emptyParams> = {
      name: "slow_tool",
      description: "A tool",
      parameters: emptyParams,
      execute: () => "tool done",
    };

    const agent = new Agent({ provider: "palsu", model: "test", tools: [slowTool] });
    agent.steer({ role: "user", content: "Please also consider X" });

    const events = await collectEvents(agent, "do something");

    expect(events.some((e) => e.type === "steering_message")).toBe(true);
  });

  it("followUp() continues the loop when agent would stop", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("First reply"));
    handle.appendResponses(palsuText("After follow-up"));

    const agent = new Agent({ provider: "palsu", model: "test" });
    agent.followUp({ role: "user", content: "One more thing..." });

    const events = await collectEvents(agent, "start");

    expect(events.some((e) => e.type === "follow_up_message")).toBe(true);
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2);
  });

  it("aborts cleanly via AbortSignal", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("should be aborted"));

    const controller = new AbortController();
    controller.abort();

    const agent = new Agent({ provider: "palsu", model: "test", signal: controller.signal });
    // Pre-aborted signal causes the loop to throw — AgentStream catches and rejects
    await expect(agent.prompt("hello")).rejects.toThrow();
    // Agent should reset to not-running after the error
    expect(agent.running).toBe(false);
  });

  it("tracks running state correctly", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("response"));

    const agent = new Agent({ provider: "palsu", model: "test" });
    expect(agent.running).toBe(false);

    const stream = agent.prompt("hello");
    expect(agent.running).toBe(true);

    await stream;
    expect(agent.running).toBe(false);
  });

  it("throws when prompt() called while already running", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("first"));

    const agent = new Agent({ provider: "palsu", model: "test" });
    const first = agent.prompt("hello");

    expect(() => agent.prompt("another")).toThrow("Agent is already running");

    await first;
  });

  it("maintains conversation history across sequential prompts", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("I am a helpful assistant"));
    handle.appendResponses((msgs) => {
      const userMsgs = msgs.filter((m) => m.role === "user");
      return palsuText(`Saw ${userMsgs.length} user messages`);
    });

    const agent = new Agent({ provider: "palsu", model: "test" });

    await agent.prompt("hello");
    const r2 = await agent.prompt("follow up");

    expect(r2.message.content).toEqual([{ type: "text", text: "Saw 2 user messages" }]);
  });

  it("enforces maxTurns when tool calls loop", async () => {
    handle = registerPalsuProvider();
    handle.setResponses(
      Array.from({ length: 10 }, (_, i) => palsuToolCall("loop_tool", {}, `tc_${i}`)),
    );

    const loopTool: AgentTool<typeof emptyParams> = {
      name: "loop_tool",
      description: "Always loops",
      parameters: emptyParams,
      execute: () => "keep going",
    };

    const agent = new Agent({ provider: "palsu", model: "test", tools: [loopTool], maxTurns: 3 });
    const result = await agent.prompt("loop forever");

    expect(result.totalTurns).toBe(3);
  });

  it("emits events in correct order for a tool-using turn", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuToolCall("echo", { text: "hi" }, "tc_1"));
    handle.appendResponses(palsuText("Final answer"));

    const echoTool: AgentTool<typeof echoParams> = {
      name: "echo",
      description: "Echo text",
      parameters: echoParams,
      execute: (args) => args.text,
    };

    const agent = new Agent({ provider: "palsu", model: "test", tools: [echoTool] });
    const events = await collectEvents(agent, "echo hi");

    const types = events.map((e) => e.type);

    // Turn 1: turn_end (from LLM response) → tool_call_start → tool_call_end
    const firstTurnEnd = types.indexOf("turn_end");
    const toolStartIdx = types.indexOf("tool_call_start");
    const toolEndIdx = types.indexOf("tool_call_end");
    expect(firstTurnEnd).toBeGreaterThanOrEqual(0);
    expect(toolStartIdx).toBeGreaterThan(firstTurnEnd);
    expect(toolStartIdx).toBeLessThan(toolEndIdx);

    // Turn 2: text_delta → turn_end → agent_done
    const textDeltaIdx = types.indexOf("text_delta");
    const secondTurnEnd = types.indexOf("turn_end", firstTurnEnd + 1);
    const agentDoneIdx = types.indexOf("agent_done");
    expect(textDeltaIdx).toBeGreaterThan(toolEndIdx);
    expect(textDeltaIdx).toBeLessThan(secondTurnEnd);
    expect(secondTurnEnd).toBeLessThan(agentDoneIdx);
  });
});

describe("Agent E2E — compaction (palsu provider)", () => {
  let handle: PalsuProviderHandle;

  afterEach(() => {
    handle?.unregister();
  });

  it("calls transformContext before each LLM call", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("Response after transform"));

    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    const agent = new Agent({
      provider: "palsu",
      model: "test",
      transformContext,
    });
    await agent.prompt("hello");

    expect(transformContext).toHaveBeenCalledTimes(1);
  });

  it("compacts messages when transformContext returns a new array", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuText("After compaction"));

    const compacted: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "[summary of prior conversation]" },
    ];

    const transformContext = vi.fn().mockReturnValueOnce(compacted);

    const agent = new Agent({
      provider: "palsu",
      model: "test",
      system: "sys",
      transformContext,
    });
    const result = await agent.prompt("hello");

    expect(transformContext).toHaveBeenCalled();
    expect(result.totalTurns).toBe(1);
  });

  it("throws immediately on context overflow without compaction", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(() => {
      throw new Error("prompt is too long: 250000 tokens > 200000 maximum");
    });

    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    const agent = new Agent({
      provider: "palsu",
      model: "test",
      system: "sys",
      transformContext,
    });

    await expect(agent.prompt("long conversation")).rejects.toThrow("prompt is too long");

    // transformContext should NOT have been called with force: true
    const forceCalls = transformContext.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[1]?.force === true,
    );
    expect(forceCalls.length).toBe(0);
  });

  it("compacts mid-flow during multi-turn tool execution", async () => {
    handle = registerPalsuProvider();
    // Turn 1: tool call
    handle.appendResponses(palsuToolCall("search", { query: "test" }, "tc_1"));
    // Turn 2: text response
    handle.appendResponses(palsuText("Found results"));

    let transformCallCount = 0;
    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => {
      transformCallCount++;
      // On the second call (after tool execution), simulate compaction
      if (transformCallCount === 2 && msgs.length > 4) {
        return [
          msgs[0]!, // system
          { role: "user" as const, content: "[compacted history]" },
          msgs[msgs.length - 2]!, // assistant with tool call
          msgs[msgs.length - 1]!, // tool result
        ];
      }
      return msgs;
    });

    const searchTool: AgentTool<typeof searchParams> = {
      name: "search",
      description: "Search",
      parameters: searchParams,
      execute: () => "result: found 3 matches",
    };

    const agent = new Agent({
      provider: "palsu",
      model: "test",
      system: "You are helpful",
      tools: [searchTool],
      transformContext,
    });
    const events = await collectEvents(agent, "search for test");

    // Both turns should complete
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2);

    // transformContext called before each LLM call (2 turns)
    expect(transformContext).toHaveBeenCalledTimes(2);
  });

  it("handles repeated compaction across many turns", async () => {
    handle = registerPalsuProvider();
    // 3 tool calls then a text response = 4 turns
    handle.appendResponses(palsuToolCall("action", {}, "tc_1"));
    handle.appendResponses(palsuToolCall("action", {}, "tc_2"));
    handle.appendResponses(palsuToolCall("action", {}, "tc_3"));
    handle.appendResponses(palsuText("All done"));

    let compactionCount = 0;
    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => {
      // Compact every time there are more than 6 messages
      if (msgs.length > 6) {
        compactionCount++;
        return [
          msgs[0]!, // system
          { role: "user" as const, content: `[compacted #${compactionCount}]` },
          msgs[msgs.length - 2]!, // keep last assistant
          msgs[msgs.length - 1]!, // keep last tool result
        ];
      }
      return msgs;
    });

    const actionTool: AgentTool<typeof emptyParams> = {
      name: "action",
      description: "Do something",
      parameters: emptyParams,
      execute: () => "done",
    };

    const agent = new Agent({
      provider: "palsu",
      model: "test",
      system: "sys",
      tools: [actionTool],
      transformContext,
    });
    const result = await agent.prompt("do 3 actions");

    expect(result.totalTurns).toBe(4);
    // transformContext called before each of 4 LLM calls
    expect(transformContext).toHaveBeenCalledTimes(4);
    // Should have triggered compaction at least once
    expect(compactionCount).toBeGreaterThan(0);
  });

  it("compaction interacts correctly with steering messages", async () => {
    handle = registerPalsuProvider();
    handle.appendResponses(palsuToolCall("task", {}, "tc_1"));
    handle.appendResponses(palsuText("Final response"));

    const transformContext = vi.fn().mockImplementation((msgs: Message[]) => msgs);

    const taskTool: AgentTool<typeof emptyParams> = {
      name: "task",
      description: "A task",
      parameters: emptyParams,
      execute: () => "task done",
    };

    const agent = new Agent({
      provider: "palsu",
      model: "test",
      tools: [taskTool],
      transformContext,
    });

    // Queue steering before prompt — it should be visible to transformContext
    agent.steer({ role: "user", content: "Also do Y" });

    const events = await collectEvents(agent, "do X");

    // Steering message should appear in events
    expect(events.some((e) => e.type === "steering_message")).toBe(true);

    // transformContext should see the steering message in the messages array
    // (it's called after steering injection on first turn, and before turn 2 LLM call)
    expect(transformContext).toHaveBeenCalledTimes(2);
  });
});

// ── Shared Zod schemas ────────────────────────────────────

const greetParams = z.object({ name: z.string() });
const emptyParams = z.object({});
const echoParams = z.object({ text: z.string() });
const searchParams = z.object({ query: z.string() });
