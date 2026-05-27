import { formatGoalReferencesForPrompt } from "../core/goal-references.js";
import { goalHasBlockingPrerequisites, type GoalRun } from "../core/goal-store.js";
import {
  APPLY_INTEGRATION_TO_MAIN_TASK_TITLE,
  COMMIT_INTEGRATED_GOAL_CHANGES_TASK_TITLE,
} from "../core/goal-controller.js";
import type { decideGoalNextAction } from "../core/goal-controller.js";
import type { GoalWorktreeDirtyError } from "../core/goal-worktree.js";

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

export function buildGoalDirtyWorktreeUserPrompt(error: GoalWorktreeDirtyError): string {
  return (
    `A Goal worker could not start because the project needs a clean working tree before GG Coder can create an isolated Goal worktree.\n\n` +
    `Dirty files from \`git status --porcelain\`:\n${error.dirtyStatus}\n\n` +
    `Explain this clearly to the user in one short message. Ask whether they want you to commit the current changes, stash them, or pause the Goal. If the user chooses commit, inspect \`git status --porcelain\`, stage only the listed dirty files the user approved, run an appropriate git commit command, then resume/continue the Goal only after the working tree is clean. Do not run git commit, git stash, or discard changes unless the user explicitly chooses one.`
  );
}

export function goalDirtyWorktreeInfoText(): string {
  return "Goal paused: your working tree has uncommitted changes. Asking whether to commit or stash them before starting isolated Goal workers.";
}

function summarizeDirtyStatusForBlocker(dirtyStatus: string): string {
  return dirtyStatus
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");
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

export function buildGoalDirtyWorktreePauseRun(
  run: GoalRun,
  error: GoalWorktreeDirtyError,
): GoalRun {
  return buildGoalPauseRun(
    run,
    `Goal worker startup is awaiting a human choice because the working tree has uncommitted changes: ${summarizeDirtyStatusForBlocker(error.dirtyStatus)}. Commit the current changes, stash them, or keep the Goal paused before starting isolated Goal workers.`,
  );
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
