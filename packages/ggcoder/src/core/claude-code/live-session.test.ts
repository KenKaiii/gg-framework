import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentEvent, AgentTool } from "@kenkaiiii/gg-agent";
import { describe, expect, it, vi } from "vitest";
import type * as GgCore from "@kenkaiiii/gg-core";
import { z } from "zod";
import { fakeQuery, result, type ScriptContext } from "./__fixtures__/fake-query.js";
import { ClaudeCodeLiveSession, type ClaudeCodeLoopOptions } from "./live-session.js";

// Rate-limit reports go to ~/.gg/claude-code/usage.json; never touch the real one here.
vi.mock("@kenkaiiii/gg-core", async (importOriginal) => ({
  ...(await importOriginal<typeof GgCore>()),
  recordClaudeCodeRateLimit: async () => {},
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, "__fixtures__", "tool-run.json"), "utf8"),
) as SDKMessage[];
const SESSION_ID = "cc-live";
const init = { type: "system", subtype: "init", session_id: SESSION_ID } as unknown as SDKMessage;

const readTool: AgentTool = {
  name: "read",
  description: "Read a file",
  parameters: z.object({ path: z.string() }),
  execute: () => "The secret word is: pancake\n",
};

const user = (text: string): Message => ({ role: "user", content: text });
const textOf = (input: SDKUserMessage | undefined) =>
  (input?.message.content as { text: string }[]).map((b) => b.text).join("|");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

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

async function drain(
  live: ClaudeCodeLiveSession,
  messages: Message[],
  opts: ClaudeCodeLoopOptions,
) {
  const events: AgentEvent[] = [];
  for await (const event of live.run(messages, opts)) events.push(event);
  return events;
}

/** Claude Code answering every message with a plain result, like a long-lived process. */
async function* answerEach(ctx: ScriptContext): AsyncGenerator<SDKMessage> {
  await ctx.listTools();
  yield init;
  while (await ctx.nextInput()) yield result({});
}

describe("ClaudeCodeLiveSession", () => {
  it("sends each later message into the same process", async () => {
    const { query, calls } = fakeQuery(answerEach);
    const live = new ClaudeCodeLiveSession();
    const messages: Message[] = [
      user("Earlier."),
      { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      user("first"),
    ];
    const ids: string[] = [];
    await drain(live, messages, options(query, {}, { onSessionId: (id) => ids.push(id) }));
    expect(live.alive).toBe(true);
    expect(live.sessionId).toBe(SESSION_ID);

    messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] }, user("second"));
    await drain(live, messages, options(query, {}, { onSessionId: (id) => ids.push(id) }));

    expect(calls.queries).toBe(1);
    expect(calls.closes).toBe(0);
    expect(calls.inputs).toHaveLength(2);
    // The seed goes to the fresh process only; the reused one gets just the new message.
    expect(textOf(calls.inputs[0])).toContain("<conversation_so_far>");
    expect(textOf(calls.inputs[1])).toBe("second");
    expect(ids).toEqual([SESSION_ID, SESSION_ID]);
    live.close();
    expect(calls.closes).toBe(1);
    expect(live.alive).toBe(false);
    await expect(drain(live, messages, options(query))).rejects.toThrow("closed");
  });

  it("re-lists tools added between runs before sending the prompt", async () => {
    let listsAtSecondInput = -1;
    const fake = fakeQuery(async function* (ctx) {
      await ctx.listTools();
      await ctx.nextInput();
      yield result({});
      await ctx.nextInput();
      listsAtSecondInput = fake.calls.lists.length;
      yield result({});
    });
    const tools: AgentTool[] = [readTool];
    const live = new ClaudeCodeLiveSession();
    await drain(live, [user("one")], options(fake.query, { tools }));
    tools.push({ ...readTool, name: "later" });
    await drain(live, [user("two")], options(fake.query, { tools }));
    expect(fake.calls.lists).toEqual([["read"], ["read", "later"]]);
    expect(listsAtSecondInput).toBe(2);
    live.close();
  });

  it("keeps the process after Stop once the interrupted result arrives", async () => {
    const controller = new AbortController();
    const { query, calls } = fakeQuery(async function* (ctx) {
      let input: SDKUserMessage | undefined;
      while ((input = await ctx.nextInput())) {
        if (textOf(input) === "slow") {
          controller.abort();
          await ctx.interrupted;
          yield result({ subtype: "error_during_execution", is_error: true, errors: [] });
        } else yield result({});
      }
    });
    const live = new ClaudeCodeLiveSession();
    const events = await drain(live, [user("slow")], options(query, { signal: controller.signal }));
    expect(events.map((e) => e.type)).toEqual(["agent_done"]);
    expect(calls.interrupts).toBe(1);
    expect(live.alive).toBe(true);

    await drain(live, [user("slow"), user("fast")], options(query));
    expect(calls.queries).toBe(1);
    expect(textOf(calls.inputs[1])).toBe("slow|fast");
    expect(live.alive).toBe(true);
    live.close();
  });

  it("closes the process when Stop gets no result in time, or input was still queued", async () => {
    const hung = new AbortController();
    const silent = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      hung.abort();
      await new Promise(() => {});
      yield result({});
    });
    const live = new ClaudeCodeLiveSession({ interruptGraceMs: 20 });
    await drain(live, [user("x")], options(silent.query, { signal: hung.signal }));
    expect(live.alive).toBe(false);
    expect(silent.calls.closes).toBe(1);

    const queued = new AbortController();
    const receipt = fakeQuery(
      async function* (ctx) {
        await ctx.nextInput();
        queued.abort();
        await ctx.interrupted;
        await tick();
        yield result({ subtype: "error_during_execution", is_error: true, errors: [] });
      },
      { interruptReceipt: { still_queued: ["steer-1"] } },
    );
    const second = new ClaudeCodeLiveSession();
    await drain(second, [user("x")], options(receipt.query, { signal: queued.signal }));
    expect(second.alive).toBe(false);
  });

  it("closes the process after a hand-off so the next run resumes cold", async () => {
    const exitPlan: AgentTool = {
      ...readTool,
      execute: () => ({ content: "Plan submitted for user review.", endRun: true }),
    };
    const { query, calls } = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      for (const message of fixture) {
        if (message.type === "user") {
          await ctx.callTool("read", { path: "hello.txt" }, "toolu_01K5B459VK61GntsTQqe6XG1");
        }
        yield message;
      }
    });
    const live = new ClaudeCodeLiveSession();
    const messages = [user("Plan it")];
    await drain(live, messages, options(query, { tools: [exitPlan] }));
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(live.alive).toBe(false);
    expect(calls.closes).toBe(1);
  });

  it("marks the process dead on an error result, an exit, or output while idle", async () => {
    const failing = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    });
    const errored = new ClaudeCodeLiveSession();
    await expect(drain(errored, [user("x")], options(failing.query))).rejects.toThrow("boom");
    expect(errored.alive).toBe(false);

    const exiting = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield result({});
    });
    const exited = new ClaudeCodeLiveSession();
    await drain(exited, [user("x")], options(exiting.query));
    await tick();
    expect(exited.alive).toBe(false);

    const chatty = fakeQuery(async function* (ctx) {
      await ctx.nextInput();
      yield result({});
      yield result({});
      await ctx.nextInput();
    });
    const drifted = new ClaudeCodeLiveSession();
    await drain(drifted, [user("x")], options(chatty.query));
    await tick();
    expect(drifted.alive).toBe(false);
    expect(chatty.calls.closes).toBe(1);
  });

  it("closes after sitting idle", async () => {
    const { query, calls } = fakeQuery(answerEach);
    const live = new ClaudeCodeLiveSession({ idleMs: 10 });
    await drain(live, [user("x")], options(query));
    expect(live.alive).toBe(true);
    await tick();
    expect(live.alive).toBe(false);
    expect(calls.closes).toBe(1);
  });

  it("changes effort in place and refuses what needs a restart", async () => {
    const { query, calls } = fakeQuery(answerEach);
    const live = new ClaudeCodeLiveSession();
    expect(await live.setEffort("low")).toBe(false);
    await drain(live, [user("x")], options(query, { thinking: "high" }));
    expect(await live.setEffort("high")).toBe(true);
    expect(await live.setEffort("ultra")).toBe(true);
    expect(calls.flagSettings).toEqual([{ effortLevel: "max" }]);
    expect(await live.setEffort(undefined)).toBe(false);
    live.close();

    const rejecting = fakeQuery(answerEach, { rejectFlagSettings: true });
    const other = new ClaudeCodeLiveSession();
    await drain(other, [user("x")], options(rejecting.query, { thinking: "high" }));
    expect(await other.setEffort("low")).toBe(false);
    other.close();
  });
});

describe("ClaudeCodeLiveSession steering", () => {
  it("stays for the turn Claude Code queued behind a result", async () => {
    // Regression: steering that missed the running turn got its own turn after
    // the result; the run ended at the first result, so that reply went nowhere
    // and the idle output killed the process. The real CLI reports
    // queued_turn_count 0 here; only the consumed uuids tell.
    let wake: (() => void) | undefined;
    const queue: Message[] = [];
    let secondResult = false;
    const { query } = fakeQuery(async function* (ctx) {
      yield init;
      const first = await ctx.nextInput();
      queue.push(user("Also say OKAPI."));
      wake!();
      const second = await ctx.nextInput();
      yield result({ queued_turn_count: 0, user_message_uuids: [first!.uuid] });
      secondResult = true;
      yield result({ queued_turn_count: 0, user_message_uuids: [second!.uuid] });
      await ctx.nextInput();
    });
    const live = new ClaudeCodeLiveSession();
    const events = await drain(
      live,
      [user("Start")],
      options(query, {
        getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
        onSteeringAvailable: (listener) => {
          wake = listener;
          return () => {};
        },
      }),
    );
    expect(secondResult).toBe(true);
    expect(events.filter((e) => e.type === "steering_message")).toHaveLength(1);
    await tick();
    expect(live.alive).toBe(true);
    live.close();
  });

  it("ends at the result that consumed steering folded into the turn", async () => {
    let wake: (() => void) | undefined;
    const queue: Message[] = [];
    const { query } = fakeQuery(async function* (ctx) {
      yield init;
      const first = await ctx.nextInput();
      queue.push(user("Also say OKAPI."));
      wake!();
      const second = await ctx.nextInput();
      yield result({ user_message_uuids: [first!.uuid, second!.uuid] });
      await ctx.nextInput();
    });
    const live = new ClaudeCodeLiveSession();
    await drain(
      live,
      [user("Start")],
      options(query, {
        getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
        onSteeringAvailable: (listener) => {
          wake = listener;
          return () => {};
        },
      }),
    );
    expect(live.alive).toBe(true);
    live.close();
  });

  it("records steering the model already read without sending it again", async () => {
    let wake: (() => void) | undefined;
    const queue: Message[] = [];
    const reply = user("I like proper names.");
    const { query, calls } = fakeQuery(async function* (ctx) {
      yield init;
      await ctx.nextInput();
      queue.push(reply);
      wake!();
      await tick();
      yield result({ queued_turn_count: 0 });
      await ctx.nextInput();
    });
    const live = new ClaudeCodeLiveSession();
    const messages = [user("Start")];
    const events = await drain(
      live,
      messages,
      options(query, {
        getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
        steeringAlreadyRead: (message) => message === reply,
        onSteeringAvailable: (listener) => {
          wake = listener;
          return () => {};
        },
      }),
    );
    expect(calls.inputs).toHaveLength(1);
    expect(events.filter((e) => e.type === "steering_message")).toHaveLength(1);
    expect(messages).toContain(reply);
    live.close();
  });
});

describe("ClaudeCodeLiveSession preempt", () => {
  it("interrupts a long tool when the user sends a message", async () => {
    let wake: (() => void) | undefined;
    const queue: Message[] = [];
    const waiter: AgentTool = {
      name: "task_output",
      description: "",
      parameters: z.object({}),
      execute: (_args, ctx) =>
        new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("log so far"))),
    };
    let toolReply: unknown;
    const { query, calls } = fakeQuery(async function* (ctx) {
      yield init;
      const first = await ctx.nextInput();
      const pending = ctx.callTool("task_output", {}, "toolu_wait");
      await tick();
      queue.push(user("Stop waiting, do X."));
      wake!();
      toolReply = (await pending).result;
      const steer = await ctx.nextInput();
      yield result({ user_message_uuids: [first!.uuid, steer!.uuid] });
      await ctx.nextInput();
    });
    const live = new ClaudeCodeLiveSession();
    await drain(
      live,
      [user("Start")],
      options(query, {
        tools: [waiter],
        getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
        onSteeringAvailable: (listener) => {
          wake = listener;
          return () => {};
        },
      }),
    );
    expect(JSON.stringify(toolReply)).toContain("Interrupted: the user sent a new message.");
    expect(textOf(calls.inputs[1])).toContain("Stop waiting, do X.");
    live.close();
  });
});
