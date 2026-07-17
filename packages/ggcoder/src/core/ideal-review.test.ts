import { describe, expect, it } from "vitest";
import {
  buildIdealReviewMessage,
  buildReviewCoverageMessage,
  detectTestDrift,
  evaluateIdealReview,
  ReviewCoverageTracker,
  withReviewCoverageRequirements,
} from "./ideal-review.js";

describe("ReviewCoverageTracker", () => {
  it("counts only successful read callbacks after review starts", () => {
    const tracker = new ReviewCoverageTracker("/project");
    tracker.recordChanged("src/a.ts");
    tracker.recordRead("src/a.ts");
    tracker.start();
    expect(tracker.evidence()).toEqual({
      expected: ["src/a.ts"],
      covered: [],
      missing: ["src/a.ts"],
    });
    tracker.recordRead("/project/src/a.ts");
    expect(tracker.evidence().missing).toEqual([]);
  });

  it("expands expected coverage for review-time edits and deduplicates paths", () => {
    const tracker = new ReviewCoverageTracker("/project");
    tracker.recordChanged("src/a.ts");
    tracker.recordChanged("/project/src/a.ts");
    tracker.start();
    tracker.recordChanged("src/../src/b.ts");
    tracker.recordRead("src/a.ts");
    expect(tracker.evidence()).toEqual({
      expected: ["src/a.ts", "src/b.ts"],
      covered: ["src/a.ts"],
      missing: ["src/b.ts"],
    });
  });

  it("builds a deterministic fail-closed follow-up", () => {
    const message = buildReviewCoverageMessage(["src/a.ts", "src/b.ts"]);
    expect(message.content).toContain("model-authored claims do not count");
    expect(message.content).toContain("- src/a.ts\n- src/b.ts");
  });

  it("puts missing read evidence on the initial review prompt", () => {
    const message = withReviewCoverageRequirements(buildIdealReviewMessage(["120 changed lines"]), [
      "src/a.ts",
      "src/b.ts",
    ]);

    expect(message.content).toContain("Ideal?");
    expect(message.content).toContain("before finalizing");
    expect(message.content).toContain("- src/a.ts\n- src/b.ts");
  });
});

describe("evaluateIdealReview", () => {
  it("skips tiny text-only changes", () => {
    const decision = evaluateIdealReview({
      changedLines: 2,
      toolCalls: 2,
      toolFailures: 0,
      turns: 1,
      writeCalls: 0,
      editCalls: 1,
      bashCalls: 0,
    });

    expect(decision.shouldReview).toBe(false);
    expect(decision.score).toBeLessThan(4);
  });

  it("triggers for broad file mutation work before final response", () => {
    const decision = evaluateIdealReview({
      changedLines: 135,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reasons).toContain("135 changed lines");
    expect(decision.reasons).toContain("4 file mutation calls");
  });

  it("triggers for failed tool recovery even with smaller diffs", () => {
    const decision = evaluateIdealReview({
      changedLines: 42,
      toolCalls: 8,
      toolFailures: 1,
      turns: 2,
      writeCalls: 0,
      editCalls: 2,
      bashCalls: 1,
    });

    expect(decision.shouldReview).toBe(true);
  });
});

describe("buildIdealReviewMessage", () => {
  it("asks the model to review and fix before the final answer", () => {
    const message = buildIdealReviewMessage(["120 changed lines"]);

    expect(message.role).toBe("user");
    expect(message.content).toContain("Ideal?");
    expect(message.content).toContain("before the final response");
    expect(message.content).toContain("fix it now");
    expect(message.content).toContain("120 changed lines");
  });

  it("defers builds/typechecks/tests to commit time instead of running them now", () => {
    const message = buildIdealReviewMessage([]);

    expect(message.content).toContain("do NOT run builds, typechecks, linters, or test suites now");
    expect(message.content).toContain("/commit");
  });

  it("calls out drifted files and their stale tests", () => {
    const message = buildIdealReviewMessage([], ["src/foo.ts"]);

    expect(message.content).toContain("src/foo.ts");
    expect(message.content).toContain("matching test file was not updated");
  });
});

describe("detectTestDrift", () => {
  const cwd = "/proj";
  const exists = (files: string[]) => {
    const set = new Set(files);
    return (p: string) => set.has(p);
  };

  it("flags a changed source whose sibling test exists but was not touched", () => {
    const drift = detectTestDrift(["src/foo.ts"], cwd, exists(["/proj/src/foo.test.ts"]));
    expect(drift).toEqual(["src/foo.ts"]);
  });

  it("stays silent when the sibling test was updated in the same run", () => {
    const drift = detectTestDrift(
      ["src/foo.ts", "src/foo.test.ts"],
      cwd,
      exists(["/proj/src/foo.test.ts"]),
    );
    expect(drift).toEqual([]);
  });

  it("stays silent when no sibling test exists on disk", () => {
    const drift = detectTestDrift(["src/foo.ts"], cwd, exists([]));
    expect(drift).toEqual([]);
  });

  it("ignores test files that are themselves the change", () => {
    const drift = detectTestDrift(["src/foo.test.ts"], cwd, exists(["/proj/src/foo.test.ts"]));
    expect(drift).toEqual([]);
  });

  it("ignores non-code files", () => {
    const drift = detectTestDrift(["README.md"], cwd, exists(["/proj/README.test.md"]));
    expect(drift).toEqual([]);
  });

  it("matches .spec siblings and resolves absolute paths", () => {
    const drift = detectTestDrift(["/proj/src/bar.tsx"], cwd, exists(["/proj/src/bar.spec.tsx"]));
    expect(drift).toEqual(["/proj/src/bar.tsx"]);
  });

  it("matches a .test.ts sibling for a .tsx source (test drops the x)", () => {
    const drift = detectTestDrift(["src/Button.tsx"], cwd, exists(["/proj/src/Button.test.ts"]));
    expect(drift).toEqual(["src/Button.tsx"]);
  });
});
