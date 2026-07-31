import type { ActivePhaseExecutionStage } from "./phase-context.js";
import { NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH } from "./project-notes-repository.js";
import type {
  NotesAutomaticPhaseStatus,
  NotesLifecycleEventKind,
  NotesLifecycleEventSource,
  NotesSessionLink,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export const PHASE_LIFECYCLE_REASON_MAX_LENGTH = NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH;

export type PhaseLifecycleSignal =
  | { type: "session-restored"; executionStage: ActivePhaseExecutionStage }
  | { type: "plan-entered" }
  | { type: "plan-submitted" }
  | { type: "plan-approved"; approvalSource: "user" | "agent" }
  | { type: "implementation-run-started" }
  | { type: "ideal-review-started" }
  | { type: "autopilot-review-started" }
  | { type: "autopilot-human"; reason: string }
  | { type: "tool-failed"; toolName: string; reason?: string }
  | { type: "runtime-error"; reason: string }
  | { type: "autopilot-stopped"; reason: string }
  | { type: "cancelled" }
  | { type: "run-ended" }
  | { type: "tool-succeeded" }
  | { type: "autopilot-done" }
  | { type: "elapsed" };

export interface PhaseLifecycleTransition {
  status: NotesAutomaticPhaseStatus;
  source: NotesLifecycleEventSource;
  reason: string;
  kind: NotesLifecycleEventKind;
}

export interface BoundPhaseLifecycleContext {
  phaseId: string;
  session: NotesSessionLink;
  executionStage: ActivePhaseExecutionStage;
}

export type PhaseLifecycleRepositoryOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot }
  | { status: "manual-override"; snapshot: ProjectNotesSnapshot }
  | {
      status:
        | "same-status"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "done-terminal"
        | "missing"
        | "corrupt";
    };

export interface PhaseLifecycleRepository {
  recordPhaseLifecycleTransition(
    cwd: string,
    phaseId: string,
    transition: PhaseLifecycleTransition & {
      timestamp: string;
      expectedSession?: NotesSessionLink | null;
    },
  ): Promise<PhaseLifecycleRepositoryOutcome>;
}

export type PhaseLifecycleReconcileOutcome =
  | { status: "committed"; snapshot: ProjectNotesSnapshot }
  | { status: "manual-override"; snapshot: ProjectNotesSnapshot }
  | { status: "ignored" }
  | { status: "no-active-phase" }
  | {
      status:
        | "same-status"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "done-terminal"
        | "missing"
        | "corrupt";
    }
  | { status: "storage-failure"; error: unknown };

export interface PhaseLifecycleCoordinatorOptions {
  cwd: string;
  repository: PhaseLifecycleRepository;
  getActivePhase(): BoundPhaseLifecycleContext | undefined;
  broadcastSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  onError?: (error: unknown, signal: PhaseLifecycleSignal) => void;
}

const RESTORED_STAGE_TRANSITIONS: Record<ActivePhaseExecutionStage, PhaseLifecycleTransition> = {
  planning: {
    status: "planning",
    source: "session",
    reason: "Planning session resumed",
    kind: "other",
  },
  "awaiting-approval": {
    status: "waiting-for-approval",
    source: "session",
    reason: "Plan approval resumed",
    kind: "approval-opened",
  },
  implementing: {
    status: "in-progress",
    source: "session",
    reason: "Implementation session resumed",
    kind: "attention-implementation-resolved",
  },
  reviewing: {
    status: "review",
    source: "session",
    reason: "Review session resumed",
    kind: "attention-review-resolved",
  },
};

export function mapPhaseLifecycleSignal(
  signal: PhaseLifecycleSignal,
  executionStage: ActivePhaseExecutionStage,
): PhaseLifecycleTransition | null {
  switch (signal.type) {
    case "session-restored":
      return RESTORED_STAGE_TRANSITIONS[signal.executionStage];
    case "plan-entered":
      return { status: "planning", source: "agent", reason: "Plan Mode entered", kind: "other" };
    case "plan-submitted":
      return {
        status: "waiting-for-approval",
        source: "agent",
        reason: "Plan submitted for approval",
        kind: "approval-opened",
      };
    case "plan-approved":
      return signal.approvalSource === "user"
        ? {
            status: "in-progress",
            source: "user",
            reason: "Plan approved by user",
            kind: "approval-resolved",
          }
        : {
            status: "in-progress",
            source: "agent",
            reason: "Plan approved by Autopilot",
            kind: "approval-resolved",
          };
    case "implementation-run-started":
      return executionStage === "implementing" || executionStage === "reviewing"
        ? {
            status: "in-progress",
            source: "session",
            reason: "Implementation run started",
            kind: "attention-implementation-resolved",
          }
        : null;
    case "ideal-review-started":
      return executionStage === "implementing"
        ? {
            status: "review",
            source: "agent",
            reason: "Implementation verification started",
            kind: "other",
          }
        : null;
    case "autopilot-review-started":
      return executionStage === "implementing" || executionStage === "reviewing"
        ? { status: "review", source: "agent", reason: "Autopilot review started", kind: "other" }
        : null;
    case "autopilot-human":
      return {
        status: "needs-attention",
        source: "agent",
        reason: boundedReason(signal.reason, "Autopilot needs a user decision"),
        kind: "attention-question-opened",
      };
    case "tool-failed": {
      const toolName = boundedReason(signal.toolName, "Unknown tool", 80);
      const detail = signal.reason ? `: ${signal.reason}` : "";
      return {
        status: "needs-attention",
        source: "agent",
        reason: boundedReason(`${toolName} failed${detail}`, `${toolName} failed`),
        kind: "attention-tool-opened",
      };
    }
    case "runtime-error":
      return {
        status: "needs-attention",
        source: "session",
        reason: boundedReason(signal.reason, "The phase session failed"),
        kind: "attention-runtime-opened",
      };
    case "autopilot-stopped":
      return {
        status: "needs-attention",
        source: "system",
        reason: boundedReason(signal.reason, "Autopilot could not continue"),
        kind: "attention-generic-opened",
      };
    case "cancelled":
      return {
        status: "cancelled",
        source: "user",
        reason: "Phase run cancelled by user",
        kind: "other",
      };
    case "run-ended":
    case "tool-succeeded":
    case "autopilot-done":
    case "elapsed":
      return null;
  }
}

export class AppSidecarPhaseLifecycleCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: PhaseLifecycleCoordinatorOptions) {}

  enqueue(
    signal: PhaseLifecycleSignal,
    activePhase?: BoundPhaseLifecycleContext,
  ): Promise<PhaseLifecycleReconcileOutcome> {
    const timestamp = this.options.now?.() ?? new Date().toISOString();
    const captured = this.capture(activePhase);
    const operation = this.tail.then(() => this.reconcile(signal, timestamp, captured));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private capture(
    activePhase?: BoundPhaseLifecycleContext,
  ): BoundPhaseLifecycleContext | undefined {
    const active = activePhase ?? this.options.getActivePhase();
    return active
      ? {
          phaseId: active.phaseId,
          session: { ...active.session },
          executionStage: active.executionStage,
        }
      : undefined;
  }

  private async reconcile(
    signal: PhaseLifecycleSignal,
    timestamp: string,
    captured: BoundPhaseLifecycleContext | undefined,
  ): Promise<PhaseLifecycleReconcileOutcome> {
    if (!captured) return { status: "no-active-phase" };
    const transition = mapPhaseLifecycleSignal(signal, captured.executionStage);
    if (!transition) return { status: "ignored" };

    try {
      const outcome = await this.options.repository.recordPhaseLifecycleTransition(
        this.options.cwd,
        captured.phaseId,
        { ...transition, timestamp, expectedSession: captured.session },
      );
      if (outcome.status === "manual-override") {
        this.options.broadcastSnapshot(outcome.snapshot);
        return outcome;
      }
      if (outcome.status !== "ok") return outcome;
      this.options.broadcastSnapshot(outcome.snapshot);
      return { status: "committed", snapshot: outcome.snapshot };
    } catch (error) {
      this.options.onError?.(error, signal);
      return { status: "storage-failure", error };
    }
  }
}

function boundedReason(
  value: string,
  fallback: string,
  maxLength = PHASE_LIFECYCLE_REASON_MAX_LENGTH,
): string {
  const normalized = value.replace(/\s+/g, " ").trim() || fallback;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trimEnd();
}
