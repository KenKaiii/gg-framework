// When a started goal has finished a stretch of work, and the score for it.
// Ported from upstream's goal-finish.ts, without Ken's face and spoken line.
//
// A stretch is every run since the last finish: the run the user's message
// started plus each run the coordinator was woken for as its workers came
// back. It is finished once nothing is left going: no run, no question
// waiting, no worker still at it, and that has held for FINISH_SETTLE_MS (a
// worker that just finished wakes the coordinator a moment later). A
// cancelled run ends the stretch without a finish; the user stopped it.

import type { RunEnd } from "../useAgentEvents";
import { workerPhase } from "./goal-progress";
import type { WorkerAgent, WorkerGroup } from "./worker-status";

/** One run of a goal's session, as the event stream saw it end. */
export interface GoalRun extends RunEnd {
  readonly goalId: string;
}

export type FinishOutcome = Exclude<GoalRun["outcome"], "cancelled">;

export interface GoalFinish {
  /** When the stretch's last run ended: unique per finish. */
  readonly id: number;
  readonly goalId: string;
  readonly outcome: FinishOutcome;
  readonly elapsedMs: number;
  /** The coordinator's own model turns across the stretch. */
  readonly turns: number;
  /** Workers brought in during the stretch, and how many of them failed. */
  readonly workers: number;
  readonly failedWorkers: number;
  /** Output tokens: the coordinator's and its workers'. */
  readonly outputTokens: number;
  readonly line: string;
}

/** How long everything must stay quiet before the stretch counts as finished. */
export const FINISH_SETTLE_MS = 1500;
/** Runs kept per window; a stretch is never anywhere near this long. */
export const MAX_RUNS = 200;

export function recordRun(runs: readonly GoalRun[], run: GoalRun): readonly GoalRun[] {
  const next = [...runs, run];
  return next.length > MAX_RUNS ? next.slice(next.length - MAX_RUNS) : next;
}

/** The runs of `goalId`'s open stretch: ended after `closedAt`, after its last cancel. */
export function openStretch(
  runs: readonly GoalRun[],
  goalId: string,
  closedAt: number,
): readonly GoalRun[] {
  const mine = runs.filter((run) => run.goalId === goalId && run.endedAt > closedAt);
  let from = 0;
  mine.forEach((run, i) => {
    if (run.outcome === "cancelled") from = i + 1;
  });
  return mine.slice(from);
}

/** Nothing is going on: no run, no question, no worker at work, not paused. */
export function goalIsQuiet(input: {
  readonly paused: boolean;
  readonly running: boolean;
  readonly waitingOnUser: boolean;
  readonly workers: readonly WorkerAgent[];
}): boolean {
  return (
    !input.paused &&
    !input.running &&
    !input.waitingOnUser &&
    !input.workers.some((worker) => workerPhase(worker.status) === "working")
  );
}

const LINE: Readonly<Record<FinishOutcome, string>> = {
  done: "All finished. The full write-up is in the chat.",
  unverified: "Finished, but not all of it could be checked. Details in the chat.",
  failed: "The goal couldn't finish this time. What went wrong is in the chat.",
};

/** The score for a finished stretch, or null when it has no runs. */
export function goalFinishOf(
  stretch: readonly GoalRun[],
  groups: readonly WorkerGroup[],
): GoalFinish | null {
  const first = stretch[0];
  const last = stretch[stretch.length - 1];
  if (!first || !last || last.outcome === "cancelled") return null;
  // Workers brought in during the stretch (their group came after it began).
  const agents = groups.filter((group) => group.id > first.fromItemId).flatMap((g) => g.agents);
  const failedWorkers = agents.filter(
    (agent) => agent.status === "error" || agent.status === "interrupted",
  ).length;
  const workerTokens = agents.reduce((sum, agent) => sum + (agent.tokenUsage?.output ?? 0), 0);
  return {
    id: last.endedAt,
    goalId: last.goalId,
    outcome: last.outcome,
    elapsedMs: Math.max(0, last.endedAt - first.startedAt),
    turns: stretch.reduce((sum, run) => sum + run.turns, 0),
    workers: agents.length,
    failedWorkers,
    outputTokens: stretch.reduce((sum, run) => sum + run.outputTokens, 0) + workerTokens,
    line: LINE[last.outcome],
  };
}
