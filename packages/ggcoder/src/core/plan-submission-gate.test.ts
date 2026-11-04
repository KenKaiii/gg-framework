import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_SUBMISSION_NUDGES,
  shouldNudgePlanSubmission,
  type PlanSubmissionGateInput,
} from "./plan-submission-gate.js";

const stoppingInPlanMode: PlanSubmissionGateInput = {
  enabled: true,
  planMode: true,
  aborted: false,
  nudgesThisRun: 0,
};

describe("shouldNudgePlanSubmission", () => {
  it("reminds a run that is about to stop in plan mode with nothing submitted", () => {
    expect(shouldNudgePlanSubmission(stoppingInPlanMode)).toBe(true);
  });

  it.each<[string, Partial<PlanSubmissionGateInput>]>([
    ["the host didn't opt in (CLI / ACP)", { enabled: false }],
    ["the plan was submitted (plan mode already left)", { planMode: false }],
    ["the run was cancelled", { aborted: true }],
    ["the reminder was already spent this run", { nudgesThisRun: MAX_PLAN_SUBMISSION_NUDGES }],
  ])("stays quiet when %s", (_label, change) => {
    expect(shouldNudgePlanSubmission({ ...stoppingInPlanMode, ...change })).toBe(false);
  });
});
