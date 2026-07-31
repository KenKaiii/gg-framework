import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "@kenkaiiii/gg-core";
import {
  canonicalProjectKey,
  canonicalReferenceIdentity,
  classifyLegacyNotesLifecycleEvent,
  isNotesLifecycleEventSource,
  isNotesPhaseStatus,
  isNotesReminderDeliveryChannel,
  isNotesReminderPermission,
  isNotesRoadmapReviewer,
  isValidNotesReminderDeliveryPair,
  migrateNotesDocumentV2,
  migrateNotesDocumentV3PhaseShape,
  normalizeCanonicalUrl,
  notesPhaseStatusForRoadmapTransition,
  notesSessionLinksEqual,
  validateNotesCompletionReviewFields,
  validateNotesDocumentV3,
  validateNotesImplementationCheckpointFields,
  type NotesDocumentV3,
  type NotesImplementationRunOutcome,
  type NotesLifecycleEventKind,
  type NotesLifecycleEventSource,
  type NotesPhase,
  type NotesPhaseStatus,
  type NotesReference,
  type NotesReminderDeliveryChannel,
  type NotesReminderPermission,
  type NotesReviewDecision,
  type NotesRoadmapActor,
  type NotesRoadmapCompletionReview,
  type NotesRoadmapImplementationCheckpoint,
  type NotesRoadmapReferencePolicyOutcome,
  type NotesRoadmapReferenceProposal,
  type NotesRoadmapReviewer,
  type NotesRoadmapStatusOutcome,
  type NotesRoadmapStatusUpdate,
  type NotesRoadmapTransition,
  type NotesSessionLink,
  type NotesValidationError,
  type NotesValidationResult,
  type NotesVerificationStatus,
  type ProjectNotesCorruptReason,
  type ProjectNotesCorruption,
  type ProjectNotesLoadOutcome,
  type ProjectNotesMigrationOutcome,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
export * from "@kenkaiiii/gg-core/project-notes";
import {
  evaluatePhaseCompletion,
  type PhaseCompletionEvaluation,
} from "./project-notes-completion-policy.js";

export interface StoredProjectNotesV1 {
  storeVersion: 1;
  projectKey: string;
  revision: number;
  document: NotesDocumentV3;
}

export interface ProjectNotesReminderDeliveryRequest {
  phaseId: string;
  occurrenceKey: string;
  attemptedAt: string;
  channel: NotesReminderDeliveryChannel;
  permission: NotesReminderPermission;
}

export type ProjectNotesReminderDeliveryOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | {
      status:
        | "phase-not-found"
        | "phase-inactive"
        | "phase-archived"
        | "reminder-not-found"
        | "stale-occurrence"
        | "not-due"
        | "already-delivered";
    }
  | { status: "invalid"; error: NotesValidationError }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface FrozenPhaseLaunchContext {
  projectKey: string;
  phase: NotesPhase;
  references: NotesReference[];
}

export type ProjectNotesPhaseLaunchOutcome =
  | {
      status: "accepted";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      references: NotesReference[];
      session: NotesSessionLink;
    }
  | {
      status: "already-bound";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      references: NotesReference[];
      session: NotesSessionLink;
    }
  | { status: "phase-not-found" }
  | { status: "phase-archived" }
  | { status: "done-terminal" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesPhaseLinkOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | { status: "phase-not-found" }
  | { status: "phase-archived" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type NotesAutomaticPhaseStatus = Exclude<NotesPhaseStatus, "not-started" | "done">;

export interface ProjectNotesPhaseLifecycleTransition {
  status: NotesAutomaticPhaseStatus;
  source: NotesLifecycleEventSource;
  reason: string;
  timestamp: string;
  kind?: NotesLifecycleEventKind;
  expectedSession?: NotesSessionLink | null;
}

export type ProjectNotesPhaseLifecycleOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | {
      status: "manual-override";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
    }
  | {
      status:
        | "same-status"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "done-terminal";
    }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesRoadmapStatusRequest {
  updateId: string;
  phaseId: string;
  expectedRevision?: number;
  actor: NotesRoadmapActor;
  transition: NotesRoadmapTransition;
  progress: string;
  blocker: string | null;
  evidence: string[];
  verification: NotesVerificationStatus | null;
  verificationReason: string | null;
  proposedReferences: Array<Omit<NotesReference, "id" | "capturedAt">>;
  timestamp: string;
  expectedSession?: NotesSessionLink | null;
  requireBoundPhase?: boolean;
  autopilotEnabled: boolean;
}

export interface ProjectNotesRoadmapProposalOutcome {
  proposalId: string;
  outcome: "pending" | "accepted" | "reused";
  policyOutcome: NotesRoadmapReferencePolicyOutcome;
  referenceId: string | null;
}

export interface ProjectNotesImplementationCheckpointRequest {
  checkpointId: string;
  phaseId: string;
  expectedSession: NotesSessionLink;
  planStepTotal: number;
  completedPlanSteps: number[];
  runOutcome: NotesImplementationRunOutcome;
  timestamp: string;
}

export type ProjectNotesImplementationCheckpointOutcome =
  | { status: "committed"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | { status: "duplicate"; revision: number; phaseId: string }
  | { status: "duplicate-id-conflict"; revision: number }
  | { status: "invalid-checkpoint"; message: string }
  | { status: "phase-not-found" | "phase-archived" | "stale-session" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesCompletionReviewRequest {
  reviewId: string;
  phaseId: string;
  expectedSession: NotesSessionLink;
  reviewer: NotesRoadmapReviewer;
  decision: NotesReviewDecision;
  evidence: string[];
  reason: string | null;
  acceptsVerificationException: boolean;
  timestamp: string;
}

export type ProjectNotesCompletionReviewOutcome =
  | {
      status: "committed";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      evaluation: PhaseCompletionEvaluation;
    }
  | {
      status: "duplicate";
      revision: number;
      phaseId: string;
      evaluation: PhaseCompletionEvaluation;
    }
  | { status: "duplicate-id-conflict"; revision: number }
  | { status: "invalid-review"; message: string }
  | { status: "phase-not-found" | "phase-archived" | "stale-session" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesRoadmapFinalReviewRequest {
  statusUpdate: ProjectNotesRoadmapStatusRequest;
  review: Omit<
    ProjectNotesCompletionReviewRequest,
    "phaseId" | "expectedSession" | "reviewer" | "timestamp"
  >;
}

export type ProjectNotesRoadmapFinalReviewOutcome =
  | {
      status: "committed";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
      evaluation: PhaseCompletionEvaluation;
    }
  | {
      status: "duplicate";
      revision: number;
      phaseId: string;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
      evaluation: PhaseCompletionEvaluation;
    }
  | { status: "duplicate-id-conflict" | "stale-revision"; revision: number }
  | { status: "invalid-review"; message: string }
  | {
      status: "phase-not-found" | "phase-archived" | "phase-not-bound" | "stale-session";
    }
  | { status: "invalid-reference"; path: string; message: string }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesRoadmapStatusOutcome =
  | {
      status: "committed";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
    }
  | {
      status: "duplicate";
      revision: number;
      phaseId: string;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
    }
  | { status: "duplicate-id-conflict"; revision: number }
  | { status: "stale-revision"; revision: number }
  | {
      status: "phase-not-found" | "phase-archived" | "phase-not-bound" | "stale-session";
    }
  | { status: "invalid-reference"; path: string; message: string }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesPaths {
  directory: string;
  primary: string;
  backup: string;
  lock: string;
}

export interface ProjectNotesFileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ProjectNotesFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  open(path: string, flags: "r" | "r+"): Promise<ProjectNotesFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ProjectNotesRepositoryOptions {
  fileSystem?: ProjectNotesFileSystem;
  lock?: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
  createId?: () => string;
}

type Candidate =
  | { status: "missing" }
  | { status: "invalid"; reason: ProjectNotesCorruptReason }
  | { status: "valid"; envelope: StoredProjectNotesV1; migratedFromV2: boolean };

type CurrentState =
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | {
      status: "ok";
      envelope: StoredProjectNotesV1;
      source: "primary" | "backup";
      migratedFromV2: boolean;
    };

type UnavailableCurrentState = Exclude<CurrentState, { status: "ok" }>;

interface CommitDocumentOptions {
  validationMode: "trusted" | "validated";
  context: string;
}

export const NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH = 240;

const STORE_DIRECTORY = "project-notes";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EISDIR",
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);
const ENVELOPE_KEYS = ["storeVersion", "projectKey", "revision", "document"];

export function projectNotesHash(projectKey: string): string {
  return createHash("sha256").update(projectKey, "utf8").digest("hex");
}

export function projectNotesPaths(agentDir: string, cwd: string): ProjectNotesPaths {
  const projectKey = canonicalProjectKey(cwd);
  const directory = path.join(agentDir, STORE_DIRECTORY);
  const primary = path.join(directory, `${projectNotesHash(projectKey)}.json`);
  return {
    directory,
    primary,
    backup: path.join(directory, `${projectNotesHash(projectKey)}.backup.json`),
    lock: `${primary}.lock`,
  };
}

function coerceNotesDocumentV3(value: unknown): NotesValidationResult & {
  migratedLegacyShape?: boolean;
} {
  const current = validateNotesDocumentV3(value);
  if (current.ok) return { ...current, migratedLegacyShape: false };
  if (typeof value === "object" && value !== null && "version" in value && value.version === 2) {
    const migrated = migrateNotesDocumentV2(value);
    return { ...migrated, migratedLegacyShape: migrated.ok };
  }
  const migrated = migrateNotesDocumentV3PhaseShape(value);
  return migrated.ok ? { ...migrated, migratedLegacyShape: true } : migrated;
}

function validationError(path: string, message: string): NotesValidationError {
  return { path, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSession(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, ["sessionId", "sessionPath"])) {
    return validationError(pathPrefix, "expected sessionId and sessionPath or null");
  }
  if (!isNonEmptyString(value.sessionId)) {
    return validationError(`${pathPrefix}.sessionId`, "session ID is required");
  }
  if (value.sessionPath !== null && !isNonEmptyString(value.sessionPath)) {
    return validationError(`${pathPrefix}.sessionPath`, "expected a non-empty path or null");
  }
  return null;
}

function validateImmutableReferenceCapturedAt(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.references.map((reference) => [reference.id, reference]));
  for (let index = 0; index < next.references.length; index += 1) {
    const nextReference = next.references[index]!;
    const previousReference = previousById.get(nextReference.id);
    if (previousReference && previousReference.capturedAt !== nextReference.capturedAt) {
      return validationError(
        `references[${index}].capturedAt`,
        "existing reference capture time cannot be changed",
      );
    }
  }
  return null;
}

function validateAppendOnlyLifecycleEvents(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const nextById = new Map(next.phases.map((phase, index) => [phase.id, { phase, index }]));
  for (const previousPhase of previous.phases) {
    const current = nextById.get(previousPhase.id);
    if (!current) {
      if (previousPhase.lifecycleEvents.length > 0) {
        return validationError(
          `phases.${previousPhase.id}.lifecycleEvents`,
          "cannot remove a phase with lifecycle history",
        );
      }
      continue;
    }
    if (current.phase.lifecycleEvents.length < previousPhase.lifecycleEvents.length) {
      return validationError(
        `phases[${current.index}].lifecycleEvents`,
        "lifecycle events are append-only",
      );
    }
    for (let index = 0; index < previousPhase.lifecycleEvents.length; index += 1) {
      if (
        !isDeepStrictEqual(
          current.phase.lifecycleEvents[index],
          previousPhase.lifecycleEvents[index],
        )
      ) {
        return validationError(
          `phases[${current.index}].lifecycleEvents[${index}]`,
          "existing lifecycle events cannot be changed",
        );
      }
    }
  }
  return null;
}

function validateAppendOnlyRoadmapEvents(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const nextById = new Map(next.phases.map((phase, index) => [phase.id, { phase, index }]));
  for (const previousPhase of previous.phases) {
    const current = nextById.get(previousPhase.id);
    if (!current) {
      if (previousPhase.roadmapEvents.length > 0) {
        return validationError(
          `phases.${previousPhase.id}.roadmapEvents`,
          "cannot remove a phase with roadmap history",
        );
      }
      continue;
    }
    if (current.phase.roadmapEvents.length < previousPhase.roadmapEvents.length) {
      return validationError(
        `phases[${current.index}].roadmapEvents`,
        "roadmap events are append-only",
      );
    }
    for (let index = 0; index < previousPhase.roadmapEvents.length; index += 1) {
      if (
        !isDeepStrictEqual(current.phase.roadmapEvents[index], previousPhase.roadmapEvents[index])
      ) {
        return validationError(
          `phases[${current.index}].roadmapEvents[${index}]`,
          "existing roadmap events and proposals cannot be changed",
        );
      }
    }
  }
  return null;
}

function validateGenericSaveEventSuffixes(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  for (let phaseIndex = 0; phaseIndex < next.phases.length; phaseIndex += 1) {
    const phase = next.phases[phaseIndex]!;
    const previousPhase = previousById.get(phase.id);
    const lifecyclePrefixLength = previousPhase?.lifecycleEvents.length ?? 0;
    for (
      let eventIndex = lifecyclePrefixLength;
      eventIndex < phase.lifecycleEvents.length;
      eventIndex += 1
    ) {
      const event = phase.lifecycleEvents[eventIndex]!;
      const pending = previousPhase?.pendingAutomaticLifecycleTransition;
      const appliesPendingReset =
        previousPhase !== undefined &&
        pending !== null &&
        pending !== undefined &&
        phase.pendingAutomaticLifecycleTransition === null &&
        previousPhase.overrides.status !== null &&
        phase.overrides.status === null &&
        previousPhase.status !== "done" &&
        notesSessionLinksEqual(previousPhase.session, pending.expectedSession) &&
        event.fromStatus === previousPhase.status &&
        event.toStatus === pending.status &&
        event.source === pending.source &&
        event.reason === pending.reason &&
        event.kind === pending.kind &&
        Date.parse(event.timestamp) >= Date.parse(pending.timestamp);
      if (event.source !== "user" && !appliesPendingReset) {
        return validationError(
          `phases[${phaseIndex}].lifecycleEvents[${eventIndex}].source`,
          "generic saves may only append user lifecycle events or apply a pending automatic transition",
        );
      }
    }

    const roadmapPrefixLength = previousPhase?.roadmapEvents.length ?? 0;
    for (
      let eventIndex = roadmapPrefixLength;
      eventIndex < phase.roadmapEvents.length;
      eventIndex += 1
    ) {
      const event = phase.roadmapEvents[eventIndex]!;
      if (event.type !== "reference-decision" && event.type !== "override-reset") {
        return validationError(
          `phases[${phaseIndex}].roadmapEvents[${eventIndex}].type`,
          "privileged roadmap events require their dedicated authority path",
        );
      }
    }
  }
  return null;
}

function validateGenericSavePendingLifecycleAuthority(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  const nextById = new Map(next.phases.map((phase, index) => [phase.id, { phase, index }]));
  for (const [index, phase] of next.phases.entries()) {
    if (!previousById.has(phase.id) && phase.pendingAutomaticLifecycleTransition !== null) {
      return validationError(
        `phases[${index}].pendingAutomaticLifecycleTransition`,
        "pending automatic lifecycle state is repository-owned",
      );
    }
  }
  for (const previousPhase of previous.phases) {
    const current = nextById.get(previousPhase.id);
    if (!current) continue;
    const previousPending = previousPhase.pendingAutomaticLifecycleTransition;
    const nextPending = current.phase.pendingAutomaticLifecycleTransition;
    const pathPrefix = `phases[${current.index}].pendingAutomaticLifecycleTransition`;
    if (previousPending === null) {
      if (nextPending !== null) {
        return validationError(pathPrefix, "pending automatic lifecycle state is repository-owned");
      }
      continue;
    }
    if (isDeepStrictEqual(previousPending, nextPending)) continue;
    if (nextPending !== null) {
      return validationError(pathPrefix, "pending automatic lifecycle state is repository-owned");
    }
    const appendedRoadmapEvents = current.phase.roadmapEvents.slice(
      previousPhase.roadmapEvents.length,
    );
    const hasStatusReset = appendedRoadmapEvents.some(
      (event) => event.type === "override-reset" && event.field === "status",
    );
    if (
      previousPhase.overrides.status === null ||
      current.phase.overrides.status !== null ||
      !hasStatusReset
    ) {
      return validationError(pathPrefix, "can only be cleared by a status override reset");
    }
    const appliesPending =
      previousPhase.status !== "done" &&
      notesSessionLinksEqual(previousPhase.session, previousPending.expectedSession);
    if (!appliesPending) continue;
    if (current.phase.status !== previousPending.status) {
      return validationError(`${pathPrefix}.status`, "status reset must apply the pending target");
    }
    const appendedLifecycleEvents = current.phase.lifecycleEvents.slice(
      previousPhase.lifecycleEvents.length,
    );
    if (previousPhase.status === previousPending.status) {
      if (appendedLifecycleEvents.length !== 0) {
        return validationError(
          pathPrefix,
          "same-status reset cannot append a lifecycle transition",
        );
      }
      continue;
    }
    if (appendedLifecycleEvents.length !== 1) {
      return validationError(
        pathPrefix,
        "status reset must append one pending lifecycle transition",
      );
    }
    const event = appendedLifecycleEvents[0]!;
    if (
      event.fromStatus !== previousPhase.status ||
      event.toStatus !== previousPending.status ||
      event.source !== previousPending.source ||
      event.reason !== previousPending.reason ||
      event.kind !== previousPending.kind ||
      Date.parse(event.timestamp) < Date.parse(previousPending.timestamp)
    ) {
      return validationError(
        pathPrefix,
        "status reset lifecycle transition must match the pending provenance",
      );
    }
  }
  return null;
}

function validateGenericSaveReminderAuthority(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  for (let phaseIndex = 0; phaseIndex < next.phases.length; phaseIndex += 1) {
    const phase = next.phases[phaseIndex]!;
    const currentReminder = phase.reminder;
    if (currentReminder === null) continue;
    const previousReminder = previousById.get(phase.id)?.reminder ?? null;
    const pathPrefix = `phases[${phaseIndex}].reminder`;

    if (previousReminder === null) {
      if (currentReminder.lastDelivery !== null) {
        return validationError(
          `${pathPrefix}.lastDelivery`,
          "new reminders cannot supply delivery evidence",
        );
      }
      continue;
    }

    if (currentReminder.id !== previousReminder.id) {
      return validationError(`${pathPrefix}.id`, "existing reminder ID cannot be changed");
    }
    if (currentReminder.occurrenceKey === previousReminder.occurrenceKey) {
      if (!isDeepStrictEqual(currentReminder.lastDelivery, previousReminder.lastDelivery)) {
        return validationError(
          `${pathPrefix}.lastDelivery`,
          "delivery evidence is repository-owned",
        );
      }
      continue;
    }
    if (!isDeepStrictEqual(currentReminder.lastDelivery, previousReminder.lastDelivery)) {
      return validationError(
        `${pathPrefix}.lastDelivery`,
        "a new occurrence must preserve prior delivery evidence",
      );
    }
  }
  return null;
}

function chronologicalLifecycleTimestamp(phase: NotesPhase, requested: string): string {
  const requestedTime = Date.parse(requested);
  if (!Number.isFinite(requestedTime)) {
    throw new Error("Cannot record a phase lifecycle transition with an invalid timestamp.");
  }
  const previousTimes = [
    phase.lifecycleEvents.at(-1)?.timestamp,
    phase.pendingAutomaticLifecycleTransition?.timestamp,
  ]
    .filter((value): value is string => value !== undefined)
    .map(Date.parse);
  return new Date(Math.max(requestedTime, ...previousTimes)).toISOString();
}

function boundedLifecycleReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  const fallback = "Phase lifecycle changed.";
  return (normalized || fallback).slice(0, NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH).trimEnd();
}

function pendingAutomaticLifecycleTransition(
  phase: NotesPhase,
  transition: ProjectNotesPhaseLifecycleTransition,
  timestamp: string,
): NotesPhase["pendingAutomaticLifecycleTransition"] {
  const reason = boundedLifecycleReason(transition.reason);
  return {
    status: transition.status,
    source: transition.source,
    reason,
    kind:
      transition.kind ??
      classifyLegacyNotesLifecycleEvent({
        toStatus: transition.status,
        source: transition.source,
        reason,
      }),
    timestamp,
    expectedSession: structuredClone(
      transition.expectedSession === undefined ? phase.session : transition.expectedSession,
    ),
  };
}

function applyPhaseLifecycleTransition(
  phase: NotesPhase,
  transition: ProjectNotesPhaseLifecycleTransition,
  createId: () => string,
): "updated" | "same-status" | "manual-override" | "done-terminal" {
  if (phase.overrides.status !== null) return "manual-override";
  if (phase.status === "done") return "done-terminal";
  if (phase.status === transition.status) return "same-status";

  const reason = boundedLifecycleReason(transition.reason);
  const fromStatus = phase.status;
  phase.status = transition.status;
  phase.pendingAutomaticLifecycleTransition = null;
  phase.attentionReason = transition.status === "needs-attention" ? reason : null;
  phase.completedAt = transition.status === "cancelled" ? transition.timestamp : null;
  phase.updatedAt = transition.timestamp;
  phase.lifecycleEvents.push({
    id: createId(),
    fromStatus,
    toStatus: transition.status,
    source: transition.source,
    timestamp: transition.timestamp,
    reason,
    kind:
      transition.kind ??
      classifyLegacyNotesLifecycleEvent({
        toStatus: transition.status,
        source: transition.source,
        reason,
      }),
  });
  return "updated";
}

function roadmapStatusOutcome(
  outcome: "updated" | "same-status" | "manual-override" | "done-terminal",
): NotesRoadmapStatusOutcome {
  return outcome === "updated" ? "applied" : outcome;
}

function chronologicalRoadmapTimestamp(phase: NotesPhase, requested: string): string {
  const requestedTime = Date.parse(requested);
  if (!Number.isFinite(requestedTime)) throw new Error("Invalid roadmap status timestamp.");
  const priorTimes = [
    phase.lifecycleEvents.at(-1)?.timestamp,
    phase.roadmapEvents.at(-1)?.timestamp,
    phase.updatedAt,
  ]
    .filter((value): value is string => value !== undefined)
    .map(Date.parse)
    .filter(Number.isFinite);
  return new Date(Math.max(requestedTime, ...priorTimes)).toISOString();
}

function normalizeRoadmapProposedReference(
  proposed: Omit<NotesReference, "id" | "capturedAt">,
): Omit<NotesReference, "id" | "capturedAt"> {
  const canonicalUrl = normalizeCanonicalUrl(proposed.canonicalUrl);
  return {
    ...proposed,
    provider: proposed.provider.trim().toLowerCase(),
    canonicalUrl: canonicalUrl ?? proposed.canonicalUrl.trim(),
    owner: proposed.owner.trim(),
    repo: proposed.repo.trim(),
  };
}

function roadmapProposalOutcome(
  proposal: NotesRoadmapReferenceProposal,
): ProjectNotesRoadmapProposalOutcome {
  return {
    proposalId: proposal.id,
    outcome: proposal.disposition,
    policyOutcome: proposal.policyOutcome,
    referenceId: proposal.referenceId,
  };
}

function validateRoadmapProposedReferences(
  references: Array<Omit<NotesReference, "id" | "capturedAt">>,
  timestamp: string,
): { path: string; message: string } | null {
  for (let index = 0; index < references.length; index += 1) {
    const validation = validateNotesDocumentV3({
      version: 3,
      reference: "",
      currentFocus: "",
      tasks: [],
      handoff: { text: "", updatedAt: null, readAt: null },
      updatedAt: timestamp,
      legacyImportedAt: null,
      phases: [],
      references: [{ ...references[index]!, id: `proposal-${index + 1}`, capturedAt: timestamp }],
    });
    if (!validation.ok) {
      return {
        path: validation.error.path.replace("references[0]", `proposed_references[${index}]`),
        message: validation.error.message,
      };
    }
  }
  return null;
}

function appendRoadmapStatusEvent(
  document: NotesDocumentV3,
  phaseIndex: number,
  request: ProjectNotesRoadmapStatusRequest,
  normalizedReferences: Array<Omit<NotesReference, "id" | "capturedAt">>,
  timestamp: string,
  statusOutcome: NotesRoadmapStatusOutcome,
  createId: () => string,
): NotesRoadmapReferenceProposal[] {
  const phase = document.phases[phaseIndex]!;
  const proposals: NotesRoadmapReferenceProposal[] = [];
  for (const proposed of normalizedReferences) {
    let disposition: NotesRoadmapReferenceProposal["disposition"] = "pending";
    let policyOutcome: NotesRoadmapReferencePolicyOutcome = request.autopilotEnabled
      ? "reference-override-protected"
      : "manual-review";
    let referenceId: string | null = null;
    if (request.autopilotEnabled && phase.overrides.referenceIds === null) {
      const identity = canonicalReferenceIdentity(proposed)!;
      const existing = document.references.find(
        (reference) => canonicalReferenceIdentity(reference) === identity,
      );
      if (existing) {
        referenceId = existing.id;
        disposition = "reused";
        policyOutcome = "reused";
      } else {
        referenceId = createId();
        document.references.push({ ...proposed, id: referenceId, capturedAt: timestamp });
        disposition = "accepted";
        policyOutcome = "accepted";
      }
      if (!phase.referenceIds.includes(referenceId)) phase.referenceIds.push(referenceId);
    }
    proposals.push({
      ...proposed,
      id: createId(),
      disposition,
      policyOutcome,
      referenceId,
    });
  }

  phase.roadmapEvents.push({
    type: "status-update",
    id: request.updateId,
    actor: request.actor,
    transition: request.transition,
    progress: request.progress,
    blocker: request.blocker,
    evidence: [...request.evidence],
    verification: request.verification,
    verificationReason: request.verificationReason,
    verificationSession:
      request.verification === null || phase.session === null ? null : { ...phase.session },
    statusOutcome,
    proposedReferences: proposals,
    timestamp,
  });
  phase.updatedAt = timestamp;
  document.updatedAt = timestamp;
  return proposals;
}

function completionEvaluationFromStoredReview(
  review: NotesRoadmapCompletionReview,
): PhaseCompletionEvaluation {
  return {
    gateOutcome: review.gateOutcome,
    unmetGateCodes: [...review.unmetGateCodes],
    implementationCheckpointId: review.implementationCheckpointId,
    verificationStatusUpdateId: review.verificationStatusUpdateId,
    targetStatus: null,
    reason: review.reason ?? "Final review was already recorded.",
  };
}

function sameImplementationCheckpointPayload(
  event: NotesRoadmapImplementationCheckpoint,
  request: ProjectNotesImplementationCheckpointRequest,
): boolean {
  return isDeepStrictEqual(
    {
      session: event.session,
      planStepTotal: event.planStepTotal,
      completedPlanSteps: event.completedPlanSteps,
      runOutcome: event.runOutcome,
    },
    {
      session: request.expectedSession,
      planStepTotal: request.planStepTotal,
      completedPlanSteps: request.completedPlanSteps,
      runOutcome: request.runOutcome,
    },
  );
}

function sameCompletionReviewPayload(
  event: NotesRoadmapCompletionReview,
  request: ProjectNotesCompletionReviewRequest,
): boolean {
  return isDeepStrictEqual(
    {
      reviewer: event.reviewer,
      decision: event.decision,
      evidence: event.evidence,
      reason: event.reason,
      acceptsVerificationException: event.acceptsVerificationException,
    },
    {
      reviewer: request.reviewer,
      decision: request.decision,
      evidence: request.evidence,
      reason: request.reason,
      acceptsVerificationException: request.acceptsVerificationException,
    },
  );
}

function validateImplementationCheckpointRequest(
  request: ProjectNotesImplementationCheckpointRequest,
): string | null {
  if (!isNonEmptyString(request.checkpointId)) return "Checkpoint ID is required.";
  if (!isTimestamp(request.timestamp)) return "Checkpoint timestamp is invalid.";
  const issue = validateNotesImplementationCheckpointFields(request);
  if (issue?.code === "not-positive-integer") return "Plan step total must be positive.";
  if (issue?.code === "unknown-run-outcome") return "Run outcome is invalid.";
  if (issue?.code === "not-array") return "Completed plan steps must be an array.";
  if (issue?.code === "invalid-step") {
    return "Completed plan steps must be unique, ascending, and within the plan total.";
  }
  return validateSession(request.expectedSession, "expectedSession")?.message ?? null;
}

function validateCompletionReviewRequest(
  request: ProjectNotesCompletionReviewRequest,
): string | null {
  if (!isNonEmptyString(request.reviewId)) return "Review ID is required.";
  if (!isTimestamp(request.timestamp)) return "Review timestamp is invalid.";
  if (!isNotesRoadmapReviewer(request.reviewer)) {
    return "Only Supah or Autopilot Supah may submit a final review.";
  }
  const issue = validateNotesCompletionReviewFields(request);
  if (issue?.code === "unknown-decision") return "Review decision is invalid.";
  if (issue?.code === "invalid-evidence") {
    return "Review evidence must contain up to 20 bounded items.";
  }
  if (issue?.code === "accepted-requires-evidence") {
    return "Accepted reviews require evidence.";
  }
  if (issue?.code === "invalid-reason") return "Review reason must be bounded or null.";
  if (issue?.code === "rejected-requires-reason") {
    return "Rejected reviews require a reason.";
  }
  return validateSession(request.expectedSession, "expectedSession")?.message ?? null;
}

type NormalizedCompletionReviewRequestResult =
  | { ok: true; request: ProjectNotesCompletionReviewRequest }
  | { ok: false; message: string };

function normalizeAndValidateCompletionReviewRequest(
  request: ProjectNotesCompletionReviewRequest,
): NormalizedCompletionReviewRequestResult {
  const normalizedRequest: ProjectNotesCompletionReviewRequest = {
    ...request,
    reason:
      typeof request.reason === "string"
        ? request.reason.replace(/\s+/g, " ").trim()
        : request.reason,
  };
  const invalid = validateCompletionReviewRequest(normalizedRequest);
  return invalid ? { ok: false, message: invalid } : { ok: true, request: normalizedRequest };
}

function applyCompletionEvaluation(
  phase: NotesPhase,
  evaluation: PhaseCompletionEvaluation,
  timestamp: string,
  createId: () => string,
): void {
  if (evaluation.targetStatus === null) return;
  const reason = boundedLifecycleReason(evaluation.reason);
  if (phase.status === evaluation.targetStatus) {
    if (evaluation.targetStatus === "needs-attention") phase.attentionReason = reason;
    return;
  }
  const fromStatus = phase.status;
  phase.status = evaluation.targetStatus;
  phase.attentionReason = evaluation.targetStatus === "needs-attention" ? reason : null;
  phase.completedAt = evaluation.targetStatus === "done" ? timestamp : null;
  phase.lifecycleEvents.push({
    id: createId(),
    fromStatus,
    toStatus: evaluation.targetStatus,
    source: "system",
    timestamp,
    reason,
    kind:
      evaluation.targetStatus === "waiting-for-approval"
        ? "approval-opened"
        : evaluation.targetStatus === "needs-attention"
          ? "attention-generic-opened"
          : "other",
  });
}

type CompletionReviewAppendResult =
  | {
      ok: true;
      document: NotesDocumentV3;
      phase: NotesPhase;
      evaluation: PhaseCompletionEvaluation;
    }
  | { ok: false; message: string };

function buildCompletionReviewAppend(
  sourceDocument: NotesDocumentV3,
  phaseIndex: number,
  request: ProjectNotesCompletionReviewRequest,
  timestamp: string,
  createId: () => string,
): CompletionReviewAppendResult {
  const document = structuredClone(sourceDocument);
  const phase = document.phases[phaseIndex]!;
  const evaluation = evaluatePhaseCompletion({
    phase,
    expectedSession: request.expectedSession,
    review: {
      reviewer: request.reviewer,
      decision: request.decision,
      acceptsVerificationException: request.acceptsVerificationException,
      reason: request.reason,
    },
  });
  if (request.acceptsVerificationException) {
    const verification = phase.roadmapEvents.find(
      (event): event is NotesRoadmapStatusUpdate =>
        event.type === "status-update" && event.id === evaluation.verificationStatusUpdateId,
    );
    if (verification?.verification !== "exception-requested") {
      return {
        ok: false,
        message: "A review can only accept the latest referenced verification exception.",
      };
    }
  }

  phase.roadmapEvents.push({
    type: "completion-review",
    id: request.reviewId,
    reviewer: request.reviewer,
    decision: request.decision,
    evidence: [...request.evidence],
    reason: request.reason,
    implementationCheckpointId: evaluation.implementationCheckpointId,
    verificationStatusUpdateId: evaluation.verificationStatusUpdateId,
    acceptsVerificationException: request.acceptsVerificationException,
    gateOutcome: evaluation.gateOutcome,
    unmetGateCodes: [...evaluation.unmetGateCodes],
    timestamp,
  });
  applyCompletionEvaluation(phase, evaluation, timestamp, createId);
  phase.updatedAt = timestamp;
  document.updatedAt = timestamp;
  return { ok: true, document, phase, evaluation };
}

function sameRoadmapStatusPayload(
  event: NotesRoadmapStatusUpdate,
  request: ProjectNotesRoadmapStatusRequest,
): boolean {
  const storedReferences = event.proposedReferences.map(
    ({
      id: _id,
      disposition: _disposition,
      policyOutcome: _policyOutcome,
      referenceId: _referenceId,
      ...reference
    }) => reference,
  );
  return isDeepStrictEqual(
    {
      actor: event.actor,
      transition: event.transition,
      progress: event.progress,
      blocker: event.blocker,
      evidence: event.evidence,
      verification: event.verification,
      verificationReason: event.verificationReason,
      proposedReferences: storedReferences,
    },
    {
      actor: request.actor,
      transition: request.transition,
      progress: request.progress,
      blocker: request.blocker,
      evidence: request.evidence,
      verification: request.verification,
      verificationReason: request.verificationReason,
      proposedReferences: request.proposedReferences,
    },
  );
}

export class ProjectNotesRepository {
  private readonly fileSystem: ProjectNotesFileSystem;
  private readonly lock: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
  private readonly createId: () => string;

  constructor(
    private readonly agentDir: string,
    options: ProjectNotesRepositoryOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? fs;
    this.lock = options.lock ?? withFileLock;
    this.createId = options.createId ?? randomUUID;
  }

  paths(cwd: string): ProjectNotesPaths {
    return projectNotesPaths(this.agentDir, cwd);
  }

  async load(cwd: string): Promise<ProjectNotesLoadOutcome> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    const initial = await this.readCurrent(paths, projectKey);
    if (initial.status === "missing" || initial.status === "corrupt") return initial;
    if (initial.source === "primary" && !initial.migratedFromV2) {
      return { status: "ok", snapshot: toSnapshot(initial.envelope), recoveredFromBackup: false };
    }

    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const recoveredFromBackup = current.source === "backup";
      if (current.source === "primary" && !current.migratedFromV2) {
        return { status: "ok", snapshot: toSnapshot(current.envelope), recoveredFromBackup: false };
      }
      const serialized = serializeEnvelope(current.envelope);
      if (current.migratedFromV2) await this.atomicWrite(paths.backup, serialized);
      await this.atomicWrite(paths.primary, serialized);
      return { status: "ok", snapshot: toSnapshot(current.envelope), recoveredFromBackup };
    });
  }

  async migrate(cwd: string, document: unknown): Promise<ProjectNotesMigrationOutcome> {
    const validated = coerceNotesDocumentV3(document);
    if (!validated.ok) return { status: "invalid", error: validated.error };
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);

    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "corrupt") return current;
      if (current.status === "ok") {
        if (current.source === "backup" || current.migratedFromV2) {
          const serialized = serializeEnvelope(current.envelope);
          if (current.migratedFromV2) await this.atomicWrite(paths.backup, serialized);
          await this.atomicWrite(paths.primary, serialized);
        }
        return { status: "ok", snapshot: toSnapshot(current.envelope), migrated: false };
      }

      const envelope: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: 1,
        document: validated.document,
      };
      const serialized = serializeEnvelope(envelope);
      await this.atomicWrite(paths.backup, serialized);
      await this.atomicWrite(paths.primary, serialized);
      return { status: "ok", snapshot: toSnapshot(envelope), migrated: true };
    });
  }

  async save(
    cwd: string,
    expectedRevision: number,
    document: unknown,
  ): Promise<ProjectNotesSaveOutcome> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return {
        status: "invalid",
        error: validationError("expectedRevision", "expected a non-negative integer"),
      };
    }
    const validated = coerceNotesDocumentV3(document);
    if (!validated.ok) return { status: "invalid", error: validated.error };
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);

    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      if (current.envelope.revision !== expectedRevision) {
        return { status: "conflict", snapshot: toSnapshot(current.envelope) };
      }
      const capturedAtError = validateImmutableReferenceCapturedAt(
        current.envelope.document,
        validated.document,
      );
      if (capturedAtError) return { status: "invalid", error: capturedAtError };
      const appendOnlyError = validateAppendOnlyLifecycleEvents(
        current.envelope.document,
        validated.document,
      );
      if (appendOnlyError) return { status: "invalid", error: appendOnlyError };
      const roadmapAppendOnlyError = validateAppendOnlyRoadmapEvents(
        current.envelope.document,
        validated.document,
      );
      if (roadmapAppendOnlyError) return { status: "invalid", error: roadmapAppendOnlyError };
      const eventAuthorityError = validateGenericSaveEventSuffixes(
        current.envelope.document,
        validated.document,
      );
      if (eventAuthorityError) return { status: "invalid", error: eventAuthorityError };
      const pendingLifecycleAuthorityError = validateGenericSavePendingLifecycleAuthority(
        current.envelope.document,
        validated.document,
      );
      if (pendingLifecycleAuthorityError) {
        return { status: "invalid", error: pendingLifecycleAuthorityError };
      }
      const reminderAuthorityError = validateGenericSaveReminderAuthority(
        current.envelope.document,
        validated.document,
      );
      if (reminderAuthorityError) return { status: "invalid", error: reminderAuthorityError };

      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: expectedRevision + 1,
        document: validated.document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return { status: "ok", snapshot: toSnapshot(next) };
    });
  }

  async recordReminderDelivery(
    cwd: string,
    request: ProjectNotesReminderDeliveryRequest,
  ): Promise<ProjectNotesReminderDeliveryOutcome> {
    if (!isNonEmptyString(request.phaseId)) {
      return {
        status: "invalid",
        error: validationError("phaseId", "phase ID is required"),
      };
    }
    if (!isNonEmptyString(request.occurrenceKey)) {
      return {
        status: "invalid",
        error: validationError("occurrenceKey", "occurrence key is required"),
      };
    }
    if (!isTimestamp(request.attemptedAt)) {
      return {
        status: "invalid",
        error: validationError("attemptedAt", "expected an ISO timestamp"),
      };
    }
    if (!isNotesReminderDeliveryChannel(request.channel)) {
      return {
        status: "invalid",
        error: validationError("channel", "unknown delivery channel"),
      };
    }
    if (!isNotesReminderPermission(request.permission)) {
      return {
        status: "invalid",
        error: validationError("permission", "unknown notification permission"),
      };
    }
    if (!isValidNotesReminderDeliveryPair(request.channel, request.permission)) {
      return {
        status: "invalid",
        error: validationError("permission", "permission does not match delivery channel"),
      };
    }

    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (currentPhase.status === "done" || currentPhase.status === "cancelled") {
        return { status: "phase-inactive" };
      }
      const currentReminder = currentPhase.reminder;
      if (currentReminder === null) return { status: "reminder-not-found" };
      if (currentReminder.occurrenceKey !== request.occurrenceKey) {
        return { status: "stale-occurrence" };
      }
      if (currentReminder.lastDelivery?.occurrenceKey === request.occurrenceKey) {
        return { status: "already-delivered" };
      }
      if (Date.parse(currentReminder.dueAt) > Date.parse(request.attemptedAt)) {
        return { status: "not-due" };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.reminder!.lastDelivery = {
        occurrenceKey: request.occurrenceKey,
        attemptedAt: request.attemptedAt,
        channel: request.channel,
        permission: request.permission,
      };
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Reminder delivery created invalid Notes",
      });
      return {
        status: "ok",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async recordRoadmapStatusUpdate(
    cwd: string,
    request: ProjectNotesRoadmapStatusRequest,
  ): Promise<ProjectNotesRoadmapStatusOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const normalizedReferences = request.proposedReferences.map(
        normalizeRoadmapProposedReference,
      );
      const normalizedRequest = { ...request, proposedReferences: normalizedReferences };
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === request.updateId,
      );
      if (prior) {
        if (!sameRoadmapStatusPayload(prior, normalizedRequest)) {
          return { status: "duplicate-id-conflict", revision };
        }
        return {
          status: "duplicate",
          revision,
          phaseId: request.phaseId,
          statusOutcome: prior.statusOutcome,
          proposals: prior.proposedReferences.map(roadmapProposalOutcome),
        };
      }

      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        (request.requireBoundPhase || request.verification !== null) &&
        currentPhase.session === null
      ) {
        return { status: "phase-not-bound" };
      }
      if (
        request.expectedSession !== undefined &&
        !notesSessionLinksEqual(currentPhase.session, request.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      const timestamp = chronologicalRoadmapTimestamp(currentPhase, request.timestamp);
      const referenceError = validateRoadmapProposedReferences(normalizedReferences, timestamp);
      if (referenceError) return { status: "invalid-reference", ...referenceError };

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const lifecycleOutcome = applyPhaseLifecycleTransition(
        phase,
        {
          status: notesPhaseStatusForRoadmapTransition(request.transition),
          source: "agent",
          reason:
            request.transition === "blocked"
              ? request.blocker!
              : `Roadmap report: ${request.progress}`,
          timestamp,
          kind: request.transition === "blocked" ? "attention-question-opened" : "other",
        },
        this.createId,
      );
      const statusOutcome = roadmapStatusOutcome(lifecycleOutcome);
      const proposals = appendRoadmapStatusEvent(
        document,
        phaseIndex,
        request,
        normalizedReferences,
        timestamp,
        statusOutcome,
        this.createId,
      );
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        if (validation.error.path.includes("proposedReferences")) {
          return {
            status: "invalid-reference",
            path: validation.error.path,
            message: validation.error.message,
          };
        }
        throw new Error(`Roadmap reconciliation created invalid Notes: ${validation.error.path}`);
      }
      const next = await this.commitDocument(paths, current, validation.document, {
        validationMode: "validated",
        context: "Roadmap reconciliation created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        statusOutcome,
        proposals: proposals.map(roadmapProposalOutcome),
      };
    });
  }

  async recordRoadmapFinalReview(
    cwd: string,
    request: ProjectNotesRoadmapFinalReviewRequest,
  ): Promise<ProjectNotesRoadmapFinalReviewOutcome> {
    const reviewer = request.statusUpdate.actor;
    if (reviewer === "gg-coder") {
      return {
        status: "invalid-review",
        message: "Only Supah or Autopilot Supah may submit a final review.",
      };
    }
    if (request.statusUpdate.transition !== "review") {
      return {
        status: "invalid-review",
        message: "Final reviews require a review status transition.",
      };
    }
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const statusRequest = request.statusUpdate;
      const phaseIndex = current.document.phases.findIndex(
        (phase) => phase.id === statusRequest.phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.session === null) return { status: "phase-not-bound" };
      const normalizedReferences = statusRequest.proposedReferences.map(
        normalizeRoadmapProposedReference,
      );
      const normalizedStatusRequest = {
        ...statusRequest,
        proposedReferences: normalizedReferences,
      };
      const normalizedReview = normalizeAndValidateCompletionReviewRequest({
        ...request.review,
        phaseId: statusRequest.phaseId,
        expectedSession: { ...currentPhase.session },
        reviewer,
        timestamp: statusRequest.timestamp,
      });
      if (!normalizedReview.ok) {
        return { status: "invalid-review", message: normalizedReview.message };
      }
      const reviewRequest = normalizedReview.request;
      if (statusRequest.updateId === reviewRequest.reviewId) {
        return { status: "duplicate-id-conflict", revision };
      }

      const priorStatus = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === statusRequest.updateId,
      );
      const priorReview = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapCompletionReview =>
          event.type === "completion-review" && event.id === reviewRequest.reviewId,
      );
      if (priorStatus || priorReview) {
        if (
          priorStatus &&
          priorReview &&
          sameRoadmapStatusPayload(priorStatus, normalizedStatusRequest) &&
          sameCompletionReviewPayload(priorReview, reviewRequest)
        ) {
          return {
            status: "duplicate",
            revision,
            phaseId: statusRequest.phaseId,
            statusOutcome: priorStatus.statusOutcome,
            proposals: priorStatus.proposedReferences.map(roadmapProposalOutcome),
            evaluation: completionEvaluationFromStoredReview(priorReview),
          };
        }
        return { status: "duplicate-id-conflict", revision };
      }
      if (
        currentPhase.roadmapEvents.some(
          (event) => event.id === statusRequest.updateId || event.id === reviewRequest.reviewId,
        )
      ) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (
        statusRequest.expectedRevision !== undefined &&
        statusRequest.expectedRevision !== revision
      ) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        statusRequest.expectedSession !== undefined &&
        !notesSessionLinksEqual(currentPhase.session, statusRequest.expectedSession)
      ) {
        return { status: "stale-session" };
      }

      const timestamp = chronologicalRoadmapTimestamp(currentPhase, statusRequest.timestamp);
      const referenceError = validateRoadmapProposedReferences(normalizedReferences, timestamp);
      if (referenceError) return { status: "invalid-reference", ...referenceError };

      const statusDocument = structuredClone(current.document);
      const statusOutcome = "evidence-only" as const;
      const proposals = appendRoadmapStatusEvent(
        statusDocument,
        phaseIndex,
        statusRequest,
        normalizedReferences,
        timestamp,
        statusOutcome,
        this.createId,
      );
      const appended = buildCompletionReviewAppend(
        statusDocument,
        phaseIndex,
        reviewRequest,
        timestamp,
        this.createId,
      );
      if (!appended.ok) {
        return { status: "invalid-review", message: appended.message };
      }
      const validation = validateNotesDocumentV3(appended.document);
      if (!validation.ok) {
        if (validation.error.path.includes("proposedReferences")) {
          return {
            status: "invalid-reference",
            path: validation.error.path,
            message: validation.error.message,
          };
        }
        throw new Error(
          `Final review reconciliation created invalid Notes: ${validation.error.path}`,
        );
      }
      const next = await this.commitDocument(paths, current, validation.document, {
        validationMode: "validated",
        context: "Final review reconciliation created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(appended.phase),
        statusOutcome,
        proposals: proposals.map(roadmapProposalOutcome),
        evaluation: appended.evaluation,
      };
    });
  }

  async recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome> {
    const invalid = validateImplementationCheckpointRequest(request);
    if (invalid) return { status: "invalid-checkpoint", message: invalid };
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint" && event.id === request.checkpointId,
      );
      if (prior) {
        return sameImplementationCheckpointPayload(prior, request)
          ? { status: "duplicate", revision, phaseId: request.phaseId }
          : { status: "duplicate-id-conflict", revision };
      }
      if (currentPhase.roadmapEvents.some((event) => event.id === request.checkpointId)) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (!notesSessionLinksEqual(currentPhase.session, request.expectedSession)) {
        return { status: "stale-session" };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      phase.roadmapEvents.push({
        type: "implementation-checkpoint",
        id: request.checkpointId,
        session: { ...request.expectedSession },
        planStepTotal: request.planStepTotal,
        completedPlanSteps: [...request.completedPlanSteps],
        runOutcome: request.runOutcome,
        timestamp,
      });
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Implementation checkpoint created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async recordCompletionReview(
    cwd: string,
    request: ProjectNotesCompletionReviewRequest,
  ): Promise<ProjectNotesCompletionReviewOutcome> {
    const normalizedReview = normalizeAndValidateCompletionReviewRequest(request);
    if (!normalizedReview.ok) {
      return { status: "invalid-review", message: normalizedReview.message };
    }
    const reviewRequest = normalizedReview.request;
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex(
        (phase) => phase.id === reviewRequest.phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapCompletionReview =>
          event.type === "completion-review" && event.id === reviewRequest.reviewId,
      );
      if (prior) {
        if (!sameCompletionReviewPayload(prior, reviewRequest)) {
          return { status: "duplicate-id-conflict", revision };
        }
        return {
          status: "duplicate",
          revision,
          phaseId: reviewRequest.phaseId,
          evaluation: completionEvaluationFromStoredReview(prior),
        };
      }
      if (currentPhase.roadmapEvents.some((event) => event.id === reviewRequest.reviewId)) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (!notesSessionLinksEqual(currentPhase.session, reviewRequest.expectedSession)) {
        return { status: "stale-session" };
      }

      const timestamp = chronologicalRoadmapTimestamp(currentPhase, reviewRequest.timestamp);
      const appended = buildCompletionReviewAppend(
        current.document,
        phaseIndex,
        reviewRequest,
        timestamp,
        this.createId,
      );
      if (!appended.ok) {
        return { status: "invalid-review", message: appended.message };
      }
      const next = await this.commitDocument(paths, current, appended.document, {
        validationMode: "validated",
        context: "Completion review created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(appended.phase),
        evaluation: appended.evaluation,
      };
    });
  }

  async launchPhase(
    cwd: string,
    phaseId: string,
    createBinding: (context: FrozenPhaseLaunchContext) => Promise<NotesSessionLink>,
  ): Promise<ProjectNotesPhaseLaunchOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (currentPhase.status === "done") return { status: "done-terminal" };
      const referencesById = new Map(
        current.document.references.map((reference) => [reference.id, reference]),
      );
      const references = currentPhase.referenceIds.map((id) => referencesById.get(id)!);
      if (currentPhase.session && currentPhase.session.sessionPath !== null) {
        return {
          status: "already-bound",
          snapshot: toSnapshot(current),
          phase: structuredClone(currentPhase),
          references: structuredClone(references),
          session: { ...currentPhase.session },
        };
      }

      const frozen: FrozenPhaseLaunchContext = {
        projectKey: current.projectKey,
        phase: structuredClone(currentPhase),
        references: structuredClone(references),
      };
      const session = await createBinding(frozen);
      if (
        !session.sessionId.trim() ||
        (session.sessionPath !== null && !session.sessionPath.trim())
      ) {
        throw new Error("Phase binding callback returned an invalid session link.");
      }
      const document = structuredClone(current.document);
      const boundPhase = document.phases[phaseIndex]!;
      boundPhase.session = { ...session };
      const timestamp = chronologicalLifecycleTimestamp(boundPhase, new Date().toISOString());
      const transition = applyPhaseLifecycleTransition(
        boundPhase,
        {
          status: "planning",
          source: "user",
          reason: "Phase started by user",
          timestamp,
          kind: "other",
        },
        this.createId,
      );
      if (transition !== "updated") boundPhase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "Phase launch commit",
      });
      return {
        status: "accepted",
        snapshot: toSnapshot(next),
        phase: structuredClone(boundPhase),
        references: structuredClone(references),
        session: { ...session },
      };
    });
  }

  async updatePhaseSessionLink(
    cwd: string,
    phaseId: string,
    session: NotesSessionLink,
  ): Promise<ProjectNotesPhaseLinkOutcome> {
    if (
      !session.sessionId.trim() ||
      (session.sessionPath !== null && !session.sessionPath.trim())
    ) {
      throw new Error("Cannot store an invalid phase session link.");
    }
    return this.mutatePhaseLinkFields(cwd, phaseId, (phase) => {
      phase.session = { ...session };
    });
  }

  async recordPhaseLifecycleTransition(
    cwd: string,
    phaseId: string,
    transition: ProjectNotesPhaseLifecycleTransition,
  ): Promise<ProjectNotesPhaseLifecycleOutcome> {
    if (!isNotesPhaseStatus(transition.status) || !isNotesLifecycleEventSource(transition.source)) {
      throw new Error("Cannot record an invalid automatic phase lifecycle transition.");
    }
    if (!Number.isFinite(Date.parse(transition.timestamp))) {
      throw new Error("Cannot record a phase lifecycle transition with an invalid timestamp.");
    }
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        transition.expectedSession !== undefined &&
        !notesSessionLinksEqual(currentPhase.session, transition.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      if (currentPhase.overrides.status !== null) {
        const document = structuredClone(current.document);
        const phase = document.phases[phaseIndex]!;
        const timestamp = chronologicalLifecycleTimestamp(phase, transition.timestamp);
        const pending = pendingAutomaticLifecycleTransition(phase, transition, timestamp);
        if (isDeepStrictEqual(phase.pendingAutomaticLifecycleTransition, pending)) {
          return {
            status: "manual-override",
            snapshot: toSnapshot(current),
            phase: structuredClone(currentPhase),
          };
        }
        phase.pendingAutomaticLifecycleTransition = pending;
        phase.updatedAt = timestamp;
        document.updatedAt = timestamp;
        const next = await this.commitDocument(paths, current, document, {
          validationMode: "trusted",
          context: "Suppressed phase lifecycle commit",
        });
        return {
          status: "manual-override",
          snapshot: toSnapshot(next),
          phase: structuredClone(phase),
        };
      }
      if (currentPhase.status === "done") return { status: "done-terminal" };
      if (currentPhase.status === transition.status) return { status: "same-status" };

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalLifecycleTimestamp(phase, transition.timestamp);
      applyPhaseLifecycleTransition(phase, { ...transition, timestamp }, this.createId);
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "Phase lifecycle commit",
      });
      return {
        status: "ok",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async recordPhaseLaunchAttention(
    cwd: string,
    phaseId: string,
    reason: string,
    expectedSession?: NotesSessionLink | null,
  ): Promise<ProjectNotesPhaseLifecycleOutcome> {
    return this.recordPhaseLifecycleTransition(cwd, phaseId, {
      status: "needs-attention",
      source: "system",
      reason,
      timestamp: new Date().toISOString(),
      kind: "attention-generic-opened",
      expectedSession,
    });
  }

  private async mutatePhaseLinkFields(
    cwd: string,
    phaseId: string,
    mutate: (phase: NotesPhase) => void,
  ): Promise<ProjectNotesPhaseLinkOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      mutate(phase);
      document.updatedAt = new Date().toISOString();
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "Phase session link commit",
      });
      return { status: "ok", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  private async withLockedCurrent<T>(
    cwd: string,
    operation: (paths: ProjectNotesPaths, current: StoredProjectNotesV1) => Promise<T>,
  ): Promise<T | UnavailableCurrentState> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      return operation(paths, current.envelope);
    });
  }

  private async commitDocument(
    paths: ProjectNotesPaths,
    current: StoredProjectNotesV1,
    document: NotesDocumentV3,
    options: CommitDocumentOptions,
  ): Promise<StoredProjectNotesV1> {
    let committedDocument = document;
    if (options.validationMode === "validated") {
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        throw new Error(`${options.context}: ${validation.error.path}`);
      }
      committedDocument = validation.document;
    }
    const next: StoredProjectNotesV1 = {
      storeVersion: 1,
      projectKey: current.projectKey,
      revision: current.revision + 1,
      document: committedDocument,
    };
    await this.atomicWrite(paths.backup, serializeEnvelope(current));
    await this.atomicWrite(paths.primary, serializeEnvelope(next));
    return next;
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await this.fileSystem.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await this.secureMode(directory, DIRECTORY_MODE);
  }

  private async atomicWrite(destination: string, contents: string): Promise<void> {
    const temporary = `${destination}.${process.pid}.${this.createId()}.tmp`;
    try {
      await this.fileSystem.writeFile(temporary, contents, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
      await this.secureMode(temporary, FILE_MODE);
      await this.syncPath(temporary, "r+");
      await this.fileSystem.rename(temporary, destination);
      await this.secureMode(destination, FILE_MODE);
      await this.syncDirectory(path.dirname(destination));
    } finally {
      await this.fileSystem.unlink(temporary).catch(() => undefined);
    }
  }

  private async syncPath(filePath: string, flags: "r" | "r+"): Promise<void> {
    const handle = await this.fileSystem.open(filePath, flags);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      await this.syncPath(directory, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw error;
    }
  }

  private async secureMode(filePath: string, mode: number): Promise<void> {
    try {
      await this.fileSystem.chmod(filePath, mode);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EINVAL") throw error;
    }
  }

  private async readCurrent(paths: ProjectNotesPaths, projectKey: string): Promise<CurrentState> {
    const [primary, backup] = await Promise.all([
      this.readCandidate(paths.primary, projectKey),
      this.readCandidate(paths.backup, projectKey),
    ]);
    if (primary.status === "valid") {
      return {
        status: "ok",
        envelope: primary.envelope,
        source: "primary",
        migratedFromV2: primary.migratedFromV2,
      };
    }
    if (backup.status === "valid") {
      return {
        status: "ok",
        envelope: backup.envelope,
        source: "backup",
        migratedFromV2: backup.migratedFromV2,
      };
    }
    if (primary.status === "missing" && backup.status === "missing") return { status: "missing" };
    return {
      status: "corrupt",
      primary: primary.status === "invalid" ? primary.reason : null,
      backup: backup.status === "invalid" ? backup.reason : null,
    };
  }

  private async readCandidate(filePath: string, projectKey: string): Promise<Candidate> {
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { status: "invalid", reason: "malformed-json" };
    }
    const parsed = parseStoredEnvelope(value);
    if (!parsed) return { status: "invalid", reason: "invalid-envelope" };
    if (parsed.envelope.projectKey !== projectKey) {
      return { status: "invalid", reason: "project-key-mismatch" };
    }
    return {
      status: "valid",
      envelope: parsed.envelope,
      migratedFromV2: parsed.migratedFromV2,
    };
  }
}

function parseStoredEnvelope(
  value: unknown,
): { envelope: StoredProjectNotesV1; migratedFromV2: boolean } | null {
  if (
    !isRecordWithKeys(value, ENVELOPE_KEYS) ||
    value.storeVersion !== 1 ||
    typeof value.projectKey !== "string" ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return null;
  }
  const document = coerceNotesDocumentV3(value.document);
  if (!document.ok) return null;
  return {
    envelope: {
      storeVersion: 1,
      projectKey: value.projectKey,
      revision: value.revision as number,
      document: document.document,
    },
    migratedFromV2: document.migratedLegacyShape === true,
  };
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

function serializeEnvelope(envelope: StoredProjectNotesV1): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function toSnapshot(envelope: StoredProjectNotesV1): ProjectNotesSnapshot {
  return {
    projectKey: envelope.projectKey,
    revision: envelope.revision,
    document: envelope.document,
  };
}
