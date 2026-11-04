/**
 * Plan-step compaction policy (port of NVlabs/SoL-Pi commit 4101906, as
 * re-implemented in bench/baseline/32-plan-step-compaction.mjs arm B).
 *
 * Checked at turn end after a plan step is newly completed. Compacting turns a
 * big cached prefix into a small summary: every later request re-reads less
 * (saving), but the new prefix must be re-written to cache once at r× the read
 * price. Compact iff that write cost is repaid within the expected number of
 * remaining requests (horizon). Pure — the session owns the bookkeeping.
 */

/** SoL-Pi default cache write/read price ratio. GPT-6.1 Sol's real ratio is 25. */
export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;
/** Recent tail kept verbatim by compaction (SoL-Pi keep budget). */
export const PLAN_STEP_KEEP_TOKENS = 20_000;
/** Approximate size of the summary that replaces the archive. */
export const PLAN_STEP_SUMMARY_TOKENS = 1_000;
/** Within this many tokens of the window, leave it to the size trigger. */
export const PLAN_STEP_WINDOW_GUARD = 16_384;

export interface PlanStepCompactionInput {
  /** Current context size in tokens. */
  contextTokens: number;
  /** Tokens of the recent tail compaction keeps verbatim. */
  keptTailTokens: number;
  contextWindow: number;
  /** Cache write price / cache read price. */
  cacheWriteReadRatio: number;
  stepsCompleted: number;
  stepsRemaining: number;
  /** Requests spent inside completed steps (for mean requests-per-step). */
  requestsInCompletedSteps: number;
  /** All requests so far (for mean context growth per request). */
  requests: number;
  /** Context tokens grown across `requests`. */
  grownTokens: number;
  /** Successful compactions so far this session. */
  priorCompactions: number;
  /** Unpaid cache-write cost (cache-read token units) from earlier compactions. */
  writeCostBalance: number;
  /** Requests since the last compaction (undefined when none yet). */
  requestsSinceLastCompaction?: number;
}

export interface PlanStepCompactionDecision {
  compact: boolean;
  reason: string;
}

export function decidePlanStepCompaction(
  input: PlanStepCompactionInput,
): PlanStepCompactionDecision {
  const ctx = input.contextTokens;
  if (input.stepsRemaining <= 0) return { compact: false, reason: "plan-finished" };
  if (ctx >= input.contextWindow - PLAN_STEP_WINDOW_GUARD) {
    return { compact: false, reason: "near-window: defer to size trigger" };
  }
  if (input.priorCompactions > 0 && (input.requestsSinceLastCompaction ?? 1) < 1) {
    return { compact: false, reason: "back-to-back" };
  }
  const r = Math.max(1, input.cacheWriteReadRatio);
  const archive = Math.max(0, ctx - input.keptTailTokens);
  const saving = archive - PLAN_STEP_SUMMARY_TOKENS;
  if (saving <= 0) return { compact: false, reason: "no-saving" };
  const post = ctx - saving;
  const breakeven = (post * (r - 1)) / saving;
  const done = input.stepsCompleted;
  const meanReq = done > 0 ? input.requestsInCompletedSteps / done : 0;
  let horizon = 1 + Math.floor(meanReq * input.stepsRemaining);
  const growth = input.requests > 0 ? input.grownTokens / input.requests : 0;
  if (growth > 0) {
    horizon = Math.min(horizon, Math.floor((input.contextWindow - ctx) / growth));
  }
  if (input.priorCompactions === 0) {
    horizon *= 2;
    return {
      compact: breakeven <= horizon,
      reason: `first be=${breakeven.toFixed(1)} h=${horizon}`,
    };
  }
  // Later compactions: stricter margin, and earlier write cost must be repaid.
  const debtCovered = input.writeCostBalance <= 0;
  return {
    compact: breakeven * 1.5 <= horizon && debtCovered,
    reason: `be=${breakeven.toFixed(1)} h=${horizon} debt=${Math.round(input.writeCostBalance)}`,
  };
}
