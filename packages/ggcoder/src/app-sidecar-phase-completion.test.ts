import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarPhaseCompletionCoordinator,
  autopilotVerdictAcceptsVerificationException,
  latestVerificationExceptionForReview,
  type PhaseCompletionRepository,
} from "./app-sidecar-phase-completion.js";
import {
  evaluatePhaseCompletion,
  type PhaseCompletionReviewDecision,
} from "./project-notes-completion-policy.js";
import type {
  NotesPhase,
  NotesRoadmapEvent,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

const NOW = "2026-07-28T12:00:00.000Z";
const LATER = "2026-07-28T12:01:00.000Z";
const session = { sessionId: "session-24", sessionPath: "/sessions/24.jsonl" };

function checkpoint(
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "implementation-checkpoint" }>> = {},
) {
  return {
    type: "implementation-checkpoint" as const,
    id: "checkpoint-1",
    session,
    planStepTotal: 3,
    completedPlanSteps: [1, 2, 3],
    runOutcome: "succeeded" as const,
    timestamp: NOW,
    ...overrides,
  };
}

function verification(
  result: "passed" | "failed" | "exception-requested" = "passed",
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "status-update" }>> = {},
) {
  return {
    type: "status-update" as const,
    id: `verification-${result}`,
    actor: "gg-coder" as const,
    transition: "review" as const,
    progress: "Verification completed",
    blocker: null,
    evidence: ["pnpm test passed"],
    verification: result,
    verificationReason: result === "passed" ? null : "Verification could not pass",
    verificationSession: session,
    statusOutcome: "same-status" as const,
    proposedReferences: [],
    timestamp: LATER,
    ...overrides,
  };
}

function rejectedReview(
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "completion-review" }>> = {},
) {
  return {
    type: "completion-review" as const,
    id: "review-rejected",
    reviewer: "ken-autopilot" as const,
    decision: "rejected" as const,
    evidence: [],
    reason: "Revise the implementation",
    implementationCheckpointId: "checkpoint-1",
    verificationStatusUpdateId: "verification-passed",
    acceptsVerificationException: false,
    gateOutcome: "review" as const,
    unmetGateCodes: [],
    timestamp: "2026-07-28T12:02:00.000Z",
    ...overrides,
  };
}

function phase(events: NotesRoadmapEvent[] = [checkpoint(), verification()]): NotesPhase {
  return {
    id: "phase-24",
    title: "Completion gates",
    goal: "Finish only with durable evidence",
    doneWhen: ["All gates pass"],
    order: 0,
    status: "review",
    sourcePrompt: "Implement Phase 24",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: LATER,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [
      {
        id: "lifecycle-progress",
        fromStatus: null,
        toStatus: "in-progress",
        source: "session",
        timestamp: NOW,
        reason: "Implementation started",
        kind: "other",
      },
      {
        id: "lifecycle-review",
        fromStatus: "in-progress",
        toStatus: "review",
        source: "agent",
        timestamp: LATER,
        reason: "Review started",
        kind: "other",
      },
    ],
    roadmapEvents: events,
  };
}

const accepted = {
  reviewer: "ken-autopilot" as const,
  decision: "accepted" as const,
  acceptsVerificationException: false,
  reason: null,
};

function evaluate(candidate: NotesPhase, review: PhaseCompletionReviewDecision = accepted) {
  return evaluatePhaseCompletion({ phase: candidate, expectedSession: session, review });
}

describe("evaluatePhaseCompletion", () => {
  it("allows Done only with a successful complete checkpoint, verification, and accepted review", () => {
    expect(evaluate(phase())).toEqual({
      gateOutcome: "done",
      unmetGateCodes: [],
      implementationCheckpointId: "checkpoint-1",
      verificationStatusUpdateId: "verification-passed",
      targetStatus: "done",
      reason: "Final review accepted by Autopilot Ken.",
    });
  });

  it.each([
    ["missing implementation", [verification()], "missing-implementation"],
    [
      "incomplete plan",
      [checkpoint({ completedPlanSteps: [1, 2] }), verification()],
      "incomplete-plan",
    ],
    ["failed run", [checkpoint({ runOutcome: "failed" }), verification()], "run-not-successful"],
    [
      "stale checkpoint",
      [checkpoint({ session: { sessionId: "stale", sessionPath: null } }), verification()],
      "stale-session",
    ],
    ["missing verification", [checkpoint()], "missing-verification"],
  ] as const)("keeps %s in review", (_name, events, gate) => {
    const result = evaluate(phase([...events]));
    expect(result.gateOutcome).toBe("review");
    expect(result.targetStatus).toBe("review");
    expect(result.unmetGateCodes).toContain(gate);
  });

  it("rejects pre-rejection evidence when a revision records no fresh evidence", () => {
    const result = evaluate(phase([checkpoint(), verification(), rejectedReview()]));
    expect(result).toMatchObject({
      gateOutcome: "review",
      implementationCheckpointId: null,
      verificationStatusUpdateId: null,
      unmetGateCodes: expect.arrayContaining(["missing-implementation", "missing-verification"]),
    });
  });

  it("rejects a fresh revision checkpoint until that review round has fresh verification", () => {
    const result = evaluate(
      phase([
        checkpoint(),
        verification(),
        rejectedReview(),
        checkpoint({ id: "checkpoint-revision", timestamp: "2026-07-28T12:03:00.000Z" }),
      ]),
    );
    expect(result).toMatchObject({
      gateOutcome: "review",
      implementationCheckpointId: "checkpoint-revision",
      verificationStatusUpdateId: null,
      unmetGateCodes: ["missing-verification"],
    });
  });

  it("rejects verification retained from a replaced session", () => {
    const replacement = { sessionId: "session-25", sessionPath: "/sessions/25.jsonl" };
    const candidate = phase([
      verification("passed", { id: "old-session-verification", verificationSession: session }),
      checkpoint({ id: "new-session-checkpoint", session: replacement, timestamp: LATER }),
    ]);
    candidate.session = replacement;
    const result = evaluatePhaseCompletion({
      phase: candidate,
      expectedSession: replacement,
      review: accepted,
    });
    expect(result).toMatchObject({
      gateOutcome: "review",
      implementationCheckpointId: "new-session-checkpoint",
      verificationStatusUpdateId: "old-session-verification",
      unmetGateCodes: ["stale-session"],
    });
  });

  it("allows Done after both revision evidence records follow the latest rejection", () => {
    const result = evaluate(
      phase([
        checkpoint(),
        verification(),
        rejectedReview(),
        verification("passed", {
          id: "verification-revision",
          timestamp: "2026-07-28T12:03:00.000Z",
        }),
        checkpoint({ id: "checkpoint-revision", timestamp: "2026-07-28T12:04:00.000Z" }),
      ]),
    );
    expect(result).toMatchObject({
      gateOutcome: "done",
      implementationCheckpointId: "checkpoint-revision",
      verificationStatusUpdateId: "verification-revision",
      unmetGateCodes: [],
    });
  });

  it("moves failed verification to attention", () => {
    const result = evaluate(phase([checkpoint(), verification("failed")]));
    expect(result).toMatchObject({
      gateOutcome: "needs-attention",
      targetStatus: "needs-attention",
      unmetGateCodes: ["failed-verification"],
    });
  });

  it("requires explicit exception acceptance and then permits Done", () => {
    const candidate = phase([checkpoint(), verification("exception-requested")]);
    expect(evaluate(candidate)).toMatchObject({
      gateOutcome: "review",
      unmetGateCodes: ["verification-exception-not-accepted"],
    });
    expect(evaluate(candidate, { ...accepted, acceptsVerificationException: true })).toMatchObject({
      gateOutcome: "done",
      unmetGateCodes: [],
    });
  });

  it("binds exception acceptance to the exact latest typed exception ID", () => {
    const candidate = phase([
      checkpoint(),
      verification("exception-requested", {
        id: "verification-exception-24",
        actor: "ken-autopilot",
        verificationReason: "CI is unavailable",
        evidence: ["Local checks passed", "CI returned 503"],
      }),
    ]);
    const currentException = latestVerificationExceptionForReview(candidate);

    expect(currentException).toEqual({
      id: "verification-exception-24",
      requesterActor: "ken-autopilot",
      reason: "CI is unavailable",
      timestamp: LATER,
      evidence: ["Local checks passed", "CI returned 503"],
    });
    expect(
      autopilotVerdictAcceptsVerificationException({ kind: "all_clear" }, currentException),
    ).toBe(false);
    expect(
      autopilotVerdictAcceptsVerificationException(
        { kind: "all_clear", acceptedVerificationExceptionId: "stale-exception" },
        currentException,
      ),
    ).toBe(false);
    expect(
      autopilotVerdictAcceptsVerificationException(
        {
          kind: "all_clear",
          acceptedVerificationExceptionId: "verification-exception-24",
        },
        currentException,
      ),
    ).toBe(true);
  });

  it("does not expose a superseded exception as the current review request", () => {
    const candidate = phase([
      checkpoint(),
      verification("exception-requested", { id: "old-exception", timestamp: NOW }),
      verification("passed", { id: "new-pass", timestamp: LATER }),
    ]);
    expect(latestVerificationExceptionForReview(candidate)).toBeNull();
  });

  it("keeps unresolved approval waiting and unresolved attention blocked", () => {
    const approval = phase();
    approval.status = "waiting-for-approval";
    approval.lifecycleEvents = [
      {
        id: "approval",
        fromStatus: null,
        toStatus: "waiting-for-approval",
        source: "agent",
        timestamp: LATER,
        reason: "Plan submitted",
        kind: "approval-opened",
      },
    ];
    expect(evaluate(approval)).toMatchObject({
      gateOutcome: "waiting-for-approval",
      unmetGateCodes: expect.arrayContaining(["unresolved-approval"]),
    });

    const attention = phase();
    attention.status = "needs-attention";
    attention.lifecycleEvents = [
      {
        id: "attention",
        fromStatus: null,
        toStatus: "needs-attention",
        source: "agent",
        timestamp: LATER,
        reason: "Question remains",
        kind: "attention-question-opened",
      },
    ];
    expect(evaluate(attention)).toMatchObject({
      gateOutcome: "needs-attention",
      unmetGateCodes: expect.arrayContaining(["unresolved-attention"]),
    });
  });

  it("resolves same-millisecond approval from lifecycle append order", () => {
    const candidate = phase();
    candidate.status = "in-progress";
    candidate.lifecycleEvents = [
      {
        id: "approval-opened",
        fromStatus: "review",
        toStatus: "waiting-for-approval",
        source: "agent",
        timestamp: LATER,
        reason: "Aprobación pendiente",
        kind: "approval-opened",
      },
      {
        id: "approval-resolved",
        fromStatus: "waiting-for-approval",
        toStatus: "in-progress",
        source: "user",
        timestamp: LATER,
        reason: "Aprobado por la persona usuaria",
        kind: "approval-resolved",
      },
    ];

    expect(evaluate(candidate)).toMatchObject({ gateOutcome: "done", unmetGateCodes: [] });
  });

  it("resolves same-millisecond attention from lifecycle append order", () => {
    const candidate = phase();
    candidate.status = "in-progress";
    candidate.lifecycleEvents = [
      {
        id: "attention-opened",
        fromStatus: "review",
        toStatus: "needs-attention",
        source: "agent",
        timestamp: LATER,
        reason: "Choisissez la forme de l’API publique",
        kind: "attention-question-opened",
      },
      {
        id: "attention-resolved",
        fromStatus: "needs-attention",
        toStatus: "in-progress",
        source: "session",
        timestamp: LATER,
        reason: "Exécution de l’implémentation démarrée",
        kind: "attention-implementation-resolved",
      },
    ];

    expect(evaluate(candidate)).toMatchObject({ gateOutcome: "done", unmetGateCodes: [] });
  });

  it.each([
    {
      blocker: "approval",
      status: "waiting-for-approval" as const,
      source: "agent" as const,
      reason: "Approval copy may change",
      kind: "approval-opened" as const,
      expectedGate: "waiting-for-approval",
      resolution: {
        toStatus: "in-progress" as const,
        source: "user" as const,
        reason: "Approval resolution copy may change",
        kind: "approval-resolved" as const,
      },
    },
    {
      blocker: "question",
      status: "needs-attention" as const,
      source: "agent" as const,
      reason: "Question copy may change",
      kind: "attention-question-opened" as const,
      expectedGate: "needs-attention",
      resolution: {
        toStatus: "in-progress" as const,
        source: "session" as const,
        reason: "Implementation resolution copy may change",
        kind: "attention-implementation-resolved" as const,
      },
    },
    {
      blocker: "runtime error via implementation",
      status: "needs-attention" as const,
      source: "session" as const,
      reason: "Runtime copy may change",
      kind: "attention-runtime-opened" as const,
      expectedGate: "needs-attention",
      resolution: {
        toStatus: "in-progress" as const,
        source: "session" as const,
        reason: "Runtime implementation resolution copy may change",
        kind: "attention-implementation-resolved" as const,
      },
    },
    {
      blocker: "runtime error via review",
      status: "needs-attention" as const,
      source: "session" as const,
      reason: "Runtime copy may change",
      kind: "attention-runtime-opened" as const,
      expectedGate: "needs-attention",
      resolution: {
        toStatus: "review" as const,
        source: "session" as const,
        reason: "Runtime review resolution copy may change",
        kind: "attention-review-resolved" as const,
      },
    },
    {
      blocker: "tool failure",
      status: "needs-attention" as const,
      source: "agent" as const,
      reason: "Tool copy has no legacy failure pattern",
      kind: "attention-tool-opened" as const,
      expectedGate: "needs-attention",
      resolution: {
        toStatus: "in-progress" as const,
        source: "session" as const,
        reason: "Tool resolution copy may change",
        kind: "attention-implementation-resolved" as const,
      },
    },
    {
      blocker: "generic attention via implementation",
      status: "needs-attention" as const,
      source: "system" as const,
      reason: "Generic attention copy may change",
      kind: "attention-generic-opened" as const,
      expectedGate: "needs-attention",
      resolution: {
        toStatus: "in-progress" as const,
        source: "session" as const,
        reason: "Generic implementation resolution copy may change",
        kind: "attention-implementation-resolved" as const,
      },
    },
    {
      blocker: "generic attention via review",
      status: "needs-attention" as const,
      source: "system" as const,
      reason: "Generic attention copy may change",
      kind: "attention-generic-opened" as const,
      expectedGate: "needs-attention",
      resolution: {
        toStatus: "review" as const,
        source: "session" as const,
        reason: "Generic review resolution copy may change",
        kind: "attention-review-resolved" as const,
      },
    },
  ])(
    "requires an explicit lifecycle resolution for a $blocker blocker",
    ({ status, source, reason, kind, expectedGate, resolution }) => {
      const candidate = phase();
      candidate.status = "review";
      candidate.lifecycleEvents = [
        {
          id: "blocker-opened",
          fromStatus: "review",
          toStatus: status,
          source,
          timestamp: "2026-07-28T12:02:00.000Z",
          reason,
          kind,
        },
        {
          id: "generic-review-report",
          fromStatus: status,
          toStatus: "review",
          source: "agent",
          timestamp: "2026-07-28T12:03:00.000Z",
          reason: "Roadmap report: Ken submitted final review",
          kind: "other",
        },
        {
          id: "reviewer-started",
          fromStatus: "review",
          toStatus: "review",
          source: "agent",
          timestamp: "2026-07-28T12:03:30.000Z",
          reason: "Autopilot review started",
          kind: "other",
        },
      ];
      expect(evaluate(candidate)).toMatchObject({ gateOutcome: expectedGate });

      candidate.lifecycleEvents.push({
        id: "blocker-resolved",
        fromStatus: "review",
        ...resolution,
        timestamp: "2026-07-28T12:04:00.000Z",
      });
      expect(evaluate(candidate)).toMatchObject({ gateOutcome: "done", unmetGateCodes: [] });
    },
  );

  it("records rejected feedback in review and protects overrides and terminal Done", () => {
    expect(
      evaluate(phase(), {
        ...accepted,
        decision: "rejected",
        reason: "Add the missing race test",
      }),
    ).toMatchObject({ gateOutcome: "review", reason: "Add the missing race test" });

    const overridden = phase();
    overridden.overrides.status = { value: "review", source: "user", updatedAt: LATER };
    expect(evaluate(overridden)).toMatchObject({
      gateOutcome: "manual-override",
      targetStatus: null,
    });

    const done = phase();
    done.status = "done";
    done.completedAt = LATER;
    done.lifecycleEvents.push({
      id: "done",
      fromStatus: "review",
      toStatus: "done",
      source: "system",
      timestamp: LATER,
      reason: "Already done",
      kind: "other",
    });
    expect(evaluate(done)).toMatchObject({ gateOutcome: "done-terminal", targetStatus: null });
  });

  it("rejects an inactive phase and a stale current binding", () => {
    const inactive = phase();
    inactive.status = "cancelled";
    inactive.lifecycleEvents = [];
    expect(evaluate(inactive).unmetGateCodes).toContain("inactive-phase");

    const stale = phase();
    stale.session = { sessionId: "replacement", sessionPath: null };
    expect(evaluate(stale).unmetGateCodes).toContain("stale-session");
  });
});

function snapshot(revision: number): ProjectNotesSnapshot {
  return {
    projectKey: "/project",
    revision,
    document: {
      version: 3,
      reference: "",
      currentFocus: "",
      tasks: [],
      handoff: { text: "", updatedAt: null, readAt: null },
      updatedAt: NOW,
      legacyImportedAt: null,
      phases: [],
      references: [],
    },
  };
}

describe("AppSidecarPhaseCompletionCoordinator", () => {
  it("serializes checkpoint and review writes, broadcasts commits, and recovers after rejection", async () => {
    const order: string[] = [];
    const repository: PhaseCompletionRepository = {
      recordImplementationCheckpoint: vi.fn(async () => {
        order.push("checkpoint");
        throw new Error("disk full");
      }),
      recordCompletionReview: vi.fn(async () => {
        order.push("review");
        return {
          status: "committed" as const,
          snapshot: snapshot(2),
          phase: phase(),
          evaluation: evaluate(phase()),
        };
      }),
    };
    const broadcasts: number[] = [];
    const errors: string[] = [];
    const coordinator = new AppSidecarPhaseCompletionCoordinator({
      cwd: "/project",
      repository,
      broadcastSnapshot: (value) => broadcasts.push(value.revision),
      onError: (_error, kind) => errors.push(kind),
    });

    const failed = coordinator.checkpoint({
      checkpointId: "checkpoint",
      phaseId: "phase-24",
      expectedSession: session,
      planStepTotal: 3,
      completedPlanSteps: [1, 2, 3],
      runOutcome: "succeeded",
      timestamp: NOW,
    });
    const reviewed = coordinator.review({
      reviewId: "review",
      phaseId: "phase-24",
      expectedSession: session,
      reviewer: "ken",
      decision: "accepted",
      evidence: ["Reviewed"],
      reason: null,
      acceptsVerificationException: false,
      timestamp: LATER,
    });

    await expect(failed).resolves.toMatchObject({ status: "storage-failure" });
    await expect(reviewed).resolves.toMatchObject({ status: "committed" });
    expect(order).toEqual(["checkpoint", "review"]);
    expect(errors).toEqual(["implementation-checkpoint"]);
    expect(broadcasts).toEqual([2]);
  });
});
