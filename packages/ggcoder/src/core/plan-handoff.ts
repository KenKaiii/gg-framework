/**
 * When to hand a submitted plan to the human (the Accept / Feedback / Reject
 * box).
 *
 * The box must open only once nothing else will act on the plan: the run that
 * submitted it has fully settled (an Accept during the run's tail is refused
 * with 409), no new run is starting, and no autopilot cycle (Ken) is still
 * deciding. Every way Ken can stop without approving — handing the plan back,
 * a failed review, the round cap, a Stop, a skipped cycle — leaves the plan
 * pending, so this one check covers them all. Offers are once per plan
 * generation so repeated settle points don't re-open a box the user just
 * closed.
 */
export interface PendingPlanOfferInput {
  /** Path of the plan waiting for a decision, or null when none is. */
  planPath: string | null;
  /** Plan generation of the pending plan (bumps on every submit/clear). */
  generation: number;
  /** Generation last offered to the human; -1 when none has been. */
  offeredGeneration: number;
  /** A build run is in flight. */
  running: boolean;
  /** A run has been claimed and is about to start. */
  starting: boolean;
  /** An autopilot cycle (Ken review / injected run) is still active. */
  autopilotActive: boolean;
  /** Messages waiting to drain as the next turn; they supersede the plan. */
  queued: number;
}

export function shouldOfferPendingPlan(input: Readonly<PendingPlanOfferInput>): boolean {
  if (input.planPath === null) return false;
  if (input.generation === input.offeredGeneration) return false;
  if (input.running || input.starting || input.autopilotActive) return false;
  return input.queued === 0;
}
