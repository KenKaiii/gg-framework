import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_DEFERRED_RESULT,
  ASK_USER_INTERACTIVE_DEADLINE_MS,
  ASK_USER_UNATTENDED_DEADLINE_MS,
  askSoftDeadlineMs,
  createAskUserBridge,
  deliverLateAnswer,
  formatLateAnswer,
  type AskUserPrompt,
  type LateAskAnswer,
} from "./ask-user.js";
import { createAskUserTool } from "../tools/ask-user.js";

/**
 * The soft-deadline ("async ask") contract: past the deadline the tool call
 * returns "proceed on your best guess", the question stays answerable, and a
 * later answer reaches the agent exactly once as a message.
 */
function harness(timeoutMs: number | (() => number) = 1000) {
  const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
  const onLateAnswer = vi.fn<(late: LateAskAnswer) => void>();
  const onClosed = vi.fn<(ids: string[]) => void>();
  const bridge = createAskUserBridge({ broadcast, timeoutMs, onLateAnswer, onClosed });
  const tool = createAskUserTool(bridge.park);
  const call = (question = "Ship it?"): Promise<string> =>
    tool.execute({ questions: [{ id: "q", question, kind: "confirm" }] }, {
      signal: new AbortController().signal,
      toolCallId: "t1",
      onUpdate: () => {},
    } as never) as Promise<string>;
  const lastPrompt = (): AskUserPrompt => {
    const calls = broadcast.mock.calls;
    const last = calls[calls.length - 1];
    if (!last) throw new Error("nothing broadcast");
    return last[0];
  };
  return { bridge, call, lastPrompt, onLateAnswer, onClosed };
}

describe("ask_user soft deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a proceed-on-best-judgment result with the safety rule", async () => {
    const { call } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    const text = await result;
    expect(text).toBe(ASK_DEFERRED_RESULT);
    expect(text).toContain("best judgment");
    expect(text).toContain("state the assumption");
    expect(text).toContain("reversible");
    expect(text).toMatch(/Do NOT delete data, push, publish/);
    expect(text).toContain("Late answer to:");
  });

  it("keeps the question open after the deadline", async () => {
    const { bridge, call } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.deferredCount).toBe(1);
  });

  it("delivers a late answer exactly once", async () => {
    const { bridge, call, lastPrompt, onLateAnswer } = harness();
    const result = call("Use Postgres?");
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    const { id } = lastPrompt();
    expect(bridge.settle(id, { action: "answer", answers: { q: "No" } })).toBe(true);
    expect(bridge.settle(id, { action: "answer", answers: { q: "No" } })).toBe(false);
    expect(onLateAnswer).toHaveBeenCalledTimes(1);
    const late = onLateAnswer.mock.calls[0]?.[0];
    if (!late) throw new Error("no late answer");
    const text = formatLateAnswer(late);
    expect(text).toContain("Late answer to: Use Postgres?\n→ No");
    expect(bridge.deferredCount).toBe(0);
  });

  it("dismissing a deferred question delivers nothing", async () => {
    const { bridge, call, lastPrompt, onLateAnswer } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(bridge.settle(lastPrompt().id, { action: "cancel" })).toBe(true);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("answering before the deadline returns the answer and never defers", async () => {
    const { bridge, call, lastPrompt, onLateAnswer } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(10);
    bridge.settle(lastPrompt().id, { action: "answer", answers: { q: "Yes" } });
    await expect(result).resolves.toContain("The user answered");
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.deferredCount).toBe(0);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("a typed user message still supersedes a deferred question", async () => {
    const { bridge, call, lastPrompt, onLateAnswer, onClosed } = harness();
    const result = call();
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    const { id } = lastPrompt();
    // What POST /prompt does.
    bridge.cancelAll({ action: "cancel", superseded: true });
    expect(onClosed).toHaveBeenCalledWith([id]);
    expect(bridge.settle(id, { action: "answer", answers: { q: "Yes" } })).toBe(false);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("a newer question supersedes a deferred one", async () => {
    const { bridge, call, lastPrompt, onClosed } = harness();
    const first = call("First?");
    await vi.advanceTimersByTimeAsync(1001);
    await first;
    const firstId = lastPrompt().id;
    const second = call("Second?");
    expect(onClosed).toHaveBeenCalledWith([firstId]);
    expect(bridge.deferredCount).toBe(0);
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.settle(firstId, { action: "answer", answers: { q: "Yes" } })).toBe(false);
    bridge.settle(lastPrompt().id, { action: "answer", answers: { q: "Yes" } });
    await expect(second).resolves.toContain("Second?\n→ Yes");
  });

  it("reads the deadline per question, so unattended runs get the short one", async () => {
    let unattended = true;
    const { bridge, call } = harness(() => askSoftDeadlineMs(unattended));
    const auto = call();
    await vi.advanceTimersByTimeAsync(ASK_USER_UNATTENDED_DEADLINE_MS + 1);
    await expect(auto).resolves.toBe(ASK_DEFERRED_RESULT);

    unattended = false;
    const interactive = call();
    await vi.advanceTimersByTimeAsync(ASK_USER_UNATTENDED_DEADLINE_MS + 1);
    expect(bridge.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(ASK_USER_INTERACTIVE_DEADLINE_MS);
    await expect(interactive).resolves.toBe(ASK_DEFERRED_RESULT);
  });

  it("uses 2 minutes unattended and 10 minutes interactive", () => {
    expect(askSoftDeadlineMs(true)).toBe(2 * 60_000);
    expect(askSoftDeadlineMs(false)).toBe(10 * 60_000);
  });
});

describe("late answer delivery", () => {
  const late: LateAskAnswer = {
    prompt: { id: "ask-1", questions: [{ id: "q", question: "Ship it?", kind: "confirm" }] },
    answers: { q: "Yes" },
  };

  it("queues as steering while a run is live, without starting another", () => {
    const queueMessage = vi.fn<(text: string) => number>(() => 1);
    const startIdleRun = vi.fn();
    deliverLateAnswer(late, { queueMessage, isBusy: () => true, startIdleRun });
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(queueMessage.mock.calls[0]?.[0]).toContain("Late answer to: Ship it?\n→ Yes");
    expect(startIdleRun).not.toHaveBeenCalled();
  });

  it("queues and starts a run when the session is idle", () => {
    const queueMessage = vi.fn<(text: string) => number>(() => 1);
    const startIdleRun = vi.fn();
    deliverLateAnswer(late, { queueMessage, isBusy: () => false, startIdleRun });
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(startIdleRun).toHaveBeenCalledTimes(1);
  });

  it("end to end: a deferred question answered later is delivered once", async () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn<(text: string) => number>(() => 1);
      const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
      const bridge = createAskUserBridge({
        broadcast,
        timeoutMs: 1000,
        onLateAnswer: (l) =>
          deliverLateAnswer(l, { queueMessage, isBusy: () => true, startIdleRun: () => {} }),
      });
      const parked = bridge.park({
        questions: [{ id: "q", question: "Ship it?", kind: "confirm" }],
      });
      await vi.advanceTimersByTimeAsync(1001);
      await expect(parked).resolves.toEqual({ action: "deferred" });
      const id = broadcast.mock.calls[0]?.[0].id ?? "";
      bridge.settle(id, { action: "answer", answers: { q: "Yes" } });
      bridge.settle(id, { action: "answer", answers: { q: "Yes" } });
      expect(queueMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
