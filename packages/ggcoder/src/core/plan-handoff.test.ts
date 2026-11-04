import { describe, expect, it } from "vitest";
import { shouldOfferPendingPlan, type PendingPlanOfferInput } from "./plan-handoff.js";

const settled: PendingPlanOfferInput = {
  planPath: "/repo/.gg/plans/p.md",
  generation: 3,
  offeredGeneration: -1,
  running: false,
  starting: false,
  autopilotActive: false,
  queued: 0,
};

describe("shouldOfferPendingPlan", () => {
  it("offers a pending plan once everything has settled", () => {
    expect(shouldOfferPendingPlan(settled)).toBe(true);
  });

  it.each<[string, Partial<PendingPlanOfferInput>]>([
    ["no plan is pending", { planPath: null }],
    ["this plan was already offered", { offeredGeneration: 3 }],
    ["the submitting run is still finishing", { running: true }],
    ["a run is about to start", { starting: true }],
    ["Ken is still reviewing", { autopilotActive: true }],
    ["a queued message will supersede it", { queued: 1 }],
  ])("holds back when %s", (_label, change) => {
    expect(shouldOfferPendingPlan({ ...settled, ...change })).toBe(false);
  });

  it("offers a resubmitted plan again (new generation)", () => {
    expect(shouldOfferPendingPlan({ ...settled, generation: 5, offeredGeneration: 3 })).toBe(true);
  });
});
