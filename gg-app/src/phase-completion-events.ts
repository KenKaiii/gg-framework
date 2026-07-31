export interface PhaseCompletionSession {
  sessionId: string;
  sessionPath: string | null;
}

export type PhaseCompletionReconciliationKind =
  | "phase-start"
  | "status-update"
  | "implementation-checkpoint"
  | "completion-review";

export interface PhaseCompletionReconciliationOwner {
  operationId: string;
  kind: PhaseCompletionReconciliationKind;
}

export type PhaseCompletionCheckpointFailureCode =
  | "reconciliation-in-progress"
  | "duplicate-id-conflict"
  | "invalid-checkpoint"
  | "phase-not-found"
  | "phase-archived"
  | "stale-session"
  | "missing"
  | "corrupt"
  | "storage-failure";

export type PhaseCompletionReviewFailureCode =
  | "completion-checkpoint-blocked"
  | "reconciliation-in-progress"
  | "duplicate-id-conflict"
  | "invalid-review"
  | "phase-not-found"
  | "phase-archived"
  | "stale-session"
  | "missing"
  | "corrupt"
  | "storage-failure";

interface PhaseCompletionFailurePayload {
  phaseId: string;
  session: PhaseCompletionSession;
  recovery: string;
  owner?: PhaseCompletionReconciliationOwner | null;
  detail?: string;
}

export interface PhaseCompletionCheckpointFailedPayload extends PhaseCompletionFailurePayload {
  code: PhaseCompletionCheckpointFailureCode;
}

export interface PhaseCompletionReviewFailedPayload extends PhaseCompletionFailurePayload {
  code: PhaseCompletionReviewFailureCode;
}

export interface PhaseCompletionCheckpointFailedEvent {
  type: "phase_completion_checkpoint_failed";
  data: PhaseCompletionCheckpointFailedPayload;
}

export interface PhaseCompletionReviewFailedEvent {
  type: "phase_completion_review_failed";
  data: PhaseCompletionReviewFailedPayload;
}

export type PhaseCompletionBlockedGateOutcome =
  | "review"
  | "needs-attention"
  | "waiting-for-approval";

export type PhaseCompletionUnmetGateCode =
  | "missing-implementation"
  | "stale-session"
  | "run-not-successful"
  | "incomplete-plan"
  | "missing-verification"
  | "failed-verification"
  | "verification-exception-not-accepted"
  | "unresolved-approval"
  | "unresolved-attention"
  | "inactive-phase";

export interface PhaseCompletionReviewBlockedPayload {
  phaseId: string;
  session: PhaseCompletionSession;
  gateOutcome: PhaseCompletionBlockedGateOutcome;
  unmetGateCodes: PhaseCompletionUnmetGateCode[];
  recovery: string;
}

export interface PhaseCompletionReviewBlockedEvent {
  type: "phase_completion_review_blocked";
  data: PhaseCompletionReviewBlockedPayload;
}

const PHASE_COMPLETION_RECONCILIATION_KINDS = new Set<PhaseCompletionReconciliationKind>([
  "phase-start",
  "status-update",
  "implementation-checkpoint",
  "completion-review",
]);

const PHASE_COMPLETION_CHECKPOINT_FAILURE_CODES = new Set<PhaseCompletionCheckpointFailureCode>([
  "reconciliation-in-progress",
  "duplicate-id-conflict",
  "invalid-checkpoint",
  "phase-not-found",
  "phase-archived",
  "stale-session",
  "missing",
  "corrupt",
  "storage-failure",
]);

const PHASE_COMPLETION_REVIEW_FAILURE_CODES = new Set<PhaseCompletionReviewFailureCode>([
  "completion-checkpoint-blocked",
  "reconciliation-in-progress",
  "duplicate-id-conflict",
  "invalid-review",
  "phase-not-found",
  "phase-archived",
  "stale-session",
  "missing",
  "corrupt",
  "storage-failure",
]);

const PHASE_COMPLETION_BLOCKED_GATE_OUTCOMES = new Set<PhaseCompletionBlockedGateOutcome>([
  "review",
  "needs-attention",
  "waiting-for-approval",
]);

const PHASE_COMPLETION_UNMET_GATE_CODES = new Set<PhaseCompletionUnmetGateCode>([
  "missing-implementation",
  "stale-session",
  "run-not-successful",
  "incomplete-plan",
  "missing-verification",
  "failed-verification",
  "verification-exception-not-accepted",
  "unresolved-approval",
  "unresolved-attention",
  "inactive-phase",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPhaseCompletionSession(value: unknown): value is PhaseCompletionSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return (
    isNonEmptyString(session.sessionId) &&
    (typeof session.sessionPath === "string" || session.sessionPath === null)
  );
}

function isPhaseCompletionOwner(
  value: unknown,
): value is PhaseCompletionReconciliationOwner | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return (
    isNonEmptyString(owner.operationId) &&
    PHASE_COMPLETION_RECONCILIATION_KINDS.has(owner.kind as PhaseCompletionReconciliationKind)
  );
}

function isPhaseCompletionFailurePayload(
  value: unknown,
  codes: ReadonlySet<string>,
): value is PhaseCompletionFailurePayload & { code: string } {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    isNonEmptyString(data.phaseId) &&
    isPhaseCompletionSession(data.session) &&
    isNonEmptyString(data.recovery) &&
    isNonEmptyString(data.code) &&
    codes.has(data.code) &&
    isPhaseCompletionOwner(data.owner) &&
    (data.detail === undefined || typeof data.detail === "string")
  );
}

interface UnknownEvent {
  type: string;
  data: unknown;
}

export function isPhaseCompletionCheckpointFailedEvent(
  event: UnknownEvent,
): event is PhaseCompletionCheckpointFailedEvent {
  return (
    event.type === "phase_completion_checkpoint_failed" &&
    isPhaseCompletionFailurePayload(event.data, PHASE_COMPLETION_CHECKPOINT_FAILURE_CODES)
  );
}

export function isPhaseCompletionReviewFailedEvent(
  event: UnknownEvent,
): event is PhaseCompletionReviewFailedEvent {
  return (
    event.type === "phase_completion_review_failed" &&
    isPhaseCompletionFailurePayload(event.data, PHASE_COMPLETION_REVIEW_FAILURE_CODES)
  );
}

export function isPhaseCompletionReviewBlockedEvent(
  event: UnknownEvent,
): event is PhaseCompletionReviewBlockedEvent {
  if (event.type !== "phase_completion_review_blocked") return false;
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Record<string, unknown>;
  return (
    isNonEmptyString(data.phaseId) &&
    isPhaseCompletionSession(data.session) &&
    isNonEmptyString(data.recovery) &&
    PHASE_COMPLETION_BLOCKED_GATE_OUTCOMES.has(
      data.gateOutcome as PhaseCompletionBlockedGateOutcome,
    ) &&
    Array.isArray(data.unmetGateCodes) &&
    data.unmetGateCodes.length > 0 &&
    data.unmetGateCodes.every(
      (code) =>
        isNonEmptyString(code) &&
        PHASE_COMPLETION_UNMET_GATE_CODES.has(code as PhaseCompletionUnmetGateCode),
    )
  );
}
