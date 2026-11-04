/**
 * `forwardAgentEvent` copies agent events onto the bus field by field, so a new
 * field on an agent event is silently dropped unless it is added here too. That
 * already happened once with `invalidArgAttempt` (the schema-rejection repeat
 * counter), which reached the sidecar as `undefined` and left the log unable to
 * distinguish a self-corrected retry from a loop that killed the turn.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus.forwardAgentEvent", () => {
  it("carries engine retry metadata through the real event bus", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on("retry", (data) => seen.push(data));
    const retry = {
      reason: "rate_limit" as const,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      silent: false,
    };
    bus.forwardAgentEvent({ type: "retry", ...retry });
    expect(seen).toEqual([retry]);
  });

  it("forwards stream_rule_triggered with every field", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on("stream_rule_triggered", (data) => seen.push(data));
    const triggered = {
      rules: ["no-todo"],
      source: "tool" as const,
      toolName: "edit",
      attempt: 1,
      maxAttempts: 3,
      usage: { inputTokens: 10, outputTokens: 2 },
    };
    bus.forwardAgentEvent({ type: "stream_rule_triggered", ...triggered });
    expect(seen).toEqual([triggered]);
  });

  it("carries invalidArgAttempt through to listeners", () => {
    const bus = new EventBus();
    const seen: (number | undefined)[] = [];
    bus.on("tool_call_end", (d) => seen.push(d.invalidArgAttempt));

    bus.forwardAgentEvent({
      type: "tool_call_end",
      toolCallId: "t1",
      result: "Invalid arguments for tool `edit`",
      isError: true,
      durationMs: 0,
      invalidArgAttempt: 2,
    });
    bus.forwardAgentEvent({
      type: "tool_call_end",
      toolCallId: "t2",
      result: "applied",
      isError: false,
      durationMs: 5,
    });

    expect(seen).toEqual([2, undefined]);
  });
});
