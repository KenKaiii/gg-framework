export type PhaseCancellationPersistenceFailureCode =
  | "phase-not-found"
  | "phase-archived"
  | "stale-session"
  | "missing"
  | "corrupt"
  | "storage-failure"
  | "not-recorded";

export interface PhaseCancellationPersistenceFailedPayload {
  operationId: string;
  phaseId: string;
  code: PhaseCancellationPersistenceFailureCode;
  recovery: string;
  detail?: string;
}

export interface PhaseCancellationPersistenceRecoveredPayload {
  operationId: string;
  phaseId: string;
  outcome: "committed" | "same-status" | "manual-override" | "done-terminal";
  roadmapStatusSaved: boolean;
}

interface UnknownEvent {
  type: string;
  data: unknown;
}

const FAILURE_CODES = new Set<PhaseCancellationPersistenceFailureCode>([
  "phase-not-found",
  "phase-archived",
  "stale-session",
  "missing",
  "corrupt",
  "storage-failure",
  "not-recorded",
]);

const RECOVERED_OUTCOMES = new Set<PhaseCancellationPersistenceRecoveredPayload["outcome"]>([
  "committed",
  "same-status",
  "manual-override",
  "done-terminal",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPhaseCancellationPersistenceFailedEvent(event: UnknownEvent): event is {
  type: "phase_cancellation_persistence_failed";
  data: PhaseCancellationPersistenceFailedPayload;
} {
  if (event.type !== "phase_cancellation_persistence_failed") return false;
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Record<string, unknown>;
  return (
    isNonEmptyString(data.operationId) &&
    isNonEmptyString(data.phaseId) &&
    FAILURE_CODES.has(data.code as PhaseCancellationPersistenceFailureCode) &&
    isNonEmptyString(data.recovery) &&
    (data.detail === undefined || typeof data.detail === "string")
  );
}

export function isPhaseCancellationPersistenceRecoveredEvent(event: UnknownEvent): event is {
  type: "phase_cancellation_persistence_recovered";
  data: PhaseCancellationPersistenceRecoveredPayload;
} {
  if (event.type !== "phase_cancellation_persistence_recovered") return false;
  if (typeof event.data !== "object" || event.data === null) return false;
  const data = event.data as Record<string, unknown>;
  return (
    isNonEmptyString(data.operationId) &&
    isNonEmptyString(data.phaseId) &&
    RECOVERED_OUTCOMES.has(
      data.outcome as PhaseCancellationPersistenceRecoveredPayload["outcome"],
    ) &&
    typeof data.roadmapStatusSaved === "boolean"
  );
}
