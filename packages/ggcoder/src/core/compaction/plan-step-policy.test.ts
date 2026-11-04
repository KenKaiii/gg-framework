import { describe, expect, it } from "vitest";
import {
  decidePlanStepCompaction,
  PLAN_STEP_KEEP_TOKENS,
  type PlanStepCompactionInput,
} from "./plan-step-policy.js";

const base: PlanStepCompactionInput = {
  contextTokens: 120_000,
  keptTailTokens: PLAN_STEP_KEEP_TOKENS,
  contextWindow: 272_000,
  cacheWriteReadRatio: 12.5,
  stepsCompleted: 1,
  stepsRemaining: 7,
  requestsInCompletedSteps: 12,
  requests: 12,
  grownTokens: 12 * 5_000,
  priorCompactions: 0,
  writeCostBalance: 0,
};

describe("decidePlanStepCompaction", () => {
  const cases: Array<{
    name: string;
    input: Partial<PlanStepCompactionInput>;
    compact: boolean;
    reason: RegExp;
  }> = [
    { name: "early step with big archive → compact", input: {}, compact: true, reason: /^first/ },
    {
      name: "tiny saving → don't",
      input: { contextTokens: 20_500 },
      compact: false,
      reason: /no-saving/,
    },
    {
      name: "saving too small for the horizon → don't",
      input: { contextTokens: 25_000, stepsRemaining: 1, requestsInCompletedSteps: 1 },
      compact: false,
      reason: /^first/,
    },
    {
      name: "back-to-back → don't",
      input: { priorCompactions: 1, requestsSinceLastCompaction: 0 },
      compact: false,
      reason: /back-to-back/,
    },
    {
      name: "near window → defer to size trigger",
      input: { contextTokens: 260_000 },
      compact: false,
      reason: /defer to size trigger/,
    },
    {
      name: "later compaction with unpaid write cost → don't",
      input: { priorCompactions: 1, requestsSinceLastCompaction: 5, writeCostBalance: 50_000 },
      compact: false,
      reason: /debt=50000/,
    },
    {
      name: "later compaction once write cost is repaid → compact",
      input: { priorCompactions: 1, requestsSinceLastCompaction: 20, writeCostBalance: 0 },
      compact: true,
      reason: /^be=/,
    },
    {
      name: "plan finished → don't",
      input: { stepsRemaining: 0 },
      compact: false,
      reason: /plan-finished/,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const d = decidePlanStepCompaction({ ...base, ...c.input });
      expect(d.compact).toBe(c.compact);
      expect(d.reason).toMatch(c.reason);
    });
  }
});
