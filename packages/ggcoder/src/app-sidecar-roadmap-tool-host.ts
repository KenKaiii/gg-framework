import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type {
  NotesReference,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import {
  createRoadmapStatusTool,
  type RoadmapStatusActor,
  type RoadmapStatusInput,
  type RoadmapStatusToolResult,
} from "./tools/roadmap-status.js";

export type AppSidecarRoadmapSessionRole = "coding" | "ken" | "ken-autopilot";

/** Ken stays read-only except for this structured Roadmap metadata write. */
export const APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
  "roadmap_status",
] as const;

export interface AppSidecarRoadmapToolSession {
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  getState(): { sessionId: string; sessionPath: string | null };
}

export interface AppSidecarRoadmapToolHostDependencies {
  cwd: string;
  repository: Pick<
    ProjectNotesRepository,
    "recordRoadmapStatusUpdate" | "recordRoadmapFinalReview"
  >;
  canSubmitFinalReview?(): boolean;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  projectAutopilot: Pick<AppSidecarProjectAutopilotState, "isEnabled">;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  onNonCommit?(metadata: { result: string; phaseId: string; updateId: string }): void;
  onError?(error: unknown, metadata: { phaseId: string; updateId: string }): void;
}

const ACTOR_BY_ROLE: Record<AppSidecarRoadmapSessionRole, RoadmapStatusActor> = {
  coding: "gg-coder",
  ken: "ken",
  "ken-autopilot": "ken-autopilot",
};

/** Production host for every app-only roadmap_status registration and execution. */
export class AppSidecarRoadmapToolHost {
  constructor(private readonly dependencies: AppSidecarRoadmapToolHostDependencies) {}

  createSessionTools(
    role: AppSidecarRoadmapSessionRole,
    getOwningSession?: () => AppSidecarRoadmapToolSession,
  ): AgentTool[] {
    if (role === "coding" && !getOwningSession) {
      throw new Error("Coding roadmap_status registration requires an owning session.");
    }
    const actor = ACTOR_BY_ROLE[role];
    return [
      createRoadmapStatusTool(actor, ({ input }) =>
        this.record(actor, input, role === "coding" ? getOwningSession : undefined),
      ),
    ];
  }

  private async record(
    actor: RoadmapStatusActor,
    input: RoadmapStatusInput,
    getOwningSession?: () => AppSidecarRoadmapToolSession,
  ): Promise<RoadmapStatusToolResult> {
    const { cwd, reconciliations } = this.dependencies;
    if (actor === "gg-coder" && input.final_review !== null) {
      return { result: "reviewer-not-authorized", phaseId: input.phase_id };
    }
    const reconciliation = reconciliations.tryAcquire(cwd, "status-update");
    if (!reconciliation) {
      const owner = reconciliations.owner(cwd);
      return {
        result: "reconciliation-in-progress",
        phaseId: input.phase_id,
        owner: owner ? { operationId: owner.operationId, kind: owner.kind } : null,
      };
    }

    try {
      const activePhase = getOwningSession ? activePhaseContext(getOwningSession()) : undefined;
      if (actor === "gg-coder" && activePhase?.phaseId !== input.phase_id) {
        return { result: "phase-not-bound", phaseId: input.phase_id };
      }
      const statusRequest = {
        updateId: input.update_id,
        phaseId: input.phase_id,
        ...(input.expected_revision === undefined
          ? {}
          : { expectedRevision: input.expected_revision }),
        actor,
        transition: input.transition,
        progress: input.progress,
        blocker: input.transition === "blocked" ? input.blocker : null,
        evidence: [...input.evidence],
        verification: input.verification?.result ?? null,
        verificationReason:
          input.verification && "reason" in input.verification ? input.verification.reason : null,
        proposedReferences: input.proposed_references.map(roadmapReferenceFromToolInput),
        timestamp: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        ...(actor === "gg-coder"
          ? { expectedSession: activePhase!.session, requireBoundPhase: true }
          : {}),
        autopilotEnabled: this.dependencies.projectAutopilot.isEnabled(cwd),
      };
      if (input.final_review !== null) {
        return this.recordFinalReview(
          actor as Exclude<RoadmapStatusActor, "gg-coder">,
          input,
          statusRequest,
        );
      }
      const outcome = await this.dependencies.repository.recordRoadmapStatusUpdate(
        cwd,
        statusRequest,
      );
      if (outcome.status === "committed" || outcome.status === "duplicate") {
        if (outcome.status === "committed") {
          this.dependencies.broadcastNotesSnapshot(outcome.snapshot);
        }
        return {
          result: outcome.status,
          phaseId: input.phase_id,
          revision: outcome.status === "committed" ? outcome.snapshot.revision : outcome.revision,
          statusOutcome: outcome.statusOutcome,
          proposals: outcome.proposals,
        };
      }
      const result =
        outcome.status === "missing"
          ? "notes-missing"
          : outcome.status === "corrupt"
            ? "notes-corrupt"
            : outcome.status;
      this.dependencies.onNonCommit?.({
        result,
        phaseId: input.phase_id,
        updateId: input.update_id,
      });
      return {
        result,
        phaseId: input.phase_id,
        ...("revision" in outcome ? { revision: outcome.revision } : {}),
        ...(outcome.status === "invalid-reference"
          ? { path: outcome.path, message: outcome.message }
          : {}),
      };
    } catch (error) {
      this.dependencies.onError?.(error, {
        phaseId: input.phase_id,
        updateId: input.update_id,
      });
      throw error;
    } finally {
      reconciliation.release();
    }
  }

  private async recordFinalReview(
    actor: Exclude<RoadmapStatusActor, "gg-coder">,
    input: RoadmapStatusInput,
    statusUpdate: Parameters<ProjectNotesRepository["recordRoadmapFinalReview"]>[1]["statusUpdate"],
  ): Promise<RoadmapStatusToolResult> {
    const finalReview = input.final_review!;
    if (this.dependencies.canSubmitFinalReview?.() === false) {
      return { result: "completion-checkpoint-blocked", phaseId: input.phase_id };
    }
    const completion = await this.dependencies.repository.recordRoadmapFinalReview(
      this.dependencies.cwd,
      {
        statusUpdate: { ...statusUpdate, actor },
        review: {
          reviewId: finalReview.review_id,
          decision: finalReview.decision,
          evidence: [...finalReview.evidence],
          reason: finalReview.reason,
          acceptsVerificationException: finalReview.accepts_verification_exception,
        },
      },
    );
    if (completion.status === "committed") {
      this.dependencies.broadcastNotesSnapshot(completion.snapshot);
      return {
        result: "completion-review-committed",
        phaseId: input.phase_id,
        revision: completion.snapshot.revision,
        statusOutcome: completion.statusOutcome,
        proposals: completion.proposals,
        gateOutcome: completion.evaluation.gateOutcome,
        unmetGateCodes: completion.evaluation.unmetGateCodes,
      };
    }
    if (completion.status === "duplicate") {
      return {
        result: "completion-review-duplicate",
        phaseId: input.phase_id,
        revision: completion.revision,
        statusOutcome: completion.statusOutcome,
        proposals: completion.proposals,
        gateOutcome: completion.evaluation.gateOutcome,
        unmetGateCodes: completion.evaluation.unmetGateCodes,
      };
    }
    const result =
      completion.status === "missing"
        ? "notes-missing"
        : completion.status === "corrupt"
          ? "notes-corrupt"
          : completion.status;
    this.dependencies.onNonCommit?.({
      result,
      phaseId: input.phase_id,
      updateId: input.update_id,
    });
    return {
      result,
      phaseId: input.phase_id,
      ...("revision" in completion ? { revision: completion.revision } : {}),
      ...(completion.status === "invalid-review"
        ? { message: completion.message }
        : completion.status === "invalid-reference"
          ? { path: completion.path, message: completion.message }
          : {}),
    };
  }
}

function activePhaseContext(session: AppSidecarRoadmapToolSession):
  | {
      phaseId: string;
      session: { sessionId: string; sessionPath: string | null };
    }
  | undefined {
  const context = session.getActivePhaseContext();
  if (!context) return undefined;
  const state = session.getState();
  return {
    phaseId: context.phase.id,
    session: { sessionId: state.sessionId, sessionPath: state.sessionPath },
  };
}

function roadmapReferenceFromToolInput(
  reference: RoadmapStatusInput["proposed_references"][number],
): Omit<NotesReference, "id" | "capturedAt"> {
  return {
    provider: reference.provider,
    tool: reference.tool,
    canonicalUrl: reference.canonical_url,
    owner: reference.owner,
    repo: reference.repo,
    revision: reference.revision,
    path: reference.path,
    range: reference.range
      ? { startLine: reference.range.start_line, endLine: reference.range.end_line }
      : null,
    issue: reference.issue,
    pullRequest: reference.pull_request,
    query: reference.query,
    anchor: reference.anchor,
    relevance: reference.relevance,
  };
}
