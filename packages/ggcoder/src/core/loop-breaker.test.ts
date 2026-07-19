import { describe, expect, it } from "vitest";
import {
  buildLoopBreakMessage,
  CycleDetector,
  detectTextRepetition,
  evaluateLoopBreak,
  LOOP_BREAK_FINAL_PROMPT,
  LOOP_BREAK_PROMPT,
  ToolCallProgressTracker,
  toolCallSignature,
} from "./loop-breaker.js";

describe("toolCallSignature", () => {
  it("is stable regardless of key order in args", () => {
    const a = toolCallSignature("edit", { file_path: "a.ts", old: "x", new: "y" });
    const b = toolCallSignature("edit", { new: "y", old: "x", file_path: "a.ts" });
    expect(a).toBe(b);
  });

  it("differs when the tool name differs", () => {
    expect(toolCallSignature("read", { file_path: "a.ts" })).not.toBe(
      toolCallSignature("write", { file_path: "a.ts" }),
    );
  });

  it("differs when args differ", () => {
    expect(toolCallSignature("read", { file_path: "a.ts" })).not.toBe(
      toolCallSignature("read", { file_path: "b.ts" }),
    );
  });

  it("handles non-object args without throwing", () => {
    expect(() => toolCallSignature("bash", "ls -la")).not.toThrow();
    expect(toolCallSignature("bash", "ls")).toBe(toolCallSignature("bash", "ls"));
  });
});

describe("detectTextRepetition", () => {
  it("returns false for ordinary varied prose", () => {
    const text =
      "I read the config file, then updated the handler, ran the tests, and verified the output looks correct now.";
    expect(detectTextRepetition(text)).toBe(false);
  });

  it("detects a long block repeated consecutively at the tail", () => {
    const block = "ERROR: could not resolve module './missing'\n";
    expect(detectTextRepetition(block.repeat(6))).toBe(true);
  });

  it("does not trip on a block repeated only twice", () => {
    const block = "Let me try a slightly different approach here.\n";
    expect(detectTextRepetition(block.repeat(2))).toBe(false);
  });

  it("ignores short empty input", () => {
    expect(detectTextRepetition("")).toBe(false);
    expect(detectTextRepetition("ok")).toBe(false);
  });
});

describe("ToolCallProgressTracker", () => {
  it("counts only consecutive identical calls with unchanged results", () => {
    const tracker = new ToolCallProgressTracker();
    expect(tracker.record("read", { file_path: "a.ts" }, "one", false)).toBe(1);
    expect(tracker.record("read", { file_path: "a.ts" }, "one", false)).toBe(2);
    expect(tracker.record("read", { file_path: "a.ts" }, "two", false)).toBe(1);
    expect(tracker.record("read", { file_path: "b.ts" }, "two", false)).toBe(1);
  });

  it("treats successful iterative edits to one file as progress", () => {
    const tracker = new ToolCallProgressTracker();
    for (let i = 0; i < 6; i++) {
      expect(
        tracker.record(
          "edit",
          { file_path: "a.ts", old_text: `before-${i}`, new_text: `after-${i}` },
          `diff-${i}`,
          false,
        ),
      ).toBe(1);
    }
  });

  it("does not count background polling as a stuck loop", () => {
    const tracker = new ToolCallProgressTracker();
    for (let i = 0; i < 5; i++) {
      expect(tracker.record("task_output", { id: "job-1" }, "still running", false)).toBe(0);
    }
  });

  it("does not count passive sleep commands as a stuck loop", () => {
    const tracker = new ToolCallProgressTracker();
    for (let i = 0; i < 3; i++) {
      expect(tracker.record("bash", { command: "sleep 30" }, "", false)).toBe(0);
    }
  });
});

describe("CycleDetector", () => {
  /** Drive an A/B/… cycle where every signature always returns the same result. */
  const runCycle = (
    detector: CycleDetector,
    unit: Array<{ name: string; args: unknown; result: string }>,
    rounds: number,
  ) => {
    let last: ReturnType<CycleDetector["record"]> = null;
    for (let round = 0; round < rounds; round++) {
      for (const call of unit) {
        last = detector.record(call.name, call.args, call.result, false);
      }
    }
    return last;
  };

  it("detects an alternating A/B cycle (length 2) within 15 calls", () => {
    const detector = new CycleDetector();
    const unit = [
      { name: "read", args: { file_path: "a.ts" }, result: "aaa" },
      { name: "read", args: { file_path: "b.ts" }, result: "bbb" },
    ];
    // 5 full cycles = 10 calls — must be detected by then.
    const detection = runCycle(detector, unit, 5);
    expect(detection).toEqual({ length: 2, repeats: 5 });
  });

  it("detects a length-3 cycle", () => {
    const detector = new CycleDetector();
    const unit = [
      { name: "read", args: { file_path: "a.ts" }, result: "aaa" },
      { name: "grep", args: { pattern: "x" }, result: "none" },
      { name: "ls", args: { path: "." }, result: "files" },
    ];
    expect(runCycle(detector, unit, 5)).toEqual({ length: 3, repeats: 5 });
  });

  it("detects a length-5 cycle", () => {
    const detector = new CycleDetector();
    const unit = [1, 2, 3, 4, 5].map((n) => ({
      name: "read",
      args: { file_path: `f${n}.ts` },
      result: `content-${n}`,
    }));
    expect(runCycle(detector, unit, 5)).toEqual({ length: 5, repeats: 5 });
  });

  it("detects a single-call repeat as a length-1 cycle", () => {
    const detector = new CycleDetector();
    let detection: ReturnType<CycleDetector["record"]> = null;
    for (let i = 0; i < 5; i++) {
      detection = detector.record("bash", { command: "npm test" }, "1 failing", true);
    }
    expect(detection).toEqual({ length: 1, repeats: 5 });
  });

  it("does NOT detect when the pattern is broken by a different call", () => {
    const detector = new CycleDetector();
    const a = { name: "read", args: { file_path: "a.ts" }, result: "aaa" };
    const b = { name: "read", args: { file_path: "b.ts" }, result: "bbb" };
    let detection: ReturnType<CycleDetector["record"]> = null;
    for (let round = 0; round < 5; round++) {
      detection = detector.record(a.name, a.args, a.result, false);
      expect(detection).toBeNull();
      detection = detector.record(b.name, b.args, b.result, false);
      if (round === 3) {
        // A fresh, different call breaks the streak before 5 full cycles.
        detection = detector.record("grep", { pattern: "unique" }, "hit", false);
      }
    }
    expect(detection).toBeNull();
  });

  it("does NOT detect when one signature's result keeps changing (progress)", () => {
    const detector = new CycleDetector();
    for (let i = 0; i < 8; i++) {
      expect(detector.record("read", { file_path: "a.ts" }, `version-${i}`, false)).toBeNull();
      expect(detector.record("read", { file_path: "b.ts" }, "stable", false)).toBeNull();
    }
  });

  it("ignores expected-repeat polling tools", () => {
    const detector = new CycleDetector();
    for (let i = 0; i < 12; i++) {
      expect(detector.record("task_output", { id: "job-1" }, "running", false)).toBeNull();
    }
  });

  it("reset() clears accumulated evidence", () => {
    const detector = new CycleDetector();
    const unit = [
      { name: "read", args: { file_path: "a.ts" }, result: "aaa" },
      { name: "read", args: { file_path: "b.ts" }, result: "bbb" },
    ];
    runCycle(detector, unit, 4);
    detector.reset();
    // One more full cycle after reset is NOT enough evidence again.
    expect(runCycle(detector, unit, 1)).toBeNull();
  });
});

describe("evaluateLoopBreak", () => {
  it("breaks on a detected cyclic pattern", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      repeatedNoProgressCalls: 0,
      textRepetitionDetected: false,
      cyclicPattern: { length: 2, repeats: 5 },
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("cycle of 2");
  });

  it("does not break on healthy progress", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 1,
      repeatedNoProgressCalls: 1,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(false);
    expect(decision.reasons).toHaveLength(0);
  });

  it("breaks after repeated consecutive tool failures", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 3,
      repeatedNoProgressCalls: 1,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("3 consecutive failed tool calls");
  });

  it("breaks when an identical call repeatedly returns the same result", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      repeatedNoProgressCalls: 3,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("same result");
  });

  it("does not treat successful same-file edits as a loop", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      repeatedNoProgressCalls: 1,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(false);
  });

  it("breaks when streaming text degenerates into repetition", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      repeatedNoProgressCalls: 1,
      textRepetitionDetected: true,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("repeated output");
  });
});

describe("buildLoopBreakMessage", () => {
  it("tells the model to stop, re-read the evidence, and question its assumption", () => {
    const message = buildLoopBreakMessage(["3 consecutive failed tool calls"]);
    expect(message.role).toBe("user");
    expect(message.content).toContain("Stuck?");
    expect(message.content).toContain("assumption");
    expect(message.content).toContain("3 consecutive failed tool calls");
  });

  it("permits escalating to the user as a last resort", () => {
    const message = buildLoopBreakMessage([]);
    expect(message.content).toContain("tell the user");
    expect(message.content).not.toContain("Triggered because");
  });

  it("does not instruct the model to narrate the note", () => {
    const message = buildLoopBreakMessage(["identical tool call repeated 3x"]);
    const content = message.content as string;
    expect(content).toContain("Triggered because");
    expect(content.toLowerCase()).toContain("do not mention this note");
  });

  it("stage 2 uses the harsher final stop-and-report prompt", () => {
    const first = buildLoopBreakMessage(["still looping"], false);
    const final = buildLoopBreakMessage(["still looping"], true);
    expect(first.content).toContain(LOOP_BREAK_PROMPT);
    expect(final.content).toContain(LOOP_BREAK_FINAL_PROMPT);
    expect(final.content).toContain("Do NOT attempt the action again");
    expect(final.content).toContain("what is blocking you");
    expect(final.content).not.toContain("Stuck?");
  });
});
