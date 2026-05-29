import type { GoalControllerDecision } from "../core/goal-controller.js";
import {
  formatGoalBlockingPrerequisites,
  goalHasBlockingPrerequisites,
  type GoalRun,
} from "../core/goal-store.js";
import type { GoalWorkerCompletion } from "../core/goal-worker.js";
import { goalPassedDetail } from "./goal-summary.js";
import type { CompletedItem, GoalProgressDraft, GoalProgressItem } from "./app-items.js";

function summarizeGoalCompletion(summary: string): string | undefined {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "[agent_done]");
  const statusLine = lines.find((line) => /^Status:/i.test(line));
  const changedLine = lines.find((line) =>
    /^(Changed|Implemented|Fixed|Added|Key findings|Full verifier)/i.test(line),
  );
  const verificationLine = lines.find((line) => /^(Verification|Verified|Result):/i.test(line));
  return statusLine ?? changedLine ?? verificationLine ?? lines[0];
}

const GOAL_PROGRESS_TEXT_LIMIT = 54;

export function truncateGoalProgressText(
  text: string,
  maxLength = GOAL_PROGRESS_TEXT_LIMIT,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const safeMaxLength = Math.max(1, maxLength);
  if (normalized.length <= safeMaxLength) return normalized;
  if (safeMaxLength === 1) return "…";
  return `${normalized.slice(0, safeMaxLength - 1).trimEnd()}…`;
}

export function formatGoalWorkerFinishedTitle(
  taskTitle: string,
  status: GoalWorkerCompletion["status"],
): string {
  const prefix = status === "done" ? "Done" : "Failed";
  return truncateGoalProgressText(`${prefix}: ${taskTitle}`);
}

export function summarizeGoalWorkerCompletion(summary: string): string | undefined {
  return summarizeGoalCompletion(summary);
}

export { summarizeGoalCompletion };

export function goalTerminalProgressId(run: GoalRun): string {
  return `goal-terminal-${run.id}`;
}

function goalTerminalRunIdFromItem(item: CompletedItem): string | undefined {
  if (item.kind !== "goal_progress" || item.phase !== "terminal") return undefined;
  if (!item.id.startsWith("goal-terminal-")) return undefined;
  return item.id.slice("goal-terminal-".length);
}

function goalProgressMatchesDraft(item: GoalProgressItem, draft: GoalProgressDraft): boolean {
  return (
    item.phase === draft.phase &&
    item.title === draft.title &&
    item.detail === draft.detail &&
    item.workerId === draft.workerId &&
    item.status === draft.status &&
    JSON.stringify(item.summaryRows ?? []) === JSON.stringify(draft.summaryRows ?? []) &&
    JSON.stringify(item.summarySections ?? []) === JSON.stringify(draft.summarySections ?? [])
  );
}

export function appendGoalProgressDraft(
  items: readonly CompletedItem[],
  draft: GoalProgressDraft,
  makeId: () => string,
): CompletedItem[] {
  const previous = items.at(-1);
  if (previous?.kind === "goal_progress" && goalProgressMatchesDraft(previous, draft)) {
    return items as CompletedItem[];
  }
  return [...items, { ...draft, id: makeId() }];
}

export function completedItemsWithDurableGoalTerminalProgress(
  items: readonly CompletedItem[],
  runs: readonly GoalRun[],
): CompletedItem[] {
  const runIds = new Set(runs.map((run) => run.id));
  const terminalByRun = new Map(
    runs
      .map((run) => [run.id, formatGoalTerminalProgress(run)] as const)
      .filter((entry): entry is readonly [string, GoalProgressDraft] => entry[1] !== null),
  );
  if (runIds.size === 0) return items as CompletedItem[];

  let changed = false;
  const reconciled = items.map((item, index): CompletedItem => {
    const runId = goalTerminalRunIdFromItem(item);
    if (!runId || !runIds.has(runId)) return item;

    const draft = terminalByRun.get(runId);
    if (draft && goalProgressMatchesDraft(item as GoalProgressItem, draft)) return item;

    changed = true;
    return { kind: "tombstone", id: `tombstone-${item.id}-${index}` };
  });

  return changed ? reconciled : (items as CompletedItem[]);
}

export function formatGoalTerminalProgress(run: GoalRun): GoalProgressDraft | null {
  switch (run.status) {
    case "passed":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal passed: ${run.title}`,
        detail: goalPassedDetail(run),
        status: run.status,
      };
    case "failed":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal failed: ${run.title}`,
        detail: "Auto-continuation stopped.",
        status: run.status,
      };
    case "blocked":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal blocked: ${run.title}`,
        detail: goalHasBlockingPrerequisites(run)
          ? formatGoalBlockingPrerequisites(run)
          : (run.blockers[0] ?? "Blocked."),
        status: run.status,
      };
    case "paused":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal paused: ${run.title}`,
        detail: run.blockers[0] ?? "Paused.",
        status: run.status,
      };
    case "draft":
    case "ready":
    case "running":
    case "verifying":
      return null;
  }
}

export function getGoalContinuationChoiceKey({
  runId,
  decision,
}: {
  runId: string;
  decision: GoalControllerDecision;
}): string {
  switch (decision.kind) {
    case "create_task":
      return `${runId}:create_task:${decision.title}:${decision.prompt}`;
    case "start_worker":
      return `${runId}:${decision.kind}:${decision.task.id}:${decision.attempts}`;
    case "run_verifier":
      return `${runId}:run_verifier:${decision.command}`;
    case "blocked":
    case "complete":
    case "terminal":
    case "wait":
      return `${runId}:${decision.kind}:${decision.reason}`;
  }
}

export type GoalSyntheticEventRoute =
  | { action: "queue"; nextQueuedSyntheticEvents: number; nextGoalMode: "coordinator" }
  | { action: "run"; nextQueuedSyntheticEvents: number; nextGoalMode: "coordinator" };

export function routeGoalSyntheticEvent({
  agentRunning,
  queuedSyntheticEvents,
}: {
  agentRunning: boolean;
  queuedSyntheticEvents: number;
}): GoalSyntheticEventRoute {
  if (agentRunning) {
    return {
      action: "queue",
      nextQueuedSyntheticEvents: queuedSyntheticEvents + 1,
      nextGoalMode: "coordinator",
    };
  }
  return {
    action: "run",
    nextQueuedSyntheticEvents: queuedSyntheticEvents,
    nextGoalMode: "coordinator",
  };
}
