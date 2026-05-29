import { formatGoalReferencesForPrompt } from "../core/goal-references.js";
import { goalHasBlockingPrerequisites, type GoalRun } from "../core/goal-store.js";
import {
  APPLY_INTEGRATION_TO_MAIN_TASK_TITLE,
  COMMIT_INTEGRATED_GOAL_CHANGES_TASK_TITLE,
} from "../core/goal-controller.js";
import type { decideGoalNextAction } from "../core/goal-controller.js";

export function buildGoalTaskPromptWithReferences(run: GoalRun, taskPrompt: string): string {
  if (taskPrompt.includes("## Goal References (MANDATORY)")) return taskPrompt;
  const references = formatGoalReferencesForPrompt(run.references ?? []);
  return references ? `${references}\n\n${taskPrompt}` : taskPrompt;
}

export function shouldRunGoalTaskInMainCheckout(taskTitle: string): boolean {
  return (
    taskTitle === APPLY_INTEGRATION_TO_MAIN_TASK_TITLE ||
    taskTitle === COMMIT_INTEGRATED_GOAL_CHANGES_TASK_TITLE
  );
}

export function goalTaskProgress(
  run: GoalRun,
  task: GoalRun["tasks"][number] | undefined,
): { taskNumber: number; taskTotal: number } | undefined {
  if (!task) return undefined;
  const taskIndex = run.tasks.findIndex((item) => item.id === task.id);
  if (taskIndex < 0 || run.tasks.length === 0) return undefined;
  return { taskNumber: taskIndex + 1, taskTotal: run.tasks.length };
}

function buildGoalPauseRun(run: GoalRun, blocker: string): GoalRun {
  return {
    ...run,
    status: "paused",
    activeWorkerId: undefined,
    continueRequestedAt: undefined,
    blockers: Array.from(new Set([...run.blockers, blocker])),
  };
}

export function buildGoalUserPauseRun(run: GoalRun): GoalRun {
  return buildGoalPauseRun(
    run,
    "Goal paused by user from the mini TUI; auto-continuation is stopped until resumed.",
  );
}

export function goalRunNeedsExplicitContinuationAfterWorker(run: GoalRun | undefined): boolean {
  return !!run?.continueRequestedAt && !goalHasBlockingPrerequisites(run);
}

export function shouldKeepGoalRunTrackedAfterDecision(
  decision: ReturnType<typeof decideGoalNextAction>,
): boolean {
  return (
    decision.kind === "start_worker" ||
    decision.kind === "run_verifier" ||
    decision.kind === "create_task" ||
    (decision.kind === "wait" && decision.workerId !== undefined)
  );
}
