export type NotesTaskStatus = "todo" | "done";

export interface NotesTask {
  id: string;
  text: string;
  status: NotesTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

export interface NotesHandoff {
  text: string;
  updatedAt: string | null;
  readAt: string | null;
}

/** Legacy shape accepted only as a v2-to-v3 migration input. */
export interface NotesDocumentV2 {
  version: 2;
  reference: string;
  currentFocus: string;
  tasks: NotesTask[];
  handoff: NotesHandoff;
  updatedAt: string;
  legacyImportedAt: string | null;
}

export const NOTES_PHASE_STATUSES = [
  "not-started",
  "planning",
  "waiting-for-approval",
  "in-progress",
  "review",
  "done",
  "needs-attention",
  "cancelled",
] as const;

export type NotesPhaseStatus = (typeof NOTES_PHASE_STATUSES)[number];

export const NOTES_LIFECYCLE_EVENT_SOURCES = ["user", "session", "agent", "system"] as const;
export type NotesLifecycleEventSource = (typeof NOTES_LIFECYCLE_EVENT_SOURCES)[number];

export const NOTES_LIFECYCLE_EVENT_KINDS = [
  "approval-opened",
  "approval-resolved",
  "attention-question-opened",
  "attention-runtime-opened",
  "attention-tool-opened",
  "attention-generic-opened",
  "attention-implementation-resolved",
  "attention-review-resolved",
  "other",
] as const;
export type NotesLifecycleEventKind = (typeof NOTES_LIFECYCLE_EVENT_KINDS)[number];

export interface NotesReferenceRange {
  startLine: number;
  endLine: number;
}

export interface NotesReference {
  id: string;
  provider: string;
  tool: string | null;
  canonicalUrl: string;
  owner: string;
  repo: string;
  revision: string | null;
  path: string | null;
  range: NotesReferenceRange | null;
  issue: number | null;
  pullRequest: number | null;
  query: string | null;
  anchor: string | null;
  relevance: string;
  capturedAt: string;
}

export interface NotesSessionLink {
  sessionId: string;
  sessionPath: string | null;
}

/** Durable/reference consumers may omit capture provenance but share all source semantics. */
export type NotesReferenceProjection = Omit<NotesReference, "capturedAt">;

export const NOTES_REMINDER_DELIVERY_CHANNELS = ["in-app", "native", "in-app-fallback"] as const;
export type NotesReminderDeliveryChannel = (typeof NOTES_REMINDER_DELIVERY_CHANNELS)[number];

export const NOTES_REMINDER_PERMISSIONS = [
  "not-required",
  "granted",
  "denied",
  "unavailable",
] as const;
export type NotesReminderPermission = (typeof NOTES_REMINDER_PERMISSIONS)[number];

export interface NotesReminderDelivery {
  occurrenceKey: string;
  attemptedAt: string;
  channel: NotesReminderDeliveryChannel;
  permission: NotesReminderPermission;
}

export interface NotesReminder {
  /** Unique across every reminder in the document. */
  id: string;
  /** Unique across every current reminder occurrence in the document. */
  occurrenceKey: string;
  dueAt: string;
  note: string;
  createdAt: string;
  lastDelivery: NotesReminderDelivery | null;
}

export interface NotesStatusOverride {
  value: NotesPhaseStatus;
  source: "user";
  updatedAt: string;
}

export interface NotesReferenceIdsOverride {
  value: string[];
  source: "user";
  updatedAt: string;
}

export interface NotesPhaseOverrides {
  status: NotesStatusOverride | null;
  referenceIds: NotesReferenceIdsOverride | null;
}

export type NotesAutomaticLifecycleStatus = Exclude<NotesPhaseStatus, "not-started" | "done">;

export interface NotesPendingAutomaticLifecycleTransition {
  status: NotesAutomaticLifecycleStatus;
  source: NotesLifecycleEventSource;
  reason: string;
  kind: NotesLifecycleEventKind;
  timestamp: string;
  expectedSession: NotesSessionLink | null;
}

export interface NotesLifecycleEvent {
  id: string;
  fromStatus: NotesPhaseStatus | null;
  toStatus: NotesPhaseStatus;
  source: NotesLifecycleEventSource;
  timestamp: string;
  reason: string | null;
  kind: NotesLifecycleEventKind;
}

export const NOTES_ROADMAP_ACTORS = ["gg-coder", "ken", "ken-autopilot"] as const;
export type NotesRoadmapActor = (typeof NOTES_ROADMAP_ACTORS)[number];

export const NOTES_ROADMAP_REVIEWERS = ["ken", "ken-autopilot"] as const;
export type NotesRoadmapReviewer = (typeof NOTES_ROADMAP_REVIEWERS)[number];

export const NOTES_ROADMAP_TRANSITIONS = ["pending", "in-progress", "blocked", "review"] as const;
export type NotesRoadmapTransition = (typeof NOTES_ROADMAP_TRANSITIONS)[number];
export type NotesRoadmapPhaseStatus = Extract<
  NotesPhaseStatus,
  "planning" | "in-progress" | "needs-attention" | "review"
>;

const NOTES_PHASE_STATUS_BY_ROADMAP_TRANSITION = {
  pending: "planning",
  "in-progress": "in-progress",
  blocked: "needs-attention",
  review: "review",
} as const satisfies Record<NotesRoadmapTransition, NotesRoadmapPhaseStatus>;

export function notesPhaseStatusForRoadmapTransition(
  transition: NotesRoadmapTransition,
): NotesRoadmapPhaseStatus {
  return NOTES_PHASE_STATUS_BY_ROADMAP_TRANSITION[transition];
}

export const NOTES_VERIFICATION_STATUSES = ["passed", "failed", "exception-requested"] as const;
export type NotesVerificationStatus = (typeof NOTES_VERIFICATION_STATUSES)[number];

export const NOTES_IMPLEMENTATION_RUN_OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type NotesImplementationRunOutcome = (typeof NOTES_IMPLEMENTATION_RUN_OUTCOMES)[number];

export const NOTES_COMPLETION_GATE_OUTCOMES = [
  "done",
  "review",
  "needs-attention",
  "waiting-for-approval",
  "manual-override",
  "done-terminal",
] as const;
export type NotesCompletionGateOutcome = (typeof NOTES_COMPLETION_GATE_OUTCOMES)[number];

export const NOTES_COMPLETION_UNMET_GATE_CODES = [
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
] as const;
export type NotesCompletionUnmetGateCode = (typeof NOTES_COMPLETION_UNMET_GATE_CODES)[number];

export const NOTES_ROADMAP_STATUS_OUTCOMES = [
  "applied",
  "same-status",
  "evidence-only",
  "manual-override",
  "done-terminal",
] as const;
export type NotesRoadmapStatusOutcome = (typeof NOTES_ROADMAP_STATUS_OUTCOMES)[number];

export const NOTES_ROADMAP_REFERENCE_POLICY_OUTCOMES = [
  "manual-review",
  "reference-override-protected",
  "accepted",
  "reused",
] as const;
export type NotesRoadmapReferencePolicyOutcome =
  (typeof NOTES_ROADMAP_REFERENCE_POLICY_OUTCOMES)[number];

export const NOTES_REVIEW_DECISIONS = ["accepted", "rejected"] as const;
export type NotesReviewDecision = (typeof NOTES_REVIEW_DECISIONS)[number];

export interface NotesRoadmapReferenceProposal extends Omit<NotesReference, "id" | "capturedAt"> {
  id: string;
  disposition: "pending" | "accepted" | "reused";
  policyOutcome: NotesRoadmapReferencePolicyOutcome;
  referenceId: string | null;
}

export interface NotesRoadmapStatusUpdate {
  type: "status-update";
  id: string;
  actor: NotesRoadmapActor;
  transition: NotesRoadmapTransition;
  progress: string;
  blocker: string | null;
  evidence: string[];
  verification: NotesVerificationStatus | null;
  verificationReason: string | null;
  verificationSession: NotesSessionLink | null;
  statusOutcome: NotesRoadmapStatusOutcome;
  proposedReferences: NotesRoadmapReferenceProposal[];
  timestamp: string;
}

export interface NotesRoadmapReferenceDecision {
  type: "reference-decision";
  id: string;
  proposalId: string;
  decision: NotesReviewDecision;
  referenceId: string | null;
  timestamp: string;
}

export interface NotesRoadmapOverrideReset {
  type: "override-reset";
  id: string;
  field: "status" | "references";
  timestamp: string;
}

export interface NotesRoadmapImplementationCheckpoint {
  type: "implementation-checkpoint";
  id: string;
  session: NotesSessionLink;
  planStepTotal: number;
  completedPlanSteps: number[];
  runOutcome: NotesImplementationRunOutcome;
  timestamp: string;
}

export interface NotesRoadmapCompletionReview {
  type: "completion-review";
  id: string;
  reviewer: NotesRoadmapReviewer;
  decision: NotesReviewDecision;
  evidence: string[];
  reason: string | null;
  implementationCheckpointId: string | null;
  verificationStatusUpdateId: string | null;
  acceptsVerificationException: boolean;
  gateOutcome: NotesCompletionGateOutcome;
  unmetGateCodes: NotesCompletionUnmetGateCode[];
  timestamp: string;
}

export type NotesRoadmapEvent =
  | NotesRoadmapStatusUpdate
  | NotesRoadmapReferenceDecision
  | NotesRoadmapOverrideReset
  | NotesRoadmapImplementationCheckpoint
  | NotesRoadmapCompletionReview;

export interface NotesPhase {
  id: string;
  title: string;
  goal: string;
  doneWhen: string[];
  order: number;
  status: NotesPhaseStatus;
  sourcePrompt: string;
  referenceIds: string[];
  session: NotesSessionLink | null;
  reminder: NotesReminder | null;
  attentionReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  overrides: NotesPhaseOverrides;
  pendingAutomaticLifecycleTransition: NotesPendingAutomaticLifecycleTransition | null;
  lifecycleEvents: NotesLifecycleEvent[];
  roadmapEvents: NotesRoadmapEvent[];
}

export function notesSessionLinksEqual(
  left: NotesSessionLink | null,
  right: NotesSessionLink | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.sessionId === right.sessionId && left.sessionPath === right.sessionPath;
}

/** Returns the status automatic policy will restore when a manual status override is reset. */
export function notesAutomaticStatusAfterOverrideReset(phase: NotesPhase): NotesPhaseStatus {
  if (phase.status === "done") return "done";

  const pending = phase.pendingAutomaticLifecycleTransition;
  if (pending && notesSessionLinksEqual(phase.session, pending.expectedSession)) {
    return pending.status;
  }

  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (
      event?.type === "status-update" &&
      (event.statusOutcome === "manual-override" || event.statusOutcome === "done-terminal")
    ) {
      return notesPhaseStatusForRoadmapTransition(event.transition);
    }
  }

  return phase.status;
}

export interface NotesDocumentV3 {
  version: 3;
  reference: string;
  currentFocus: string;
  tasks: NotesTask[];
  handoff: NotesHandoff;
  updatedAt: string;
  legacyImportedAt: string | null;
  phases: NotesPhase[];
  references: NotesReference[];
}

export interface NotesValidationError {
  path: string;
  message: string;
}

export type NotesValidationResult =
  | { ok: true; document: NotesDocumentV3 }
  | { ok: false; error: NotesValidationError };

export interface ProjectNotesSnapshot {
  projectKey: string;
  revision: number;
  document: NotesDocumentV3;
}
export type ProjectNotesCorruptReason =
  | "malformed-json"
  | "invalid-envelope"
  | "project-key-mismatch";

export interface ProjectNotesCorruption {
  primary: ProjectNotesCorruptReason | null;
  backup: ProjectNotesCorruptReason | null;
}

export type ProjectNotesLoadOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; recoveredFromBackup: boolean }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesMigrationOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; migrated: boolean }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | { status: "invalid"; error: NotesValidationError };

export type ProjectNotesSaveOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot }
  | { status: "conflict"; snapshot: ProjectNotesSnapshot }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | { status: "invalid"; error: NotesValidationError };

/**
 * Produces the shared project identity used by browser and sidecar Notes storage.
 * Windows drive and UNC paths are case-insensitive; POSIX paths preserve case.
 */
export function canonicalProjectKey(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]):(?:\/|$)/.exec(normalized);

  if (driveMatch) {
    const drive = `${driveMatch[1]!.toLowerCase()}:`;
    const remainder = normalized.slice(driveMatch[0].length);
    const segments = resolveSegments(remainder.split("/"), true);
    return segments.length === 0 ? `${drive}/` : `${drive}/${segments.join("/")}`.toLowerCase();
  }

  if (normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    const rootParts = parts.slice(0, 2);
    const segments = resolveSegments(parts.slice(2), true);
    return `//${[...rootParts, ...segments].join("/")}`.toLowerCase();
  }

  const absolute = normalized.startsWith("/");
  const segments = resolveSegments(normalized.split("/"), absolute);
  const result = `${absolute ? "/" : ""}${segments.join("/")}`;
  return result || (absolute ? "/" : ".");
}

function resolveSegments(parts: string[], rooted: boolean): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") result.pop();
      else if (!rooted) result.push(part);
    } else {
      result.push(part);
    }
  }
  return result;
}

export const NOTES_REFERENCE_URL_MAX_LENGTH = 2_048;
export const NOTES_REFERENCE_METADATA_MAX_LENGTH = 4_096;
export const NOTES_REMINDER_NOTE_MAX_LENGTH = 500;
export const NOTES_ROADMAP_EVIDENCE_MAX_ITEMS = 20;
export const NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH = 4_096;
export const NOTES_ROADMAP_REASON_MAX_LENGTH = 1_024;
export const NOTES_ROADMAP_PROPOSALS_MAX_ITEMS = 20;
export const NOTES_COMPLETION_UNMET_GATE_CODES_MAX_ITEMS = 20;

export const NOTES_REFERENCE_METADATA_FIELDS = [
  "provider",
  "tool",
  "owner",
  "repo",
  "revision",
  "path",
  "query",
  "anchor",
  "relevance",
] as const satisfies readonly (keyof NotesReference)[];

const DOCUMENT_V2_KEYS = [
  "version",
  "reference",
  "currentFocus",
  "tasks",
  "handoff",
  "updatedAt",
  "legacyImportedAt",
];
const DOCUMENT_V3_KEYS = [...DOCUMENT_V2_KEYS, "phases", "references"];
const TASK_KEYS = ["id", "text", "status", "createdAt", "updatedAt", "completedAt", "archivedAt"];
const HANDOFF_KEYS = ["text", "updatedAt", "readAt"];
const REFERENCE_KEYS = [
  "id",
  "provider",
  "tool",
  "canonicalUrl",
  "owner",
  "repo",
  "revision",
  "path",
  "range",
  "issue",
  "pullRequest",
  "query",
  "anchor",
  "relevance",
  "capturedAt",
];
const REFERENCE_PROJECTION_KEYS = REFERENCE_KEYS.filter((key) => key !== "capturedAt");
const REFERENCE_RANGE_KEYS = ["startLine", "endLine"];
const PHASE_KEYS = [
  "id",
  "title",
  "goal",
  "doneWhen",
  "order",
  "status",
  "sourcePrompt",
  "referenceIds",
  "session",
  "reminder",
  "attentionReason",
  "createdAt",
  "updatedAt",
  "completedAt",
  "archivedAt",
  "overrides",
  "pendingAutomaticLifecycleTransition",
  "lifecycleEvents",
  "roadmapEvents",
];
const LEGACY_V3_PHASE_REQUIRED_KEYS = PHASE_KEYS.filter(
  (key) =>
    key !== "archivedAt" &&
    key !== "pendingAutomaticLifecycleTransition" &&
    key !== "roadmapEvents",
);
const SESSION_KEYS = ["sessionId", "sessionPath"];
const LEGACY_REMINDER_KEYS = ["id", "dueAt", "note", "createdAt"];
const REMINDER_KEYS = ["id", "occurrenceKey", "dueAt", "note", "createdAt", "lastDelivery"];
const REMINDER_DELIVERY_KEYS = ["occurrenceKey", "attemptedAt", "channel", "permission"];
const REMINDER_DELIVERY_CHANNELS: ReadonlySet<string> = new Set(NOTES_REMINDER_DELIVERY_CHANNELS);
const REMINDER_PERMISSIONS: ReadonlySet<string> = new Set(NOTES_REMINDER_PERMISSIONS);

export function isValidNotesReminderDeliveryPair(channel: unknown, permission: unknown): boolean {
  return (
    (channel === "in-app" && permission === "not-required") ||
    (channel === "native" && permission === "granted") ||
    (channel === "in-app-fallback" && (permission === "denied" || permission === "unavailable"))
  );
}
const OVERRIDES_KEYS = ["status", "referenceIds"];
const STATUS_OVERRIDE_KEYS = ["value", "source", "updatedAt"];
const REFERENCE_IDS_OVERRIDE_KEYS = ["value", "source", "updatedAt"];
const PENDING_AUTOMATIC_LIFECYCLE_TRANSITION_KEYS = [
  "status",
  "source",
  "reason",
  "kind",
  "timestamp",
  "expectedSession",
];
const LEGACY_LIFECYCLE_EVENT_KEYS = [
  "id",
  "fromStatus",
  "toStatus",
  "source",
  "timestamp",
  "reason",
];
const LIFECYCLE_EVENT_KEYS = [...LEGACY_LIFECYCLE_EVENT_KEYS, "kind"];
const LEGACY_ROADMAP_STATUS_UPDATE_KEYS = [
  "type",
  "id",
  "actor",
  "transition",
  "progress",
  "blocker",
  "evidence",
  "statusOutcome",
  "proposedReferences",
  "timestamp",
];
const UNBOUND_VERIFICATION_ROADMAP_STATUS_UPDATE_KEYS = [
  ...LEGACY_ROADMAP_STATUS_UPDATE_KEYS,
  "verification",
  "verificationReason",
];
const ROADMAP_STATUS_UPDATE_KEYS = [
  ...UNBOUND_VERIFICATION_ROADMAP_STATUS_UPDATE_KEYS,
  "verificationSession",
];
const ROADMAP_REFERENCE_DECISION_KEYS = [
  "type",
  "id",
  "proposalId",
  "decision",
  "referenceId",
  "timestamp",
];
const ROADMAP_OVERRIDE_RESET_KEYS = ["type", "id", "field", "timestamp"];
const ROADMAP_IMPLEMENTATION_CHECKPOINT_KEYS = [
  "type",
  "id",
  "session",
  "planStepTotal",
  "completedPlanSteps",
  "runOutcome",
  "timestamp",
];
const ROADMAP_COMPLETION_REVIEW_KEYS = [
  "type",
  "id",
  "reviewer",
  "decision",
  "evidence",
  "reason",
  "implementationCheckpointId",
  "verificationStatusUpdateId",
  "acceptsVerificationException",
  "gateOutcome",
  "unmetGateCodes",
  "timestamp",
];
const LEGACY_ROADMAP_PROPOSAL_KEYS = [
  "id",
  "provider",
  "tool",
  "canonicalUrl",
  "owner",
  "repo",
  "revision",
  "path",
  "range",
  "issue",
  "pullRequest",
  "query",
  "anchor",
  "relevance",
  "disposition",
  "referenceId",
];
const ROADMAP_PROPOSAL_KEYS = [...LEGACY_ROADMAP_PROPOSAL_KEYS, "policyOutcome"];
const PHASE_STATUSES: ReadonlySet<string> = new Set(NOTES_PHASE_STATUSES);
const LIFECYCLE_EVENT_SOURCES: ReadonlySet<string> = new Set(NOTES_LIFECYCLE_EVENT_SOURCES);
const LIFECYCLE_EVENT_KINDS: ReadonlySet<string> = new Set(NOTES_LIFECYCLE_EVENT_KINDS);
const ROADMAP_ACTORS: ReadonlySet<string> = new Set(NOTES_ROADMAP_ACTORS);
const ROADMAP_REVIEWERS: ReadonlySet<string> = new Set(NOTES_ROADMAP_REVIEWERS);
const ROADMAP_TRANSITIONS: ReadonlySet<string> = new Set(NOTES_ROADMAP_TRANSITIONS);
const ROADMAP_STATUS_OUTCOMES: ReadonlySet<string> = new Set(NOTES_ROADMAP_STATUS_OUTCOMES);
const ROADMAP_REFERENCE_POLICY_OUTCOMES: ReadonlySet<string> = new Set(
  NOTES_ROADMAP_REFERENCE_POLICY_OUTCOMES,
);
const VERIFICATION_STATUSES: ReadonlySet<string> = new Set(NOTES_VERIFICATION_STATUSES);
const IMPLEMENTATION_RUN_OUTCOMES: ReadonlySet<string> = new Set(NOTES_IMPLEMENTATION_RUN_OUTCOMES);
const COMPLETION_GATE_OUTCOMES: ReadonlySet<string> = new Set(NOTES_COMPLETION_GATE_OUTCOMES);
const COMPLETION_UNMET_GATE_CODES: ReadonlySet<string> = new Set(NOTES_COMPLETION_UNMET_GATE_CODES);
const REVIEW_DECISIONS: ReadonlySet<string> = new Set(NOTES_REVIEW_DECISIONS);

export function isNotesReminderDeliveryChannel(
  value: unknown,
): value is NotesReminderDeliveryChannel {
  return typeof value === "string" && REMINDER_DELIVERY_CHANNELS.has(value);
}

export function isNotesReminderPermission(value: unknown): value is NotesReminderPermission {
  return typeof value === "string" && REMINDER_PERMISSIONS.has(value);
}

export function isNotesPhaseStatus(value: unknown): value is NotesPhaseStatus {
  return typeof value === "string" && PHASE_STATUSES.has(value);
}

export function isNotesLifecycleEventSource(value: unknown): value is NotesLifecycleEventSource {
  return typeof value === "string" && LIFECYCLE_EVENT_SOURCES.has(value);
}

export function isNotesLifecycleEventKind(value: unknown): value is NotesLifecycleEventKind {
  return typeof value === "string" && LIFECYCLE_EVENT_KINDS.has(value);
}

export function isNotesRoadmapActor(value: unknown): value is NotesRoadmapActor {
  return typeof value === "string" && ROADMAP_ACTORS.has(value);
}

export function isNotesRoadmapReviewer(value: unknown): value is NotesRoadmapReviewer {
  return typeof value === "string" && ROADMAP_REVIEWERS.has(value);
}

export function isNotesRoadmapTransition(value: unknown): value is NotesRoadmapTransition {
  return typeof value === "string" && ROADMAP_TRANSITIONS.has(value);
}

export function isNotesRoadmapStatusOutcome(value: unknown): value is NotesRoadmapStatusOutcome {
  return typeof value === "string" && ROADMAP_STATUS_OUTCOMES.has(value);
}

export function isNotesRoadmapReferencePolicyOutcome(
  value: unknown,
): value is NotesRoadmapReferencePolicyOutcome {
  return typeof value === "string" && ROADMAP_REFERENCE_POLICY_OUTCOMES.has(value);
}

export function isNotesVerificationStatus(value: unknown): value is NotesVerificationStatus {
  return typeof value === "string" && VERIFICATION_STATUSES.has(value);
}

export function isNotesImplementationRunOutcome(
  value: unknown,
): value is NotesImplementationRunOutcome {
  return typeof value === "string" && IMPLEMENTATION_RUN_OUTCOMES.has(value);
}

export function isNotesCompletionGateOutcome(value: unknown): value is NotesCompletionGateOutcome {
  return typeof value === "string" && COMPLETION_GATE_OUTCOMES.has(value);
}

export function isNotesCompletionUnmetGateCode(
  value: unknown,
): value is NotesCompletionUnmetGateCode {
  return typeof value === "string" && COMPLETION_UNMET_GATE_CODES.has(value);
}

export function isNotesReviewDecision(value: unknown): value is NotesReviewDecision {
  return typeof value === "string" && REVIEW_DECISIONS.has(value);
}

export function isValidNotesRoadmapEvidence(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= NOTES_ROADMAP_EVIDENCE_MAX_ITEMS &&
    value.every((item) => isBoundedNonEmptyString(item, NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH))
  );
}

export function isNotesRoadmapTransitionEvidenceSatisfied(
  transition: unknown,
  evidence: readonly unknown[],
): boolean {
  return transition !== "review" || evidence.length > 0;
}

export function isNotesVerificationEvidenceSatisfied(
  verification: unknown,
  evidence: readonly unknown[],
): boolean {
  return verification !== "passed" || evidence.length > 0;
}

export function isNotesVerificationReasonSatisfied(
  verification: unknown,
  reason: unknown,
): boolean {
  if (verification === null) return reason === null;
  if (verification === "passed") return reason === null;
  if (verification === "failed" || verification === "exception-requested") {
    return isBoundedNonEmptyString(reason, NOTES_ROADMAP_REASON_MAX_LENGTH);
  }
  return false;
}

export type NotesImplementationCheckpointFieldIssue =
  | { field: "planStepTotal"; code: "not-positive-integer" }
  | { field: "completedPlanSteps"; code: "not-array" }
  | { field: "completedPlanSteps"; code: "invalid-step"; index: number }
  | { field: "runOutcome"; code: "unknown-run-outcome" };

export function validateNotesImplementationCheckpointFields(fields: {
  planStepTotal: unknown;
  completedPlanSteps: unknown;
  runOutcome: unknown;
}): NotesImplementationCheckpointFieldIssue | null {
  if (!isPositiveInteger(fields.planStepTotal)) {
    return { field: "planStepTotal", code: "not-positive-integer" };
  }
  if (!Array.isArray(fields.completedPlanSteps)) {
    return { field: "completedPlanSteps", code: "not-array" };
  }
  let priorStep = 0;
  for (let index = 0; index < fields.completedPlanSteps.length; index += 1) {
    const step = fields.completedPlanSteps[index];
    if (!isPositiveInteger(step) || step > fields.planStepTotal || step <= priorStep) {
      return { field: "completedPlanSteps", code: "invalid-step", index };
    }
    priorStep = step;
  }
  if (!isNotesImplementationRunOutcome(fields.runOutcome)) {
    return { field: "runOutcome", code: "unknown-run-outcome" };
  }
  return null;
}

export type NotesCompletionReviewFieldIssue =
  | { field: "decision"; code: "unknown-decision" }
  | { field: "evidence"; code: "invalid-evidence" | "accepted-requires-evidence" }
  | { field: "reason"; code: "invalid-reason" | "rejected-requires-reason" };

export function validateNotesCompletionReviewFields(fields: {
  decision: unknown;
  evidence: unknown;
  reason: unknown;
}): NotesCompletionReviewFieldIssue | null {
  if (!isNotesReviewDecision(fields.decision)) {
    return { field: "decision", code: "unknown-decision" };
  }
  if (!isValidNotesRoadmapEvidence(fields.evidence)) {
    return { field: "evidence", code: "invalid-evidence" };
  }
  if (fields.decision === "accepted" && fields.evidence.length === 0) {
    return { field: "evidence", code: "accepted-requires-evidence" };
  }
  if (
    fields.reason !== null &&
    !isBoundedNonEmptyString(fields.reason, NOTES_ROADMAP_REASON_MAX_LENGTH)
  ) {
    return { field: "reason", code: "invalid-reason" };
  }
  if (fields.decision === "rejected" && fields.reason === null) {
    return { field: "reason", code: "rejected-requires-reason" };
  }
  return null;
}

export function classifyLegacyNotesLifecycleEvent(event: {
  toStatus: unknown;
  source: unknown;
  reason: unknown;
}): NotesLifecycleEventKind {
  if (event.toStatus === "waiting-for-approval") return "approval-opened";
  if (event.toStatus === "needs-attention") {
    if (event.source === "session") return "attention-runtime-opened";
    if (event.source === "agent" && /(^|\s)\S+ failed(?::|$)/i.test(String(event.reason ?? ""))) {
      return "attention-tool-opened";
    }
    return event.source === "agent" ? "attention-question-opened" : "attention-generic-opened";
  }
  if (
    event.toStatus === "in-progress" &&
    ((event.source === "user" && event.reason === "Plan approved by user") ||
      (event.source === "agent" && event.reason === "Plan approved by Autopilot"))
  ) {
    return "approval-resolved";
  }
  if (
    event.toStatus === "in-progress" &&
    event.source === "session" &&
    (event.reason === "Implementation run started" ||
      event.reason === "Implementation session resumed")
  ) {
    return "attention-implementation-resolved";
  }
  if (
    event.toStatus === "review" &&
    event.source === "session" &&
    event.reason === "Review session resumed"
  ) {
    return "attention-review-resolved";
  }
  return "other";
}

function isLifecycleEventKindCompatible(
  kind: NotesLifecycleEventKind,
  toStatus: NotesPhaseStatus,
  source: NotesLifecycleEventSource,
): boolean {
  switch (kind) {
    case "approval-opened":
      return toStatus === "waiting-for-approval";
    case "approval-resolved":
      return toStatus === "in-progress" && (source === "user" || source === "agent");
    case "attention-question-opened":
    case "attention-tool-opened":
      return toStatus === "needs-attention" && source === "agent";
    case "attention-runtime-opened":
      return toStatus === "needs-attention" && source === "session";
    case "attention-generic-opened":
      return toStatus === "needs-attention";
    case "attention-implementation-resolved":
      return toStatus === "in-progress" && source === "session";
    case "attention-review-resolved":
      return toStatus === "review" && source === "session";
    case "other":
      return true;
  }
}
export function isNotesDocumentV2(value: unknown): value is NotesDocumentV2 {
  return validateNotesDocumentV2(value) === null;
}

export function migrateNotesDocumentV2(value: unknown): NotesValidationResult {
  const error = validateNotesDocumentV2(value);
  if (error) return { ok: false, error };
  const legacy = value as NotesDocumentV2;
  return {
    ok: true,
    document: {
      ...legacy,
      version: 3,
      tasks: stabilizeMigratedTaskIds(legacy.tasks),
      phases: [],
      references: [],
    },
  };
}

export function isNotesDocumentV3(value: unknown): value is NotesDocumentV3 {
  return validateNotesDocumentV3(value).ok;
}

/** Adds missing additive fields to legacy v3 phase, lifecycle, and roadmap records, then validates. */
export function migrateNotesDocumentV3PhaseShape(value: unknown): NotesValidationResult {
  type LegacyNotesLifecycleEventInput = Record<keyof Omit<NotesLifecycleEvent, "kind">, unknown>;
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_V3_KEYS) || value.version !== 3) {
    return validateNotesDocumentV3(value);
  }
  if (!Array.isArray(value.phases)) return validateNotesDocumentV3(value);

  let migrated = false;
  const phases = value.phases.map((phase) => {
    if (!isRecord(phase)) return phase;
    const keys = Object.keys(phase);
    const hasRequiredKeys = LEGACY_V3_PHASE_REQUIRED_KEYS.every((key) => keys.includes(key));
    const onlyCurrentKeys = keys.every((key) => PHASE_KEYS.includes(key));
    if (!hasRequiredKeys || !onlyCurrentKeys) return phase;

    const missingPhaseFields =
      !keys.includes("archivedAt") ||
      !keys.includes("pendingAutomaticLifecycleTransition") ||
      !keys.includes("roadmapEvents");
    if (missingPhaseFields) migrated = true;
    let reminder = phase.reminder;
    if (isRecord(reminder) && hasExactKeys(reminder, LEGACY_REMINDER_KEYS)) {
      migrated = true;
      reminder = {
        ...reminder,
        occurrenceKey: reminder.id,
        lastDelivery: null,
      };
    }
    const migratedPhase = {
      ...phase,
      reminder,
      archivedAt: keys.includes("archivedAt") ? phase.archivedAt : null,
      pendingAutomaticLifecycleTransition: keys.includes("pendingAutomaticLifecycleTransition")
        ? phase.pendingAutomaticLifecycleTransition
        : null,
      lifecycleEvents: phase.lifecycleEvents,
      roadmapEvents: keys.includes("roadmapEvents") ? phase.roadmapEvents : [],
    };
    if (
      !Array.isArray(migratedPhase.lifecycleEvents) ||
      !Array.isArray(migratedPhase.roadmapEvents)
    ) {
      return migratedPhase;
    }

    const lifecycleEvents = migratedPhase.lifecycleEvents.map((event) => {
      if (!isRecord(event) || !hasExactKeys(event, LEGACY_LIFECYCLE_EVENT_KEYS)) return event;
      const legacyEvent = event as LegacyNotesLifecycleEventInput;
      migrated = true;
      return {
        ...legacyEvent,
        kind: classifyLegacyNotesLifecycleEvent({
          toStatus: legacyEvent.toStatus,
          source: legacyEvent.source,
          reason: legacyEvent.reason,
        }),
      };
    });

    const roadmapEvents = migratedPhase.roadmapEvents.map((event) => {
      if (!isRecord(event) || event.type !== "status-update") return event;
      let migratedEvent = false;
      const migratedStatusUpdate: Record<string, unknown> = hasExactKeys(
        event,
        LEGACY_ROADMAP_STATUS_UPDATE_KEYS,
      )
        ? (() => {
            migratedEvent = true;
            migrated = true;
            return {
              ...event,
              verification: null,
              verificationReason: null,
              verificationSession: null,
            };
          })()
        : hasExactKeys(event, UNBOUND_VERIFICATION_ROADMAP_STATUS_UPDATE_KEYS)
          ? (() => {
              migratedEvent = true;
              migrated = true;
              return { ...event, verificationSession: null };
            })()
          : event;
      if (!Array.isArray(migratedStatusUpdate.proposedReferences)) {
        return migratedEvent ? migratedStatusUpdate : event;
      }
      const proposedReferences = migratedStatusUpdate.proposedReferences.map((proposal) => {
        if (!isRecord(proposal) || !hasExactKeys(proposal, LEGACY_ROADMAP_PROPOSAL_KEYS)) {
          return proposal;
        }
        const policyOutcome =
          proposal.disposition === "pending"
            ? "manual-review"
            : proposal.disposition === "accepted" || proposal.disposition === "reused"
              ? proposal.disposition
              : null;
        if (policyOutcome === null) return proposal;
        migratedEvent = true;
        migrated = true;
        return { ...proposal, policyOutcome };
      });
      return migratedEvent ? { ...migratedStatusUpdate, proposedReferences } : event;
    });
    return { ...migratedPhase, lifecycleEvents, roadmapEvents };
  });
  return validateNotesDocumentV3(migrated ? { ...value, phases } : value);
}

export function validateNotesDocumentV3(value: unknown): NotesValidationResult {
  if (!isRecordWithKeys(value, DOCUMENT_V3_KEYS)) {
    return invalid("$", `expected exactly: ${DOCUMENT_V3_KEYS.join(", ")}`);
  }
  if (value.version !== 3) return invalid("version", "expected 3");
  const existingError = validateExistingNotesFields(value, true);
  if (existingError) return { ok: false, error: existingError };
  if (!Array.isArray(value.references)) return invalid("references", "expected an array");
  if (!Array.isArray(value.phases)) return invalid("phases", "expected an array");

  const referenceIds = new Set<string>();
  const referenceIdentities = new Map<string, number>();
  for (let index = 0; index < value.references.length; index += 1) {
    const referenceError = validateReference(value.references[index], `references[${index}]`);
    if (referenceError) return { ok: false, error: referenceError };
    const reference = value.references[index] as NotesReference;
    const id = reference.id;
    if (referenceIds.has(id)) return invalid(`references[${index}].id`, `duplicate ID: ${id}`);
    referenceIds.add(id);
    const identity = canonicalReferenceIdentity(reference)!;
    const duplicateIndex = referenceIdentities.get(identity);
    if (duplicateIndex !== undefined) {
      return invalid(
        `references[${index}].canonicalUrl`,
        `duplicate canonical source; already saved at references[${duplicateIndex}]`,
      );
    }
    referenceIdentities.set(identity, index);
  }

  const phaseIds = new Set<string>();
  const reminderIdPaths = new Map<string, string>();
  const occurrenceKeyPaths = new Map<string, string>();
  for (let index = 0; index < value.phases.length; index += 1) {
    const phase = value.phases[index];
    const phaseError = validatePhase(phase, index, referenceIds);
    if (phaseError) return { ok: false, error: phaseError };
    const validatedPhase = phase as NotesPhase;
    if (phaseIds.has(validatedPhase.id)) {
      return invalid(`phases[${index}].id`, `duplicate ID: ${validatedPhase.id}`);
    }
    phaseIds.add(validatedPhase.id);

    const reminder = validatedPhase.reminder;
    if (reminder === null) continue;
    const reminderPath = `phases[${index}].reminder`;
    const existingReminderIdPath = reminderIdPaths.get(reminder.id);
    if (existingReminderIdPath) {
      return invalid(
        `${reminderPath}.id`,
        `duplicate reminder ID; already used at ${existingReminderIdPath}`,
      );
    }
    reminderIdPaths.set(reminder.id, `${reminderPath}.id`);

    const existingOccurrencePath = occurrenceKeyPaths.get(reminder.occurrenceKey);
    if (existingOccurrencePath) {
      return invalid(
        `${reminderPath}.occurrenceKey`,
        `duplicate occurrence key; already used at ${existingOccurrencePath}`,
      );
    }
    occurrenceKeyPaths.set(reminder.occurrenceKey, `${reminderPath}.occurrenceKey`);
  }

  return { ok: true, document: value as unknown as NotesDocumentV3 };
}

function validateNotesDocumentV2(value: unknown): NotesValidationError | null {
  if (!isRecordWithKeys(value, DOCUMENT_V2_KEYS)) {
    return validationError("$", `expected exactly: ${DOCUMENT_V2_KEYS.join(", ")}`);
  }
  if (value.version !== 2) return validationError("version", "expected 2");
  return validateExistingNotesFields(value, false);
}

function validateExistingNotesFields(
  value: Record<string, unknown>,
  requireStableTaskIds: boolean,
): NotesValidationError | null {
  if (typeof value.reference !== "string") return validationError("reference", "expected a string");
  if (typeof value.currentFocus !== "string") {
    return validationError("currentFocus", "expected a string");
  }
  if (!Array.isArray(value.tasks)) return validationError("tasks", "expected an array");
  const taskIds = new Set<string>();
  for (let index = 0; index < value.tasks.length; index += 1) {
    const task = value.tasks[index];
    if (!isNotesTask(task)) return validationError(`tasks[${index}]`, "invalid task record");
    if (requireStableTaskIds) {
      if (!isNonEmptyString(task.id)) {
        return validationError(`tasks[${index}].id`, "expected a stable ID");
      }
      if (taskIds.has(task.id)) {
        return validationError(`tasks[${index}].id`, `duplicate ID: ${task.id}`);
      }
      taskIds.add(task.id);
    }
  }
  if (!isNotesHandoff(value.handoff)) return validationError("handoff", "invalid handoff record");
  if (!isTimestamp(value.updatedAt))
    return validationError("updatedAt", "expected an ISO timestamp");
  if (!isNullableTimestamp(value.legacyImportedAt)) {
    return validationError("legacyImportedAt", "expected an ISO timestamp or null");
  }
  return null;
}

function stabilizeMigratedTaskIds(tasks: NotesTask[]): NotesTask[] {
  const reservedIds = new Set(tasks.map((task) => task.id).filter(isNonEmptyString));
  const assignedIds = new Set<string>();
  return tasks.map((task, index) => {
    if (isNonEmptyString(task.id) && !assignedIds.has(task.id)) {
      assignedIds.add(task.id);
      return task;
    }

    const baseId = `legacy-task-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (reservedIds.has(id) || assignedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    assignedIds.add(id);
    return { ...task, id };
  });
}

function validateReference(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (!isRecordWithKeys(value, REFERENCE_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${REFERENCE_KEYS.join(", ")}`);
  }
  const projectionError = validateReferenceProjectionFields(value, pathPrefix);
  if (projectionError) return projectionError;
  if (!isTimestamp(value.capturedAt)) {
    return validationError(`${pathPrefix}.capturedAt`, "expected an ISO timestamp");
  }
  return null;
}

export function validateNotesReferenceProjection(
  value: unknown,
  pathPrefix = "reference",
): NotesValidationError | null {
  if (!isRecordWithKeys(value, REFERENCE_PROJECTION_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${REFERENCE_PROJECTION_KEYS.join(", ")}`);
  }
  return validateReferenceProjectionFields(value, pathPrefix);
}

function validateReferenceProjectionFields(
  value: Record<string, unknown>,
  pathPrefix: string,
): NotesValidationError | null {
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "expected a stable ID");
  if (!isNonEmptyString(value.provider)) {
    return validationError(`${pathPrefix}.provider`, "expected a provider name");
  }
  if (isReferenceMetadataTooLong(value.provider)) {
    return referenceMetadataLengthError(`${pathPrefix}.provider`);
  }
  const nullableStringFields = ["tool", "revision", "path", "query", "anchor"] as const;
  for (const field of nullableStringFields) {
    if (!isNullableNonEmptyString(value[field])) {
      return validationError(`${pathPrefix}.${field}`, "expected a non-empty string or null");
    }
    if (isReferenceMetadataTooLong(value[field])) {
      return referenceMetadataLengthError(`${pathPrefix}.${field}`);
    }
  }
  if (
    typeof value.canonicalUrl === "string" &&
    value.canonicalUrl.length > NOTES_REFERENCE_URL_MAX_LENGTH
  ) {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      `expected ${NOTES_REFERENCE_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    );
  }
  if (!isCanonicalHttpUrl(value.canonicalUrl)) {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      "expected an absolute http(s) URL without username or password",
    );
  }
  if (!isNonEmptyString(value.owner)) {
    return validationError(`${pathPrefix}.owner`, "repository owner is required");
  }
  if (isReferenceMetadataTooLong(value.owner)) {
    return referenceMetadataLengthError(`${pathPrefix}.owner`);
  }
  if (!isNonEmptyString(value.repo)) {
    return validationError(`${pathPrefix}.repo`, "repository name is required");
  }
  if (isReferenceMetadataTooLong(value.repo)) {
    return referenceMetadataLengthError(`${pathPrefix}.repo`);
  }
  if (value.range !== null) {
    if (!isRecordWithKeys(value.range, REFERENCE_RANGE_KEYS)) {
      return validationError(`${pathPrefix}.range`, "expected startLine and endLine or null");
    }
    if (!isPositiveInteger(value.range.startLine)) {
      return validationError(`${pathPrefix}.range.startLine`, "expected a positive integer");
    }
    if (!isPositiveInteger(value.range.endLine) || value.range.endLine < value.range.startLine) {
      return validationError(
        `${pathPrefix}.range.endLine`,
        "expected an integer at or after startLine",
      );
    }
    if (value.path === null) {
      return validationError(`${pathPrefix}.path`, "path is required when range is present");
    }
  }
  if (!isNullablePositiveInteger(value.issue)) {
    return validationError(`${pathPrefix}.issue`, "expected a positive integer or null");
  }
  if (!isNullablePositiveInteger(value.pullRequest)) {
    return validationError(`${pathPrefix}.pullRequest`, "expected a positive integer or null");
  }
  if (value.issue !== null && value.pullRequest !== null) {
    return validationError(
      `${pathPrefix}.pullRequest`,
      "a reference cannot target both an issue and a pull request",
    );
  }
  const semanticError = validateReferenceCoordinates(
    value as unknown as NotesReferenceProjection,
    pathPrefix,
  );
  if (semanticError) return semanticError;
  if (typeof value.relevance !== "string") {
    return validationError(`${pathPrefix}.relevance`, "expected a string");
  }
  if (isReferenceMetadataTooLong(value.relevance)) {
    return referenceMetadataLengthError(`${pathPrefix}.relevance`);
  }
  return null;
}

function validateReferenceCoordinates(
  reference: NotesReferenceProjection,
  pathPrefix: string,
): NotesValidationError | null {
  if (reference.provider.trim().toLowerCase() !== "github") return null;
  const normalized = normalizeCanonicalUrl(reference.canonicalUrl)!;
  const url = new URL(normalized);
  if (url.hostname !== "github.com") {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      "GitHub references must use a github.com URL",
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length < 2 ||
    segments[0]!.toLowerCase() !== reference.owner.trim().toLowerCase() ||
    segments[1]!.replace(/\.git$/i, "").toLowerCase() !==
      reference.repo
        .trim()
        .replace(/\.git$/i, "")
        .toLowerCase()
  ) {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      "URL owner and repository must match the stored repository",
    );
  }
  const directNumber = segments[3] && /^\d+$/.test(segments[3]) ? Number(segments[3]) : null;
  if (segments[2] === "issues" && directNumber !== null && reference.issue !== directNumber) {
    return validationError(
      `${pathPrefix}.issue`,
      `expected ${directNumber} to match the issue URL`,
    );
  }
  if (segments[2] === "pull" && directNumber !== null && reference.pullRequest !== directNumber) {
    return validationError(
      `${pathPrefix}.pullRequest`,
      `expected ${directNumber} to match the pull request URL`,
    );
  }
  return null;
}

function validatePhase(
  value: unknown,
  index: number,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  const pathPrefix = `phases[${index}]`;
  if (!isRecordWithKeys(value, PHASE_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${PHASE_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "expected a stable ID");
  if (!isNonEmptyString(value.title))
    return validationError(`${pathPrefix}.title`, "title is required");
  if (typeof value.goal !== "string")
    return validationError(`${pathPrefix}.goal`, "expected a string");
  if (!Array.isArray(value.doneWhen) || !value.doneWhen.every(isNonEmptyString)) {
    return validationError(`${pathPrefix}.doneWhen`, "expected non-empty criteria strings");
  }
  if (value.order !== index) {
    return validationError(`${pathPrefix}.order`, `expected ${index} to match array order`);
  }
  if (!isNotesPhaseStatus(value.status)) {
    return validationError(`${pathPrefix}.status`, "unknown phase status");
  }
  if (typeof value.sourcePrompt !== "string") {
    return validationError(`${pathPrefix}.sourcePrompt`, "expected a string");
  }
  const referenceIdsError = validateReferenceIds(
    value.referenceIds,
    `${pathPrefix}.referenceIds`,
    knownReferenceIds,
  );
  if (referenceIdsError) return referenceIdsError;
  const sessionError = validateNotesSessionLink(value.session, `${pathPrefix}.session`);
  if (sessionError) return sessionError;
  const reminderError = validateReminder(value.reminder, `${pathPrefix}.reminder`);
  if (reminderError) return reminderError;
  if (!isNullableNonEmptyString(value.attentionReason)) {
    return validationError(`${pathPrefix}.attentionReason`, "expected a non-empty string or null");
  }
  if (!isTimestamp(value.createdAt)) {
    return validationError(`${pathPrefix}.createdAt`, "expected an ISO timestamp");
  }
  if (!isTimestamp(value.updatedAt)) {
    return validationError(`${pathPrefix}.updatedAt`, "expected an ISO timestamp");
  }
  if (!isNullableTimestamp(value.completedAt)) {
    return validationError(`${pathPrefix}.completedAt`, "expected an ISO timestamp or null");
  }
  if (!isNullableTimestamp(value.archivedAt)) {
    return validationError(`${pathPrefix}.archivedAt`, "expected an ISO timestamp or null");
  }
  const overridesError = validateOverrides(
    value.overrides,
    `${pathPrefix}.overrides`,
    knownReferenceIds,
  );
  if (overridesError) return overridesError;
  const pendingTransitionError = validatePendingAutomaticLifecycleTransition(
    value.pendingAutomaticLifecycleTransition,
    `${pathPrefix}.pendingAutomaticLifecycleTransition`,
    value.overrides,
  );
  if (pendingTransitionError) return pendingTransitionError;
  const lifecycleError = validateLifecycleEvents(
    value.lifecycleEvents,
    `${pathPrefix}.lifecycleEvents`,
    value.status,
  );
  if (lifecycleError) return lifecycleError;
  return validateRoadmapEvents(
    value.roadmapEvents,
    `${pathPrefix}.roadmapEvents`,
    knownReferenceIds,
    value.session as NotesSessionLink | null,
  );
}

function validateReferenceIds(
  value: unknown,
  pathPrefix: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!Array.isArray(value))
    return validationError(pathPrefix, "expected an array of reference IDs");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    if (!isNonEmptyString(id))
      return validationError(`${pathPrefix}[${index}]`, "expected a stable ID");
    if (seen.has(id)) return validationError(`${pathPrefix}[${index}]`, `duplicate link: ${id}`);
    if (!knownReferenceIds.has(id))
      return validationError(`${pathPrefix}[${index}]`, `unknown reference ID: ${id}`);
    seen.add(id);
  }
  return null;
}

export function validateNotesSessionLink(
  value: unknown,
  pathPrefix = "session",
): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, SESSION_KEYS)) {
    return validationError(pathPrefix, "expected sessionId and sessionPath or null");
  }
  if (!isNonEmptyString(value.sessionId)) {
    return validationError(`${pathPrefix}.sessionId`, "session ID is required");
  }
  if (!isNullableNonEmptyString(value.sessionPath)) {
    return validationError(`${pathPrefix}.sessionPath`, "expected a non-empty path or null");
  }
  return null;
}

export function isNotesSessionLink(value: unknown): value is NotesSessionLink {
  return value !== null && validateNotesSessionLink(value) === null;
}

export function isNullableNotesSessionLink(value: unknown): value is NotesSessionLink | null {
  return validateNotesSessionLink(value) === null;
}

function validateReminder(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, REMINDER_KEYS)) {
    return validationError(
      pathPrefix,
      "expected id, occurrenceKey, dueAt, note, createdAt, and lastDelivery or null",
    );
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "reminder ID is required");
  if (!isNonEmptyString(value.occurrenceKey)) {
    return validationError(`${pathPrefix}.occurrenceKey`, "occurrence key is required");
  }
  if (!isTimestamp(value.dueAt))
    return validationError(`${pathPrefix}.dueAt`, "expected an ISO timestamp");
  if (typeof value.note !== "string")
    return validationError(`${pathPrefix}.note`, "expected a string");
  if (value.note.length > NOTES_REMINDER_NOTE_MAX_LENGTH) {
    return validationError(
      `${pathPrefix}.note`,
      `expected ${NOTES_REMINDER_NOTE_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    );
  }
  if (!isTimestamp(value.createdAt)) {
    return validationError(`${pathPrefix}.createdAt`, "expected an ISO timestamp");
  }
  return validateReminderDelivery(value.lastDelivery, `${pathPrefix}.lastDelivery`);
}

function validateReminderDelivery(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, REMINDER_DELIVERY_KEYS)) {
    return validationError(
      pathPrefix,
      "expected occurrenceKey, attemptedAt, channel, and permission or null",
    );
  }
  if (!isNonEmptyString(value.occurrenceKey)) {
    return validationError(`${pathPrefix}.occurrenceKey`, "occurrence key is required");
  }
  if (!isTimestamp(value.attemptedAt)) {
    return validationError(`${pathPrefix}.attemptedAt`, "expected an ISO timestamp");
  }
  if (!isNotesReminderDeliveryChannel(value.channel)) {
    return validationError(`${pathPrefix}.channel`, "unknown delivery channel");
  }
  if (!isNotesReminderPermission(value.permission)) {
    return validationError(`${pathPrefix}.permission`, "unknown notification permission");
  }
  if (!isValidNotesReminderDeliveryPair(value.channel, value.permission)) {
    return validationError(
      `${pathPrefix}.permission`,
      "permission does not match delivery channel",
    );
  }
  return null;
}

function validateOverrides(
  value: unknown,
  pathPrefix: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!isRecordWithKeys(value, OVERRIDES_KEYS)) {
    return validationError(pathPrefix, "expected status and referenceIds override markers");
  }
  if (value.status !== null) {
    if (!isRecordWithKeys(value.status, STATUS_OVERRIDE_KEYS)) {
      return validationError(`${pathPrefix}.status`, "invalid status override marker");
    }
    if (!isNotesPhaseStatus(value.status.value)) {
      return validationError(`${pathPrefix}.status.value`, "unknown phase status");
    }
    if (value.status.source !== "user") {
      return validationError(`${pathPrefix}.status.source`, "expected user");
    }
    if (!isTimestamp(value.status.updatedAt)) {
      return validationError(`${pathPrefix}.status.updatedAt`, "expected an ISO timestamp");
    }
  }
  if (value.referenceIds !== null) {
    if (!isRecordWithKeys(value.referenceIds, REFERENCE_IDS_OVERRIDE_KEYS)) {
      return validationError(`${pathPrefix}.referenceIds`, "invalid reference override marker");
    }
    const idsError = validateReferenceIds(
      value.referenceIds.value,
      `${pathPrefix}.referenceIds.value`,
      knownReferenceIds,
    );
    if (idsError) return idsError;
    if (value.referenceIds.source !== "user") {
      return validationError(`${pathPrefix}.referenceIds.source`, "expected user");
    }
    if (!isTimestamp(value.referenceIds.updatedAt)) {
      return validationError(`${pathPrefix}.referenceIds.updatedAt`, "expected an ISO timestamp");
    }
  }
  return null;
}

function validatePendingAutomaticLifecycleTransition(
  value: unknown,
  pathPrefix: string,
  overrides: unknown,
): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, PENDING_AUTOMATIC_LIFECYCLE_TRANSITION_KEYS)) {
    return validationError(pathPrefix, "invalid pending automatic lifecycle transition");
  }
  if (
    value.status === "not-started" ||
    value.status === "done" ||
    !isNotesPhaseStatus(value.status)
  ) {
    return validationError(`${pathPrefix}.status`, "unknown automatic phase status");
  }
  if (!isNotesLifecycleEventSource(value.source)) {
    return validationError(`${pathPrefix}.source`, "unknown lifecycle event source");
  }
  if (!isNonEmptyString(value.reason)) {
    return validationError(`${pathPrefix}.reason`, "expected a non-empty string");
  }
  if (!isNotesLifecycleEventKind(value.kind)) {
    return validationError(`${pathPrefix}.kind`, "unknown lifecycle event kind");
  }
  if (
    !isLifecycleEventKindCompatible(
      value.kind as NotesLifecycleEventKind,
      value.status as NotesPhaseStatus,
      value.source as NotesLifecycleEventSource,
    )
  ) {
    return validationError(`${pathPrefix}.kind`, "kind does not match lifecycle transition");
  }
  if (!isTimestamp(value.timestamp)) {
    return validationError(`${pathPrefix}.timestamp`, "expected an ISO timestamp");
  }
  const sessionError = validateNotesSessionLink(
    value.expectedSession,
    `${pathPrefix}.expectedSession`,
  );
  if (sessionError) return sessionError;
  if (!isRecord(overrides) || overrides.status === null) {
    return validationError(pathPrefix, "requires an active status override");
  }
  return null;
}

function validateLifecycleEvents(
  value: unknown,
  pathPrefix: string,
  phaseStatus: NotesPhaseStatus,
): NotesValidationError | null {
  if (!Array.isArray(value))
    return validationError(pathPrefix, "expected an append-only event array");
  const ids = new Set<string>();
  let previousStatus: NotesPhaseStatus | null | undefined;
  let previousTimestamp = -Infinity;
  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    const eventPath = `${pathPrefix}[${index}]`;
    if (!isRecordWithKeys(event, LIFECYCLE_EVENT_KEYS)) {
      return validationError(eventPath, "invalid lifecycle transition record");
    }
    if (!isNonEmptyString(event.id))
      return validationError(`${eventPath}.id`, "event ID is required");
    if (ids.has(event.id)) return validationError(`${eventPath}.id`, `duplicate ID: ${event.id}`);
    ids.add(event.id);
    if (event.fromStatus !== null && !isNotesPhaseStatus(event.fromStatus)) {
      return validationError(`${eventPath}.fromStatus`, "unknown phase status");
    }
    if (!isNotesPhaseStatus(event.toStatus)) {
      return validationError(`${eventPath}.toStatus`, "unknown phase status");
    }
    if (event.fromStatus === event.toStatus) {
      return validationError(eventPath, "transition must change status");
    }
    if (previousStatus !== undefined && event.fromStatus !== previousStatus) {
      return validationError(`${eventPath}.fromStatus`, `expected ${previousStatus}`);
    }
    if (!isNotesLifecycleEventSource(event.source)) {
      return validationError(`${eventPath}.source`, "unknown lifecycle event source");
    }
    if (!isTimestamp(event.timestamp)) {
      return validationError(`${eventPath}.timestamp`, "expected an ISO timestamp");
    }
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < previousTimestamp) {
      return validationError(`${eventPath}.timestamp`, "events must be chronological");
    }
    if (!isNullableNonEmptyString(event.reason)) {
      return validationError(`${eventPath}.reason`, "expected a non-empty string or null");
    }
    if (
      typeof event.kind !== "string" ||
      !LIFECYCLE_EVENT_KINDS.has(event.kind as NotesLifecycleEventKind)
    ) {
      return validationError(`${eventPath}.kind`, "unknown lifecycle event kind");
    }
    if (
      !isLifecycleEventKindCompatible(
        event.kind as NotesLifecycleEventKind,
        event.toStatus as NotesPhaseStatus,
        event.source as NotesLifecycleEventSource,
      )
    ) {
      return validationError(`${eventPath}.kind`, "kind does not match lifecycle transition");
    }
    previousStatus = event.toStatus;
    previousTimestamp = timestamp;
  }
  if (value.length > 0 && previousStatus !== phaseStatus) {
    return validationError(pathPrefix, `last event must end at phase status ${phaseStatus}`);
  }
  return null;
}

function validateRoadmapEvents(
  value: unknown,
  pathPrefix: string,
  knownReferenceIds: ReadonlySet<string>,
  phaseSession: NotesSessionLink | null,
): NotesValidationError | null {
  if (!Array.isArray(value)) {
    return validationError(pathPrefix, "expected an append-only event array");
  }
  const eventIds = new Set<string>();
  const proposalIds = new Set<string>();
  const pendingProposalIds = new Set<string>();
  const decidedProposalIds = new Set<string>();
  const implementationCheckpoints = new Map<string, NotesRoadmapImplementationCheckpoint>();
  const implementationCheckpointIndexes = new Map<string, number>();
  const verificationUpdates = new Map<string, NotesRoadmapStatusUpdate>();
  const verificationUpdateIndexes = new Map<string, number>();
  let latestRejectedReviewIndex = -1;
  let previousTimestamp = -Infinity;

  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    const eventPath = `${pathPrefix}[${index}]`;
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return validationError(eventPath, "invalid roadmap event record");
    }
    const record = event as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) {
      return validationError(`${eventPath}.id`, "event ID is required");
    }
    if (eventIds.has(record.id)) {
      return validationError(`${eventPath}.id`, `duplicate ID: ${record.id}`);
    }
    eventIds.add(record.id);
    if (!isTimestamp(record.timestamp)) {
      return validationError(`${eventPath}.timestamp`, "expected an ISO timestamp");
    }
    const timestamp = Date.parse(record.timestamp);
    if (timestamp < previousTimestamp) {
      return validationError(`${eventPath}.timestamp`, "events must be chronological");
    }
    previousTimestamp = timestamp;

    if (record.type === "status-update") {
      if (!isRecordWithKeys(record, ROADMAP_STATUS_UPDATE_KEYS)) {
        return validationError(eventPath, "invalid roadmap status update");
      }
      if (!isNotesRoadmapActor(record.actor)) {
        return validationError(`${eventPath}.actor`, "unknown roadmap actor");
      }
      if (!isNotesRoadmapTransition(record.transition)) {
        return validationError(`${eventPath}.transition`, "unknown roadmap transition");
      }
      if (!isBoundedNonEmptyString(record.progress, 4_096)) {
        return validationError(`${eventPath}.progress`, "expected 1 to 4,096 characters");
      }
      if (record.transition === "blocked") {
        if (!isBoundedNonEmptyString(record.blocker, 1_024)) {
          return validationError(`${eventPath}.blocker`, "blocked reports require a blocker");
        }
      } else if (record.blocker !== null) {
        return validationError(
          `${eventPath}.blocker`,
          "only blocked reports may include a blocker",
        );
      }
      if (!isValidNotesRoadmapEvidence(record.evidence)) {
        return validationError(`${eventPath}.evidence`, "expected up to 20 bounded evidence items");
      }
      if (!isNotesRoadmapTransitionEvidenceSatisfied(record.transition, record.evidence)) {
        return validationError(`${eventPath}.evidence`, "review reports require evidence");
      }
      if (record.verification === null) {
        if (!isNotesVerificationReasonSatisfied(record.verification, record.verificationReason)) {
          return validationError(
            `${eventPath}.verificationReason`,
            "verification reason requires a verification result",
          );
        }
        if (record.verificationSession !== null) {
          return validationError(
            `${eventPath}.verificationSession`,
            "verification session requires a verification result",
          );
        }
      } else {
        if (!isNotesVerificationStatus(record.verification)) {
          return validationError(`${eventPath}.verification`, "unknown verification result");
        }
        if (record.verification === "passed") {
          if (!isNotesVerificationEvidenceSatisfied(record.verification, record.evidence)) {
            return validationError(
              `${eventPath}.evidence`,
              "passed verification requires evidence",
            );
          }
          if (!isNotesVerificationReasonSatisfied(record.verification, record.verificationReason)) {
            return validationError(
              `${eventPath}.verificationReason`,
              "passed verification cannot include a failure or exception reason",
            );
          }
        } else if (
          !isNotesVerificationReasonSatisfied(record.verification, record.verificationReason)
        ) {
          return validationError(
            `${eventPath}.verificationReason`,
            "failed or exception verification requires a bounded reason",
          );
        }
        const verificationSessionError = validateNotesSessionLink(
          record.verificationSession,
          `${eventPath}.verificationSession`,
        );
        if (verificationSessionError) return verificationSessionError;
        verificationUpdates.set(record.id, record as unknown as NotesRoadmapStatusUpdate);
        verificationUpdateIndexes.set(record.id, index);
      }
      if (!isNotesRoadmapStatusOutcome(record.statusOutcome)) {
        return validationError(`${eventPath}.statusOutcome`, "unknown status outcome");
      }
      if (
        !Array.isArray(record.proposedReferences) ||
        record.proposedReferences.length > NOTES_ROADMAP_PROPOSALS_MAX_ITEMS
      ) {
        return validationError(`${eventPath}.proposedReferences`, "expected up to 20 proposals");
      }
      for (
        let proposalIndex = 0;
        proposalIndex < record.proposedReferences.length;
        proposalIndex += 1
      ) {
        const proposal = record.proposedReferences[proposalIndex];
        const proposalPath = `${eventPath}.proposedReferences[${proposalIndex}]`;
        const proposalError = validateRoadmapProposal(
          proposal,
          proposalPath,
          record.timestamp,
          knownReferenceIds,
        );
        if (proposalError) return proposalError;
        const typed = proposal as NotesRoadmapReferenceProposal;
        if (proposalIds.has(typed.id)) {
          return validationError(`${proposalPath}.id`, `duplicate ID: ${typed.id}`);
        }
        proposalIds.add(typed.id);
        if (typed.disposition === "pending") pendingProposalIds.add(typed.id);
      }
      continue;
    }

    if (record.type === "reference-decision") {
      if (!isRecordWithKeys(record, ROADMAP_REFERENCE_DECISION_KEYS)) {
        return validationError(eventPath, "invalid reference decision");
      }
      if (!isNonEmptyString(record.proposalId) || !pendingProposalIds.has(record.proposalId)) {
        return validationError(`${eventPath}.proposalId`, "expected a prior pending proposal ID");
      }
      if (decidedProposalIds.has(record.proposalId)) {
        return validationError(`${eventPath}.proposalId`, "proposal already has a decision");
      }
      if (!isNotesReviewDecision(record.decision)) {
        return validationError(`${eventPath}.decision`, "expected accepted or rejected");
      }
      if (record.decision === "accepted") {
        if (!isNonEmptyString(record.referenceId) || !knownReferenceIds.has(record.referenceId)) {
          return validationError(
            `${eventPath}.referenceId`,
            "accepted decisions require a known reference ID",
          );
        }
      } else if (record.referenceId !== null) {
        return validationError(
          `${eventPath}.referenceId`,
          "rejected decisions cannot attach a reference",
        );
      }
      decidedProposalIds.add(record.proposalId);
      continue;
    }

    if (record.type === "override-reset") {
      if (!isRecordWithKeys(record, ROADMAP_OVERRIDE_RESET_KEYS)) {
        return validationError(eventPath, "invalid override reset");
      }
      if (record.field !== "status" && record.field !== "references") {
        return validationError(`${eventPath}.field`, "expected status or references");
      }
      continue;
    }

    if (record.type === "implementation-checkpoint") {
      if (!isRecordWithKeys(record, ROADMAP_IMPLEMENTATION_CHECKPOINT_KEYS)) {
        return validationError(eventPath, "invalid implementation checkpoint");
      }
      const sessionError = validateNotesSessionLink(record.session, `${eventPath}.session`);
      if (sessionError || record.session === null) {
        return (
          sessionError ?? validationError(`${eventPath}.session`, "a bound session is required")
        );
      }
      const checkpointIssue = validateNotesImplementationCheckpointFields({
        planStepTotal: record.planStepTotal,
        completedPlanSteps: record.completedPlanSteps,
        runOutcome: record.runOutcome,
      });
      if (checkpointIssue?.code === "not-positive-integer") {
        return validationError(`${eventPath}.planStepTotal`, "expected a positive integer");
      }
      if (checkpointIssue?.code === "not-array") {
        return validationError(`${eventPath}.completedPlanSteps`, "expected a sorted step array");
      }
      if (checkpointIssue?.code === "invalid-step") {
        return validationError(
          `${eventPath}.completedPlanSteps[${checkpointIssue.index}]`,
          "expected unique ascending steps within the plan total",
        );
      }
      if (checkpointIssue?.code === "unknown-run-outcome") {
        return validationError(`${eventPath}.runOutcome`, "unknown implementation run outcome");
      }
      implementationCheckpoints.set(
        record.id,
        record as unknown as NotesRoadmapImplementationCheckpoint,
      );
      implementationCheckpointIndexes.set(record.id, index);
      continue;
    }

    if (record.type === "completion-review") {
      if (!isRecordWithKeys(record, ROADMAP_COMPLETION_REVIEW_KEYS)) {
        return validationError(eventPath, "invalid completion review");
      }
      if (!isNotesRoadmapReviewer(record.reviewer)) {
        return validationError(`${eventPath}.reviewer`, "expected Supah or Autopilot Supah");
      }
      const reviewIssue = validateNotesCompletionReviewFields({
        decision: record.decision,
        evidence: record.evidence,
        reason: record.reason,
      });
      if (reviewIssue?.code === "unknown-decision") {
        return validationError(`${eventPath}.decision`, "expected accepted or rejected");
      }
      if (reviewIssue?.code === "invalid-evidence") {
        return validationError(`${eventPath}.evidence`, "expected up to 20 bounded evidence items");
      }
      if (reviewIssue?.code === "accepted-requires-evidence") {
        return validationError(`${eventPath}.evidence`, "accepted reviews require evidence");
      }
      if (reviewIssue?.code === "invalid-reason") {
        return validationError(`${eventPath}.reason`, "expected a bounded reason or null");
      }
      if (reviewIssue?.code === "rejected-requires-reason") {
        return validationError(`${eventPath}.reason`, "rejected reviews require a reason");
      }
      if (
        record.implementationCheckpointId !== null &&
        (!isNonEmptyString(record.implementationCheckpointId) ||
          !implementationCheckpoints.has(record.implementationCheckpointId))
      ) {
        return validationError(
          `${eventPath}.implementationCheckpointId`,
          "expected a prior implementation checkpoint ID or null",
        );
      }
      if (
        record.verificationStatusUpdateId !== null &&
        (!isNonEmptyString(record.verificationStatusUpdateId) ||
          !verificationUpdates.has(record.verificationStatusUpdateId))
      ) {
        return validationError(
          `${eventPath}.verificationStatusUpdateId`,
          "expected a prior typed verification update ID or null",
        );
      }
      if (typeof record.acceptsVerificationException !== "boolean") {
        return validationError(`${eventPath}.acceptsVerificationException`, "expected a boolean");
      }
      if (
        record.acceptsVerificationException &&
        (record.verificationStatusUpdateId === null ||
          verificationUpdates.get(record.verificationStatusUpdateId)?.verification !==
            "exception-requested")
      ) {
        return validationError(
          `${eventPath}.acceptsVerificationException`,
          "can only accept a referenced verification exception",
        );
      }
      if (!isNotesCompletionGateOutcome(record.gateOutcome)) {
        return validationError(`${eventPath}.gateOutcome`, "unknown completion gate outcome");
      }
      if (
        !Array.isArray(record.unmetGateCodes) ||
        record.unmetGateCodes.length > NOTES_COMPLETION_UNMET_GATE_CODES_MAX_ITEMS
      ) {
        return validationError(`${eventPath}.unmetGateCodes`, "expected up to 20 unmet gate codes");
      }
      const unmetCodes = new Set<string>();
      for (let gateIndex = 0; gateIndex < record.unmetGateCodes.length; gateIndex += 1) {
        const gate = record.unmetGateCodes[gateIndex];
        if (!isNotesCompletionUnmetGateCode(gate) || unmetCodes.has(gate)) {
          return validationError(
            `${eventPath}.unmetGateCodes[${gateIndex}]`,
            "expected a unique known completion gate code",
          );
        }
        unmetCodes.add(gate);
      }
      if (record.gateOutcome === "done") {
        const implementationCheckpoint =
          typeof record.implementationCheckpointId === "string"
            ? implementationCheckpoints.get(record.implementationCheckpointId)
            : undefined;
        const verificationStatusUpdate =
          typeof record.verificationStatusUpdateId === "string"
            ? verificationUpdates.get(record.verificationStatusUpdateId)
            : undefined;
        const hasCompleteSuccessfulImplementation =
          implementationCheckpoint !== undefined &&
          implementationCheckpoint.runOutcome === "succeeded" &&
          implementationCheckpoint.completedPlanSteps.length ===
            implementationCheckpoint.planStepTotal &&
          implementationCheckpoint.completedPlanSteps.every((step, index) => step === index + 1);
        const hasAcceptedVerification =
          (verificationStatusUpdate?.verification === "passed" &&
            !record.acceptsVerificationException) ||
          (verificationStatusUpdate?.verification === "exception-requested" &&
            record.acceptsVerificationException);
        const hasFreshReviewRoundEvidence =
          implementationCheckpoint !== undefined &&
          verificationStatusUpdate !== undefined &&
          (implementationCheckpointIndexes.get(implementationCheckpoint.id) ?? -1) >
            latestRejectedReviewIndex &&
          (verificationUpdateIndexes.get(verificationStatusUpdate.id) ?? -1) >
            latestRejectedReviewIndex;
        const hasCurrentSessionEvidence =
          implementationCheckpoint !== undefined &&
          notesSessionLinksEqual(implementationCheckpoint.session, phaseSession) &&
          notesSessionLinksEqual(
            verificationStatusUpdate?.verificationSession ?? null,
            phaseSession,
          );
        if (
          record.decision !== "accepted" ||
          !hasCompleteSuccessfulImplementation ||
          !hasAcceptedVerification ||
          !hasFreshReviewRoundEvidence ||
          !hasCurrentSessionEvidence ||
          record.unmetGateCodes.length > 0
        ) {
          return validationError(
            eventPath,
            "Done requires accepted review evidence, a successful complete implementation checkpoint, passed verification or an accepted verification exception, evidence matching the current phase session, and no unmet gates",
          );
        }
      }
      if (record.decision === "rejected") latestRejectedReviewIndex = index;
      continue;
    }

    return validationError(`${eventPath}.type`, "unknown roadmap event type");
  }
  return null;
}

function validateRoadmapProposal(
  value: unknown,
  pathPrefix: string,
  timestamp: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!isRecordWithKeys(value, ROADMAP_PROPOSAL_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${ROADMAP_PROPOSAL_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "proposal ID is required");
  const referenceError = validateReference(
    {
      id: value.id,
      provider: value.provider,
      tool: value.tool,
      canonicalUrl: value.canonicalUrl,
      owner: value.owner,
      repo: value.repo,
      revision: value.revision,
      path: value.path,
      range: value.range,
      issue: value.issue,
      pullRequest: value.pullRequest,
      query: value.query,
      anchor: value.anchor,
      relevance: value.relevance,
      capturedAt: timestamp,
    },
    pathPrefix,
  );
  if (referenceError) return referenceError;
  if (
    value.disposition !== "pending" &&
    value.disposition !== "accepted" &&
    value.disposition !== "reused"
  ) {
    return validationError(`${pathPrefix}.disposition`, "expected pending, accepted, or reused");
  }
  if (!isNotesRoadmapReferencePolicyOutcome(value.policyOutcome)) {
    return validationError(
      `${pathPrefix}.policyOutcome`,
      "expected manual-review, reference-override-protected, accepted, or reused",
    );
  }
  const expectedDisposition =
    value.policyOutcome === "manual-review" ||
    value.policyOutcome === "reference-override-protected"
      ? "pending"
      : value.policyOutcome;
  if (value.disposition !== expectedDisposition) {
    return validationError(`${pathPrefix}.policyOutcome`, "must match the proposal disposition");
  }
  if (value.disposition === "accepted" || value.disposition === "reused") {
    if (!isNonEmptyString(value.referenceId) || !knownReferenceIds.has(value.referenceId)) {
      return validationError(
        `${pathPrefix}.referenceId`,
        "accepted or reused proposals require a known reference ID",
      );
    }
  } else if (value.referenceId !== null) {
    return validationError(
      `${pathPrefix}.referenceId`,
      "pending proposals cannot attach a reference",
    );
  }
  return null;
}

function invalid(path: string, message: string): NotesValidationResult {
  return { ok: false, error: validationError(path, message) };
}

function validationError(path: string, message: string): NotesValidationError {
  return { path, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
  return isNonEmptyString(value) && value.length <= maximum;
}

function isReferenceMetadataTooLong(value: unknown): boolean {
  return typeof value === "string" && value.length > NOTES_REFERENCE_METADATA_MAX_LENGTH;
}

function referenceMetadataLengthError(pathPrefix: string): NotesValidationError {
  return validationError(
    pathPrefix,
    `expected ${NOTES_REFERENCE_METADATA_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
  );
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

export function normalizeCanonicalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    if (url.pathname === "/") url.pathname = "";
    else url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function canonicalReferenceIdentity(
  reference: Pick<NotesReference, "provider" | "canonicalUrl">,
): string | null {
  const url = normalizeCanonicalUrl(reference.canonicalUrl);
  const provider = reference.provider.trim().toLowerCase();
  return provider && url ? `${provider}\n${url}` : null;
}

function isCanonicalHttpUrl(value: unknown): value is string {
  return typeof value === "string" && normalizeCanonicalUrl(value) !== null;
}

function isNotesTask(value: unknown): value is NotesTask {
  return (
    isRecordWithKeys(value, TASK_KEYS) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.status === "todo" || value.status === "done") &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.completedAt) &&
    isNullableTimestamp(value.archivedAt)
  );
}

function isNotesHandoff(value: unknown): value is NotesHandoff {
  return (
    isRecordWithKeys(value, HANDOFF_KEYS) &&
    typeof value.text === "string" &&
    isNullableTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.readAt)
  );
}

function isRecordWithKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
