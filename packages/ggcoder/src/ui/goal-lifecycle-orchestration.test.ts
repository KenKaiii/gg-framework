import { describe, expect, it } from "vitest";
import type { GoalRun, GoalTask } from "../core/goal-store.js";
import {
  APPLY_INTEGRATION_TO_MAIN_TASK_TITLE,
  COMMIT_INTEGRATED_GOAL_CHANGES_TASK_TITLE,
  canCompleteGoalRun,
  decideGoalNextAction,
} from "../core/goal-controller.js";
import type { CompletedItem } from "./app-items.js";
import {
  appendGoalProgressDraft,
  completedItemsWithDurableGoalTerminalProgress,
  formatGoalTerminalProgress,
  routeGoalSyntheticEvent,
  truncateGoalProgressText,
} from "./goal-progress.js";
import { nextGoalModeAfterAgentDone } from "./layout-decisions.js";
import {
  buildGoalUserPauseRun,
  goalRunNeedsExplicitContinuationAfterWorker,
  shouldKeepGoalRunTrackedAfterDecision,
  shouldRunGoalTaskInMainCheckout,
} from "./App.js";

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-ui",
    title: "UI Goal lifecycle",
    goal: "Exercise the /goal UI orchestration lifecycle",
    status: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    projectPath: "/tmp/project",
    successCriteria: ["Verifier passes"],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function task(overrides: Partial<GoalTask> = {}): GoalTask {
  return {
    id: "task-a",
    title: "Implement UI path",
    prompt: "Do focused work",
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

function applyStartWorker(run: GoalRun, workerId = "worker-ui"): GoalRun {
  const decision = decideGoalNextAction(run);
  expect(decision).toMatchObject({ kind: "start_worker" });
  if (decision.kind !== "start_worker") throw new Error("expected worker start");
  return {
    ...run,
    status: "running",
    activeWorkerId: workerId,
    tasks: run.tasks.map((item) =>
      item.id === decision.task.id
        ? { ...item, status: "running", workerId, attempts: decision.attempts }
        : item,
    ),
  };
}

function applyWorkerDone(run: GoalRun): GoalRun {
  return {
    ...run,
    status: "ready",
    activeWorkerId: undefined,
    tasks: run.tasks.map((item) =>
      item.workerId ? { ...item, status: "done", workerId: undefined } : item,
    ),
  };
}

function applyVerifierResult(
  run: GoalRun,
  status: "pass" | "fail",
  summary = `${status} summary`,
): GoalRun {
  const lastResult = {
    status,
    summary,
    command: "pnpm test",
    checkedAt: "2024-01-01T00:00:00.000Z",
    exitCode: status === "pass" ? 0 : 1,
    outputPath: ".goal-evidence/verifier.log",
  };
  const runWithVerifier: GoalRun = {
    ...run,
    verifier: {
      description: "Full check",
      command: "pnpm test",
      ...run.verifier,
      lastResult,
    },
    ...(status === "pass"
      ? {
          completionAudit: {
            status: "unknown",
            summary: "Final completion audit pending for latest verifier result.",
            checkedAt: lastResult.checkedAt,
            verifierCheckedAt: lastResult.checkedAt,
            outputPath: lastResult.outputPath,
          },
        }
      : {}),
  };
  const completion = status === "pass" ? canCompleteGoalRun(runWithVerifier) : { ok: false };
  return {
    ...runWithVerifier,
    status: status === "pass" && completion.ok ? "passed" : "ready",
    continueRequestedAt: run.continueRequestedAt,
    evidence: [
      ...run.evidence,
      {
        id: `evidence-${run.evidence.length + 1}`,
        createdAt: "2024-01-01T00:00:00.000Z",
        kind: "command",
        label: `Verifier ${status}`,
        content: summary,
        path: ".goal-evidence/verifier.log",
      },
    ],
  };
}

function applyCompletionAudit(run: GoalRun): GoalRun {
  const verifier = run.verifier?.lastResult;
  if (!verifier) throw new Error("expected verifier result");
  return {
    ...run,
    status: "passed",
    completionAudit: {
      status: "pass",
      summary: `FINAL_AUDIT_PASS verifier_checked_at=${verifier.checkedAt} original-goal-prompt GOAL_PLAN`,
      checkedAt: "2024-01-01T00:00:01.000Z",
      verifierCheckedAt: verifier.checkedAt,
      ...(verifier.outputPath ? { outputPath: verifier.outputPath } : {}),
    },
    tasks: [
      ...run.tasks,
      task({
        id: "final-audit",
        title: "Audit Goal completion evidence",
        status: "done",
        attempts: 1,
      }),
    ],
  };
}

describe("/goal UI orchestration lifecycle", () => {
  it("runs integration apply and commit tasks in the main checkout", () => {
    expect(shouldRunGoalTaskInMainCheckout(APPLY_INTEGRATION_TO_MAIN_TASK_TITLE)).toBe(true);
    expect(shouldRunGoalTaskInMainCheckout(COMMIT_INTEGRATED_GOAL_CHANGES_TASK_TITLE)).toBe(true);
    expect(shouldRunGoalTaskInMainCheckout("Implement isolated feature")).toBe(false);
  });

  it("truncates long Goal progress text before it wraps across the TUI", () => {
    const text =
      "Choosing next Goal step: A-Z /goal system test, refinement, leak-safety, and report";

    expect(truncateGoalProgressText(text)).toBe(
      "Choosing next Goal step: A-Z /goal system test, refin…",
    );
  });

  it("dedupes adjacent identical Goal progress rows", () => {
    const draft = {
      kind: "goal_progress" as const,
      phase: "continuing" as const,
      title: "Choosing next Goal step: Close remaining /goal reliability gaps",
      detail: "Latest result is recorded; starting the next worker task or verifier automatically.",
      status: "ready" as const,
    };
    let nextId = 0;
    const makeId = () => `goal-progress-${nextId++}`;

    const once = appendGoalProgressDraft([], draft, makeId);
    const twice = appendGoalProgressDraft(once, draft, makeId);
    const afterDifferentRow = appendGoalProgressDraft(
      [...twice, { kind: "assistant", id: "assistant-1", text: "Recorded verifier pass." }],
      draft,
      makeId,
    );

    expect(once).toHaveLength(1);
    expect(twice).toHaveLength(1);
    expect(afterDifferentRow).toHaveLength(3);
  });

  it("queues worker completion synthetic events while the orchestrator is busy", () => {
    expect(
      routeGoalSyntheticEvent({
        agentRunning: true,
        queuedSyntheticEvents: 2,
      }),
    ).toEqual({
      action: "queue",
      nextQueuedSyntheticEvents: 3,
      nextGoalMode: "coordinator",
    });

    expect(
      routeGoalSyntheticEvent({
        agentRunning: false,
        queuedSyntheticEvents: 2,
      }),
    ).toEqual({
      action: "run",
      nextQueuedSyntheticEvents: 2,
      nextGoalMode: "coordinator",
    });
  });

  it("builds a user pause state that stops auto-continuation", () => {
    const pausedRun = buildGoalUserPauseRun(
      goalRun({
        status: "running",
        activeWorkerId: "worker-live",
        continueRequestedAt: "2024-01-01T00:00:00.000Z",
        tasks: [task({ status: "running", workerId: "worker-live" })],
      }),
    );

    expect(pausedRun).toMatchObject({ status: "paused" });
    expect(pausedRun.activeWorkerId).toBeUndefined();
    expect(pausedRun.continueRequestedAt).toBeUndefined();
    expect(pausedRun.blockers).toContain(
      "Goal paused by user from the mini TUI; auto-continuation is stopped until resumed.",
    );
    expect(decideGoalNextAction(pausedRun)).toMatchObject({ kind: "terminal", status: "paused" });
  });

  it("requires explicit continuation before chaining another Goal worker after completion", () => {
    const completedRun = goalRun({
      status: "ready",
      tasks: [task({ status: "done", attempts: 1 })],
    });

    expect(goalRunNeedsExplicitContinuationAfterWorker(completedRun)).toBe(false);
    expect(
      goalRunNeedsExplicitContinuationAfterWorker({
        ...completedRun,
        continueRequestedAt: "2024-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      goalRunNeedsExplicitContinuationAfterWorker({
        ...completedRun,
        continueRequestedAt: "2024-01-01T00:00:00.000Z",
        prerequisites: [{ id: "api", label: "API key", status: "missing" }],
      }),
    ).toBe(false);
  });

  it("tracks Goal runs only while concrete continuation work remains", () => {
    const passed = applyCompletionAudit(
      applyVerifierResult(
        goalRun({
          tasks: [task({ status: "done", attempts: 1 })],
          verifier: { description: "Full check", command: "pnpm test" },
          evidencePlan: [
            {
              id: "proof-log",
              label: "Verifier log",
              mechanism: "command",
              description: "Verifier output log",
              status: "ready",
              path: ".goal-evidence/verifier.log",
            },
          ],
        }),
        "pass",
      ),
    );
    expect(shouldKeepGoalRunTrackedAfterDecision(decideGoalNextAction(passed))).toBe(false);

    const dependencyWait = goalRun({
      tasks: [task({ id: "dependent", dependsOn: ["missing"] })],
    });
    expect(shouldKeepGoalRunTrackedAfterDecision(decideGoalNextAction(dependencyWait))).toBe(false);

    const activeWorker = applyStartWorker(goalRun({ tasks: [task()] }));
    expect(shouldKeepGoalRunTrackedAfterDecision(decideGoalNextAction(activeWorker))).toBe(true);

    const readyVerifier = goalRun({
      tasks: [task({ status: "done", attempts: 1 })],
      verifier: { description: "Full check", command: "pnpm test" },
    });
    expect(shouldKeepGoalRunTrackedAfterDecision(decideGoalNextAction(readyVerifier))).toBe(true);
  });

  it("keeps coordinator mode only while Goal continuation work remains", () => {
    expect(
      nextGoalModeAfterAgentDone({
        currentMode: "setup",
        runningGoalIds: 1,
        queuedSyntheticEvents: 0,
        wasGoalSetupTurn: true,
      }),
    ).toBe("off");

    expect(
      nextGoalModeAfterAgentDone({
        currentMode: "coordinator",
        runningGoalIds: 0,
        queuedSyntheticEvents: 1,
      }),
    ).toBe("coordinator");

    expect(
      nextGoalModeAfterAgentDone({
        currentMode: "coordinator",
        runningGoalIds: 1,
        queuedSyntheticEvents: 0,
      }),
    ).toBe("coordinator");

    expect(
      nextGoalModeAfterAgentDone({
        currentMode: "coordinator",
        runningGoalIds: 0,
        queuedSyntheticEvents: 0,
        activeContinuationFlights: 1,
      }),
    ).toBe("coordinator");

    expect(
      nextGoalModeAfterAgentDone({
        currentMode: "coordinator",
        runningGoalIds: 0,
        queuedSyntheticEvents: 0,
      }),
    ).toBe("off");
  });

  it("reconstructs a visible blocker/verification terminal message from durable Goal state", () => {
    const blocked = goalRun({
      status: "blocked",
      title: "Investigate disappearing blocker",
      tasks: [task({ status: "blocked", attempts: 2, lastSummary: "Paused after verifier loop." })],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "GOAL BLOCKER verification failed after pane switch",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
          outputPath: ".goal-evidence/blocker.log",
        },
      },
      evidence: [
        {
          id: "ev-blocker",
          createdAt: "2024-01-01T00:00:01.000Z",
          kind: "command",
          label: "GOAL BLOCKER verification",
          content: "GOAL BLOCKER verification failed after pane switch",
          path: ".goal-evidence/blocker.log",
        },
      ],
      blockers: ["GOAL BLOCKER verification failed after pane switch"],
    });

    const initiallyVisible = formatGoalTerminalProgress(blocked);
    expect(initiallyVisible).toMatchObject({
      kind: "goal_progress",
      phase: "terminal",
      title: "Goal blocked: Investigate disappearing blocker",
      detail: "GOAL BLOCKER verification failed after pane switch",
      status: "blocked",
    });

    // Model the sensory regression: pane switches/remounts can lose ephemeral
    // liveItems, so the blocker must be reconstructable from durable GoalRun.
    const sessionStoreAfterGoalPaneSwitch = { liveItems: [] as unknown[] };
    expect(sessionStoreAfterGoalPaneSwitch.liveItems).toHaveLength(0);

    const reconstructedAfterRestore = formatGoalTerminalProgress(blocked);
    expect(reconstructedAfterRestore).toEqual(initiallyVisible);
    expect(reconstructedAfterRestore).not.toHaveProperty("summaryRows");
    expect(reconstructedAfterRestore).not.toHaveProperty("summarySections");
  });

  it("does not synthesize old terminal Goal messages into fresh UI state", () => {
    const blocked = goalRun({
      id: "goal-blocked",
      status: "blocked",
      title: "Pane restore blocker",
      blockers: ["GOAL BLOCKER survived remount"],
      verifier: {
        description: "Full check",
        lastResult: { status: "fail", summary: "failed", checkedAt: "2024-01-01T00:00:00.000Z" },
      },
    });
    const freshHistory: CompletedItem[] = [];

    const afterPoll = completedItemsWithDurableGoalTerminalProgress(freshHistory, [blocked]);

    expect(afterPoll).toBe(freshHistory);
    expect(afterPoll).toHaveLength(0);
  });

  it("reconciles terminal Goal messages that were already visible in this UI session", () => {
    const blocked = goalRun({
      id: "goal-scroll",
      status: "blocked",
      title: "Scroll-safe blocker",
      blockers: ["GOAL BLOCKER should not pin scroll"],
    });
    const terminalProgress = formatGoalTerminalProgress(blocked);
    if (!terminalProgress) throw new Error("expected terminal progress");
    const withBlocker: CompletedItem[] = [{ ...terminalProgress, id: "goal-terminal-goal-scroll" }];

    const repeatedPoll = completedItemsWithDurableGoalTerminalProgress(withBlocker, [blocked]);
    expect(repeatedPoll).toBe(withBlocker);

    const passed = { ...blocked, status: "passed" as const, blockers: [] };
    const passedProgress = formatGoalTerminalProgress(passed);
    if (!passedProgress) throw new Error("expected passed progress");
    const afterEventAppend = [
      ...repeatedPoll,
      { ...passedProgress, id: "goal-terminal-goal-scroll" },
    ];
    const afterPassed = completedItemsWithDurableGoalTerminalProgress(afterEventAppend, [passed]);
    expect(afterPassed).not.toBe(afterEventAppend);
    expect(afterPassed).toHaveLength(2);
    expect(afterPassed[0]).toMatchObject({ kind: "tombstone" });
    expect(afterPassed[1]).toMatchObject({ title: "Goal passed: Scroll-safe blocker" });

    const repeatedPassedPoll = completedItemsWithDurableGoalTerminalProgress(afterPassed, [passed]);
    expect(repeatedPassedPoll).toBe(afterPassed);
  });

  it("starts a pending task and persists running task worker identity", () => {
    const staleSnapshot = goalRun({ tasks: [task()] });
    const started = applyStartWorker(staleSnapshot, "worker-123");

    expect(started).toMatchObject({ status: "running", activeWorkerId: "worker-123" });
    expect(started.tasks).toEqual([
      expect.objectContaining({
        id: "task-a",
        status: "running",
        workerId: "worker-123",
        attempts: 1,
      }),
    ]);
    expect(decideGoalNextAction(started)).toEqual({
      kind: "wait",
      reason: "Goal already has an active worker.",
      workerId: "worker-123",
    });

    const staleOverwrite = {
      ...staleSnapshot,
      status: "running" as const,
      activeWorkerId: "worker-123",
    };
    expect(staleOverwrite.tasks[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("worker completion drives verifier, final audit, and passed status", () => {
    const done = applyWorkerDone(
      applyStartWorker(
        goalRun({
          tasks: [task()],
          verifier: { description: "Full check", command: "pnpm test" },
          evidencePlan: [
            {
              id: "proof-log",
              label: "Verifier log",
              mechanism: "command",
              description: "Verifier output log",
              status: "ready",
              path: ".goal-evidence/verifier.log",
            },
          ],
        }),
      ),
    );

    expect(decideGoalNextAction(done)).toEqual({
      kind: "run_verifier",
      command: "pnpm test",
      reason: "All Goal tasks are done; running configured verifier for real completion evidence.",
    });

    const verified = applyVerifierResult(done, "pass", "mock verifier passed");
    expect(verified.status).toBe("ready");
    expect(canCompleteGoalRun(verified)).toEqual({
      ok: false,
      reason: "Final completion audit status is unknown.",
    });
    expect(decideGoalNextAction(verified)).toMatchObject({
      kind: "create_task",
      title: "Audit Goal completion evidence",
    });

    const passed = applyCompletionAudit(verified);
    expect(passed.status).toBe("passed");
    expect(canCompleteGoalRun(passed)).toEqual({
      ok: true,
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
    expect(decideGoalNextAction(passed)).toEqual({
      kind: "complete",
      reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
    });
    expect(
      decideGoalNextAction({ ...passed, continueRequestedAt: "2024-01-01T00:00:02.000Z" }),
    ).toEqual({
      kind: "run_verifier",
      command: "pnpm test",
      reason: "Goal rerun requested; rerunning configured verifier before any new final audit.",
    });
  });

  it("verifier failure creates exactly one bounded fix task and queued continuation starts it", () => {
    const done = applyWorkerDone(
      applyStartWorker(
        goalRun({ tasks: [task()], verifier: { description: "Full check", command: "pnpm test" } }),
      ),
    );
    const failed = applyVerifierResult(
      { ...done, continueRequestedAt: "2024-01-01T00:00:00.000Z" },
      "fail",
      "assertion failed",
    );

    expect(failed.status).toBe("ready");
    expect(failed.status).not.toBe("failed");
    expect(failed.continueRequestedAt).toBe("2024-01-01T00:00:00.000Z");
    const createFix = decideGoalNextAction(failed, { verifierFixLimit: 1 });
    expect(createFix).toMatchObject({
      kind: "create_task",
      title: "Fix verifier failure",
      reason: "Verifier failed; creating bounded fix task 1/1.",
    });
    const withFix =
      createFix.kind === "create_task"
        ? {
            ...failed,
            tasks: [
              ...failed.tasks,
              task({ id: "fix-1", title: createFix.title, prompt: createFix.prompt }),
            ],
          }
        : failed;

    expect(withFix.tasks.filter((item) => item.title === "Fix verifier failure")).toHaveLength(1);
    expect(decideGoalNextAction(withFix)).toMatchObject({
      kind: "start_worker",
      task: expect.objectContaining({ id: "fix-1", title: "Fix verifier failure" }),
      attempts: 1,
    });

    const fixing = applyStartWorker(withFix, "worker-fix");
    expect(fixing.tasks.find((item) => item.id === "fix-1")).toMatchObject({
      status: "running",
      workerId: "worker-fix",
    });
  });

  it("prevents duplicate verifier fix ownership once controller-created fix exists", () => {
    const run = goalRun({
      status: "ready",
      tasks: [
        task({ status: "done", attempts: 1 }),
        task({ id: "fix-1", title: "Fix verifier failure", status: "pending" }),
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "assertion failed",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
        },
      },
    });

    expect(decideGoalNextAction(run, { verifierFixLimit: 2 })).toMatchObject({
      kind: "start_worker",
      task: expect.objectContaining({ id: "fix-1", title: "Fix verifier failure" }),
    });
    expect(run.tasks.filter((item) => item.title === "Fix verifier failure")).toHaveLength(1);
  });

  it("re-strategizes on repeated identical verifier failure instead of stopping", () => {
    const run = goalRun({
      status: "ready",
      tasks: [task({ status: "done", attempts: 1 })],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "same failure",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
        },
      },
      evidence: [
        {
          id: "e1",
          createdAt: "2024-01-01T00:00:00.000Z",
          kind: "command",
          label: "Verifier fail",
          content: "same failure",
        },
        {
          id: "e2",
          createdAt: "2024-01-01T00:00:01.000Z",
          kind: "command",
          label: "Verifier fail",
          content: "same failure",
        },
      ],
    });

    const decision = decideGoalNextAction(run, { verifierFixLimit: 1 });
    expect(decision).toMatchObject({
      kind: "create_task",
      title: "Re-strategize Goal approach",
    });
    // create_task keeps the run tracked so the loop continues unattended.
    expect(shouldKeepGoalRunTrackedAfterDecision(decision)).toBe(true);
  });

  it("fails with a diagnosis once the bounded verifier-fix limit is reached", () => {
    const run = goalRun({
      status: "ready",
      tasks: [
        task({ status: "done", attempts: 1 }),
        task({ id: "fix-1", title: "Fix verifier failure", status: "done", attempts: 1 }),
      ],
      verifier: {
        description: "Full check",
        command: "pnpm test",
        lastResult: {
          status: "fail",
          summary: "new failure",
          checkedAt: "2024-01-01T00:00:00.000Z",
          exitCode: 1,
        },
      },
      evidence: [
        {
          id: "e1",
          createdAt: "2024-01-01T00:00:00.000Z",
          kind: "command",
          label: "Verifier fail",
          content: "first failure",
        },
        {
          id: "e2",
          createdAt: "2024-01-01T00:00:01.000Z",
          kind: "command",
          label: "Verifier fail",
          content: "new failure",
        },
      ],
    });

    const decision = decideGoalNextAction(run, { verifierFixLimit: 1 });
    expect(decision).toMatchObject({ kind: "terminal", status: "failed" });
    expect(decision.reason).toContain("GOAL_FAILURE_DIAGNOSIS");
    expect(shouldKeepGoalRunTrackedAfterDecision(decision)).toBe(false);
  });
});
