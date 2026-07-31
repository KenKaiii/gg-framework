import {
  isNotesDocumentV3,
  isNullableNotesSessionLink,
  NOTES_REMINDER_NOTE_MAX_LENGTH,
  type NotesDocumentV3,
  type NotesPhase,
  type NotesPhaseStatus,
  type NotesReminder,
  type NotesReminderDeliveryChannel,
  type NotesReminderPermission,
  type NotesValidationError,
  type ProjectNotesCorruptReason,
  type ProjectNotesCorruption,
  type ProjectNotesLoadOutcome,
  type ProjectNotesMigrationOutcome,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
export {
  PHASE_START_FAILURE_CODES,
  PHASE_START_STATUSES,
  isPhaseStartFailureCode,
  isPhaseStartResult,
  isPhaseStartSession,
} from "@kenkaiiii/gg-core/phase-start-protocol";
export type {
  PhaseStartFailureCode,
  PhaseStartResult,
  PhaseStartSession,
  PhaseStartStatus,
} from "@kenkaiiii/gg-core/phase-start-protocol";
export {
  isNotesDocumentV2,
  isNotesDocumentV3,
  migrateNotesDocumentV2,
  migrateNotesDocumentV3PhaseShape,
  NOTES_REMINDER_NOTE_MAX_LENGTH,
  validateNotesDocumentV3,
} from "@kenkaiiii/gg-core/project-notes";
export type {
  NotesCompletionGateOutcome,
  NotesCompletionUnmetGateCode,
  NotesDocumentV2,
  NotesDocumentV3,
  NotesHandoff,
  NotesImplementationRunOutcome,
  NotesLifecycleEvent,
  NotesLifecycleEventKind,
  NotesLifecycleEventSource,
  NotesPendingAutomaticLifecycleTransition,
  NotesPhase,
  NotesPhaseOverrides,
  NotesPhaseStatus,
  NotesReference,
  NotesReferenceIdsOverride,
  NotesReferenceRange,
  NotesReminder,
  NotesReminderDelivery,
  NotesReminderDeliveryChannel,
  NotesReminderPermission,
  NotesRoadmapActor,
  NotesRoadmapCompletionReview,
  NotesRoadmapEvent,
  NotesRoadmapImplementationCheckpoint,
  NotesRoadmapOverrideReset,
  NotesRoadmapReferenceDecision,
  NotesRoadmapReferencePolicyOutcome,
  NotesRoadmapReferenceProposal,
  NotesRoadmapReviewer,
  NotesRoadmapStatusOutcome,
  NotesRoadmapStatusUpdate,
  NotesRoadmapTransition,
  NotesSessionLink,
  NotesStatusOverride,
  NotesTask,
  NotesTaskStatus,
  NotesValidationError,
  NotesValidationResult,
  NotesVerificationStatus,
  ProjectNotesCorruptReason,
  ProjectNotesCorruption,
  ProjectNotesMigrationOutcome,
  ProjectNotesSaveOutcome,
  ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";

export type PhaseLaunchErrorCode = "prompt-failed" | "launch-failed";

export interface PhaseLaunchErrorEvent {
  type: "phase_launch_error";
  data: {
    operationId: string;
    phaseId: string;
    code: PhaseLaunchErrorCode;
    message: string;
    detail?: string;
  };
}

export function isPhaseLaunchErrorEvent(event: {
  type: string;
  data: unknown;
}): event is PhaseLaunchErrorEvent {
  if (event.type !== "phase_launch_error" || typeof event.data !== "object" || !event.data) {
    return false;
  }
  const data = event.data as Record<string, unknown>;
  return (
    typeof data.operationId === "string" &&
    data.operationId.length > 0 &&
    typeof data.phaseId === "string" &&
    data.phaseId.length > 0 &&
    (data.code === "prompt-failed" || data.code === "launch-failed") &&
    typeof data.message === "string" &&
    data.message.length > 0 &&
    (data.detail === undefined || typeof data.detail === "string")
  );
}

export type NotesParseFailureReason = "malformed-json" | "unsupported-version" | "invalid-shape";

export type NotesParseResult =
  | {
      ok: true;
      document: NotesDocumentV3;
      migratedFromV2: boolean;
      migratedArchiveShape: boolean;
    }
  | { ok: false; reason: NotesParseFailureReason; error?: NotesValidationError };

export type NotesLoadSource = "v3" | "v2-migrated" | "legacy" | "empty" | "legacy-fallback";

export type NotesMigrationEligibility =
  | "valid-v3"
  | "valid-v2-migrated"
  | "valid-legacy"
  | "empty"
  | "ineligible-unreadable"
  | "ineligible-invalid-document";

export type NotesLoadDiagnostic =
  | { kind: "document-parse"; reason: NotesParseFailureReason; error?: NotesValidationError }
  | { kind: "storage-read"; key: string; error: unknown }
  | { kind: "storage-write"; key: string; error: unknown }
  | { kind: "ambiguous-legacy"; selectedKey: string; matchingKeys: string[] };

export interface NotesLoadResult {
  document: NotesDocumentV3;
  value: string;
  source: NotesLoadSource;
  legacyKey: string | null;
  v2ImportAttempted: boolean;
  v2ImportSucceeded: boolean | null;
  legacyRecoveryAttempted: boolean;
  legacyRecoverySucceeded: boolean | null;
  diagnostics: NotesLoadDiagnostic[];
  migrationEligibility: NotesMigrationEligibility;
}

export interface NotesWriteResult {
  key: string;
  ok: boolean;
  error?: unknown;
}

export interface NotesSaveResult {
  legacy: NotesWriteResult;
  v3: NotesWriteResult;
}

export type ProjectNotesReadOutcome = ProjectNotesLoadOutcome;

export type NotesOperationFailureReason =
  | "invalid"
  | "missing"
  | "corrupt"
  | "unavailable"
  | "storage";

export type NotesReferenceOperationResult =
  | { status: "committed"; referenceId: string }
  | { status: "reused"; referenceId: string }
  | { status: "collision"; referenceId: string }
  | { status: "linked-blocked"; phaseIds: string[] }
  | { status: "missing-reference" }
  | { status: "missing-phase"; phaseId: string }
  | { status: "failed"; reason: NotesOperationFailureReason };

export type NotesReminderMutationResult =
  | { status: "committed"; phaseId: string; occurrenceKey?: string }
  | { status: "missing-phase"; phaseId: string }
  | { status: "archived-phase"; phaseId: string }
  | { status: "inactive-phase"; phaseId: string }
  | { status: "missing-reminder"; phaseId: string }
  | {
      status: "stale-occurrence";
      phaseId: string;
      expectedOccurrenceKey: string;
      actualOccurrenceKey: string | null;
    }
  | { status: "invalid-time"; phaseId: string }
  | {
      status: "failed";
      reason: "unavailable" | "storage" | "validation";
      error?: NotesValidationError;
    };

export type NotesRoadmapMutationResult =
  | {
      status: "committed";
      phaseId: string;
      referenceId?: string;
      resultingStatus?: NotesPhaseStatus;
    }
  | { status: "already-decided"; phaseId: string; decision: "accepted" | "rejected" }
  | { status: "decision-conflict"; phaseId: string; decision: "accepted" | "rejected" }
  | { status: "missing-phase"; phaseId: string }
  | { status: "archived-phase"; phaseId: string }
  | { status: "missing-proposal"; phaseId: string; proposalId: string }
  | { status: "failed"; reason: NotesOperationFailureReason };

export type NotesPromptSaveInput =
  | { kind: "new-draft"; title: string; prompt: string }
  | {
      kind: "existing-phase";
      phaseId: string;
      prompt: string;
      expectedSourcePrompt: string;
    };

export type NotesPromptSaveResult =
  | { status: "committed"; phaseId: string; title: string }
  | { status: "replacement-conflict"; phaseId: string; title: string }
  | { status: "missing-phase"; phaseId: string }
  | { status: "archived-phase"; phaseId: string; title: string }
  | { status: "failed"; reason: "invalid"; error?: NotesValidationError }
  | {
      status: "failed";
      reason: Exclude<NotesOperationFailureReason, "invalid">;
    };

export interface NotesSidecarEvent {
  type: string;
  data: unknown;
}

export interface NotesChangeEvent extends NotesSidecarEvent {
  type: "notes_change";
  data: ProjectNotesSnapshot;
}

/** Every new SSE connection emits this signal after its event bridge is ready. */
export interface NotesReadyEvent extends NotesSidecarEvent {
  type: "ready";
}

export interface RoadmapReminderDueEvent extends NotesSidecarEvent {
  type: "roadmap_reminder_due";
  data: Record<string, never>;
}

export interface ReservedReminderOccurrence {
  leaseToken: string;
  expiresAt: string;
  phase: Pick<NotesPhase, "id" | "title" | "session">;
  reminder: Pick<NotesReminder, "id" | "occurrenceKey" | "dueAt" | "note">;
}

export type ReminderReserveOutcome =
  | ({ status: "reserved" } & ReservedReminderOccurrence)
  | { status: "deferred"; retryAt: string }
  | { status: "leased" | "none" | "already-delivered" | "missing" | "corrupt" };

export type ReminderClaimOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | {
      status:
        | "phase-not-found"
        | "phase-inactive"
        | "phase-archived"
        | "reminder-not-found"
        | "stale-occurrence"
        | "not-due"
        | "already-delivered"
        | "invalid-lease"
        | "expired-lease"
        | "wrong-session"
        | "missing";
    }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | { status: "invalid"; error: NotesValidationError };

export type ReminderReleaseOutcome =
  | { status: "released" }
  | { status: "invalid-lease" | "expired-lease" | "wrong-session" };

export interface NotesClient {
  getNotes(): Promise<ProjectNotesReadOutcome>;
  migrateNotes(document: NotesDocumentV3): Promise<ProjectNotesMigrationOutcome>;
  saveNotes(expectedRevision: number, document: NotesDocumentV3): Promise<ProjectNotesSaveOutcome>;
  reserveReminder(focused: boolean): Promise<ReminderReserveOutcome>;
  claimReminder(
    leaseToken: string,
    channel: NotesReminderDeliveryChannel,
    permission: NotesReminderPermission,
  ): Promise<ReminderClaimOutcome>;
  releaseReminder(leaseToken: string): Promise<ReminderReleaseOutcome>;
  subscribe(onEvent: (event: NotesSidecarEvent) => void): () => void;
}

export type NotesAuthorityDiagnostic =
  | { kind: "sidecar-open"; error: unknown }
  | { kind: "sidecar-corrupt"; corruption: ProjectNotesCorruption }
  | { kind: "migration-refused"; load: NotesLoadResult }
  | { kind: "migration-failed"; error: unknown }
  | { kind: "save-failed"; error: unknown }
  | { kind: "fallback-storage"; load: NotesLoadResult; save: NotesSaveResult | null };

export function isProjectNotesSnapshot(value: unknown): value is ProjectNotesSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["projectKey", "revision", "document"]) &&
    typeof value.projectKey === "string" &&
    value.projectKey.length > 0 &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    isNotesDocumentV3(value.document)
  );
}

export function isProjectNotesReadOutcome(value: unknown): value is ProjectNotesReadOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "missing") return hasExactKeys(value, ["status"]);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    value.status === "ok" &&
    typeof value.recoveredFromBackup === "boolean" &&
    isProjectNotesSnapshot(value.snapshot)
  );
}

export function isProjectNotesMigrationOutcome(
  value: unknown,
): value is ProjectNotesMigrationOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "invalid") return isInvalidOutcome(value);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    value.status === "ok" &&
    typeof value.migrated === "boolean" &&
    isProjectNotesSnapshot(value.snapshot)
  );
}

export function isProjectNotesSaveOutcome(value: unknown): value is ProjectNotesSaveOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "missing") return hasExactKeys(value, ["status"]);
  if (value.status === "invalid") return isInvalidOutcome(value);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    (value.status === "ok" || value.status === "conflict") && isProjectNotesSnapshot(value.snapshot)
  );
}

export function isReminderReserveOutcome(value: unknown): value is ReminderReserveOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (
    value.status === "leased" ||
    value.status === "none" ||
    value.status === "already-delivered" ||
    value.status === "missing" ||
    value.status === "corrupt"
  ) {
    return hasExactKeys(value, ["status"]);
  }
  if (value.status === "deferred") {
    return hasExactKeys(value, ["status", "retryAt"]) && isTimestamp(value.retryAt);
  }
  if (value.status !== "reserved") return false;
  return (
    hasExactKeys(value, ["status", "leaseToken", "expiresAt", "phase", "reminder"]) &&
    isNonEmptyString(value.leaseToken) &&
    isTimestamp(value.expiresAt) &&
    isRecord(value.phase) &&
    hasExactKeys(value.phase, ["id", "title", "session"]) &&
    isNonEmptyString(value.phase.id) &&
    typeof value.phase.title === "string" &&
    isNullableNotesSessionLink(value.phase.session) &&
    isRecord(value.reminder) &&
    hasExactKeys(value.reminder, ["id", "occurrenceKey", "dueAt", "note"]) &&
    isNonEmptyString(value.reminder.id) &&
    isNonEmptyString(value.reminder.occurrenceKey) &&
    isTimestamp(value.reminder.dueAt) &&
    typeof value.reminder.note === "string" &&
    value.reminder.note.length <= NOTES_REMINDER_NOTE_MAX_LENGTH
  );
}

export function isReminderClaimOutcome(value: unknown): value is ReminderClaimOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  const bareStatuses = new Set([
    "phase-not-found",
    "phase-inactive",
    "phase-archived",
    "reminder-not-found",
    "stale-occurrence",
    "not-due",
    "already-delivered",
    "invalid-lease",
    "expired-lease",
    "wrong-session",
    "missing",
  ]);
  if (bareStatuses.has(value.status)) return hasExactKeys(value, ["status"]);
  if (value.status === "corrupt") return isCorruption(value);
  if (value.status === "invalid") return isInvalidOutcome(value);
  if (
    value.status !== "ok" ||
    !hasExactKeys(value, ["status", "snapshot", "phase"]) ||
    !isProjectNotesSnapshot(value.snapshot) ||
    !isRecord(value.phase)
  ) {
    return false;
  }
  const responsePhase = value.phase;
  const phase = value.snapshot.document.phases.find(
    (candidate) => candidate.id === responsePhase.id,
  );
  return phase !== undefined && JSON.stringify(phase) === JSON.stringify(responsePhase);
}

export function isReminderReleaseOutcome(value: unknown): value is ReminderReleaseOutcome {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["status"]) &&
    (value.status === "released" ||
      value.status === "invalid-lease" ||
      value.status === "expired-lease" ||
      value.status === "wrong-session")
  );
}

export function isRoadmapReminderDueEvent(
  value: NotesSidecarEvent,
): value is RoadmapReminderDueEvent {
  return (
    value.type === "roadmap_reminder_due" &&
    isRecord(value.data) &&
    Object.keys(value.data).length === 0
  );
}

export function isNotesChangeEvent(value: NotesSidecarEvent): value is NotesChangeEvent {
  return value.type === "notes_change" && isProjectNotesSnapshot(value.data);
}

export function isNotesReadyEvent(value: NotesSidecarEvent): value is NotesReadyEvent {
  return value.type === "ready";
}

function isInvalidOutcome(value: Record<string, unknown>): boolean {
  return (
    value.status === "invalid" &&
    hasExactKeys(value, ["status", "error"]) &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ["path", "message"]) &&
    typeof value.error.path === "string" &&
    typeof value.error.message === "string"
  );
}

function isCorruption(value: unknown): value is { status: "corrupt" } & ProjectNotesCorruption {
  return (
    isRecord(value) &&
    value.status === "corrupt" &&
    isNullableCorruptReason(value.primary) &&
    isNullableCorruptReason(value.backup)
  );
}

function isNullableCorruptReason(value: unknown): value is ProjectNotesCorruptReason | null {
  return (
    value === null ||
    value === "malformed-json" ||
    value === "invalid-envelope" ||
    value === "project-key-mismatch"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
