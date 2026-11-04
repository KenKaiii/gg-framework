/**
 * Completion gate for desktop plan mode.
 *
 * A run that stops while still in plan mode, without calling exit_plan, leaves
 * nothing for anyone to review: no approval box, and autopilot Ken can only
 * report that the coder is "still drafting". This happens when the agent writes
 * the plan into chat instead of submitting it, or when exit_plan rejects the
 * plan (e.g. no numbered `## Steps`) and the agent stops instead of fixing it.
 *
 * When the run is about to stop in that state, the session injects one hidden
 * reminder so the agent submits in the same run. One per run: a rejected
 * exit_plan already returns its own fix-it error mid-run, so a model that
 * still stops after the reminder won't be talked round by a second one.
 */
export const MAX_PLAN_SUBMISSION_NUDGES = 1;

export const PLAN_SUBMISSION_NUDGE =
  "You are still in plan mode and haven't submitted a plan, so nobody can review it. " +
  "Write the plan to .gg/plans/<name>.md (a '## Steps' heading followed by a numbered list) " +
  "and call exit_plan with that path now. If exit_plan rejected the plan, fix what it named " +
  "and call it again. If you can't finish the plan without the user's input, ask with " +
  "ask_user instead of ending your turn.";

export interface PlanSubmissionGateInput {
  /** The host opted in (desktop sidecar; not the CLI or ACP, where the user
   *  drives plan mode directly). */
  enabled: boolean;
  /** The session is still in plan mode as the run is about to stop. */
  planMode: boolean;
  /** The run was cancelled. */
  aborted: boolean;
  /** Reminders already injected this run. */
  nudgesThisRun: number;
}

export function shouldNudgePlanSubmission(input: Readonly<PlanSubmissionGateInput>): boolean {
  return (
    input.enabled &&
    input.planMode &&
    !input.aborted &&
    input.nudgesThisRun < MAX_PLAN_SUBMISSION_NUDGES
  );
}
