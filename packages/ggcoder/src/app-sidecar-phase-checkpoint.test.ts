import { describe, expect, it, vi } from "vitest";
import {
  PhaseCheckpointError,
  commitPlanApprovalCheckpoint,
  completeCompactionCheckpoint,
  syncActivePhaseSessionLink,
  type PhaseCheckpointErrorCode,
  type PhaseCheckpointRepository,
  type PhaseCheckpointSession,
} from "./app-sidecar-phase-checkpoint.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type {
  ProjectNotesPhaseLinkOutcome,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

const context: ActivePhaseContextV1 = {
  version: 1,
  projectKey: "project-key",
  phase: {
    id: "phase-21",
    title: "Checkpoint synchronization",
    goal: "Keep Notes on the latest session",
    doneWhen: ["Approval and compaction are durable before completion"],
    sourcePrompt: null,
    status: "in-progress",
    archivedAt: null,
  },
  session: { sessionId: "session-old", sessionPath: "/sessions/old.jsonl" },
  references: [],
  executionStage: "awaiting-approval",
  approvedPlanPath: "/plans/phase-21.md",
};

const snapshot = {
  projectKey: "project-key",
  revision: 2,
  document: {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: "2026-07-27T00:00:00.000Z",
    legacyImportedAt: null,
    references: [],
    phases: [],
  },
} satisfies ProjectNotesSnapshot;

const successfulOutcome: ProjectNotesPhaseLinkOutcome = {
  status: "ok",
  snapshot,
  phase: {
    id: "phase-21",
    title: "Checkpoint synchronization",
    goal: "Keep Notes on the latest session",
    doneWhen: ["Approval and compaction are durable before completion"],
    order: 21,
    status: "in-progress",
    sourcePrompt: "Keep approval durable.",
    referenceIds: [],
    session: { sessionId: "session-new", sessionPath: "/sessions/new.jsonl" },
    reminder: null,
    attentionReason: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  },
};

function createSession(
  events: string[],
  options: { active?: boolean; stageFailure?: Error } = {},
): PhaseCheckpointSession {
  return {
    getActivePhaseContext: () => (options.active === false ? undefined : structuredClone(context)),
    getState: () => ({
      sessionId: "session-new",
      sessionPath: "/sessions/new.jsonl",
    }),
    updateActivePhaseStage: vi.fn(async (stage, planPath) => {
      events.push("stage-persisted");
      if (options.stageFailure) throw options.stageFailure;
      return { ...structuredClone(context), executionStage: stage, approvedPlanPath: planPath };
    }),
  };
}

function createRepository(
  events: string[],
  outcome: ProjectNotesPhaseLinkOutcome = successfulOutcome,
): PhaseCheckpointRepository {
  return {
    updatePhaseSessionLink: vi.fn(async () => {
      events.push("notes-link-persisted");
      return outcome;
    }),
  };
}

async function attemptApproval(options: {
  outcome?: ProjectNotesPhaseLinkOutcome;
  stageFailure?: Error;
  active?: boolean;
}) {
  const events: string[] = [];
  let pendingReview = true;
  let error: unknown;
  const session = createSession(events, options);
  const repository = createRepository(events, options.outcome);

  try {
    await commitPlanApprovalCheckpoint({
      session,
      repository,
      cwd: "/project",
      planPath: "/plans/phase-21.md",
      approvalSource: "user",
      reconcileLifecycle: async () => {
        events.push("notes-lifecycle-persisted", "notes-snapshot-broadcast");
        return { status: "committed", snapshot };
      },
      prepareFreshSession: async () => {
        events.push("fresh-session-prepared");
        return 3;
      },
      onSnapshot: () => events.push("unexpected-direct-fan-out"),
    });
    pendingReview = false;
    events.push("approval-reset", "implementation-prompt");
  } catch (caught) {
    error = caught;
  }

  return { error, events, pendingReview, session, repository };
}

const rejectedOutcomes: Array<{
  outcome: Exclude<ProjectNotesPhaseLinkOutcome, { status: "ok" }>;
  code: PhaseCheckpointErrorCode;
}> = [
  { outcome: { status: "missing" }, code: "notes-missing" },
  {
    outcome: { status: "corrupt", primary: "malformed-json", backup: "invalid-envelope" },
    code: "notes-corrupt",
  },
  { outcome: { status: "phase-not-found" }, code: "phase-not-found" },
  { outcome: { status: "phase-archived" }, code: "phase-archived" },
];

describe("plan approval checkpoint", () => {
  it.each(rejectedOutcomes)(
    "keeps the review recoverable and blocks reset/implementation for $code",
    async ({ outcome, code }) => {
      const result = await attemptApproval({ outcome });

      expect(result.error).toBeInstanceOf(PhaseCheckpointError);
      expect(result.error).toMatchObject({ code, phaseId: "phase-21", retryable: true });
      expect(result.pendingReview).toBe(true);
      expect(result.events).toEqual(["fresh-session-prepared", "notes-link-persisted"]);
      expect(result.events).not.toContain("approval-reset");
      expect(result.events).not.toContain("implementation-prompt");
    },
  );

  it("keeps the review recoverable on the freshly linked session when stage persistence fails", async () => {
    const result = await attemptApproval({ stageFailure: new Error("disk full") });

    expect(result.error).toMatchObject({
      code: "phase-stage-persistence-failed",
      phaseId: "phase-21",
      retryable: true,
    });
    expect(result.pendingReview).toBe(true);
    expect(result.events).toEqual([
      "fresh-session-prepared",
      "notes-link-persisted",
      "stage-persisted",
    ]);
    expect(result.repository.updatePhaseSessionLink).toHaveBeenCalledOnce();
    expect(result.events).not.toContain("approval-reset");
    expect(result.events).not.toContain("implementation-prompt");
  });

  it("broadcasts durable Notes before approval reset and implementation", async () => {
    const result = await attemptApproval({});

    expect(result.error).toBeUndefined();
    expect(result.pendingReview).toBe(false);
    expect(result.events).toEqual([
      "fresh-session-prepared",
      "notes-link-persisted",
      "stage-persisted",
      "notes-lifecycle-persisted",
      "notes-snapshot-broadcast",
      "approval-reset",
      "implementation-prompt",
    ]);
  });

  it.each(["user", "agent"] as const)(
    "serializes the %s lifecycle checkpoint before reset",
    async (approvalSource) => {
      const events: string[] = [];
      const session = createSession(events);
      const repository = createRepository(events);
      let signal: unknown;
      await commitPlanApprovalCheckpoint({
        session,
        repository,
        cwd: "/project",
        planPath: "/plans/phase-21.md",
        approvalSource,
        prepareFreshSession: async () => {
          events.push("fresh-session-prepared");
          return 3;
        },
        reconcileLifecycle: async (value) => {
          signal = value;
          events.push("notes-lifecycle-persisted", "notes-snapshot-broadcast");
          return { status: "committed", snapshot };
        },
        onSnapshot: () => events.push("unexpected-direct-fan-out"),
      });
      events.push("approval-reset", "implementation-prompt");

      expect(signal).toEqual({ type: "plan-approved", approvalSource });
      expect(events).toEqual([
        "fresh-session-prepared",
        "notes-link-persisted",
        "stage-persisted",
        "notes-lifecycle-persisted",
        "notes-snapshot-broadcast",
        "approval-reset",
        "implementation-prompt",
      ]);
    },
  );

  it.each(["same-status", "done-terminal"] as const)(
    "completes approval and broadcasts the linked snapshot for lifecycle no-op: %s",
    async (status) => {
      const events: string[] = [];
      const session = createSession(events);
      const onSnapshot = vi.fn(() => events.push("notes-snapshot-broadcast"));

      await expect(
        commitPlanApprovalCheckpoint({
          session,
          repository: createRepository(events),
          cwd: "/project",
          planPath: "/plans/phase-21.md",
          approvalSource: "user",
          reconcileLifecycle: async () => {
            events.push(`notes-lifecycle-${status}`);
            return { status };
          },
          prepareFreshSession: async () => {
            events.push("fresh-session-prepared");
            return 3;
          },
          onSnapshot,
        }),
      ).resolves.toMatchObject({ planTotal: 3 });

      expect(onSnapshot).toHaveBeenCalledWith(snapshot);
      expect(events).toEqual([
        "fresh-session-prepared",
        "notes-link-persisted",
        "stage-persisted",
        `notes-lifecycle-${status}`,
        "notes-snapshot-broadcast",
      ]);
    },
  );

  it("uses the lifecycle fan-out for a persisted manual override target", async () => {
    const events: string[] = [];
    const session = createSession(events);
    const onSnapshot = vi.fn();

    await expect(
      commitPlanApprovalCheckpoint({
        session,
        repository: createRepository(events),
        cwd: "/project",
        planPath: "/plans/phase-21.md",
        approvalSource: "user",
        reconcileLifecycle: async () => {
          events.push("notes-lifecycle-manual-override", "notes-snapshot-broadcast");
          return { status: "manual-override", snapshot };
        },
        prepareFreshSession: async () => {
          events.push("fresh-session-prepared");
          return 3;
        },
        onSnapshot,
      }),
    ).resolves.toMatchObject({ planTotal: 3 });

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(events).toEqual([
      "fresh-session-prepared",
      "notes-link-persisted",
      "stage-persisted",
      "notes-lifecycle-manual-override",
      "notes-snapshot-broadcast",
    ]);
  });

  it.each([
    { status: "stale-session", code: "stale-phase-session" },
    { status: "missing", code: "notes-missing" },
    { status: "corrupt", code: "notes-corrupt" },
  ] as const)(
    "restores pending approval when lifecycle reconciliation returns $status",
    async ({ status, code }) => {
      const events: string[] = [];
      const session = createSession(events);

      await expect(
        commitPlanApprovalCheckpoint({
          session,
          repository: createRepository(events),
          cwd: "/project",
          planPath: "/plans/phase-21.md",
          approvalSource: "user",
          reconcileLifecycle: async () => {
            events.push(`notes-lifecycle-${status}`);
            return { status };
          },
          prepareFreshSession: async () => {
            events.push("fresh-session-prepared");
            return 3;
          },
        }),
      ).rejects.toMatchObject({ code, phaseId: "phase-21", retryable: true });

      expect(vi.mocked(session.updateActivePhaseStage)).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        "fresh-session-prepared",
        "notes-link-persisted",
        "stage-persisted",
        `notes-lifecycle-${status}`,
        "stage-persisted",
      ]);
    },
  );

  it("restores the pending approval stage when lifecycle persistence fails", async () => {
    const events: string[] = [];
    const session = createSession(events);
    const repository = createRepository(events);
    const storageError = new Error("notes disk full");

    await expect(
      commitPlanApprovalCheckpoint({
        session,
        repository,
        cwd: "/project",
        planPath: "/plans/phase-21.md",
        approvalSource: "user",
        prepareFreshSession: async () => {
          events.push("fresh-session-prepared");
          return 3;
        },
        reconcileLifecycle: async () => {
          events.push("notes-lifecycle-failed");
          return { status: "storage-failure", error: storageError };
        },
      }),
    ).rejects.toMatchObject({
      code: "phase-lifecycle-persistence-failed",
      phaseId: "phase-21",
      cause: storageError,
    });

    expect(vi.mocked(session.updateActivePhaseStage)).toHaveBeenNthCalledWith(
      1,
      "implementing",
      "/plans/phase-21.md",
    );
    expect(vi.mocked(session.updateActivePhaseStage)).toHaveBeenNthCalledWith(
      2,
      "awaiting-approval",
      "/plans/phase-21.md",
    );
    expect(events).toEqual([
      "fresh-session-prepared",
      "notes-link-persisted",
      "stage-persisted",
      "notes-lifecycle-failed",
      "stage-persisted",
    ]);
  });

  it("preserves approval behavior when the session has no active phase", async () => {
    const result = await attemptApproval({ active: false });

    expect(result.error).toBeUndefined();
    expect(result.pendingReview).toBe(false);
    expect(result.events).toEqual([
      "fresh-session-prepared",
      "approval-reset",
      "implementation-prompt",
    ]);
    expect(result.session.updateActivePhaseStage).not.toHaveBeenCalled();
    expect(result.repository.updatePhaseSessionLink).not.toHaveBeenCalled();
  });
});

describe("compaction checkpoint", () => {
  it("publishes the Notes snapshot before compaction completion is observed", async () => {
    const events: string[] = [];
    let resolveOutcome!: (outcome: ProjectNotesPhaseLinkOutcome) => void;
    const outcome = new Promise<ProjectNotesPhaseLinkOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const session = createSession(events);
    const repository: PhaseCheckpointRepository = {
      updatePhaseSessionLink: async () => {
        events.push("notes-link-started");
        return outcome;
      },
    };

    const completion = completeCompactionCheckpoint({
      synchronize: () =>
        syncActivePhaseSessionLink({
          session,
          repository,
          cwd: "/project",
          onSnapshot: () => events.push("notes-snapshot-broadcast"),
        }),
      onComplete: () => events.push("compaction-end"),
      onFailure: () => events.push("compaction-sync-failed"),
    });

    await Promise.resolve();
    expect(events).toEqual(["notes-link-started"]);
    resolveOutcome(successfulOutcome);
    await expect(completion).resolves.toBe("completed");
    expect(events).toEqual(["notes-link-started", "notes-snapshot-broadcast", "compaction-end"]);
  });

  it("emits a distinct failed-sync boundary instead of compaction completion", async () => {
    const events: string[] = [];
    const session = createSession(events);
    const repository = createRepository(events, { status: "phase-archived" });

    await expect(
      completeCompactionCheckpoint({
        synchronize: () => syncActivePhaseSessionLink({ session, repository, cwd: "/project" }),
        onComplete: () => events.push("compaction-end"),
        onFailure: (error) => events.push(`compaction-sync-failed:${error.code}`),
      }),
    ).resolves.toBe("sync-failed");

    expect(events).toEqual(["notes-link-persisted", "compaction-sync-failed:phase-archived"]);
    expect(events).not.toContain("compaction-end");
  });
});
