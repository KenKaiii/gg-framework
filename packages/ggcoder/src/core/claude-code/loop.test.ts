import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Message, ToolResult } from "@kenkaiiii/gg-ai";
import type { AgentEvent, AgentResult, AgentTool } from "@kenkaiiii/gg-agent";
import { describe, expect, it, vi } from "vitest";
import type * as GgCore from "@kenkaiiii/gg-core";
import { z } from "zod";
import { effortForThinking, renderTranscript, toUsage } from "./events.js";
import { claudeCodeLoop, type ClaudeCodeLoopOptions } from "./loop.js";
import { fakeQuery, result, type ScriptContext } from "./__fixtures__/fake-query.js";

// Rate-limit reports go to ~/.gg/claude-code/usage.json; never touch the real one here.
const recorded = vi.hoisted(() => [] as unknown[]);
vi.mock("@kenkaiiii/gg-core", async (importOriginal) => ({
  ...(await importOriginal<typeof GgCore>()),
  recordClaudeCodeRateLimit: async (info: unknown) => {
    recorded.push(info);
  },
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, "__fixtures__", "tool-run.json"), "utf8"),
) as SDKMessage[];
const SESSION_ID = "2bb23d04-02a4-4d70-b3ad-15640c7dfeef";
const TOOL_USE_ID = "toolu_01K5B459VK61GntsTQqe6XG1";

/** The recorded run, with the tool call routed through our bridge. */
async function* replayFixture(ctx: ScriptContext): AsyncGenerator<SDKMessage> {
  await ctx.nextInput();
  for (const message of fixture) {
    if (message.type === "user") {
      await ctx.callTool("read", { path: "hello.txt" }, TOOL_USE_ID);
    }
    yield message;
  }
}

const readTool: AgentTool = {
  name: "read",
  description: "Read a file",
  parameters: z.object({ path: z.string() }),
  execute: () => "The secret word is: pancake\n",
};

function options(
  query: ReturnType<typeof fakeQuery>["query"],
  extra: Partial<ClaudeCodeLoopOptions> = {},
  cc: Partial<ClaudeCodeLoopOptions["claudeCode"]> = {},
): ClaudeCodeLoopOptions {
  return {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    system: "You are GG Coder.",
    tools: [readTool],
    ...extra,
    claudeCode: { executable: "/bin/claude", cwd: "/tmp/proj", env: {}, query, ...cc },
  };
}

async function run(messages: Message[], opts: ClaudeCodeLoopOptions) {
  const events: AgentEvent[] = [];
  const loop = claudeCodeLoop(messages, opts);
  let next = await loop.next();
  while (!next.done) {
    events.push(next.value);
    next = await loop.next();
  }
  return { events, result: next.value as AgentResult };
}

const user = (text: string): Message => ({ role: "user", content: text });

describe("claudeCodeLoop", () => {
  it("replays a recorded tool run into our events and transcript", async () => {
    const { query, calls } = fakeQuery(replayFixture);
    const sessionIds: string[] = [];
    const rateLimits: unknown[] = [];
    const messages = [user("What is the secret word in hello.txt?")];
    const { events, result } = await run(
      messages,
      options(
        query,
        { thinking: "ultra", maxTurns: 12 },
        {
          title: "probe",
          onSessionId: (id) => sessionIds.push(id),
          onRateLimit: (i) => rateLimits.push(i),
        },
      ),
    );

    const types = events.map((e) => e.type).filter((t) => t !== "toolcall_delta");
    expect(types).toEqual([
      "turn_end",
      "tool_call_start",
      "tool_call_end",
      "checkpoint",
      "text_delta",
      "text_delta",
      "turn_end",
      "agent_done",
    ]);
    expect(events.find((e) => e.type === "tool_call_start")).toMatchObject({
      toolCallId: TOOL_USE_ID,
      name: "read",
      args: { path: "hello.txt" },
    });
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({
      turn: 1,
      stopReason: "tool_use",
      usage: { inputTokens: 2, outputTokens: 56, cacheWrite: 1075 },
    });

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]!.content).toEqual([
      { type: "tool_call", id: TOOL_USE_ID, name: "read", args: { path: "hello.txt" } },
    ]);
    expect((messages[2]!.content as ToolResult[])[0]).toMatchObject({
      toolCallId: TOOL_USE_ID,
      content: "The secret word is: pancake\n",
    });
    expect(result.message.content).toEqual([
      { type: "text", text: "The secret word is **pancake**." },
    ]);
    expect(result.totalTurns).toBe(2);
    expect(result.totalUsage).toMatchObject({ inputTokens: 4, outputTokens: 69 });

    expect(sessionIds).toEqual([SESSION_ID]);
    expect(rateLimits).toHaveLength(1);
    expect(recorded).toContainEqual(rateLimits[0]);
    expect(calls.closes).toBe(1);
    expect(calls.inputs[0]!.message.content).toEqual([
      { type: "text", text: "What is the secret word in hello.txt?" },
    ]);
    const o = calls.options!;
    expect(o.systemPrompt).toEqual({ type: "custom", prompt: "You are GG Coder." });
    expect(o).toMatchObject({
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      model: "claude-haiku-5-5",
      effort: "max",
      thinking: { type: "adaptive" },
      maxTurns: 12,
      title: "probe",
      pathToClaudeCodeExecutable: "/bin/claude",
    });
    expect(o.resume).toBeUndefined();
    // allowedTools would skip canUseTool (SDK warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
    expect(o.allowedTools).toBeUndefined();
    const canUse = o.canUseTool!;
    const sig = { signal: new AbortController().signal } as Parameters<typeof canUse>[2];
    expect((await canUse("mcp__gg__read", {}, sig))?.behavior).toBe("allow");
    expect((await canUse("mcp__gg__later", {}, sig))?.behavior).toBe("allow");
    expect((await canUse("Bash", {}, sig))?.behavior).toBe("deny");
  });

  it("seeds a fresh session with our history, and resumes without it", async () => {
    const history: Message[] = [
      user("Remember the codeword: tangerine."),
      { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      user("What was it?"),
    ];
    const reply = async function* (ctx: ScriptContext): AsyncGenerator<SDKMessage> {
      await ctx.nextInput();
      yield result({});
    };

    const fresh = fakeQuery(reply);
    await run([...history], options(fresh.query, {}, { title: "t" }));
    const seeded = fresh.calls.inputs[0]!.message.content as { text: string }[];
    expect(seeded).toHaveLength(2);
    expect(seeded[0]!.text).toContain("<conversation_so_far>");
    expect(seeded[0]!.text).toContain("User: Remember the codeword: tangerine.");
    expect(seeded[0]!.text).toContain("Assistant: Noted.");
    expect(seeded[1]).toEqual({ type: "text", text: "What was it?" });

    const resumed = fakeQuery(reply);
    await run([...history], options(resumed.query, {}, { resume: SESSION_ID, title: "t" }));
    expect(resumed.calls.inputs[0]!.message.content).toEqual([
      { type: "text", text: "What was it?" },
    ]);
    expect(resumed.calls.options).toMatchObject({ resume: SESSION_ID });
    expect(resumed.calls.options!.title).toBeUndefined();
    expect(resumed.calls.options).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("sends steering mid-run and records it after the tool results", async () => {
    const { query, calls } = fakeQuery(replayFixture);
    let steered = false;
    const messages = [user("Read hello.txt")];
    const { events } = await run(
      messages,
      options(query, {
        getSteeringMessages: () => {
          if (steered) return null;
          steered = true;
          return [user("Also, be brief.")];
        },
      }),
    );
    expect(events.filter((e) => e.type === "steering_message")).toHaveLength(1);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(messages[3]).toEqual(user("Also, be brief."));
    // The fixture never reads further input, but the steering was queued for it.
    expect(calls.inputs).toHaveLength(1);
  });

  it("takes queued steering after the call that queued it returns", async () => {
    // Regression: draining inside queueMessage left the queue empty before the
    // sidecar reported the message as queued, so the app never saw it pending
    // and kept its bubble labelled "Queued" after the agent had it.
    let wake: (() => void) | undefined;
    const queue: Message[] = [];
    let drainedDuringQueue = false;
    const { query, calls } = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      queue.push(user("Also, be brief."));
      wake!();
      drainedDuringQueue = queue.length === 0;
      await ctx.nextInput();
      yield result({ num_turns: 1 });
    });
    await run(
      [user("Start")],
      options(query, {
        getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
        onSteeringAvailable: (listener) => {
          wake = listener;
          return () => {};
        },
      }),
    );
    expect(drainedDuringQueue).toBe(false);
    // It still reached Claude Code right after.
    expect(calls.inputs).toHaveLength(2);
  });

  it("leaves a message queued as the run ends in the queue for the next run", async () => {
    // A hand-off still pending when the loop ends must not take the message:
    // nothing would deliver it, and it belongs to the next run.
    let wake: (() => void) | undefined;
    const queue: Message[] = [];
    const { query } = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      queue.push(user("Also, be brief."));
      wake!();
      // The run stops abruptly (max turns) before the hand-off fires.
      yield result({ subtype: "error_max_turns", num_turns: 1 });
    });
    await run(
      [user("Start")],
      options(query, {
        getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
        onSteeringAvailable: (listener) => {
          wake = listener;
          return () => {};
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue).toHaveLength(1);
  });

  it("continues with follow-ups after a result, then stops", async () => {
    let followed = false;
    const { query, calls } = fakeQuery(async function* (ctx) {
      while (await ctx.nextInput()) yield result({ result: "ok" });
    });
    const { events } = await run(
      [user("first")],
      options(query, {
        getFollowUpMessages: () => {
          if (followed) return null;
          followed = true;
          return [user("second")];
        },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["follow_up_message", "agent_done"]);
    expect(calls.inputs.map((m) => m.message.content)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ]);
  });

  it("stops Claude Code right after a tool that ends the run (submitted plan)", async () => {
    // Regression: endRun was only checked at Claude Code's final `result`, so the
    // model kept going after exit_plan, got the "plan mode off" note as steering,
    // and asked for approval in chat before the real review box opened.
    const queue: Message[] = [user("Also, be brief.")];
    let steeringPolls = 0;
    const exitPlan: AgentTool = {
      ...readTool,
      execute: () => ({ content: "Plan submitted for user review.", endRun: true }),
    };
    const { query, calls } = fakeQuery(replayFixture);
    const messages = [user("Plan it")];
    const { events } = await run(
      messages,
      options(query, {
        tools: [exitPlan],
        getSteeringMessages: () => {
          steeringPolls++;
          return queue.splice(0);
        },
      }),
    );
    expect(events.map((e) => e.type).filter((t) => t !== "toolcall_delta")).toEqual([
      "turn_end",
      "tool_call_start",
      "tool_call_end",
      "checkpoint",
      "agent_done",
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // The queued message was not taken: it belongs to the next run.
    expect(steeringPolls).toBe(0);
    expect(queue).toHaveLength(1);
    expect(calls.inputs).toHaveLength(1);
    expect(calls.closes).toBe(1);
  });

  it("treats Stop as a clean end and pairs the interrupted tool call", async () => {
    const controller = new AbortController();
    const { query, calls } = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield fixture[1]!;
      yield fixture[6]!; // input_json_delta
      yield fixture[9]!; // assistant tool_use
      await ctx.interrupted;
      yield result({ subtype: "error_during_execution", is_error: true, errors: [] });
      throw new Error("Claude Code returned an error result: interrupted");
    });
    const messages = [user("Read hello.txt")];
    const events: AgentEvent[] = [];
    for await (const event of claudeCodeLoop(
      messages,
      options(query, { signal: controller.signal }),
    )) {
      events.push(event);
      if (event.type === "toolcall_delta") controller.abort();
    }
    expect(calls.interrupts).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["toolcall_delta", "agent_done"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect((messages[2]!.content as ToolResult[])[0]).toMatchObject({
      toolCallId: TOOL_USE_ID,
      isError: true,
    });
  });

  it("surfaces Claude Code errors and the max-turns cut-off", async () => {
    const failing = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    });
    await expect(run([user("x")], options(failing.query))).rejects.toThrow("boom");

    const apiError = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield result({ is_error: true, result: "API Error: 401 authentication_error" });
    });
    await expect(run([user("x")], options(apiError.query))).rejects.toThrow("401");

    const capped = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield result({ subtype: "error_max_turns", is_error: true, errors: [] });
    });
    const { events } = await run([user("x")], options(capped.query, { maxTurns: 3 }));
    expect(events).toEqual([
      { type: "max_turns", totalTurns: 0, maxTurns: 3 },
      { type: "agent_done", totalTurns: 0, totalUsage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });
});

describe("claude-code events helpers", () => {
  it("maps thinking levels to effort", () => {
    expect(effortForThinking(undefined)).toBeUndefined();
    expect(effortForThinking("low")).toBe("low");
    expect(effortForThinking("xhigh")).toBe("xhigh");
    expect(effortForThinking("ultra")).toBe("max");
  });

  it("converts Anthropic usage", () => {
    expect(
      toUsage({
        input_tokens: 5,
        output_tokens: 9,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 7,
        output_tokens_details: { thinking_tokens: 3 },
      }),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 9,
      cacheRead: 100,
      cacheWrite: 7,
      reasoningTokens: 3,
    });
  });

  it("keeps the newest messages when the transcript is over the cap", () => {
    const history = Array.from({ length: 50 }, (_, i) => user(`message ${i} ${"x".repeat(80)}`));
    const text = renderTranscript(history, 1_000);
    expect(text).toContain("message 49");
    expect(text).not.toContain("message 0 ");
    expect(text).toMatch(/\[\d+ earlier messages omitted\]/);
  });
});

describe("claudeCodeResumeId", () => {
  it("resumes only while the saved anchor still ends the seen history", async () => {
    const { claudeCodeResumeId, parseClaudeCodeSessionState, claudeCodeSessionEntryData } =
      await import("./session-sync.js");
    const sys: Message = { role: "system", content: "sys" };
    const u1 = user("one");
    const a1: Message = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const state = { sessionId: "s", messageCount: 2, anchor: a1 };
    expect(claudeCodeResumeId(state, [sys, u1, a1, user("two")])).toBe("s");
    expect(claudeCodeResumeId(state, [sys, u1, { ...a1 }, user("two")])).toBeUndefined();
    expect(claudeCodeResumeId(state, [sys, u1])).toBeUndefined();
    expect(
      claudeCodeResumeId(state, [sys, u1, a1, { role: "assistant", content: "other provider" }]),
    ).toBeUndefined();

    const restored = [u1, JSON.parse(JSON.stringify(a1)) as Message];
    const data = claudeCodeSessionEntryData(state);
    expect(parseClaudeCodeSessionState(data, restored)).toMatchObject({ sessionId: "s" });
    expect(parseClaudeCodeSessionState(data, [u1, user("different")])).toBeNull();
  });
});
