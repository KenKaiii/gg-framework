import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { Message, StreamEvent, StreamOptions, StreamResponse } from "@kleio/ai";
import { agentLoop, STEER_INTERRUPTED_TEXT } from "./agent-loop.js";
import { Agent } from "./agent.js";
import type { AgentEvent, AgentOptions, AgentResult, AgentTool } from "./types.js";

vi.mock("@kleio/ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await importOriginal<typeof import("@kleio/ai")>();
  return { ...mod, stream: vi.fn() };
});

import { stream } from "@kleio/ai";
const mockStream = vi.mocked(stream);

interface ScriptedAttempt {
  events: StreamEvent[];
  response: StreamResponse;
}

function script(attempts: ScriptedAttempt[]): Message[][] {
  const calls: Message[][] = [];
  let index = 0;
  mockStream.mockImplementation((opts: StreamOptions) => {
    const attempt = attempts[index++];
    if (!attempt) throw new Error(`unexpected stream() call #${index}`);
    calls.push(structuredClone(opts.messages));
    const response = Promise.resolve(attempt.response);
    return {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<StreamEvent> {
        for (const event of attempt.events) yield event;
      },
      get response(): Promise<StreamResponse> {
        return response;
      },
    } as unknown as ReturnType<typeof stream>;
  });
  return calls;
}

function textAttempt(text: string): ScriptedAttempt {
  return {
    events: [{ type: "text_delta", text }],
    response: {
      message: { role: "assistant", content: [{ type: "text", text }] },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  };
}

function toolAttempt(calls: Array<{ id: string; name: string }>): ScriptedAttempt {
  return {
    events: [],
    response: {
      message: {
        role: "assistant",
        content: calls.map((c) => ({
          type: "tool_call" as const,
          id: c.id,
          name: c.name,
          args: {},
        })),
      },
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  };
}

/** A slow tool that honors its AbortSignal (like bash killing its process tree). */
function slowTool(name: string, opts: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    executionMode: "sequential",
    ...opts,
    execute: (_args, ctx) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(`${name} finished`), 5_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(`${name} partial output`);
        });
      }),
  };
}

/** Steering source with an instant-interrupt subscription, like AgentSession. */
function steeringSource(): {
  options: Pick<AgentOptions, "getSteeringMessages" | "onSteeringAvailable">;
  steer: (text: string) => void;
} {
  const queue: Message[] = [];
  const listeners = new Set<() => void>();
  return {
    options: {
      getSteeringMessages: () => (queue.length > 0 ? queue.splice(0) : null),
      onSteeringAvailable: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    steer: (text) => {
      queue.push({ role: "user", content: text });
      for (const l of listeners) l();
    },
  };
}

async function drive(
  messages: Message[],
  options: Partial<AgentOptions>,
  onEvent: (e: AgentEvent) => void = () => {},
): Promise<{ events: AgentEvent[]; result: AgentResult }> {
  const gen = agentLoop(messages, { provider: "anthropic", model: "test", ...options });
  const events: AgentEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
    onEvent(next.value);
  }
}

function toolResultsOf(
  messages: Message[],
): Array<{ toolCallId: string; content: unknown; isError?: boolean }> {
  return messages.flatMap((m) => (m.role === "tool" ? m.content : []));
}

describe("instant interrupt (steering preempts tools)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("aborts a slow tool fast, pairs an Interrupted error result, and continues with the steer", async () => {
    const calls = script([toolAttempt([{ id: "t1", name: "bash" }]), textAttempt("ok, switching")]);
    const src = steeringSource();
    const messages: Message[] = [{ role: "user", content: "do it" }];
    let startedAt = 0;
    const { events, result } = await drive(
      messages,
      { tools: [slowTool("bash")], ...src.options },
      (e) => {
        if (e.type === "tool_call_start") {
          startedAt = Date.now();
          setTimeout(() => src.steer("actually do X"), 20);
        }
      },
    );
    const end = events.find((e) => e.type === "tool_call_end");
    expect(end && end.type === "tool_call_end" && end.durationMs).toBeLessThan(1_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The UI event says the same thing the model reads (found live: the panel
    // showed the raw "KILLED" result while the model got the Interrupted text).
    expect(end).toMatchObject({ isError: true });
    expect(end && end.type === "tool_call_end" && end.result).toContain(STEER_INTERRUPTED_TEXT);
    const [res] = toolResultsOf(messages);
    expect(res).toMatchObject({ toolCallId: "t1", isError: true });
    expect(String(res!.content)).toContain(STEER_INTERRUPTED_TEXT);
    expect(String(res!.content).split(STEER_INTERRUPTED_TEXT)).toHaveLength(2);
    expect(String(res!.content)).toContain("bash partial output");
    expect(events.some((e) => e.type === "steering_message")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)).toMatchObject({ role: "user", content: "actually do X" });
    expect(result.message.content).toEqual([{ type: "text", text: "ok, switching" }]);
  });

  it("abandons a tool that ignores its signal after the grace period", async () => {
    script([toolAttempt([{ id: "t1", name: "fetch" }]), textAttempt("done")]);
    const src = steeringSource();
    const stubborn: AgentTool = {
      name: "fetch",
      description: "fetch",
      parameters: z.object({}),
      execute: () => new Promise((resolve) => setTimeout(() => resolve("late"), 5_000)),
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    const t0 = Date.now();
    await drive(messages, { tools: [stubborn], ...src.options }, (e) => {
      if (e.type === "tool_call_start") setTimeout(() => src.steer("stop that"), 10);
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(toolResultsOf(messages)[0]).toMatchObject({
      toolCallId: "t1",
      content: STEER_INTERRUPTED_TEXT,
      isError: true,
    });
  });

  it("never preempts an atomic edit; later calls in the batch are cancelled before start", async () => {
    script([
      toolAttempt([
        { id: "e1", name: "edit" },
        { id: "b1", name: "bash" },
      ]),
      textAttempt("done"),
    ]);
    const src = steeringSource();
    let editSawAbort = false;
    const edit: AgentTool = {
      name: "edit",
      description: "edit",
      parameters: z.object({}),
      executionMode: "sequential",
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          setTimeout(() => {
            editSawAbort = ctx.signal.aborted;
            resolve("edit applied");
          }, 150);
        }),
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    await drive(messages, { tools: [edit, slowTool("bash")], ...src.options }, (e) => {
      if (e.type === "tool_call_start" && e.name === "edit") setTimeout(() => src.steer("hey"), 10);
    });
    expect(editSawAbort).toBe(false);
    const results = toolResultsOf(messages);
    expect(results[0]).toMatchObject({ toolCallId: "e1", content: "edit applied" });
    expect(results[0]!.isError).toBeUndefined();
    expect(results[1]).toMatchObject({ toolCallId: "b1", isError: true });
    expect(String(results[1]!.content)).not.toContain("bash finished");
  });

  it("Stop (options.signal) still ends the run instead of continuing", async () => {
    const calls = script([toolAttempt([{ id: "t1", name: "bash" }]), textAttempt("never")]);
    const src = steeringSource();
    const controller = new AbortController();
    const messages: Message[] = [{ role: "user", content: "go" }];
    const { events } = await drive(
      messages,
      { tools: [slowTool("bash")], signal: controller.signal, ...src.options },
      (e) => {
        if (e.type === "tool_call_start") setTimeout(() => controller.abort(), 20);
      },
    );
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === "steering_message")).toBe(false);
    expect(events.at(-1)?.type).toBe("agent_done");
  });

  it("without a steer, tools run to completion (no preemption)", async () => {
    script([toolAttempt([{ id: "t1", name: "quick" }]), textAttempt("done")]);
    const src = steeringSource();
    const quick: AgentTool = {
      name: "quick",
      description: "quick",
      parameters: z.object({}),
      execute: () => "quick result",
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    await drive(messages, { tools: [quick], ...src.options });
    expect(toolResultsOf(messages)[0]).toMatchObject({ toolCallId: "t1", content: "quick result" });
  });

  it("Agent.steer() preempts a running tool", async () => {
    const calls = script([toolAttempt([{ id: "t1", name: "bash" }]), textAttempt("pivoted")]);
    const agent = new Agent({ provider: "anthropic", model: "test", tools: [slowTool("bash")] });
    const stream = agent.prompt("go");
    const t0 = Date.now();
    for await (const e of stream) {
      if (e.type === "tool_call_start") {
        setTimeout(() => agent.steer({ role: "user", content: "new direction" }), 20);
      }
    }
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(calls[1]!.at(-1)).toMatchObject({ role: "user", content: "new direction" });
  });
});
