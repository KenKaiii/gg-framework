import { describe, expect, it } from "vitest";
import {
  extractPlanSteps,
  rebasePlanSteps,
  segmentDisplayText,
  stepsDoneThrough,
  stripDoneMarkers,
  type PlanStep,
} from "./plan-steps.js";

const steps: PlanStep[] = [{ step: 6, text: "Ship the final response", completed: false }];

describe("extractPlanSteps", () => {
  it("returns no steps when the plan has no `## Steps` section", () => {
    // Numbered prose that is NOT a task list — design decisions, Q&A bullets,
    // rejected alternatives. None of these should be scraped as steps.
    const plan = [
      "# Reels Pipeline",
      "",
      "## Design Decisions",
      "1. All TypeScript / Node (no Python sidecar in v1).",
      "2. Ports & adapters (hexagonal).",
      "",
      "## Open Questions",
      "1. Source format(s):",
      "2. Caption styles:",
    ].join("\n");
    expect(extractPlanSteps(plan)).toEqual([]);
  });

  it("extracts only the numbered items under a `## Steps` section", () => {
    const plan = [
      "# Plan",
      "",
      "## Design Decisions",
      "1. Use hexagonal architecture.",
      "",
      "## Steps",
      "1. Add the FFmpeg renderer adapter.",
      "2. Wire the renderer into the CLI.",
      "3. **Add an integration test** for the render path.",
      "",
      "## Risks",
      "1. ONNX model download may be large.",
    ].join("\n");
    expect(extractPlanSteps(plan)).toEqual([
      { step: 1, text: "Add the FFmpeg renderer adapter.", completed: false },
      { step: 2, text: "Wire the renderer into the CLI.", completed: false },
      { step: 3, text: "Add an integration test", completed: false },
    ]);
  });

  it("recognises common step-section heading synonyms", () => {
    for (const heading of [
      "## Implementation Steps",
      "### Steps",
      "## Steps to implement",
      "## Tasks",
    ]) {
      const plan = [heading, "1. First real step here.", "2. Second real step here."].join("\n");
      expect(extractPlanSteps(plan)).toEqual([
        { step: 1, text: "First real step here.", completed: false },
        { step: 2, text: "Second real step here.", completed: false },
      ]);
    }
  });

  it("does not treat broad container or essay headings as a step section", () => {
    for (const heading of [
      // `## Plan` is a container heading that often holds non-task numbered
      // lists (design decisions, risks) — must NOT be scraped as steps.
      "## Plan",
      "## Step-by-step rationale for the design",
    ]) {
      const plan = [heading, "1. We chose X because Y."].join("\n");
      expect(extractPlanSteps(plan)).toEqual([]);
    }
  });

  it("renumbers steps sequentially and skips sub-items / snippets", () => {
    const plan = [
      "## Steps",
      "1. First real step here.",
      "   1. nested detail that should be ignored",
      "2. `code-only line`",
      "3. Second real step here.",
    ].join("\n");
    expect(extractPlanSteps(plan)).toEqual([
      { step: 1, text: "First real step here.", completed: false },
      { step: 2, text: "Second real step here.", completed: false },
    ]);
  });
});

describe("rebasePlanSteps", () => {
  // The agent can rewrite/expand the approved plan mid-implementation. The
  // progress widget must track the CURRENT plan, not the snapshot captured at
  // approval time, while preserving steps already marked done.
  it("adopts the new step list when the plan grows", () => {
    const frozen: PlanStep[] = [
      { step: 1, text: "Scaffold the helper module.", completed: true },
      { step: 2, text: "Wire it into the UI.", completed: false },
    ];
    const expanded: PlanStep[] = [
      { step: 1, text: "Scaffold the helper module.", completed: false },
      { step: 2, text: "Wire it into the UI.", completed: false },
      { step: 3, text: "Add the header chips.", completed: false },
      { step: 4, text: "Add the vital-signs line.", completed: false },
    ];
    const rebased = rebasePlanSteps(frozen, expanded);
    expect(rebased).toHaveLength(4);
    // Step 1 was already done — completion is preserved across the rebase.
    expect(rebased[0]?.completed).toBe(true);
    expect(rebased.filter((s) => s.completed)).toHaveLength(1);
    // New steps adopt the fresh text and start incomplete.
    expect(rebased[2]).toEqual({ step: 3, text: "Add the header chips.", completed: false });
  });

  it("preserves completion by step number, not text", () => {
    const frozen: PlanStep[] = [
      { step: 1, text: "Old wording for step one.", completed: true },
      { step: 2, text: "Old wording for step two.", completed: true },
    ];
    const rewritten: PlanStep[] = [
      { step: 1, text: "Reworded step one.", completed: false },
      { step: 2, text: "Reworded step two.", completed: false },
      { step: 3, text: "A brand new step three.", completed: false },
    ];
    const rebased = rebasePlanSteps(frozen, rewritten);
    expect(rebased[0]).toEqual({ step: 1, text: "Reworded step one.", completed: true });
    expect(rebased[1]).toEqual({ step: 2, text: "Reworded step two.", completed: true });
    expect(rebased[2]?.completed).toBe(false);
  });

  it("returns the previous array unchanged when the fresh plan has no steps", () => {
    const frozen: PlanStep[] = [{ step: 1, text: "Only step.", completed: true }];
    expect(rebasePlanSteps(frozen, [])).toBe(frozen);
  });

  it("returns the previous array reference when nothing changed", () => {
    const frozen: PlanStep[] = [
      { step: 1, text: "Step one.", completed: true },
      { step: 2, text: "Step two.", completed: false },
    ];
    const same: PlanStep[] = [
      { step: 1, text: "Step one.", completed: false },
      { step: 2, text: "Step two.", completed: false },
    ];
    // Same length, same text, same derived completion → identity preserved so
    // React state setters can no-op.
    expect(rebasePlanSteps(frozen, same)).toBe(frozen);
  });
});

describe("plan step display markers", () => {
  it("strips DONE markers even when adjacent to assistant text", () => {
    expect(stripDoneMarkers("[DONE:6]All set.")).toBe("All set.");
    expect(stripDoneMarkers("Finished [DONE:6]All set.")).toBe("Finished All set.");
  });

  it("segments adjacent DONE markers before following assistant text", () => {
    expect(segmentDisplayText("[DONE:6]All set.", steps)).toEqual([
      { kind: "done", stepNum: 6, description: "Ship the final response" },
      { kind: "text", text: "All set." },
    ]);
  });

  it("consumes backticks the model wrapped around a DONE marker", () => {
    expect(stripDoneMarkers("`[DONE:6]`")).toBe("");
    expect(stripDoneMarkers("Done `[DONE:6]` next")).toBe("Done next");
  });

  it("drops orphan-backtick fragments left by a wrapped DONE marker", () => {
    expect(segmentDisplayText("`[DONE:6]`\n\nStep 7 next", steps)).toEqual([
      { kind: "done", stepNum: 6, description: "Ship the final response" },
      { kind: "text", text: "\n\nStep 7 next" },
    ]);
  });
});

describe("stepsDoneThrough", () => {
  it("counts every step up to the highest marker, so skipped markers don't stall progress", () => {
    expect(stepsDoneThrough([2, 7, 9], 15)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("completes the plan when the last marker lands even if a middle one was skipped", () => {
    const all = Array.from({ length: 15 }, (_, i) => i + 1).filter((step) => step !== 8);
    expect(stepsDoneThrough(all, 15)).toHaveLength(15);
  });

  it("ignores markers beyond the plan's total and non-positive steps", () => {
    expect(stepsDoneThrough([0, -1, 99], 4)).toEqual([]);
    expect(stepsDoneThrough([3, 99], 4)).toEqual([1, 2, 3]);
  });
});
