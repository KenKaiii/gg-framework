import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { PhaseStartResult } from "@kenkaiiii/gg-core/phase-start-protocol";
import type { AppSidecarPhaseCandidateStore } from "./app-sidecar-phase-candidates.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { isAppSidecarSessionBusy } from "./app-sidecar-session-mutation.js";
import type {
  AppSidecarSessionBusyState,
  AppSidecarSessionMutationCoordinator,
} from "./app-sidecar-session-mutation.js";
import {
  createActivePhaseContext,
  renderActivePhasePackage,
  type ActivePhaseContextV1,
} from "./phase-context.js";
import type {
  FrozenPhaseLaunchContext,
  NotesSessionLink,
  ProjectNotesPhaseLaunchOutcome,
  ProjectNotesPhaseLifecycleOutcome,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export interface BoundPhaseSessionState {
  provider: Provider;
  model: string;
  sessionId: string;
  sessionPath: string | null;
}

export interface BoundPhaseSession {
  initialize(): Promise<void>;
  getState(): BoundPhaseSessionState;
  setActivePhaseContext(context: ActivePhaseContextV1): Promise<void>;
  setIdealReviewSuppressed(suppressed: boolean): void;
  prompt(text: string): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface BoundPhaseCandidate<TSession extends BoundPhaseSession = BoundPhaseSession> {
  session: TSession;
  initialPrompt: string;
  tokenCount: number;
}

export interface PhaseLaunchRepository {
  launchPhase(
    cwd: string,
    phaseId: string,
    createBinding: (context: FrozenPhaseLaunchContext) => Promise<{
      sessionId: string;
      sessionPath: string | null;
    }>,
  ): Promise<ProjectNotesPhaseLaunchOutcome>;
  recordPhaseLaunchAttention(
    cwd: string,
    phaseId: string,
    reason: string,
    expectedSession?: NotesSessionLink | null,
  ): Promise<ProjectNotesPhaseLifecycleOutcome>;
}

export type PhaseStartResponseBody = PhaseStartResult;

export interface LaunchBoundPhaseDependencies<TSession extends BoundPhaseSession> {
  phaseId: string;
  mode: "code" | "chat";
  busyState: AppSidecarSessionBusyState;
  mutations: AppSidecarSessionMutationCoordinator;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  repository: PhaseLaunchRepository;
  cwd: string;
  candidates: AppSidecarPhaseCandidateStore<BoundPhaseCandidate<TSession>>;
  getSession(): TSession;
  getThinkingLevel(): ThinkingLevel | undefined;
  createSession(active: {
    provider: Provider;
    model: string;
    thinkingLevel?: ThinkingLevel;
  }): TSession;
  replaceSession(session: TSession): void;
  bindSessionEvents(session: TSession): void;
  autopilotEnabled: boolean;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  broadcast(type: string, data: unknown): void;
  resetSessionState(): void;
  enterPlanMode(reason: string): Promise<void>;
  startPrompt(
    label: string,
    run: () => Promise<void>,
    onFailure: (error: unknown) => void | Promise<void>,
  ): void;
  respond(status: number, body: PhaseStartResponseBody): void;
  onLaunchFailure?(error: unknown, metadata: { operationId: string; phaseId: string }): void;
  onAttentionFailure?(error: unknown, metadata: { operationId: string; phaseId: string }): void;
}

const PROMPT_FAILURE_MESSAGE =
  "The phase session was created, but its first planning prompt failed. Resume the phase to retry.";
const LAUNCH_FAILURE_MESSAGE = "Phase launch failed. Retry Start phase.";

/**
 * Authoritative phase-start transaction used by the production HTTP route.
 *
 * The mutation lease spans candidate creation, durable binding, session promotion,
 * Plan Mode entry, and the accepted response. The provider run starts only after
 * the response is emitted; its failure callback records a recoverable Notes state.
 */
export async function launchBoundPhase<TSession extends BoundPhaseSession>(
  dependencies: LaunchBoundPhaseDependencies<TSession>,
): Promise<void> {
  const { phaseId } = dependencies;
  if (dependencies.mode !== "code") {
    dependencies.respond(409, {
      status: "failed",
      code: "coding-mode-required",
      operationId: null,
      message: "Roadmap phases can only start in coding mode.",
    } satisfies PhaseStartResponseBody);
    return;
  }
  if (isAppSidecarSessionBusy(dependencies.busyState)) {
    dependencies.respond(409, {
      status: "failed",
      code: "session-busy",
      operationId: null,
      message: "Wait for the current run or Autopilot review to finish.",
    } satisfies PhaseStartResponseBody);
    return;
  }

  const mutation = dependencies.mutations.tryAcquire("phase-start");
  if (!mutation) {
    dependencies.respond(409, {
      status: "failed",
      code: "session-mutation-in-progress",
      operationId: dependencies.mutations.owner?.operationId ?? null,
      message: "Another session action is already in progress.",
    } satisfies PhaseStartResponseBody);
    return;
  }

  const reconciliation = dependencies.reconciliations.tryAcquire(dependencies.cwd, "phase-start");
  if (!reconciliation) {
    const owner = dependencies.reconciliations.owner(dependencies.cwd);
    mutation.release();
    dependencies.respond(409, {
      status: "failed",
      code: "reconciliation-in-progress",
      operationId: owner?.operationId ?? null,
      message: "Another Roadmap launch or status update is already in progress for this project.",
    } satisfies PhaseStartResponseBody);
    return;
  }

  let attentionExpectedSession: NotesSessionLink | null = null;
  try {
    const outcome = await dependencies.repository.launchPhase(
      dependencies.cwd,
      phaseId,
      async (frozen) => {
        attentionExpectedSession = frozen.phase.session ? { ...frozen.phase.session } : null;
        return createOrReuseCandidate(dependencies, frozen);
      },
    );
    if ("session" in outcome) attentionExpectedSession = outcome.session;

    if (outcome.status === "phase-not-found" || outcome.status === "phase-archived") {
      await dependencies.candidates.disposeCandidate(phaseId);
      dependencies.respond(409, {
        status: "failed",
        code: outcome.status,
        operationId: mutation.operationId,
        message:
          outcome.status === "phase-archived"
            ? "This phase was archived. Reopen Roadmap and choose an active phase."
            : "This phase no longer exists. Reopen Roadmap and try again.",
      } satisfies PhaseStartResponseBody);
      return;
    }
    if (outcome.status === "done-terminal") {
      await dependencies.candidates.disposeCandidate(phaseId);
      dependencies.respond(409, {
        status: "failed",
        code: "phase-inactive",
        operationId: mutation.operationId,
        message: "This phase is already Done. Reopen Roadmap to review its completion evidence.",
      } satisfies PhaseStartResponseBody);
      return;
    }
    if (outcome.status === "missing" || outcome.status === "corrupt") {
      dependencies.respond(outcome.status === "missing" ? 404 : 409, {
        status: "failed",
        code: outcome.status === "missing" ? "notes-missing" : "notes-corrupt",
        operationId: mutation.operationId,
        message: "Project Notes are unavailable. Reopen Notes and retry.",
      } satisfies PhaseStartResponseBody);
      return;
    }
    if (outcome.status === "already-bound") {
      await dependencies.candidates.disposeCandidate(phaseId);
      dependencies.broadcastNotesSnapshot(outcome.snapshot);
      dependencies.respond(200, {
        status: "already-bound",
        operationId: mutation.operationId,
        session: outcome.session,
        packageTokenCount: 0,
      } satisfies PhaseStartResponseBody);
      return;
    }

    const candidate = dependencies.candidates.take(phaseId);
    if (!candidate) throw new Error("Committed phase binding has no candidate session.");

    dependencies.broadcastNotesSnapshot(outcome.snapshot);
    const previousSession = dependencies.getSession();
    dependencies.replaceSession(candidate.session);
    try {
      dependencies.bindSessionEvents(candidate.session);
      candidate.session.setIdealReviewSuppressed(dependencies.autopilotEnabled);
      dependencies.resetSessionState();
      dependencies.broadcast("session_reset", {
        operationId: mutation.operationId,
        phaseId,
        sessionId: outcome.session.sessionId,
        sessionPath: outcome.session.sessionPath,
      });
      await dependencies.enterPlanMode(`Plan Roadmap phase: ${outcome.phase.title}`);
    } finally {
      await Promise.resolve(previousSession.dispose()).catch(() => {});
    }

    dependencies.respond(202, {
      status: "accepted",
      operationId: mutation.operationId,
      session: outcome.session,
      packageTokenCount: candidate.tokenCount,
    } satisfies PhaseStartResponseBody);
    dependencies.startPrompt(
      candidate.initialPrompt,
      () => candidate.session.prompt(candidate.initialPrompt),
      async (error) => {
        try {
          const attention = await dependencies.repository.recordPhaseLaunchAttention(
            dependencies.cwd,
            phaseId,
            PROMPT_FAILURE_MESSAGE,
            outcome.session,
          );
          if (attention.status === "ok") dependencies.broadcastNotesSnapshot(attention.snapshot);
        } catch (attentionError) {
          dependencies.onAttentionFailure?.(attentionError, {
            operationId: mutation.operationId,
            phaseId,
          });
        }
        dependencies.broadcast("phase_launch_error", {
          operationId: mutation.operationId,
          phaseId,
          code: "prompt-failed",
          message: PROMPT_FAILURE_MESSAGE,
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    );
  } catch (error) {
    dependencies.onLaunchFailure?.(error, { operationId: mutation.operationId, phaseId });
    const attention = await dependencies.repository
      .recordPhaseLaunchAttention(
        dependencies.cwd,
        phaseId,
        LAUNCH_FAILURE_MESSAGE,
        attentionExpectedSession,
      )
      .catch(() => null);
    if (attention?.status === "ok") dependencies.broadcastNotesSnapshot(attention.snapshot);
    dependencies.broadcast("phase_launch_error", {
      operationId: mutation.operationId,
      phaseId,
      code: "launch-failed",
      message: LAUNCH_FAILURE_MESSAGE,
    });
    dependencies.respond(500, {
      status: "failed",
      code: "launch-failed",
      operationId: mutation.operationId,
      message: LAUNCH_FAILURE_MESSAGE,
    } satisfies PhaseStartResponseBody);
  } finally {
    reconciliation.release();
    mutation.release();
  }
}

async function createOrReuseCandidate<TSession extends BoundPhaseSession>(
  dependencies: LaunchBoundPhaseDependencies<TSession>,
  frozen: FrozenPhaseLaunchContext,
): Promise<{ sessionId: string; sessionPath: string | null }> {
  const reusable = dependencies.candidates.get(dependencies.phaseId);
  if (reusable) {
    const state = reusable.session.getState();
    return { sessionId: state.sessionId, sessionPath: state.sessionPath };
  }

  const liveState = dependencies.getSession().getState();
  const candidateSession = dependencies.createSession({
    provider: liveState.provider,
    model: liveState.model,
    thinkingLevel: dependencies.getThinkingLevel(),
  });
  let candidateState: BoundPhaseSessionState;
  let rendered: ReturnType<typeof renderActivePhasePackage>;
  try {
    await candidateSession.initialize();
    candidateState = candidateSession.getState();
    rendered = renderActivePhasePackage(
      createActivePhaseContext({
        projectKey: frozen.projectKey,
        phase: frozen.phase,
        references: frozen.references,
        session: {
          sessionId: candidateState.sessionId,
          sessionPath: candidateState.sessionPath,
        },
      }),
    );
    await candidateSession.setActivePhaseContext(rendered.context);
  } catch (error) {
    await Promise.resolve(candidateSession.dispose()).catch(() => {});
    throw error;
  }
  await dependencies.candidates.add(dependencies.phaseId, {
    session: candidateSession,
    initialPrompt: rendered.initialPrompt,
    tokenCount: rendered.tokenEstimate,
  });
  return { sessionId: candidateState.sessionId, sessionPath: candidateState.sessionPath };
}
