import type {
  ProjectNotesPhaseLinkOutcome,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import type {
  PhaseLifecycleReconcileOutcome,
  PhaseLifecycleSignal,
} from "./app-sidecar-phase-lifecycle.js";
import type { ActivePhaseContextV1, ActivePhaseExecutionStage } from "./phase-context.js";

export type PhaseCheckpointErrorCode =
  | "phase-stage-persistence-failed"
  | "notes-missing"
  | "notes-corrupt"
  | "phase-not-found"
  | "phase-archived"
  | "phase-link-persistence-failed"
  | "phase-lifecycle-persistence-failed"
  | "stale-phase-session";

export class PhaseCheckpointError extends Error {
  readonly retryable = true;

  constructor(
    readonly code: PhaseCheckpointErrorCode,
    readonly phaseId: string,
    message: string,
    readonly guidance: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PhaseCheckpointError";
  }
}

export type ActivePhaseStageResult =
  | { status: "no-active-phase" }
  | { status: "updated"; context: ActivePhaseContextV1 };

export type ActivePhaseLinkSyncResult =
  | { status: "no-active-phase" }
  | {
      status: "synchronized";
      snapshot: ProjectNotesSnapshot;
      context: ActivePhaseContextV1;
    };

export interface PhaseCheckpointSession {
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  getState(): { sessionId: string; sessionPath: string | null };
  updateActivePhaseStage(
    executionStage: ActivePhaseExecutionStage,
    approvedPlanPath?: string,
  ): Promise<ActivePhaseContextV1>;
}

export interface PhaseCheckpointRepository {
  updatePhaseSessionLink(
    cwd: string,
    phaseId: string,
    session: { sessionId: string; sessionPath: string | null },
  ): Promise<ProjectNotesPhaseLinkOutcome>;
}

export interface PlanApprovalCheckpointResult {
  planTotal: number;
  phaseLink: ActivePhaseLinkSyncResult;
}

export interface PhaseCheckpointFailurePayload {
  code: PhaseCheckpointErrorCode;
  message: string;
  guidance: string;
  retryable: true;
  phaseId: string;
}

export async function persistActivePhaseStage(input: {
  session: PhaseCheckpointSession;
  executionStage: ActivePhaseExecutionStage;
  approvedPlanPath?: string;
}): Promise<ActivePhaseStageResult> {
  const activePhase = input.session.getActivePhaseContext();
  if (!activePhase) return { status: "no-active-phase" };

  try {
    const context = await input.session.updateActivePhaseStage(
      input.executionStage,
      input.approvedPlanPath,
    );
    return { status: "updated", context };
  } catch (cause) {
    throw new PhaseCheckpointError(
      "phase-stage-persistence-failed",
      activePhase.phase.id,
      "The active phase stage could not be saved.",
      "The plan is still pending. Fix the session storage problem, then retry approval.",
      { cause },
    );
  }
}

export async function syncActivePhaseSessionLink(input: {
  session: PhaseCheckpointSession;
  repository: PhaseCheckpointRepository;
  cwd: string;
  onSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
}): Promise<ActivePhaseLinkSyncResult> {
  const activePhase = input.session.getActivePhaseContext();
  if (!activePhase) return { status: "no-active-phase" };

  let outcome: ProjectNotesPhaseLinkOutcome;
  try {
    const state = input.session.getState();
    outcome = await input.repository.updatePhaseSessionLink(input.cwd, activePhase.phase.id, {
      sessionId: state.sessionId,
      sessionPath: state.sessionPath,
    });
  } catch (cause) {
    throw new PhaseCheckpointError(
      "phase-link-persistence-failed",
      activePhase.phase.id,
      "The latest phase checkpoint could not be written to Project Notes.",
      "The current session remains authoritative. Fix Project Notes storage, then retry the action.",
      { cause },
    );
  }

  if (outcome.status !== "ok") throw phaseLinkOutcomeError(activePhase.phase.id, outcome);
  input.onSnapshot?.(outcome.snapshot);
  return { status: "synchronized", snapshot: outcome.snapshot, context: activePhase };
}

export async function commitPlanApprovalCheckpoint(input: {
  session: PhaseCheckpointSession;
  repository: PhaseCheckpointRepository;
  cwd: string;
  planPath?: string;
  approvalSource: "user" | "agent";
  reconcileLifecycle: (
    signal: Extract<PhaseLifecycleSignal, { type: "plan-approved" }>,
  ) => Promise<PhaseLifecycleReconcileOutcome>;
  prepareFreshSession: () => Promise<number>;
  onSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
}): Promise<PlanApprovalCheckpointResult> {
  const planTotal = await input.prepareFreshSession();
  const phaseLink = await syncActivePhaseSessionLink({ ...input, onSnapshot: undefined });
  if (phaseLink.status === "no-active-phase") return { planTotal, phaseLink };
  const stage = await persistActivePhaseStage({
    session: input.session,
    executionStage: "implementing",
    approvedPlanPath: input.planPath,
  });
  if (stage.status === "no-active-phase") {
    throw new PhaseCheckpointError(
      "phase-stage-persistence-failed",
      phaseLink.context.phase.id,
      "The active phase disappeared before its implementation stage could be saved.",
      "The plan is still pending. Resume the linked phase, then retry approval.",
    );
  }

  try {
    let reconciled: PhaseLifecycleReconcileOutcome;
    try {
      reconciled = await input.reconcileLifecycle({
        type: "plan-approved",
        approvalSource: input.approvalSource,
      });
    } catch (cause) {
      throw phaseLifecyclePersistenceError(phaseLink.context.phase.id, cause);
    }
    if (reconciled.status === "storage-failure") {
      throw phaseLifecyclePersistenceError(phaseLink.context.phase.id, reconciled.error);
    }
    if (reconciled.status === "same-status" || reconciled.status === "done-terminal") {
      input.onSnapshot?.(phaseLink.snapshot);
    } else if (reconciled.status !== "committed" && reconciled.status !== "manual-override") {
      throw phaseLifecycleReconcileError(phaseLink.context.phase.id, reconciled.status);
    }
  } catch (error) {
    try {
      await input.session.updateActivePhaseStage(
        phaseLink.context.executionStage,
        phaseLink.context.approvedPlanPath,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Phase lifecycle persistence failed and the pending approval stage could not be restored",
        { cause: restoreError },
      );
    }
    throw error;
  }
  return { planTotal, phaseLink };
}

export async function completeCompactionCheckpoint(input: {
  synchronize: () => Promise<ActivePhaseLinkSyncResult>;
  onComplete: () => void;
  onFailure: (error: PhaseCheckpointError) => void;
}): Promise<"completed" | "sync-failed"> {
  try {
    await input.synchronize();
    input.onComplete();
    return "completed";
  } catch (error) {
    const checkpointError =
      error instanceof PhaseCheckpointError
        ? error
        : new PhaseCheckpointError(
            "phase-link-persistence-failed",
            "unknown",
            "The latest phase checkpoint could not be synchronized after compaction.",
            "The current session remains authoritative. Fix Project Notes storage, then retry the action.",
            { cause: error },
          );
    input.onFailure(checkpointError);
    return "sync-failed";
  }
}

export function phaseCheckpointFailurePayload(
  error: PhaseCheckpointError,
): PhaseCheckpointFailurePayload {
  return {
    code: error.code,
    message: error.message,
    guidance: error.guidance,
    retryable: true,
    phaseId: error.phaseId,
  };
}

function phaseLifecyclePersistenceError(phaseId: string, cause: unknown): PhaseCheckpointError {
  return new PhaseCheckpointError(
    "phase-lifecycle-persistence-failed",
    phaseId,
    "The approved phase status could not be saved to Project Notes.",
    "The plan is still pending. Fix Project Notes storage, then retry approval.",
    { cause },
  );
}

function phaseLifecycleReconcileError(
  phaseId: string,
  status: Exclude<
    PhaseLifecycleReconcileOutcome["status"],
    "committed" | "same-status" | "manual-override" | "done-terminal" | "storage-failure"
  >,
): PhaseCheckpointError {
  if (status === "stale-session") {
    return new PhaseCheckpointError(
      "stale-phase-session",
      phaseId,
      "The phase is now linked to a different session.",
      "Resume the latest linked phase session, then retry approval.",
    );
  }
  const code: PhaseCheckpointErrorCode =
    status === "missing"
      ? "notes-missing"
      : status === "corrupt"
        ? "notes-corrupt"
        : status === "phase-archived"
          ? "phase-archived"
          : status === "phase-not-found"
            ? "phase-not-found"
            : "phase-lifecycle-persistence-failed";
  return new PhaseCheckpointError(
    code,
    phaseId,
    "The approved phase status checkpoint was not committed.",
    "Keep the plan pending, restore the linked phase, then retry approval.",
  );
}

function phaseLinkOutcomeError(
  phaseId: string,
  outcome: Exclude<ProjectNotesPhaseLinkOutcome, { status: "ok" }>,
): PhaseCheckpointError {
  switch (outcome.status) {
    case "missing":
      return new PhaseCheckpointError(
        "notes-missing",
        phaseId,
        "Project Notes are missing, so the latest phase checkpoint was not saved.",
        "Restore or recreate Project Notes, then retry the action.",
      );
    case "corrupt":
      return new PhaseCheckpointError(
        "notes-corrupt",
        phaseId,
        "Project Notes are corrupt, so the latest phase checkpoint was not saved.",
        "Restore Project Notes from a valid backup, then retry the action.",
      );
    case "phase-not-found":
      return new PhaseCheckpointError(
        "phase-not-found",
        phaseId,
        "The active phase no longer exists in Project Notes.",
        "Restore the phase or start it again, then retry the action.",
      );
    case "phase-archived":
      return new PhaseCheckpointError(
        "phase-archived",
        phaseId,
        "The active phase is archived, so its latest checkpoint was not saved.",
        "Unarchive or restart the phase, then retry the action.",
      );
  }
}
