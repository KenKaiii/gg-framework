import {
  notesAutomaticStatusAfterOverrideReset,
  notesSessionLinksEqual,
} from "@kenkaiiii/gg-core/project-notes";
import { canonicalReferenceIdentity } from "./notes-reference";
import {
  NOTES_REMINDER_NOTE_MAX_LENGTH,
  type NotesDocumentV3,
  type NotesPhase,
  type NotesPromptSaveInput,
  type NotesPromptSaveResult,
  type NotesReferenceOperationResult,
  type NotesReminderMutationResult,
  type NotesRoadmapMutationResult,
  type NotesRoadmapReferenceProposal,
} from "./notes-types";

export interface ReferenceMutationApplication {
  document: NotesDocumentV3 | null;
  result: NotesReferenceOperationResult;
}

export interface PromptSaveMutationApplication {
  document: NotesDocumentV3 | null;
  result: NotesPromptSaveResult;
}

export interface RoadmapMutationApplication {
  document: NotesDocumentV3 | null;
  result: NotesRoadmapMutationResult;
}

export interface ReminderMutationApplication {
  document: NotesDocumentV3 | null;
  result: NotesReminderMutationResult;
}

interface CreateNotesPhaseRecordInput {
  id: string;
  title: string;
  goal: string;
  doneWhen: readonly string[];
  order: number;
  sourcePrompt: string;
  requestedAt: string;
  currentUpdatedAt: string;
}

export function createNotesPhaseRecord(input: CreateNotesPhaseRecordInput): NotesPhase {
  const timestamp = mutationTimestamp(input.requestedAt, input.currentUpdatedAt);
  return {
    id: input.id,
    title: input.title,
    goal: input.goal,
    doneWhen: [...input.doneWhen],
    order: input.order,
    status: "not-started",
    sourcePrompt: input.sourcePrompt,
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

export function evaluateReminderSchedule(
  current: NotesDocumentV3,
  phaseId: string,
  input: { dueAt: string; note: string },
  now: string,
  occurrenceKey: string,
  newReminderId: string,
): ReminderMutationApplication {
  const guarded = reminderPhaseGuard(current, phaseId);
  if (guarded.result) return { document: null, result: guarded.result };
  if (!isFutureReminderTime(input.dueAt, now)) {
    return { document: null, result: { status: "invalid-time", phaseId } };
  }
  const note = input.note.trim();
  if (note.length > NOTES_REMINDER_NOTE_MAX_LENGTH) {
    return {
      document: null,
      result: {
        status: "failed",
        reason: "validation",
        error: {
          path: `phases.${phaseId}.reminder.note`,
          message: `expected ${NOTES_REMINDER_NOTE_MAX_LENGTH} characters or fewer`,
        },
      },
    };
  }
  const phase = guarded.phase!;
  const reminder = phase.reminder;
  const occurrenceCollision = reminderIdentityCollision(
    current,
    phaseId,
    "occurrenceKey",
    occurrenceKey,
  );
  if (occurrenceCollision) return { document: null, result: occurrenceCollision };
  if (reminder === null) {
    const idCollision = reminderIdentityCollision(current, phaseId, "id", newReminderId);
    if (idCollision) return { document: null, result: idCollision };
  }
  const timestamp = reminderMutationTimestamp(now, current.updatedAt, phase.updatedAt);
  const nextPhase: NotesPhase = {
    ...phase,
    updatedAt: timestamp,
    reminder: {
      id: reminder?.id ?? newReminderId,
      occurrenceKey,
      dueAt: new Date(input.dueAt).toISOString(),
      note,
      createdAt: now,
      lastDelivery: reminder?.lastDelivery ?? null,
    },
  };
  return {
    document: replaceReminderPhase(current, nextPhase, timestamp),
    result: { status: "committed", phaseId, occurrenceKey },
  };
}

export function evaluateReminderSnooze(
  current: NotesDocumentV3,
  phaseId: string,
  dueAt: string,
  now: string,
  occurrenceKey: string,
  expectedOccurrenceKey?: string,
): ReminderMutationApplication {
  const guarded = reminderPhaseGuard(current, phaseId);
  if (guarded.result) return { document: null, result: guarded.result };
  const phase = guarded.phase!;
  const staleResult = staleReminderOccurrence(phase, expectedOccurrenceKey);
  if (staleResult) return { document: null, result: staleResult };
  if (phase.reminder === null) {
    return { document: null, result: { status: "missing-reminder", phaseId } };
  }
  if (!isFutureReminderTime(dueAt, now)) {
    return { document: null, result: { status: "invalid-time", phaseId } };
  }
  const occurrenceCollision = reminderIdentityCollision(
    current,
    phaseId,
    "occurrenceKey",
    occurrenceKey,
  );
  if (occurrenceCollision) return { document: null, result: occurrenceCollision };
  const timestamp = reminderMutationTimestamp(now, current.updatedAt, phase.updatedAt);
  const nextPhase: NotesPhase = {
    ...phase,
    updatedAt: timestamp,
    reminder: {
      ...phase.reminder,
      occurrenceKey,
      dueAt: new Date(dueAt).toISOString(),
      createdAt: now,
    },
  };
  return {
    document: replaceReminderPhase(current, nextPhase, timestamp),
    result: { status: "committed", phaseId, occurrenceKey },
  };
}

export function evaluateReminderDismiss(
  current: NotesDocumentV3,
  phaseId: string,
  now: string,
  expectedOccurrenceKey?: string,
): ReminderMutationApplication {
  const guarded = reminderPhaseGuard(current, phaseId);
  if (guarded.result) return { document: null, result: guarded.result };
  const phase = guarded.phase!;
  const staleResult = staleReminderOccurrence(phase, expectedOccurrenceKey);
  if (staleResult) return { document: null, result: staleResult };
  if (phase.reminder === null) {
    return { document: null, result: { status: "missing-reminder", phaseId } };
  }
  const timestamp = reminderMutationTimestamp(now, current.updatedAt, phase.updatedAt);
  return {
    document: replaceReminderPhase(
      current,
      { ...phase, reminder: null, updatedAt: timestamp },
      timestamp,
    ),
    result: { status: "committed", phaseId },
  };
}

export function evaluatePromptSave(
  current: NotesDocumentV3,
  input: NotesPromptSaveInput,
  phaseId: string,
  title: string,
  prompt: string,
  requestedAt: string,
): PromptSaveMutationApplication {
  if (input.kind === "new-draft") {
    const existing = current.phases.find((phase) => phase.id === phaseId);
    if (existing) {
      return {
        document: null,
        result: { status: "committed", phaseId: existing.id, title: existing.title },
      };
    }
    const phase = createNotesPhaseRecord({
      id: phaseId,
      title,
      goal: "",
      doneWhen: [],
      order: current.phases.length,
      sourcePrompt: prompt,
      requestedAt,
      currentUpdatedAt: current.updatedAt,
    });
    return {
      document: {
        ...current,
        phases: normalizePhaseOrder([...current.phases, phase]),
        updatedAt: phase.updatedAt,
      },
      result: { status: "committed", phaseId, title },
    };
  }

  const phaseIndex = current.phases.findIndex((phase) => phase.id === input.phaseId);
  const phase = current.phases[phaseIndex];
  if (!phase) {
    return {
      document: null,
      result: { status: "missing-phase", phaseId: input.phaseId },
    };
  }
  if (phase.archivedAt !== null) {
    return {
      document: null,
      result: { status: "archived-phase", phaseId: phase.id, title: phase.title },
    };
  }
  if (phase.sourcePrompt === prompt) {
    return {
      document: null,
      result: { status: "committed", phaseId: phase.id, title: phase.title },
    };
  }
  if (phase.sourcePrompt !== input.expectedSourcePrompt) {
    return {
      document: null,
      result: { status: "replacement-conflict", phaseId: phase.id, title: phase.title },
    };
  }

  const timestamp = mutationTimestamp(requestedAt, current.updatedAt);
  const phases = [...current.phases];
  phases[phaseIndex] = { ...phase, sourcePrompt: prompt, updatedAt: timestamp };
  return {
    document: { ...current, phases, updatedAt: timestamp },
    result: { status: "committed", phaseId: phase.id, title: phase.title },
  };
}

export function evaluateReferenceProposalDecision(
  current: NotesDocumentV3,
  phaseId: string,
  proposalId: string,
  decision: "accepted" | "rejected",
  requestedAt: string,
  decisionId: string,
  generatedReferenceId: string,
): RoadmapMutationApplication {
  const phaseIndex = current.phases.findIndex((phase) => phase.id === phaseId);
  const phase = current.phases[phaseIndex];
  if (!phase) return { document: null, result: { status: "missing-phase", phaseId } };
  if (phase.archivedAt !== null) {
    return { document: null, result: { status: "archived-phase", phaseId } };
  }
  const proposal = findRoadmapProposal(phase, proposalId);
  if (!proposal || proposal.disposition !== "pending") {
    return { document: null, result: { status: "missing-proposal", phaseId, proposalId } };
  }
  const priorDecision = phase.roadmapEvents.find(
    (event) => event.type === "reference-decision" && event.proposalId === proposalId,
  );
  if (priorDecision?.type === "reference-decision") {
    return {
      document: null,
      result:
        priorDecision.decision === decision
          ? { status: "already-decided", phaseId, decision }
          : { status: "decision-conflict", phaseId, decision: priorDecision.decision },
    };
  }

  const timestamp = chronologicalRoadmapMutationTimestamp(requestedAt, current.updatedAt, phase);
  const phases = [...current.phases];
  let references = current.references;
  let acceptedReferenceId: string | null = null;
  let referenceIds = phase.referenceIds;
  let overrides = phase.overrides;

  if (decision === "accepted") {
    const identity = canonicalReferenceIdentity(proposal);
    if (!identity) return { document: null, result: { status: "failed", reason: "invalid" } };
    const winner = current.references.find(
      (reference) => canonicalReferenceIdentity(reference) === identity,
    );
    if (!winner && current.references.some((reference) => reference.id === generatedReferenceId)) {
      return { document: null, result: { status: "failed", reason: "invalid" } };
    }
    acceptedReferenceId = winner?.id ?? generatedReferenceId;
    if (!winner) {
      references = [
        ...current.references,
        {
          ...roadmapProposalReferenceFields(proposal),
          id: acceptedReferenceId,
          capturedAt: timestamp,
        },
      ];
    }
    referenceIds = phase.referenceIds.includes(acceptedReferenceId)
      ? phase.referenceIds
      : [...phase.referenceIds, acceptedReferenceId];
    overrides = {
      ...phase.overrides,
      referenceIds: { value: referenceIds, source: "user", updatedAt: timestamp },
    };
  }

  const nextPhase: NotesPhase = {
    ...phase,
    referenceIds,
    overrides,
    updatedAt: timestamp,
    roadmapEvents: [
      ...phase.roadmapEvents,
      {
        type: "reference-decision",
        id: decisionId,
        proposalId,
        decision,
        referenceId: acceptedReferenceId,
        timestamp,
      },
    ],
  };
  phases[phaseIndex] = nextPhase;
  return {
    document: { ...current, references, phases, updatedAt: timestamp },
    result: {
      status: "committed",
      phaseId,
      ...(acceptedReferenceId ? { referenceId: acceptedReferenceId } : {}),
    },
  };
}

export function evaluateStatusOverrideReset(
  current: NotesDocumentV3,
  phaseId: string,
  requestedAt: string,
  resetId: string,
  lifecycleId: string,
): RoadmapMutationApplication {
  const phaseIndex = current.phases.findIndex((phase) => phase.id === phaseId);
  const phase = current.phases[phaseIndex];
  if (!phase) return { document: null, result: { status: "missing-phase", phaseId } };
  if (phase.archivedAt !== null) {
    return { document: null, result: { status: "archived-phase", phaseId } };
  }
  if (phase.overrides.status === null) {
    return {
      document: null,
      result: { status: "committed", phaseId, resultingStatus: phase.status },
    };
  }
  const pendingLifecycle =
    phase.pendingAutomaticLifecycleTransition != null &&
    notesSessionLinksEqual(phase.session, phase.pendingAutomaticLifecycleTransition.expectedSession)
      ? phase.pendingAutomaticLifecycleTransition
      : null;
  const latestProtected = [...phase.roadmapEvents]
    .reverse()
    .find(
      (event) =>
        event.type === "status-update" &&
        (event.statusOutcome === "manual-override" || event.statusOutcome === "done-terminal"),
    );
  const targetStatus = notesAutomaticStatusAfterOverrideReset(phase);
  const timestamp = chronologicalRoadmapMutationTimestamp(requestedAt, current.updatedAt, phase);
  const lifecycleEvents = [...phase.lifecycleEvents];
  if (targetStatus !== phase.status) {
    lifecycleEvents.push({
      id: lifecycleId,
      fromStatus: phase.status,
      toStatus: targetStatus,
      source: pendingLifecycle?.source ?? "user",
      timestamp,
      reason: pendingLifecycle?.reason ?? "Automatic status updates resumed by user",
      kind:
        pendingLifecycle?.kind ??
        (targetStatus === "waiting-for-approval"
          ? "approval-opened"
          : targetStatus === "needs-attention"
            ? "attention-generic-opened"
            : "other"),
    });
  }
  const phases = [...current.phases];
  phases[phaseIndex] = {
    ...phase,
    status: targetStatus,
    attentionReason:
      pendingLifecycle?.status === "needs-attention"
        ? pendingLifecycle.reason
        : latestProtected?.type === "status-update" && latestProtected.transition === "blocked"
          ? latestProtected.blocker
          : targetStatus === phase.status
            ? phase.attentionReason
            : null,
    completedAt:
      targetStatus === "cancelled"
        ? (pendingLifecycle?.timestamp ?? phase.completedAt)
        : targetStatus === "done"
          ? phase.completedAt
          : null,
    updatedAt: timestamp,
    overrides: { ...phase.overrides, status: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents,
    roadmapEvents: [
      ...phase.roadmapEvents,
      { type: "override-reset", id: resetId, field: "status", timestamp },
    ],
  };
  return {
    document: { ...current, phases, updatedAt: timestamp },
    result: { status: "committed", phaseId, resultingStatus: targetStatus },
  };
}

export function evaluateReferenceOverrideReset(
  current: NotesDocumentV3,
  phaseId: string,
  requestedAt: string,
  resetId: string,
): RoadmapMutationApplication {
  const phaseIndex = current.phases.findIndex((phase) => phase.id === phaseId);
  const phase = current.phases[phaseIndex];
  if (!phase) return { document: null, result: { status: "missing-phase", phaseId } };
  if (phase.archivedAt !== null) {
    return { document: null, result: { status: "archived-phase", phaseId } };
  }
  if (phase.overrides.referenceIds === null) {
    return { document: null, result: { status: "committed", phaseId } };
  }
  const timestamp = chronologicalRoadmapMutationTimestamp(requestedAt, current.updatedAt, phase);
  const phases = [...current.phases];
  phases[phaseIndex] = {
    ...phase,
    updatedAt: timestamp,
    overrides: { ...phase.overrides, referenceIds: null },
    roadmapEvents: [
      ...phase.roadmapEvents,
      { type: "override-reset", id: resetId, field: "references", timestamp },
    ],
  };
  return {
    document: { ...current, phases, updatedAt: timestamp },
    result: { status: "committed", phaseId },
  };
}

export function updateTask(
  current: NotesDocumentV3,
  id: string,
  updatedAt: string,
  update: (task: NotesDocumentV3["tasks"][number]) => NotesDocumentV3["tasks"][number] | null,
): NotesDocumentV3 | null {
  const index = current.tasks.findIndex((task) => task.id === id);
  const task = current.tasks[index];
  if (!task) return null;
  const nextTask = update(task);
  if (!nextTask) return null;
  const tasks = [...current.tasks];
  tasks[index] = nextTask;
  return { ...current, tasks, updatedAt };
}

export function updatePhase(
  current: NotesDocumentV3,
  id: string,
  updatedAt: string,
  update: (phase: NotesPhase) => NotesPhase | null,
): NotesDocumentV3 | null {
  const index = current.phases.findIndex((phase) => phase.id === id);
  const phase = current.phases[index];
  if (!phase) return null;
  const nextPhase = update(phase);
  if (!nextPhase) return null;
  const phases = [...current.phases];
  phases[index] = nextPhase;
  return { ...current, phases, updatedAt };
}

export function linkReferenceToPhases(
  phases: readonly NotesPhase[],
  referenceId: string,
  phaseIds: readonly string[],
  updatedAt: string,
): NotesPhase[] {
  if (phaseIds.length === 0) return phases as NotesPhase[];
  const requested = new Set(phaseIds);
  let changed = false;
  const next = phases.map((phase) => {
    if (!requested.has(phase.id) || phase.referenceIds.includes(referenceId)) return phase;
    changed = true;
    const referenceIds = [...phase.referenceIds, referenceId];
    return withReferenceIds(phase, referenceIds, updatedAt);
  });
  return changed ? next : (phases as NotesPhase[]);
}

export function updateReferenceLink(
  phases: readonly NotesPhase[],
  referenceId: string,
  phaseId: string,
  linked: boolean,
  updatedAt: string,
): NotesPhase[] {
  const index = phases.findIndex((phase) => phase.id === phaseId);
  const phase = phases[index];
  if (!phase) return phases as NotesPhase[];
  const currentlyLinked = phase.referenceIds.includes(referenceId);
  const overrideLinked = phase.overrides.referenceIds?.value.includes(referenceId) ?? false;
  if ((linked && currentlyLinked) || (!linked && !currentlyLinked && !overrideLinked)) {
    return phases as NotesPhase[];
  }
  const referenceIds = linked
    ? [...phase.referenceIds, referenceId]
    : phase.referenceIds.filter((id) => id !== referenceId);
  const next = [...phases];
  next[index] = withReferenceIds(phase, referenceIds, updatedAt);
  return next;
}

export function referenceFieldsEqual(
  left: NotesDocumentV3["references"][number],
  right: NotesDocumentV3["references"][number],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mutationTimestamp(proposed: string, current: string): string {
  return Date.parse(current) > Date.parse(proposed) ? current : proposed;
}

export function normalizeDoneWhen(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function normalizePhaseOrder(phases: readonly NotesPhase[]): NotesPhase[] {
  return phases.map((phase, order) => (phase.order === order ? phase : { ...phase, order }));
}

export function chronologicalTimestamp(now: string, phase: NotesPhase): string {
  const previous = phase.lifecycleEvents[phase.lifecycleEvents.length - 1]?.timestamp;
  return previous && Date.parse(previous) > Date.parse(now) ? previous : now;
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reminderIdentityCollision(
  current: NotesDocumentV3,
  targetPhaseId: string,
  field: "id" | "occurrenceKey",
  value: string,
): Extract<NotesReminderMutationResult, { status: "failed" }> | null {
  const existingIndex = current.phases.findIndex((phase) => phase.reminder?.[field] === value);
  if (existingIndex === -1) return null;
  const targetIndex = current.phases.findIndex((phase) => phase.id === targetPhaseId);
  const label = field === "id" ? "reminder ID" : "occurrence key";
  return {
    status: "failed",
    reason: "validation",
    error: {
      path: `phases[${targetIndex}].reminder.${field}`,
      message: `duplicate ${label}; already used at phases[${existingIndex}].reminder.${field}`,
    },
  };
}

function staleReminderOccurrence(
  phase: NotesPhase,
  expectedOccurrenceKey: string | undefined,
): Extract<NotesReminderMutationResult, { status: "stale-occurrence" }> | null {
  const actualOccurrenceKey = phase.reminder?.occurrenceKey ?? null;
  if (expectedOccurrenceKey === undefined || expectedOccurrenceKey === actualOccurrenceKey) {
    return null;
  }
  return {
    status: "stale-occurrence",
    phaseId: phase.id,
    expectedOccurrenceKey,
    actualOccurrenceKey,
  };
}

function reminderPhaseGuard(
  current: NotesDocumentV3,
  phaseId: string,
): { phase?: NotesPhase; result?: NotesReminderMutationResult } {
  const phase = current.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) return { result: { status: "missing-phase", phaseId } };
  if (phase.archivedAt !== null) return { result: { status: "archived-phase", phaseId } };
  if (phase.status === "done" || phase.status === "cancelled") {
    return { result: { status: "inactive-phase", phaseId } };
  }
  return { phase };
}

function isFutureReminderTime(dueAt: string, now: string): boolean {
  const due = Date.parse(dueAt);
  const current = Date.parse(now);
  return Number.isFinite(due) && Number.isFinite(current) && due > current;
}

function reminderMutationTimestamp(
  now: string,
  documentUpdatedAt: string,
  phaseUpdatedAt: string,
): string {
  return new Date(
    Math.max(Date.parse(now), Date.parse(documentUpdatedAt), Date.parse(phaseUpdatedAt)),
  ).toISOString();
}

function replaceReminderPhase(
  current: NotesDocumentV3,
  nextPhase: NotesPhase,
  updatedAt: string,
): NotesDocumentV3 {
  return {
    ...current,
    phases: current.phases.map((phase) => (phase.id === nextPhase.id ? nextPhase : phase)),
    updatedAt,
  };
}

function findRoadmapProposal(
  phase: NotesPhase,
  proposalId: string,
): NotesRoadmapReferenceProposal | undefined {
  for (const event of phase.roadmapEvents) {
    if (event.type !== "status-update") continue;
    const proposal = event.proposedReferences.find((item) => item.id === proposalId);
    if (proposal) return proposal;
  }
  return undefined;
}

function roadmapProposalReferenceFields(
  proposal: NotesRoadmapReferenceProposal,
): Omit<NotesDocumentV3["references"][number], "id" | "capturedAt"> {
  const {
    id: _id,
    disposition: _disposition,
    policyOutcome: _policyOutcome,
    referenceId: _referenceId,
    ...reference
  } = proposal;
  return reference;
}

function chronologicalRoadmapMutationTimestamp(
  requestedAt: string,
  documentUpdatedAt: string,
  phase: NotesPhase,
): string {
  const latest = [
    requestedAt,
    documentUpdatedAt,
    phase.updatedAt,
    phase.pendingAutomaticLifecycleTransition?.timestamp,
    phase.lifecycleEvents[phase.lifecycleEvents.length - 1]?.timestamp,
    phase.roadmapEvents[phase.roadmapEvents.length - 1]?.timestamp,
  ]
    .filter((value): value is string => value !== undefined)
    .reduce((maximum, value) => Math.max(maximum, Date.parse(value)), -Infinity);
  return new Date(latest).toISOString();
}

function withReferenceIds(
  phase: NotesPhase,
  referenceIds: string[],
  updatedAt: string,
): NotesPhase {
  return {
    ...phase,
    referenceIds,
    updatedAt,
    overrides: {
      ...phase.overrides,
      referenceIds: { value: referenceIds, source: "user", updatedAt },
    },
  };
}
