/**
 * Autopilot cycle — the review→prompt→review loop as pure orchestration logic.
 *
 * The sidecar wires the real dependencies (kenAuto session, runAgent, SSE
 * broadcast); this module owns the loop's control flow so every exit path is
 * unit-testable without booting the sidecar.
 *
 * Two branches share one loop:
 *  - PLAN branch (planPending): GG Coder submitted a plan via exit_plan. Ken
 *    reviews the PLAN itself — approve (auto-accept + implement, then the next
 *    round work-reviews the implementation), send revision feedback, or hand a
 *    genuine user-level decision to the human. Verdict mapping for plans:
 *    Only `all_clear` approves. `ignore` stops for a human instead of granting
 *    implicit permission to implement. Unparseable output also stops as HUMAN
 *    upstream (the verdict parser returns HUMAN for garbage).
 *  - WORK branch: the classic review of a finished turn (ALL_CLEAR / IGNORE /
 *    HUMAN / PROMPT), unchanged.
 *
 * A mid-cycle enter_plan WITHOUT exit_plan (isPlanMode() true, no pending
 * plan) still halts as HUMAN — Ken must never prompt into a read-only
 * plan-mode session.
 */
import { CORPUS_UNVERIFIED_REASON, type AutopilotVerdict } from "./autopilot-verdict.js";

/** Reason shown in the Ken bubble when the build session is still INSIDE plan
 *  mode (enter_plan without exit_plan) when the cycle checks in — there is no
 *  submitted plan to review and the session is read-only, so the loop halts
 *  and hands control to the user. */
export const AUTOPILOT_PLAN_DRAFTING_REASON =
  "GG Coder is still drafting a plan (plan mode is active with nothing submitted). Finish or cancel the plan yourself; autopilot can't prompt a read-only session.";

/** Injected when Autopilot finds the work unchecked before its review. */
export const AUTOPILOT_VERIFY_PROMPT =
  "Run the project's checks for your changes (see Verification), standalone and unpiped, " +
  "and fix any failures.";

/** Situational-awareness preamble prepended to EVERY build-session run that
 *  Autopilot Ken injects (fix prompts, plan-revision prompts, the post-approval
 *  "implement it now" run). GG Coder otherwise can't tell an autopilot-injected
 *  prompt from a human one — it lands as a plain user message — so it behaves as
 *  if someone is watching: it may stop to ask permission for safe, already-
 *  implied work (which only burns a review round, since no human is there) and
 *  it may end a turn on "should work" instead of proving it. This tells it the
 *  turn came from the automated reviewer, that no human is watching, so it must
 *  self-verify and only surface genuine user-level decisions. NEVER prepended to
 *  human-typed prompts — the sidecar applies it only at the autopilot cycle's
 *  injection sites. */
export const AUTOPILOT_INJECTION_PREAMBLE =
  "[Autopilot] This turn was triggered by Ken, GG Coder's automated reviewer — " +
  "not by a human, and no human is watching it land. So:\n" +
  "- Prove your work before finishing: run the tests/build or screenshot the UI. " +
  'Don\'t end on "should work" — nobody is here to catch a mistake, so verify it ' +
  "yourself.\n" +
  "- Don't stop to ask permission for work that's already implied by the original " +
  "request and safe to do. Just do it and keep going.\n" +
  "- Only surface a question when it needs a real human decision (a product/taste " +
  "call, a destructive or irreversible action, a missing secret or external " +
  "access). State it plainly and stop; Ken routes it to the user.\n\n" +
  "Your instruction:";

/** Prepend {@link AUTOPILOT_INJECTION_PREAMBLE} to a body destined for the build
 *  session during an autopilot cycle. Deterministic so the sidecar can compute
 *  the same framed string both when it runs the prompt AND when it records the
 *  match-string Ken's digest uses to label the message as injected. */
export function frameAutopilotInjection(body: string): string {
  return `${AUTOPILOT_INJECTION_PREAMBLE}\n\n${body}`;
}

/** Prompt injected into the build session when Ken rejects a plan with
 *  feedback. Mirrors the webview's manual "Feedback" wording in spirit: the
 *  plan was not approved, revise it, resubmit via exit_plan. */
export function buildPlanRevisionPrompt(feedback: string): string {
  return (
    `The plan was not approved. Feedback from Ken (automated reviewer):\n\n` +
    `${feedback}\n\n` +
    `Revise the plan based on this feedback, then call exit_plan again for review.`
  );
}

/** SSE frame types the cycle can emit (matched by the webview). */
export type AutopilotCycleEmit =
  | { type: "autopilot_done"; data: { reason?: string } }
  | { type: "autopilot_ignored"; data: Record<string, never> }
  | { type: "autopilot_human"; data: { reason: string } }
  | { type: "autopilot_capped"; data: { rounds: number } }
  | { type: "autopilot_plan_accepted"; data: Record<string, never> };

export interface AutopilotCycleDeps {
  /** Hard cap on review→prompt rounds per user turn (loop safety). The sidecar
   *  widens this by +2 when the cycle starts plan-pending (approve+implement
   *  and the post-implement review each consume a round). */
  maxRounds: number;
  /** True once /cancel fires — checked between every step. */
  isCancelled: () => boolean;
  /** Host evidence, independent of Ken's verdict and reminder budgets. */
  verificationProblem: () => string | null;
  /** Live plan-mode state of the BUILD session. */
  isPlanMode: () => boolean;
  /** True while a submitted plan (exit_plan) awaits a verdict. */
  planPending: () => boolean;
  /** Wipe the reviewer's history so each user turn starts cheap (within one
   *  cycle the review messages persist so Ken remembers what he asked). */
  resetReviewer: () => Promise<void>;
  /** Run one work review; resolves to the parsed verdict or null on failure
   *  (failure is already surfaced by the sidecar as autopilot_error). */
  review: () => Promise<AutopilotVerdict | null>;
  /** Run one PLAN review (plan digest, not work digest); null on failure OR
   *  when the review went stale (user acted mid-review) — both stop silently. */
  reviewPlan: () => Promise<AutopilotVerdict | null>;
  /** Auto-accept the pending plan (fresh session + approved-plan prompt).
   *  Resolves false when the plan generation went stale (a user Accept/Reject
   *  raced the review and won) — the cycle stops silently. */
  acceptPlan: (reason?: string) => Promise<boolean>;
  /** Run the "plan approved — implement it now" prompt on the fresh session. */
  runImplement: () => Promise<void>;
  /** Feed a PROMPT verdict's body to GG Coder as an injected run.
   *  `planRevision` marks a plan-feedback run: the host puts the session back
   *  in read-only plan mode first, so revising can't start editing code. */
  runPrompt: (body: string, opts?: { planRevision?: boolean }) => Promise<void>;
  /** Called BEFORE runPrompt: record the injected body (digest labeling) and
   *  broadcast the autopilot_prompted marker. */
  onInjected: (body: string, round: number) => void;
  /** Broadcast one of the cycle's terminal SSE frames. */
  emit: (event: AutopilotCycleEmit) => void;
}

/**
 * Drive one full autopilot cycle for a finished user turn. Every exit is
 * explicit:
 *  - cancelled                 → silent stop (the /cancel path already broadcast)
 *  - plan mode, no submission  → autopilot_human with the drafting reason
 *  - review failed (null)     → silent stop (autopilot_error already broadcast)
 *  - plan approve, stale accept→ silent stop (user's manual action won)
 *  - ALL_CLEAR                 → autopilot_done
 *  - IGNORE (work)             → autopilot_ignored (renders nothing)
 *  - HUMAN                     → autopilot_human
 *  - rounds exhausted          → autopilot_capped
 */
export async function driveAutopilotCycle(deps: AutopilotCycleDeps): Promise<void> {
  const stopIfUnverified = () => {
    const reason = deps.verificationProblem();
    if (!reason) return false;
    deps.emit({ type: "autopilot_human", data: { reason } });
    return true;
  };
  // Plain replies leave checks to the commit, so a turn often ends unchecked.
  // Autopilot has a real end, so it asks for the checks once before reviewing;
  // only work still unchecked after that goes back to the human.
  const ensureVerified = async (round: number): Promise<boolean> => {
    if (!deps.verificationProblem()) return true;
    // A pending plan is reviewed by Ken in plan mode, where checks cannot run;
    // its outcome (or the user) decides what happens to the unchecked work.
    if (deps.planPending()) {
      stopIfUnverified();
      return false;
    }
    deps.onInjected(AUTOPILOT_VERIFY_PROMPT, round);
    await deps.runPrompt(AUTOPILOT_VERIFY_PROMPT);
    return !deps.isCancelled() && !stopIfUnverified();
  };
  if (deps.isCancelled() || !(await ensureVerified(1))) return;
  await deps.resetReviewer();
  for (let round = 1; round <= deps.maxRounds; round++) {
    if (deps.isCancelled() || !(await ensureVerified(round))) return;
    if (deps.planPending()) {
      const verdict = await deps.reviewPlan();
      if (!verdict || deps.isCancelled() || stopIfUnverified()) return;
      if (verdict.kind === "human") {
        deps.emit({ type: "autopilot_human", data: { reason: verdict.reason } });
        return;
      }
      if (verdict.kind === "prompt") {
        // Rejection with feedback: inject a revision prompt. The sidecar's
        // acceptPlan-side state clears pendingPlanPath on injection; if the
        // run resubmits (exit_plan), planPending() is true again next round;
        // if not, the loop falls through to a normal work review of whatever
        // the run actually did.
        const body = buildPlanRevisionPrompt(verdict.body);
        deps.onInjected(body, round);
        await deps.runPrompt(body, { planRevision: true });
        continue;
      }
      // Only an explicit approval can authorize implementation of a plan.
      if (verdict.kind !== "all_clear") {
        deps.emit({
          type: "autopilot_human",
          data: {
            reason: "Ken did not explicitly approve the plan. Review it before implementation.",
          },
        });
        return;
      }
      const reason = verdict.evidenceLimitation ? CORPUS_UNVERIFIED_REASON : undefined;
      const ok = await deps.acceptPlan(reason);
      // Acceptance awaits session/plan setup. A cancellation during that await
      // must win before we dispatch any implementation, even if setup succeeded.
      if (!ok || deps.isCancelled()) return;
      await deps.runImplement();
      // Next round: normal work review of the implementation.
      continue;
    }
    // The gate blocks a still-in-plan-mode turn up front, so hitting this
    // means an injected run entered plan mode mid-cycle WITHOUT submitting a
    // plan: halt — Ken can't prompt a read-only session.
    if (deps.isPlanMode()) {
      deps.emit({ type: "autopilot_human", data: { reason: AUTOPILOT_PLAN_DRAFTING_REASON } });
      return;
    }
    const verdict = await deps.review();
    if (!verdict || deps.isCancelled() || stopIfUnverified()) return;
    if (verdict.kind === "all_clear") {
      deps.emit({
        type: "autopilot_done",
        data: verdict.evidenceLimitation ? { reason: CORPUS_UNVERIFIED_REASON } : {},
      });
      return;
    }
    if (verdict.kind === "ignore") {
      deps.emit({ type: "autopilot_ignored", data: {} });
      return;
    }
    if (verdict.kind === "human") {
      deps.emit({ type: "autopilot_human", data: { reason: verdict.reason } });
      return;
    }
    deps.onInjected(verdict.body, round);
    await deps.runPrompt(verdict.body);
    if (deps.isCancelled()) return;
  }
  deps.emit({ type: "autopilot_capped", data: { rounds: deps.maxRounds } });
}
