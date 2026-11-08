/**
 * Whether a goal is being worked on right now, by any process on this machine.
 *
 * A goal can be run by the desktop app's sidecar, by `kleio-coder acp` (pew2 on
 * the phone spawns that), or by both over a day. Each knows only its own
 * sessions, so a goal another process was in the middle of read as cut off
 * mid-work: its session file ends on a tool call. The goal list said
 * "Interrupted" for a goal that was running, and opening it offered to resume
 * it, which would start a second coordinator on the same goal.
 *
 * So the process running a goal says so, in a small file in the goal's
 * `.gg` folder: its pid and a heartbeat. A reader counts it only while that
 * pid is alive *and* the heartbeat is fresh. A crash leaves the file behind,
 * and the heartbeat going stale (or the pid being gone) is what lets the goal
 * read as interrupted again; the freshness check also stops a recycled pid
 * from passing as the old run.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** How often a held marker is re-stamped. */
export const GOAL_RUN_HEARTBEAT_MS = 15_000;
/** A marker not re-stamped for this long belongs to a run that is gone. */
export const GOAL_RUN_STALE_MS = 60_000;

/** What the file holds. */
export interface GoalRunMarker {
  version: 1;
  pid: number;
  /** Distinguishes two holds by the same pid across a restart of the process. */
  token: string;
  startedAt: string;
  heartbeatAt: string;
}

export function goalRunMarkerPath(dir: string): string {
  return path.join(dir, ".gg", "goal-running.json");
}

/** True when a process with this pid exists (EPERM: it exists, it's just not ours). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a marker stands for a run still going. Pure, so it can be tested. */
export function goalRunMarkerLive(
  marker: GoalRunMarker,
  now: number,
  isAlive: (pid: number) => boolean = processAlive,
): boolean {
  const beat = Date.parse(marker.heartbeatAt);
  if (!Number.isFinite(beat) || now - beat > GOAL_RUN_STALE_MS) return false;
  return isAlive(marker.pid);
}

/** The marker in a goal folder, or null when there is none or it can't be read. */
export function readGoalRunMarker(dir: string): GoalRunMarker | null {
  let raw: string;
  try {
    raw = fs.readFileSync(goalRunMarkerPath(dir), "utf-8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<GoalRunMarker>;
    if (
      value.version !== 1 ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.heartbeatAt !== "string"
    ) {
      return null;
    }
    return value as GoalRunMarker;
  } catch {
    return null;
  }
}

/** Some process (this one included) is running the goal right now. */
export function goalRunLive(dir: string, now = Date.now()): boolean {
  const marker = readGoalRunMarker(dir);
  return marker !== null && goalRunMarkerLive(marker, now);
}

/**
 * Another process is running the goal right now. What the resume checks ask:
 * this process's own run is already known to them, and must not stop it
 * resuming a goal it was itself cut off from.
 */
export function goalRunningElsewhere(dir: string, now = Date.now()): boolean {
  const marker = readGoalRunMarker(dir);
  return marker !== null && marker.pid !== process.pid && goalRunMarkerLive(marker, now);
}

interface Hold {
  count: number;
  marker: GoalRunMarker;
  timer: ReturnType<typeof setInterval>;
}

/** Live holds in this process, by resolved goal folder. */
const holds = new Map<string, Hold>();
let exitHookInstalled = false;

/** Written beside the target and renamed, so a reader never sees half a file. */
function writeMarker(dir: string, marker: GoalRunMarker): void {
  const file = goalRunMarkerPath(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marker));
    fs.renameSync(tmp, file);
  } catch {
    // Best effort: without the file the goal just isn't shown as running
    // elsewhere, exactly as before the marker existed. Never fail a run on it.
  }
}

/** Removes the file only while it is still this hold's: another process may have taken over. */
function removeMarker(dir: string, marker: GoalRunMarker): void {
  const current = readGoalRunMarker(dir);
  if (!current || current.pid !== marker.pid || current.token !== marker.token) return;
  try {
    fs.unlinkSync(goalRunMarkerPath(dir));
  } catch {
    // Already gone.
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A clean exit (quit, a supervisor restart) clears its markers at once
  // instead of leaving the goal "running" until the heartbeat goes stale.
  process.once("exit", () => {
    for (const [dir, hold] of holds) {
      clearInterval(hold.timer);
      removeMarker(dir, hold.marker);
    }
    holds.clear();
  });
}

/**
 * Mark a goal as being worked on by this process until the returned release
 * is called. Holds nest: two sessions on one goal (two windows) keep the
 * marker until both let go. Releasing twice is harmless.
 */
export function holdGoalRun(goalDir: string, now: () => Date = () => new Date()): () => void {
  const dir = path.resolve(goalDir);
  let hold = holds.get(dir);
  if (hold) {
    hold.count++;
  } else {
    const at = now().toISOString();
    const marker: GoalRunMarker = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      startedAt: at,
      heartbeatAt: at,
    };
    writeMarker(dir, marker);
    const timer = setInterval(() => {
      const current = holds.get(dir);
      if (!current) return;
      current.marker = { ...current.marker, heartbeatAt: now().toISOString() };
      writeMarker(dir, current.marker);
    }, GOAL_RUN_HEARTBEAT_MS);
    // Never what keeps a process alive.
    timer.unref?.();
    hold = { count: 1, marker, timer };
    holds.set(dir, hold);
    installExitHook();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = holds.get(dir);
    if (!current) return;
    current.count--;
    if (current.count > 0) return;
    clearInterval(current.timer);
    holds.delete(dir);
    removeMarker(dir, current.marker);
  };
}
