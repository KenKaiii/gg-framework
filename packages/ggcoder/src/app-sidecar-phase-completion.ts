import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import type { KenVerificationException } from "./core/ken-context.js";
import { latestVerificationExceptionEventForReview } from "./project-notes-completion-policy.js";
import type {
  NotesPhase,
  ProjectNotesCompletionReviewOutcome,
  ProjectNotesCompletionReviewRequest,
  ProjectNotesImplementationCheckpointOutcome,
  ProjectNotesImplementationCheckpointRequest,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

/** Adapt the current typed verification exception into Autopilot Ken's review context. */
export function latestVerificationExceptionForReview(
  phase: NotesPhase | undefined,
): KenVerificationException | null {
  const verification = latestVerificationExceptionEventForReview(phase);
  if (!verification) return null;
  return {
    id: verification.id,
    requesterActor: verification.actor,
    reason: verification.verificationReason,
    timestamp: verification.timestamp,
    evidence: [...verification.evidence],
  };
}

/** An ALL_CLEAR accepts an exception only by naming the exact current request. */
export function autopilotVerdictAcceptsVerificationException(
  verdict: Extract<AutopilotVerdict, { kind: "all_clear" }>,
  currentException: KenVerificationException | null,
): boolean {
  return (
    currentException !== null && verdict.acceptedVerificationExceptionId === currentException.id
  );
}

export interface PhaseCompletionRepository {
  recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome>;
  recordCompletionReview(
    cwd: string,
    request: ProjectNotesCompletionReviewRequest,
  ): Promise<ProjectNotesCompletionReviewOutcome>;
}

export type PhaseCompletionCoordinatorOutcome =
  | ProjectNotesImplementationCheckpointOutcome
  | ProjectNotesCompletionReviewOutcome
  | { status: "storage-failure"; error: unknown };

export interface PhaseCompletionCoordinatorOptions {
  cwd: string;
  repository: PhaseCompletionRepository;
  broadcastSnapshot(snapshot: ProjectNotesSnapshot): void;
  onError?(error: unknown, kind: "implementation-checkpoint" | "completion-review"): void;
}

export class AppSidecarPhaseCompletionCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: PhaseCompletionCoordinatorOptions) {}

  checkpoint(
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("implementation-checkpoint", () =>
      this.options.repository.recordImplementationCheckpoint(this.options.cwd, request),
    );
  }

  review(request: ProjectNotesCompletionReviewRequest): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("completion-review", () =>
      this.options.repository.recordCompletionReview(this.options.cwd, request),
    );
  }

  private enqueue(
    kind: "implementation-checkpoint" | "completion-review",
    operation: () => Promise<
      ProjectNotesImplementationCheckpointOutcome | ProjectNotesCompletionReviewOutcome
    >,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    const queued = this.tail.then(async () => {
      try {
        const outcome = await operation();
        if (outcome.status === "committed") this.options.broadcastSnapshot(outcome.snapshot);
        return outcome;
      } catch (error) {
        this.options.onError?.(error, kind);
        return { status: "storage-failure" as const, error };
      }
    });
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}
