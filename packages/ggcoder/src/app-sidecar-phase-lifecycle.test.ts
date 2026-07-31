import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarPhaseLifecycleCoordinator,
  PHASE_LIFECYCLE_REASON_MAX_LENGTH,
  mapPhaseLifecycleSignal,
  type BoundPhaseLifecycleContext,
  type PhaseLifecycleRepository,
  type PhaseLifecycleRepositoryOutcome,
  type PhaseLifecycleSignal,
  type PhaseLifecycleTransition,
} from "./app-sidecar-phase-lifecycle.js";
import type { ProjectNotesSnapshot } from "./project-notes-repository.js";

const snapshot = (revision: number): ProjectNotesSnapshot => ({
  projectKey: "/project",
  revision,
  document: {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: "2026-07-27T00:00:00.000Z",
    legacyImportedAt: null,
    phases: [],
    references: [],
  },
});

const active: BoundPhaseLifecycleContext = {
  phaseId: "phase-22",
  session: { sessionId: "session-22", sessionPath: "/sessions/22.jsonl" },
  executionStage: "implementing",
};

const contract: Array<{
  name: string;
  signal: PhaseLifecycleSignal;
  stage: BoundPhaseLifecycleContext["executionStage"];
  expected: Omit<PhaseLifecycleTransition, "kind"> | null;
}> = [
  {
    name: "restored planning",
    signal: { type: "session-restored", executionStage: "planning" },
    stage: "planning",
    expected: { status: "planning", source: "session", reason: "Planning session resumed" },
  },
  {
    name: "restored approval",
    signal: { type: "session-restored", executionStage: "awaiting-approval" },
    stage: "awaiting-approval",
    expected: {
      status: "waiting-for-approval",
      source: "session",
      reason: "Plan approval resumed",
    },
  },
  {
    name: "restored implementation",
    signal: { type: "session-restored", executionStage: "implementing" },
    stage: "implementing",
    expected: {
      status: "in-progress",
      source: "session",
      reason: "Implementation session resumed",
    },
  },
  {
    name: "restored review",
    signal: { type: "session-restored", executionStage: "reviewing" },
    stage: "reviewing",
    expected: { status: "review", source: "session", reason: "Review session resumed" },
  },
  {
    name: "plan entered",
    signal: { type: "plan-entered" },
    stage: "planning",
    expected: { status: "planning", source: "agent", reason: "Plan Mode entered" },
  },
  {
    name: "plan submitted",
    signal: { type: "plan-submitted" },
    stage: "planning",
    expected: {
      status: "waiting-for-approval",
      source: "agent",
      reason: "Plan submitted for approval",
    },
  },
  {
    name: "manual approval",
    signal: { type: "plan-approved", approvalSource: "user" },
    stage: "implementing",
    expected: { status: "in-progress", source: "user", reason: "Plan approved by user" },
  },
  {
    name: "Autopilot approval",
    signal: { type: "plan-approved", approvalSource: "agent" },
    stage: "implementing",
    expected: {
      status: "in-progress",
      source: "agent",
      reason: "Plan approved by Autopilot",
    },
  },
  {
    name: "implementation starts",
    signal: { type: "implementation-run-started" },
    stage: "implementing",
    expected: {
      status: "in-progress",
      source: "session",
      reason: "Implementation run started",
    },
  },
  {
    name: "revision implementation starts",
    signal: { type: "implementation-run-started" },
    stage: "reviewing",
    expected: {
      status: "in-progress",
      source: "session",
      reason: "Implementation run started",
    },
  },
  {
    name: "Ideal review starts",
    signal: { type: "ideal-review-started" },
    stage: "implementing",
    expected: {
      status: "review",
      source: "agent",
      reason: "Implementation verification started",
    },
  },
  {
    name: "Autopilot review starts",
    signal: { type: "autopilot-review-started" },
    stage: "reviewing",
    expected: { status: "review", source: "agent", reason: "Autopilot review started" },
  },
  {
    name: "Autopilot requests a decision",
    signal: { type: "autopilot-human", reason: "Choose the public API shape" },
    stage: "implementing",
    expected: {
      status: "needs-attention",
      source: "agent",
      reason: "Choose the public API shape",
    },
  },
  {
    name: "tool fails",
    signal: { type: "tool-failed", toolName: "bash", reason: "typecheck failed" },
    stage: "implementing",
    expected: {
      status: "needs-attention",
      source: "agent",
      reason: "bash failed: typecheck failed",
    },
  },
  {
    name: "runtime fails",
    signal: { type: "runtime-error", reason: "Provider connection failed" },
    stage: "implementing",
    expected: {
      status: "needs-attention",
      source: "session",
      reason: "Provider connection failed",
    },
  },
  {
    name: "Autopilot cannot continue",
    signal: { type: "autopilot-stopped", reason: "Autopilot reached its review limit" },
    stage: "reviewing",
    expected: {
      status: "needs-attention",
      source: "system",
      reason: "Autopilot reached its review limit",
    },
  },
  {
    name: "user cancellation settles",
    signal: { type: "cancelled" },
    stage: "implementing",
    expected: {
      status: "cancelled",
      source: "user",
      reason: "Phase run cancelled by user",
    },
  },
];

describe("phase lifecycle signal mapper", () => {
  it.each(contract)("maps $name to its authoritative contract", ({ signal, stage, expected }) => {
    expect(mapPhaseLifecycleSignal(signal, stage)).toMatchObject(expected ?? {});
  });

  it.each([
    ["approval opened", { type: "plan-submitted" }, "planning", "approval-opened"],
    [
      "user approval resolved",
      { type: "plan-approved", approvalSource: "user" },
      "implementing",
      "approval-resolved",
    ],
    [
      "Autopilot approval resolved",
      { type: "plan-approved", approvalSource: "agent" },
      "implementing",
      "approval-resolved",
    ],
    [
      "question opened",
      { type: "autopilot-human", reason: "Localized question" },
      "implementing",
      "attention-question-opened",
    ],
    [
      "tool blocker opened",
      { type: "tool-failed", toolName: "bash", reason: "Localized failure" },
      "implementing",
      "attention-tool-opened",
    ],
    [
      "runtime blocker opened",
      { type: "runtime-error", reason: "Localized runtime error" },
      "implementing",
      "attention-runtime-opened",
    ],
    [
      "generic attention opened",
      { type: "autopilot-stopped", reason: "Localized stop" },
      "reviewing",
      "attention-generic-opened",
    ],
    [
      "implementation resolved attention",
      { type: "implementation-run-started" },
      "implementing",
      "attention-implementation-resolved",
    ],
    [
      "review restoration resolved attention",
      { type: "session-restored", executionStage: "reviewing" },
      "reviewing",
      "attention-review-resolved",
    ],
  ] as const)("assigns a stable kind when $0", (_name, signal, stage, kind) => {
    expect(mapPhaseLifecycleSignal(signal as PhaseLifecycleSignal, stage)?.kind).toBe(kind);
  });

  it.each([
    { type: "run-ended" },
    { type: "tool-succeeded" },
    { type: "autopilot-done" },
    { type: "elapsed" },
  ] as const)("ignores $type instead of inferring Done or attention", (signal) => {
    expect(mapPhaseLifecycleSignal(signal, "implementing")).toBeNull();
  });

  it("requires implementation stages for run and review start signals", () => {
    expect(mapPhaseLifecycleSignal({ type: "implementation-run-started" }, "planning")).toBeNull();
    expect(mapPhaseLifecycleSignal({ type: "ideal-review-started" }, "reviewing")).toBeNull();
    expect(mapPhaseLifecycleSignal({ type: "autopilot-review-started" }, "planning")).toBeNull();
  });

  it("bounds and normalizes dynamic reasons", () => {
    const transition = mapPhaseLifecycleSignal(
      { type: "autopilot-human", reason: `  choose\n${"x".repeat(500)}  ` },
      "implementing",
    );
    expect(transition?.reason).toHaveLength(PHASE_LIFECYCLE_REASON_MAX_LENGTH);
    expect(transition?.reason).not.toContain("\n");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("phase lifecycle coordinator", () => {
  it("captures timestamps and phase identity immediately, then serializes writes and fan-out", async () => {
    const first = deferred<PhaseLifecycleRepositoryOutcome>();
    const writes: Array<{
      phaseId: string;
      transition: PhaseLifecycleTransition & { timestamp: string };
    }> = [];
    const broadcasts: number[] = [];
    let current = active;
    let now = "2026-07-27T00:00:01.000Z";
    const repository: PhaseLifecycleRepository = {
      recordPhaseLifecycleTransition: vi.fn(async (_cwd, phaseId, transition) => {
        writes.push({ phaseId, transition });
        if (writes.length === 1) return first.promise;
        return { status: "ok" as const, snapshot: snapshot(2) };
      }),
    };
    const coordinator = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository,
      getActivePhase: () => current,
      broadcastSnapshot: (value) => broadcasts.push(value.revision),
      now: () => now,
    });

    const planning = coordinator.enqueue({ type: "plan-entered" });
    current = { ...active, phaseId: "later-phase", executionStage: "reviewing" };
    now = "2026-07-27T00:00:02.000Z";
    const review = coordinator.enqueue({ type: "autopilot-review-started" });
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      phaseId: "phase-22",
      transition: { timestamp: "2026-07-27T00:00:01.000Z" },
    });

    first.resolve({ status: "ok", snapshot: snapshot(1) });
    await expect(planning).resolves.toMatchObject({ status: "committed" });
    await expect(review).resolves.toMatchObject({ status: "committed" });
    expect(writes[1]).toMatchObject({
      phaseId: "later-phase",
      transition: { timestamp: "2026-07-27T00:00:02.000Z", status: "review" },
    });
    expect(broadcasts).toEqual([1, 2]);
  });

  it.each([
    "same-status",
    "phase-not-found",
    "phase-archived",
    "stale-session",
    "done-terminal",
    "missing",
    "corrupt",
  ] as const)("preserves explicit repository no-op outcome: %s", async (status) => {
    const broadcastSnapshot = vi.fn();
    const coordinator = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository: { recordPhaseLifecycleTransition: async () => ({ status }) },
      getActivePhase: () => active,
      broadcastSnapshot,
    });
    await expect(coordinator.enqueue({ type: "plan-entered" })).resolves.toEqual({ status });
    expect(broadcastSnapshot).not.toHaveBeenCalled();
  });

  it("broadcasts a persisted manual-override marker", async () => {
    const persisted = snapshot(3);
    const broadcastSnapshot = vi.fn();
    const coordinator = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository: {
        recordPhaseLifecycleTransition: async () => ({
          status: "manual-override",
          snapshot: persisted,
        }),
      },
      getActivePhase: () => active,
      broadcastSnapshot,
    });

    await expect(
      coordinator.enqueue({ type: "plan-approved", approvalSource: "user" }),
    ).resolves.toEqual({
      status: "manual-override",
      snapshot: persisted,
    });
    expect(broadcastSnapshot).toHaveBeenCalledWith(persisted);
  });

  it("reports no active phase and ignored signals without touching storage", async () => {
    const repository = { recordPhaseLifecycleTransition: vi.fn() };
    const coordinator = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository,
      getActivePhase: () => undefined,
      broadcastSnapshot: vi.fn(),
    });
    await expect(coordinator.enqueue({ type: "plan-entered" })).resolves.toEqual({
      status: "no-active-phase",
    });
    expect(repository.recordPhaseLifecycleTransition).not.toHaveBeenCalled();

    const activeCoordinator = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository,
      getActivePhase: () => active,
      broadcastSnapshot: vi.fn(),
    });
    await expect(activeCoordinator.enqueue({ type: "run-ended" })).resolves.toEqual({
      status: "ignored",
    });
    expect(repository.recordPhaseLifecycleTransition).not.toHaveBeenCalled();
  });

  it("recovers its queue after a failed write", async () => {
    const onError = vi.fn();
    const repository: PhaseLifecycleRepository = {
      recordPhaseLifecycleTransition: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce({ status: "ok", snapshot: snapshot(2) }),
    };
    const coordinator = new AppSidecarPhaseLifecycleCoordinator({
      cwd: "/project",
      repository,
      getActivePhase: () => active,
      broadcastSnapshot: vi.fn(),
      onError,
    });
    await expect(coordinator.enqueue({ type: "plan-entered" })).resolves.toMatchObject({
      status: "storage-failure",
    });
    await expect(coordinator.enqueue({ type: "plan-submitted" })).resolves.toMatchObject({
      status: "committed",
    });
    expect(repository.recordPhaseLifecycleTransition).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });
});
