import type { ReactElement } from "react";
import type {
  NotesCompletionUnmetGateCode,
  NotesImplementationRunOutcome,
  NotesPhase,
  NotesRoadmapActor,
  NotesRoadmapCompletionReview,
  NotesRoadmapEvent,
  NotesRoadmapImplementationCheckpoint,
  NotesRoadmapReviewer,
  NotesRoadmapStatusUpdate,
  NotesVerificationStatus,
} from "./notes-types";

const ROADMAP_ACTOR_LABELS = {
  "gg-coder": "GG Coder",
  ken: "Ken",
  "ken-autopilot": "Autopilot Ken",
} as const satisfies Record<NotesRoadmapActor, string>;

const ROADMAP_REVIEWER_LABELS = {
  ken: "Ken",
  "ken-autopilot": "Autopilot Ken",
} as const satisfies Record<NotesRoadmapReviewer, string>;

const VERIFICATION_LABELS = {
  passed: "Passed",
  failed: "Failed",
  "exception-requested": "Exception requested",
} as const satisfies Record<NotesVerificationStatus, string>;

const IMPLEMENTATION_OUTCOME_LABELS = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
} as const satisfies Record<NotesImplementationRunOutcome, string>;

const COMPLETION_GATE_RECOVERY = {
  "missing-implementation": "Implementation evidence has not been recorded.",
  "stale-session": "Completion evidence belongs to a different phase session.",
  "run-not-successful": "The implementation run did not settle successfully.",
  "incomplete-plan":
    "The implementation checkpoint used by this final review does not complete every canonical plan step.",
  "missing-verification": "Typed verification evidence has not been recorded.",
  "failed-verification": "The verification used by this final review failed.",
  "verification-exception-not-accepted":
    "The verification exception still needs reviewer acceptance.",
  "unresolved-approval": "Plan approval is still unresolved.",
  "unresolved-attention": "A question or error still needs attention.",
  "inactive-phase": "The phase is not active for automatic completion.",
} as const satisfies Record<NotesCompletionUnmetGateCode, string>;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function NotesPhaseCompletionGates({ phase }: { phase: NotesPhase }): ReactElement {
  const latestImplementation = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const latestVerification = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.verification !== null,
  );
  const latestCompletionReview = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapCompletionReview => event.type === "completion-review",
  );
  const displayedImplementation = latestCompletionReview
    ? (phase.roadmapEvents.find(
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint" &&
          event.id === latestCompletionReview.implementationCheckpointId,
      ) ?? null)
    : latestImplementation;
  const displayedVerification = latestCompletionReview
    ? (phase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" &&
          event.id === latestCompletionReview.verificationStatusUpdateId,
      ) ?? null)
    : latestVerification;
  const latestCompletionReviewIndex = latestCompletionReview
    ? phase.roadmapEvents.lastIndexOf(latestCompletionReview)
    : -1;
  const newerImplementation = latestCompletionReview
    ? latestRoadmapEventAfter(
        phase,
        latestCompletionReviewIndex,
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint",
      )
    : null;
  const newerVerification = latestCompletionReview
    ? latestRoadmapEventAfter(
        phase,
        latestCompletionReviewIndex,
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.verification !== null,
      )
    : null;
  const acceptedVerificationException =
    displayedVerification?.verification === "exception-requested" &&
    latestCompletionReview?.acceptsVerificationException &&
    latestCompletionReview.verificationStatusUpdateId === displayedVerification.id
      ? latestCompletionReview
      : null;

  return (
    <section
      className="notes-completion-gates"
      aria-labelledby={`notes-completion-gates-${phase.id}`}
    >
      <h4 id={`notes-completion-gates-${phase.id}`}>Completion gates</h4>
      <dl>
        <div>
          <dt>Implementation</dt>
          <dd>
            {latestCompletionReview && <span>Evidence used by this final review.</span>}
            {displayedImplementation ? (
              <>
                <strong>
                  {displayedImplementation.completedPlanSteps.length} of{" "}
                  {displayedImplementation.planStepTotal} plan steps
                </strong>
                <span>
                  Run {implementationOutcomeLabel(displayedImplementation.runOutcome)} by the bound
                  session.
                </span>
                <time dateTime={displayedImplementation.timestamp}>
                  {formatDateTime(displayedImplementation.timestamp)}
                </time>
              </>
            ) : (
              <span>
                {latestCompletionReview
                  ? "This final review did not reference implementation evidence."
                  : "Completion evidence has not been recorded."}
              </span>
            )}
            {newerImplementation && (
              <div className="notes-completion-unreviewed">
                <strong>Newer unreviewed evidence</strong>
                <span>
                  {newerImplementation.completedPlanSteps.length} of{" "}
                  {newerImplementation.planStepTotal} plan steps; run{" "}
                  {implementationOutcomeLabel(newerImplementation.runOutcome)} at{" "}
                  <time dateTime={newerImplementation.timestamp}>
                    {formatDateTime(newerImplementation.timestamp)}
                  </time>
                  . This was not part of the final review.
                </span>
              </div>
            )}
          </dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {latestCompletionReview && <span>Evidence used by this final review.</span>}
            {displayedVerification?.verification ? (
              <>
                <strong>{verificationLabel(displayedVerification.verification)}</strong>
                <span>
                  Reported by {roadmapActorLabel(displayedVerification.actor)} at{" "}
                  <time dateTime={displayedVerification.timestamp}>
                    {formatDateTime(displayedVerification.timestamp)}
                  </time>
                  .
                </span>
                {displayedVerification.verificationReason && (
                  <span>{displayedVerification.verificationReason}</span>
                )}
                {displayedVerification.evidence.length > 0 && (
                  <ul>
                    {displayedVerification.evidence.map((item, index) => (
                      <li key={`${displayedVerification.id}-evidence-${index}`}>{item}</li>
                    ))}
                  </ul>
                )}
                {acceptedVerificationException && (
                  <span>
                    Exception accepted by{" "}
                    {roadmapReviewerLabel(acceptedVerificationException.reviewer)} at{" "}
                    <time dateTime={acceptedVerificationException.timestamp}>
                      {formatDateTime(acceptedVerificationException.timestamp)}
                    </time>
                    .
                  </span>
                )}
              </>
            ) : (
              <span>
                {latestCompletionReview
                  ? "This final review did not reference typed verification."
                  : "Typed verification has not been recorded."}
              </span>
            )}
            {newerVerification?.verification && (
              <div className="notes-completion-unreviewed">
                <strong>Newer unreviewed evidence</strong>
                <span>
                  {verificationLabel(newerVerification.verification)} reported by{" "}
                  {roadmapActorLabel(newerVerification.actor)} at{" "}
                  <time dateTime={newerVerification.timestamp}>
                    {formatDateTime(newerVerification.timestamp)}
                  </time>
                  . This was not part of the final review.
                </span>
                {newerVerification.verificationReason && (
                  <span>{newerVerification.verificationReason}</span>
                )}
                {newerVerification.evidence.length > 0 && (
                  <ul>
                    {newerVerification.evidence.map((item, index) => (
                      <li key={`${newerVerification.id}-evidence-${index}`}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </dd>
        </div>
        <div>
          <dt>Final review</dt>
          <dd>
            {latestCompletionReview?.type === "completion-review" ? (
              <>
                <strong>
                  {latestCompletionReview.decision === "accepted" ? "Accepted" : "Rejected"} by{" "}
                  {roadmapReviewerLabel(latestCompletionReview.reviewer)}
                </strong>
                <time dateTime={latestCompletionReview.timestamp}>
                  {formatDateTime(latestCompletionReview.timestamp)}
                </time>
                {latestCompletionReview.reason && <span>{latestCompletionReview.reason}</span>}
                {latestCompletionReview.unmetGateCodes.length > 0 && (
                  <ul>
                    {latestCompletionReview.unmetGateCodes.map((code) => (
                      <li key={code}>{completionGateRecovery(code)}</li>
                    ))}
                  </ul>
                )}
                {latestCompletionReview.gateOutcome === "manual-override" && (
                  <span>
                    The review is recorded, but the user status override remains authoritative.
                  </span>
                )}
                {latestCompletionReview.gateOutcome === "done" && phase.archivedAt === null && (
                  <span>Done is complete. Archiving remains a separate action.</span>
                )}
              </>
            ) : (
              <span>Final review has not been recorded.</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function roadmapActorLabel(actor: NotesRoadmapActor): string {
  return ROADMAP_ACTOR_LABELS[actor];
}

function roadmapReviewerLabel(reviewer: NotesRoadmapReviewer): string {
  return ROADMAP_REVIEWER_LABELS[reviewer];
}

function verificationLabel(verification: NotesVerificationStatus): string {
  return VERIFICATION_LABELS[verification];
}

function implementationOutcomeLabel(outcome: NotesImplementationRunOutcome): string {
  return IMPLEMENTATION_OUTCOME_LABELS[outcome];
}

function completionGateRecovery(code: NotesCompletionUnmetGateCode): string {
  return COMPLETION_GATE_RECOVERY[code];
}

function latestRoadmapEvent<T extends NotesRoadmapEvent>(
  phase: NotesPhase,
  predicate: (event: NotesRoadmapEvent) => event is T,
): T | null {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event && predicate(event)) return event;
  }
  return null;
}

function latestRoadmapEventAfter<T extends NotesRoadmapEvent>(
  phase: NotesPhase,
  startIndex: number,
  predicate: (event: NotesRoadmapEvent) => event is T,
): T | null {
  for (let index = phase.roadmapEvents.length - 1; index > startIndex; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event && predicate(event)) return event;
  }
  return null;
}

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}
