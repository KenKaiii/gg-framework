// How a started goal's work stands, for the header: how many workers are
// working right now, and how many tasks have finished (and failed) so far.
//
// Finished tasks are counted as they happen, not read off the current list: a
// worker Kleio Goals hands a follow-up goes from done back to working, and its
// first task still counts as done.

import type { Item } from "../transcript-item";
import type { WorkerAgent } from "./worker-status";

/** Where one worker is: on a task, finished with it, or stopped short. */
export type WorkerPhase = "working" | "done" | "failed";

export interface GoalTally {
  /** Each worker's phase when last seen, by key. */
  readonly phases: ReadonlyMap<string, WorkerPhase>;
  /** Workers on a task now. */
  readonly working: number;
  /** Tasks finished so far. */
  readonly done: number;
  /** Tasks that failed or were stopped short so far. */
  readonly failed: number;
}

export const EMPTY_TALLY: GoalTally = { phases: new Map(), working: 0, done: 0, failed: 0 };

/** A worker (see collectWorkers): idle means it finished and waits for more. */
export function workerPhase(status: WorkerAgent["status"]): WorkerPhase {
  if (status === "running") return "working";
  if (status === "error" || status === "interrupted") return "failed";
  return "done";
}

/**
 * The tally after seeing `workers` (key and phase, Kleio Goals left out): each
 * worker that reaches done or failed (from working, or seen first already
 * there, as when a window resumes) adds one task to that count; one going
 * back to work (a follow-up, a retry) takes nothing away. Returns `prev`
 * itself when nothing changed.
 */
export function tallyGoal(
  prev: GoalTally,
  workers: ReadonlyArray<{ readonly key: string; readonly phase: WorkerPhase }>,
): GoalTally {
  const phases = new Map<string, WorkerPhase>();
  let { done, failed } = prev;
  let working = 0;
  let changed = workers.length !== prev.phases.size;
  for (const { key, phase } of workers) {
    phases.set(key, phase);
    if (phase === "working") working++;
    const was = prev.phases.get(key);
    if (was === phase) continue;
    changed = true;
    if (phase === "done") done++;
    else if (phase === "failed") failed++;
  }
  if (!changed) return prev;
  return { phases, working, done, failed };
}

/** Kleio Goals' own tools that are hands-on work (not reading, planning, managing or waiting). */
const HANDS_ON = new Set(["edit", "write", "bash"]);

/**
 * Kleio Goals itself, for the header's working count: working while it runs
 * one of its own hands-on tools (it does small and connected work itself),
 * not while it reads, plans, starts workers or waits on them. Only counted
 * while working: its turns aren't tasks, so never done or failed.
 */
export function coordinatorAtWork(
  liveTools: ReadonlyArray<{ readonly name: string; readonly status: string }>,
): boolean {
  return liveTools.some((tool) => tool.status === "running" && HANDS_ON.has(tool.name));
}

/** The header's readout, in words: "3 working · 5 done · 1 failed" (failed only when any did). */
export function describeTally(tally: GoalTally): string {
  const parts = [`${tally.working} working`, `${tally.done} done`];
  if (tally.failed > 0) parts.push(`${tally.failed} failed`);
  return parts.join(" · ");
}

/**
 * The question Kleio Goals is blocked on: the latest one still waiting for an
 * answer, that it hasn't moved on from (past its deadline it carries on with
 * its best guess, so it isn't blocked). Null when there's none.
 */
export function blockingAsk(
  items: readonly Item[],
): { readonly id: string; readonly question: string; readonly more: number } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "ask" || item.sent || item.cancelled || item.deferred) continue;
    const [first, ...rest] = item.prompt.questions;
    if (!first) continue;
    // ask_user's `question` is the short question itself (its explanation is
    // a separate `detail`, left in the chat), so it reads as the coordinator asking.
    // Clipped at a word in case one runs long; the rest are counted.
    return { id: item.prompt.id, question: clipQuestion(first.question), more: rest.length };
  }
  return null;
}

/** The most of a question the Workers view shows (the chat has it all). */
export const ASK_QUESTION_MAX = 160;

function clipQuestion(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= ASK_QUESTION_MAX) return flat;
  const cut = flat.slice(0, ASK_QUESTION_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > ASK_QUESTION_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}
