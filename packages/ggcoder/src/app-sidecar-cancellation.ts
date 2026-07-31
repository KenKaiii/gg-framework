import { randomUUID } from "node:crypto";
interface BoundPhaseLifecycleContext {
  phaseId: string;
  [key: string]: unknown;
}

type PhaseLifecycleReconcileStatus =
  | "committed"
  | "same-status"
  | "manual-override"
  | "done-terminal"
  | "no-active-phase"
  | "phase-not-found"
  | "phase-archived"
  | "stale-session"
  | "missing"
  | "corrupt"
  | "storage-failure";

interface PhaseLifecycleReconcileOutcome {
  status: PhaseLifecycleReconcileStatus;
  error?: unknown;
}

interface AppSidecarPhaseLifecycleCoordinator {
  enqueue(
    event: { type: "cancelled" },
    context: BoundPhaseLifecycleContext,
  ): Promise<PhaseLifecycleReconcileOutcome>;
}

export type PhaseCancellationPersistenceFailureCode =
  | "phase-not-found"
  | "phase-archived"
  | "stale-session"
  | "missing"
  | "corrupt"
  | "storage-failure"
  | "not-recorded";

export interface PhaseCancellationPersistenceFailure {
  operationId: string;
  phaseId: string;
  code: PhaseCancellationPersistenceFailureCode;
  recovery: string;
  detail?: string;
}

export interface PhaseCancellationPersistenceResult {
  roadmapStatusSaved: boolean;
  roadmapStatusOutcome: PhaseLifecycleReconcileOutcome["status"] | "not-pending";
  roadmapStatusRetryable: boolean;
  roadmapStatusFailure?: PhaseCancellationPersistenceFailure;
}

interface PendingCancellationPersistence {
  operationId: string;
  activePhase: BoundPhaseLifecycleContext;
}

export interface AppSidecarCancellationPersistenceOptions {
  lifecycle: Pick<AppSidecarPhaseLifecycleCoordinator, "enqueue">;
  broadcast(type: string, data: unknown): void;
  createOperationId?: () => string;
}

const RECOVERY_BY_CODE: Record<PhaseCancellationPersistenceFailureCode, string> = {
  "phase-not-found":
    "Open Project Notes and restore the Roadmap phase, then retry saving its Cancelled status.",
  "phase-archived":
    "Open Project Notes and unarchive the Roadmap phase, then retry saving its Cancelled status.",
  "stale-session":
    "Open Project Notes and restore this session as the phase owner, then retry saving its Cancelled status.",
  missing: "Restore Project Notes for this project, then retry saving the Cancelled status.",
  corrupt: "Repair or restore Project Notes, then retry saving the Cancelled status.",
  "storage-failure":
    "Check Project Notes storage permissions and free space, then retry saving the Cancelled status.",
  "not-recorded": "Reopen the bound Roadmap phase, then retry saving its Cancelled status.",
};

function isIntentionalCancellationOutcome(outcome: PhaseLifecycleReconcileOutcome): boolean {
  return (
    outcome.status === "committed" ||
    outcome.status === "same-status" ||
    outcome.status === "manual-override" ||
    outcome.status === "done-terminal" ||
    outcome.status === "no-active-phase"
  );
}

function cancellationFailure(
  operationId: string,
  activePhase: BoundPhaseLifecycleContext,
  outcome: PhaseLifecycleReconcileOutcome,
): PhaseCancellationPersistenceFailure {
  const code: PhaseCancellationPersistenceFailureCode =
    outcome.status === "phase-not-found" ||
    outcome.status === "phase-archived" ||
    outcome.status === "stale-session" ||
    outcome.status === "missing" ||
    outcome.status === "corrupt" ||
    outcome.status === "storage-failure"
      ? outcome.status
      : "not-recorded";
  return {
    operationId,
    phaseId: activePhase.phaseId,
    code,
    recovery: RECOVERY_BY_CODE[code],
    ...(outcome.status === "storage-failure"
      ? { detail: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }
      : {}),
  };
}

/**
 * Owns the partial-failure boundary between an acknowledged provider cancellation
 * and its Project Notes lifecycle write. A failed write retains the exact phase
 * identity captured before cancellation so the retry cannot target a newer run.
 */
export class AppSidecarCancellationPersistence {
  private pending: PendingCancellationPersistence | null = null;
  private retryInFlight: Promise<PhaseCancellationPersistenceResult> | null = null;
  private readonly createOperationId: () => string;

  constructor(private readonly options: AppSidecarCancellationPersistenceOptions) {
    this.createOperationId = options.createOperationId ?? randomUUID;
  }

  async recordConfirmedCancellation(
    activePhase: BoundPhaseLifecycleContext | undefined,
  ): Promise<PhaseCancellationPersistenceResult> {
    if (!activePhase) {
      this.pending = null;
      return {
        roadmapStatusSaved: false,
        roadmapStatusOutcome: "no-active-phase",
        roadmapStatusRetryable: false,
      };
    }
    const pending = {
      operationId: this.createOperationId(),
      activePhase: structuredClone(activePhase),
    };
    this.pending = pending;
    return this.reconcile(pending, false);
  }

  retry(): Promise<PhaseCancellationPersistenceResult> {
    if (this.retryInFlight) return this.retryInFlight;
    const pending = this.pending;
    if (!pending) {
      return Promise.resolve({
        roadmapStatusSaved: false,
        roadmapStatusOutcome: "not-pending",
        roadmapStatusRetryable: false,
      });
    }
    const retry = this.reconcile(pending, true).finally(() => {
      if (this.retryInFlight === retry) this.retryInFlight = null;
    });
    this.retryInFlight = retry;
    return retry;
  }

  private async reconcile(
    pending: PendingCancellationPersistence,
    isRetry: boolean,
  ): Promise<PhaseCancellationPersistenceResult> {
    const outcome = await this.options.lifecycle.enqueue(
      { type: "cancelled" },
      pending.activePhase,
    );
    if (isIntentionalCancellationOutcome(outcome)) {
      if (this.pending?.operationId === pending.operationId) this.pending = null;
      const result: PhaseCancellationPersistenceResult = {
        roadmapStatusSaved: outcome.status === "committed" || outcome.status === "same-status",
        roadmapStatusOutcome: outcome.status,
        roadmapStatusRetryable: false,
      };
      if (isRetry) {
        this.options.broadcast("phase_cancellation_persistence_recovered", {
          operationId: pending.operationId,
          phaseId: pending.activePhase.phaseId,
          outcome: outcome.status,
          roadmapStatusSaved: result.roadmapStatusSaved,
        });
      }
      return result;
    }

    const failure = cancellationFailure(pending.operationId, pending.activePhase, outcome);
    this.options.broadcast("phase_cancellation_persistence_failed", failure);
    return {
      roadmapStatusSaved: false,
      roadmapStatusOutcome: outcome.status,
      roadmapStatusRetryable: true,
      roadmapStatusFailure: failure,
    };
  }
}

export function handleCancellationPersistenceRetryRoute(options: {
  method: string;
  url: string;
  retry(): Promise<PhaseCancellationPersistenceResult>;
  respond(status: number, body: PhaseCancellationPersistenceResult): void;
}): boolean {
  if (options.method !== "POST" || options.url !== "/cancel/roadmap-status/retry") return false;
  void options.retry().then(
    (result) => options.respond(200, result),
    (error) =>
      options.respond(500, {
        roadmapStatusSaved: false,
        roadmapStatusOutcome: "storage-failure",
        roadmapStatusRetryable: true,
        roadmapStatusFailure: {
          operationId: "unknown",
          phaseId: "unknown",
          code: "storage-failure",
          recovery:
            "Check Project Notes storage permissions and free space, then retry saving the Cancelled status.",
          detail: error instanceof Error ? error.message : String(error),
        },
      }),
  );
  return true;
}
