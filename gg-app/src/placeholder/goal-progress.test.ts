import { describe, expect, it } from "vitest";
import {
  EMPTY_TALLY,
  ASK_QUESTION_MAX,
  blockingAsk,
  coordinatorAtWork,
  describeTally,
  workerPhase,
  tallyGoal,
  type WorkerPhase,
} from "./goal-progress";
import type { Item } from "../transcript-item";

const seen = (...phases: Array<[string, WorkerPhase]>) =>
  phases.map(([key, phase]) => ({ key, phase }));

describe("tallyGoal", () => {
  it("counts who's working now, and every task as it finishes or fails", () => {
    let tally = tallyGoal(EMPTY_TALLY, seen(["a", "working"], ["b", "working"], ["c", "working"]));
    expect([tally.working, tally.done, tally.failed]).toEqual([3, 0, 0]);
    tally = tallyGoal(tally, seen(["a", "done"], ["b", "working"], ["c", "failed"]));
    expect([tally.working, tally.done, tally.failed]).toEqual([1, 1, 1]);
    expect(describeTally(tally)).toBe("1 working · 1 done · 1 failed");
  });

  it("keeps a finished task counted when its worker takes a follow-up, and counts that one too", () => {
    let tally = tallyGoal(EMPTY_TALLY, seen(["a", "working"]));
    tally = tallyGoal(tally, seen(["a", "done"]));
    tally = tallyGoal(tally, seen(["a", "working"]));
    expect([tally.working, tally.done]).toEqual([1, 1]);
    tally = tallyGoal(tally, seen(["a", "done"]));
    expect([tally.working, tally.done]).toEqual([0, 2]);
  });

  it("counts workers already finished when first seen (a resumed window)", () => {
    const tally = tallyGoal(EMPTY_TALLY, seen(["a", "done"], ["b", "done"], ["c", "working"]));
    expect([tally.working, tally.done]).toEqual([1, 2]);
  });

  it("returns the same tally when nothing changed", () => {
    const tally = tallyGoal(EMPTY_TALLY, seen(["a", "working"]));
    expect(tallyGoal(tally, seen(["a", "working"]))).toBe(tally);
  });

  it("counts Kleio Goals as working only while it does hands-on work itself", () => {
    // Hybrid: Kleio Goals edits and runs commands itself; the header shouldn't
    // read "0 working" while it does.
    expect(coordinatorAtWork([{ name: "edit", status: "running" }])).toBe(true);
    expect(coordinatorAtWork([{ name: "bash", status: "running" }])).toBe(true);
    expect(coordinatorAtWork([{ name: "edit", status: "done" }])).toBe(false);
    expect(coordinatorAtWork([{ name: "wait_agent", status: "running" }])).toBe(false);
    expect(coordinatorAtWork([{ name: "read", status: "running" }])).toBe(false);
  });

  it("reads a floor worker's status: idle is a finished task, interrupted a failed one", () => {
    expect(workerPhase("running")).toBe("working");
    expect(workerPhase("idle")).toBe("done");
    expect(workerPhase("done")).toBe("done");
    expect(workerPhase("error")).toBe("failed");
    expect(workerPhase("interrupted")).toBe("failed");
  });
});

describe("blockingAsk", () => {
  const ask = (id: string, extra: Partial<Extract<Item, { kind: "ask" }>> = {}): Item => ({
    kind: "ask",
    id: 1,
    prompt: {
      id,
      questions: [
        { id: "q1", question: `Question ${id}?`, kind: "choice", options: [] },
        { id: "q2", question: "Second?", kind: "choice", options: [] },
      ],
    } as unknown as Extract<Item, { kind: "ask" }>["prompt"],
    ...extra,
  });

  it("finds the latest question Kleio Goals is still waiting on", () => {
    expect(blockingAsk([ask("old"), ask("new")])).toEqual({
      id: "new",
      question: "Question new?",
      more: 1,
    });
  });

  it("clips a long question at a word for the Workers view", () => {
    const long = ask("x");
    if (long.kind === "ask") {
      const [first] = long.prompt.questions;
      if (first) (first as { question: string }).question = `${"Should we ".repeat(30)}go?`;
    }
    const shown = blockingAsk([long])?.question ?? "";
    expect(shown.length).toBeLessThanOrEqual(ASK_QUESTION_MAX);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("ignores answered, cancelled and deferred questions (it isn't blocked on those)", () => {
    expect(
      blockingAsk([
        ask("a", { sent: true }),
        ask("b", { cancelled: true }),
        ask("c", { deferred: true }),
      ]),
    ).toBeNull();
  });
});
