import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { Message, StreamEvent, StreamOptions, StreamResponse } from "@kleio/ai";
import { agentLoop } from "./agent-loop.js";
import { JsonEscapeDecoder, StreamRuleMonitor, type StreamRule } from "./stream-rules.js";
import type { AgentEvent, AgentOptions, AgentResult } from "./types.js";

vi.mock("@kleio/ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await importOriginal<typeof import("@kleio/ai")>();
  return { ...mod, stream: vi.fn() };
});

import { stream } from "@kleio/ai";
const mockStream = vi.mocked(stream);

// ── Scripted fake stream ────────────────────────────────────

interface ScriptedAttempt {
  events: StreamEvent[];
  response: StreamResponse;
}

interface CallRecord {
  signal: AbortSignal | undefined;
  messages: Message[];
  /** Events the loop actually pulled before it stopped iterating. */
  pulled: number;
}

/**
 * Each call to `stream()` plays the next attempt. Like the real StreamResult,
 * an aborted attempt's `response` rejects with an AbortError.
 */
function script(attempts: ScriptedAttempt[]): CallRecord[] {
  const calls: CallRecord[] = [];
  let index = 0;
  mockStream.mockImplementation((opts: StreamOptions) => {
    const attempt = attempts[index++];
    if (!attempt) throw new Error(`unexpected stream() call #${index}`);
    const record: CallRecord = {
      signal: opts.signal,
      messages: structuredClone(opts.messages),
      pulled: 0,
    };
    calls.push(record);
    const response = new Promise<StreamResponse>((resolve, reject) => {
      queueMicrotask(() => {
        if (opts.signal?.aborted) {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        } else {
          resolve(attempt.response);
        }
      });
    });
    response.catch(() => {});
    const result = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<StreamEvent> {
        for (const event of attempt.events) {
          if (opts.signal?.aborted) {
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          }
          record.pulled++;
          yield event;
        }
      },
      get response(): Promise<StreamResponse> {
        return response;
      },
    };
    return result as unknown as ReturnType<typeof stream>;
  });
  return calls;
}

function textAttempt(chunks: string[]): ScriptedAttempt {
  return {
    events: chunks.map((text) => ({ type: "text_delta" as const, text })),
    response: {
      message: { role: "assistant", content: [{ type: "text", text: chunks.join("") }] },
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    },
  };
}

function toolAttempt(id: string, args: Record<string, unknown>, chunks: string[]): ScriptedAttempt {
  return {
    events: chunks.map((argsJson) => ({
      type: "toolcall_delta" as const,
      id,
      name: "write",
      argsJson,
    })),
    response: {
      message: { role: "assistant", content: [{ type: "tool_call", id, name: "write", args }] },
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    },
  };
}

function rule(name: string, pattern: RegExp, scope: StreamRule["scope"] = "both"): StreamRule {
  return { name, pattern, scope, reminder: `Reminder for ${name}.` };
}

async function run(
  messages: Message[],
  extra: Partial<AgentOptions> = {},
): Promise<{ events: AgentEvent[]; result: AgentResult }> {
  const gen = agentLoop(messages, { provider: "anthropic", model: "test", ...extra });
  const events: AgentEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function streamedText(events: AgentEvent[]): string {
  return events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
}

function finalText(result: AgentResult): string {
  const content = result.message.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

// ── Loop integration ────────────────────────────────────────

describe("agentLoop stream rules", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("aborts mid-text, injects the reminder, and retries the same step", async () => {
    const calls = script([
      textAttempt(["Sure, here ", "is a TO", "DO marker", " and more text that never streams"]),
      textAttempt(["Clean answer."]),
    ]);
    const userController = new AbortController();
    const messages: Message[] = [{ role: "user", content: "hi" }];

    const { events, result } = await run(messages, {
      signal: userController.signal,
      streamRules: { rules: [rule("no-todo", /TODO/)] },
    });

    expect(calls).toHaveLength(2);
    // Aborted through the per-attempt controller, never the caller's signal.
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(userController.signal.aborted).toBe(false);
    // Stopped pulling at the violating delta (3rd of 4).
    expect(calls[0]?.pulled).toBe(3);

    // The violating delta never reached the consumer; the final answer is clean.
    expect(streamedText(events)).toBe("Sure, here is a TOClean answer.");
    expect(finalText(result)).toBe("Clean answer.");

    // Retry request: original prompt + hidden reminder, no partial assistant.
    const retryMessages = calls[1]?.messages ?? [];
    expect(retryMessages.map((m) => m.role)).toEqual(["user", "user"]);
    const reminder = retryMessages[1];
    expect(reminder?.provenance).toEqual({
      source: "runtime",
      kind: "notification",
      visibility: "hidden",
    });
    expect(typeof reminder?.content === "string" ? reminder.content : "").toContain(
      "Reminder for no-todo.",
    );
    // Nothing from the aborted attempt was persisted.
    expect(JSON.stringify(messages)).not.toContain("TODO marker");
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    const triggered = events.find((e) => e.type === "stream_rule_triggered");
    expect(triggered).toMatchObject({
      type: "stream_rule_triggered",
      rules: ["no-todo"],
      source: "text",
      attempt: 1,
      maxAttempts: 3,
    });
    const retry = events.find((e) => e.type === "retry");
    expect(retry).toMatchObject({ reason: "stream_rule", silent: true, delayMs: 0 });
    // Events ordered: notice → silent retry → replayed attempt.
    const types = events.map((e) => e.type);
    expect(types.indexOf("stream_rule_triggered")).toBeLessThan(types.indexOf("retry"));

    // The aborted attempt is still counted (estimated) on top of the real one.
    expect(result.totalUsage.inputTokens).toBeGreaterThan(100);
    expect(result.totalUsage.outputTokens).toBeGreaterThan(50);
    // The discarded attempt does not consume a turn.
    expect(result.totalTurns).toBe(1);
  });

  it("bills an aborted later step at the provider-reported prompt size", async () => {
    // Step 1 is a real tool turn whose provider usage reports the full prompt
    // (system + tool schemas + history = 9,000 tokens, mostly cached). The
    // rule fires on step 2: its aborted prompt is that prefix plus the small
    // tool result, not just the history text.
    const step1 = toolAttempt("t1", { content: "ok" }, ['{"content":"ok"}']);
    step1.response.usage = { inputTokens: 1_000, outputTokens: 20, cacheRead: 8_000 };
    const step3 = textAttempt(["Clean answer."]);
    step3.response.usage = { inputTokens: 300, outputTokens: 10, cacheRead: 8_800 };
    script([step1, textAttempt(["a TODO slipped in"]), step3]);

    const { events, result } = await run([{ role: "user", content: "hi" }], {
      tools: [
        {
          name: "write",
          description: "write a file",
          parameters: z.object({ content: z.string().optional() }),
          execute: () => "wrote",
        },
      ],
      streamRules: { rules: [rule("no-todo", /TODO/, "text")] },
    });

    const fired = events.find((e) => e.type === "stream_rule_triggered");
    expect(fired).toMatchObject({ usage: { cacheRead: 9_000 } });
    // Real steps (1,000 + 300 input, 8,000 + 8,800 cached) plus the aborted
    // attempt: 9,000 cached prefix and a handful of new tool-result tokens.
    expect(result.totalUsage.cacheRead).toBe(8_000 + 8_800 + 9_000);
    expect(result.totalUsage.inputTokens).toBeGreaterThan(1_300);
    expect(result.totalUsage.inputTokens).toBeLessThan(1_320);
  });

  it("matches a pattern split across deltas", async () => {
    const calls = script([textAttempt(["…TO", "D", "O…"]), textAttempt(["ok"])]);
    const { result } = await run([{ role: "user", content: "hi" }], {
      streamRules: { rules: [rule("no-todo", /TODO/)] },
    });
    expect(calls).toHaveLength(2);
    expect(finalText(result)).toBe("ok");
  });

  it("aborts a violating tool call before it can execute", async () => {
    const execute = vi.fn((_args: unknown) => "wrote");
    const calls = script([
      toolAttempt("bad", { content: "x" }, [
        '{"path":"a.ts","content":"line1\\n// ... ex',
        'isting code ...\\nline3"}',
      ]),
      toolAttempt("good", { content: "full file" }, ['{"path":"a.ts","content":"full file"}']),
      textAttempt(["done"]),
    ]);
    const messages: Message[] = [{ role: "user", content: "edit a.ts" }];

    const { events, result } = await run(messages, {
      tools: [
        {
          name: "write",
          description: "write a file",
          parameters: z.object({ path: z.string().optional(), content: z.string().optional() }),
          execute,
        },
      ],
      streamRules: {
        rules: [rule("placeholder", /^\s*\/\/\s*\.\.\.\s*existing code/m, "tool")],
      },
    });

    expect(calls).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ content: "full file" });
    expect(events.find((e) => e.type === "stream_rule_triggered")).toMatchObject({
      source: "tool",
      toolName: "write",
    });
    expect(JSON.stringify(messages)).not.toContain('"bad"');
    expect(events.some((e) => e.type === "tool_call_start" && e.toolCallId === "bad")).toBe(false);
    expect(finalText(result)).toBe("done");
  });

  it("does not apply text-scoped rules to tool arguments", async () => {
    const execute = vi.fn(() => "ok");
    const calls = script([
      toolAttempt("t1", { content: "TODO" }, ['{"content":"TODO"}']),
      textAttempt(["done"]),
    ]);
    await run([{ role: "user", content: "go" }], {
      tools: [
        {
          name: "write",
          description: "write",
          parameters: z.object({ content: z.string().optional() }),
          execute,
        },
      ],
      streamRules: { rules: [rule("no-todo", /TODO/, "text")] },
    });
    expect(calls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fires each rule at most once per run", async () => {
    const calls = script([textAttempt(["a TODO here"]), textAttempt(["still TODO, sorry"])]);
    const { events, result } = await run([{ role: "user", content: "hi" }], {
      streamRules: { rules: [rule("no-todo", /TODO/)] },
    });
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "stream_rule_triggered")).toHaveLength(1);
    expect(finalText(result)).toBe("still TODO, sorry");
  });

  it("caps rule retries per run", async () => {
    const calls = script([
      textAttempt(["alpha"]),
      textAttempt(["beta"]),
      textAttempt(["gamma"]),
      textAttempt(["unused"]),
    ]);
    const { events, result } = await run([{ role: "user", content: "hi" }], {
      streamRules: {
        maxRetries: 2,
        rules: [rule("a", /alpha/), rule("b", /beta/), rule("c", /gamma/)],
      },
    });
    expect(calls).toHaveLength(3);
    const fired = events.filter((e) => e.type === "stream_rule_triggered");
    expect(fired.map((e) => (e.type === "stream_rule_triggered" ? e.rules : []))).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(finalText(result)).toBe("gamma");
  });

  it("changes nothing when no rules are configured", async () => {
    const chunks = ["has a TODO", " in it"];
    script([textAttempt(chunks)]);
    const baseline = await run([{ role: "user", content: "hi" }]);
    vi.resetAllMocks();
    script([textAttempt(chunks)]);
    const empty = await run([{ role: "user", content: "hi" }], { streamRules: { rules: [] } });

    const shape = (events: AgentEvent[]): string[] => events.map((e) => e.type);
    expect(shape(empty.events)).toEqual(shape(baseline.events));
    expect(streamedText(empty.events)).toBe("has a TODO in it");
    expect(empty.result.totalUsage).toEqual(baseline.result.totalUsage);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});

// ── Monitor unit tests ──────────────────────────────────────

describe("StreamRuleMonitor", () => {
  it("bounds the rolling window", () => {
    const monitor = new StreamRuleMonitor({
      rules: [rule("ab", /A.*B/s)],
      windowChars: 64,
    });
    monitor.beginAttempt();
    expect(monitor.checkText("A")).toBeNull();
    expect(monitor.checkText("x".repeat(100))).toBeNull();
    // "A" has scrolled out of the 64-char window.
    expect(monitor.checkText("B")).toBeNull();
  });

  it("resets windows between attempts", () => {
    const monitor = new StreamRuleMonitor({ rules: [rule("todo", /TODO/)] });
    monitor.beginAttempt();
    expect(monitor.checkText("TO")).toBeNull();
    monitor.beginAttempt();
    expect(monitor.checkText("DO")).toBeNull();
  });

  it("keeps per-tool-call windows separate and honours tool filters", () => {
    const filtered: StreamRule = { ...rule("w", /XY/, "tool"), tools: ["edit"] };
    const monitor = new StreamRuleMonitor({ rules: [filtered] });
    monitor.beginAttempt();
    expect(monitor.checkToolArgs("1", "edit", "X")).toBeNull();
    expect(monitor.checkToolArgs("2", "edit", "Y")).toBeNull();
    expect(monitor.checkToolArgs("3", "write", "XY")).toBeNull();
    expect(monitor.checkToolArgs("1", "edit", "Y")?.rules.map((r) => r.name)).toEqual(["w"]);
  });

  it("tolerates global/sticky flags", () => {
    const monitor = new StreamRuleMonitor({ rules: [rule("g", /TODO/g)] });
    monitor.beginAttempt();
    expect(monitor.checkText("TODO")).not.toBeNull();
  });
});

describe("JsonEscapeDecoder", () => {
  it("decodes escapes split across chunks", () => {
    const decoder = new JsonEscapeDecoder();
    const out = ["a\\", "nb\\u00", '41c\\"', "d"].map((c) => decoder.push(c)).join("");
    expect(out).toBe('a\nbAc"d');
  });
});
