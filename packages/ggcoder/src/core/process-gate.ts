import type { Message } from "@kenkaiiii/gg-ai";
import type { BackgroundProcess } from "./process-manager.js";

/**
 * Pre-stop gate for background processes.
 *
 * `ProcessManager` pushes progress and exit checkpoints into the *steering*
 * path, which only lands while the agent is still looping. An agent about to
 * stop never sees them, so a run can claim "done" with a test run still in
 * flight, or with a build that already exited non-zero and was never read.
 *
 * This module is the process-side twin of `SubAgentManager.completionGateMessage`
 * and is deliberately pure so both hosts (AgentSession and the Ink app) wire it
 * identically.
 */

/**
 * Hard bound on gate injections per run. A wedged gate that never lets the turn
 * finish is worse than a premature "done", so after this many nudges the gate
 * goes silent.
 */
export const MAX_PROCESS_GATE_INJECTIONS = 2;

/** The subset of `BackgroundProcess` the gate reasons about. */
export type GateableProcess = Pick<
  BackgroundProcess,
  "id" | "command" | "startedAt" | "exitCode" | "lastReadOffset" | "logSize"
>;

/**
 * A process blocks completion only when all three hold:
 *
 * 1. it started during the current run — a dev server the user deliberately
 *    left running from an earlier turn must never deadlock the agent;
 * 2. it is unresolved: still running, or exited non-zero;
 * 3. its output was never consumed in that state — nothing read at all for a
 *    running process, or unread bytes remaining for an exited one.
 */
export function isUnresolvedProcess(proc: GateableProcess, runStartedAt: number): boolean {
  if (proc.startedAt < runStartedAt) return false;
  const running = proc.exitCode === null;
  if (!running && proc.exitCode === 0) return false;
  return running
    ? proc.lastReadOffset === null || proc.lastReadOffset === 0
    : (proc.lastReadOffset ?? 0) < proc.logSize;
}

/** Unresolved processes in stable start order, so the message is deterministic. */
export function selectUnresolvedProcesses(
  procs: readonly GateableProcess[],
  runStartedAt: number,
): GateableProcess[] {
  return procs
    .filter((proc) => isUnresolvedProcess(proc, runStartedAt))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/**
 * The gate text, or undefined when nothing blocks completion. Wording mirrors
 * the child-agent gate so the model reads one contract for both.
 */
export function buildProcessCompletionGateMessage(
  procs: readonly GateableProcess[],
  runStartedAt: number,
): string | undefined {
  const unresolved = selectUnresolvedProcesses(procs, runStartedAt);
  if (unresolved.length === 0) return undefined;

  const running = unresolved.filter((proc) => proc.exitCode === null);
  const failed = unresolved.filter((proc) => proc.exitCode !== null);
  const describe = (proc: GateableProcess): string =>
    `- ${proc.id} (${proc.command})${proc.exitCode === null ? "" : ` — exited with code ${proc.exitCode}`}`;

  return [
    "Background-process completion gate: you cannot finish with unread background work from this run.",
    ...(running.length > 0 ? ["Still running, output never read:", ...running.map(describe)] : []),
    ...(failed.length > 0 ? ["Exited non-zero, output never read:", ...failed.map(describe)] : []),
    `Call task_output on each of [${unresolved.map((proc) => `"${proc.id}"`).join(", ")}] and act on what it says.`,
    "If a process is meant to keep running (a dev server, a watcher), call task_stop on it or state plainly that you are leaving it running.",
  ].join("\n");
}

/**
 * Shared pre-finalization hook used by both AgentSession and the Ink host.
 * Returns null once `injected` reaches `MAX_PROCESS_GATE_INJECTIONS`.
 */
export function buildProcessCompletionFollowUp(
  procs: readonly GateableProcess[],
  runStartedAt: number,
  injected: number,
): Message[] | null {
  if (injected >= MAX_PROCESS_GATE_INJECTIONS) return null;
  const message = buildProcessCompletionGateMessage(procs, runStartedAt);
  return message
    ? [
        {
          role: "user",
          content: message,
          provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
        },
      ]
    : null;
}
