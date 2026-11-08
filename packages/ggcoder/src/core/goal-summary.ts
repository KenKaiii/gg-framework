/**
 * Goal list rows, shared by the desktop sidecar (`app-sidecar/goal-routes.ts`)
 * and ACP mode (`modes/acp-goals.ts`), so both surfaces describe a goal the
 * same way.
 */
import { promises as fs } from "node:fs";
import type { MessageProvenance } from "@kleio/ai";
import { goalWasInterrupted, type GoalRecord } from "./goals-store.js";
import { goalRunLive } from "./goal-run-marker.js";
import { formatRelativeTime } from "./project-discovery.js";
import type { SessionManager } from "./session-manager.js";

/** The kickoff/resume instruction is runtime-authored and never shown as a user bubble. */
export const GOAL_RUNTIME_PROVENANCE: MessageProvenance = {
  source: "runtime",
  kind: "automation",
  visibility: "hidden",
};

/** One row of the app's goal list. */
export interface GoalSummary {
  id: string;
  name: string;
  goal: string;
  context: GoalRecord["context"];
  path: string;
  createdAt: string;
  lastActiveMs: number;
  lastActiveDisplay: string;
  /** Newest non-empty session to resume; null opens a fresh coordinator session. */
  latestSessionPath: string | null;
  /**
   * Where the goal stands, for the goal list: briefing (not started yet),
   * running (working right now), paused (by the user), or idle (started,
   * not working: done, or waiting to be opened again).
   */
  status: "briefing" | "running" | "paused" | "interrupted" | "idle";
}

/** A summary plus the newest session's id, for callers that address sessions by id. */
export type GoalSummaryWithSessionId = GoalSummary & { latestSessionId: string | null };

/** How much of a session file's end is read to find its last message. */
const TAIL_BYTES = 64 * 1024;

/**
 * The last few messages of a session file (role and content), read from its
 * end only, never thawing or rewriting it. Empty when it can't be read
 * (archived, gone): the goal then just isn't marked interrupted.
 */
async function lastMessages(file: string): Promise<Array<{ role: string; content?: unknown }>> {
  let text: string;
  try {
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      text = buf.toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  const out: Array<{ role: string; content?: unknown }> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (entry.type === "message" && entry.message?.role) {
        out.push({ role: entry.message.role, content: entry.message.content });
      }
    } catch {
      // A line cut at the start of the read window.
    }
  }
  return out;
}

/** A goal's status for the list (see GoalSummary.status). */
export function goalListStatus(
  record: GoalRecord,
  busy: boolean,
  cutOff = false,
): GoalSummary["status"] {
  if (record.pausedAt) return "paused";
  if (busy) return "running";
  if (cutOff) return "interrupted";
  return record.startedAt ? "idle" : "briefing";
}

/** Summarize one goal for a list, from its record and its coordinator sessions. */
export async function summarizeGoal(
  sessions: SessionManager,
  dir: string,
  record: GoalRecord,
  busy = false,
): Promise<GoalSummaryWithSessionId> {
  const list = await sessions.list(dir).catch(() => []);
  const withMessages = list.filter((s) => s.messageCount > 0);
  let lastActiveMs = Date.parse(record.createdAt) || 0;
  let latestSessionPath: string | null = null;
  let latestSessionId: string | null = null;
  let latestMs = -1;
  for (const s of withMessages) {
    const ms = Date.parse(s.lastActivity) || 0;
    if (ms > latestMs) {
      latestMs = ms;
      latestSessionPath = s.path;
      latestSessionId = s.id;
    }
    if (ms > lastActiveMs) lastActiveMs = ms;
  }
  // `busy` only knows this process's sessions. A goal another process is
  // running (the phone through `kleio-coder acp`, or the desktop app while the
  // phone asks) says so through its run marker; without it, a session file
  // ending on a tool call read as "Interrupted" while the goal was working.
  const live = busy || goalRunLive(dir);
  return {
    id: record.id,
    name: record.name,
    goal: record.goal,
    context: record.context,
    path: dir,
    createdAt: record.createdAt,
    lastActiveMs,
    lastActiveDisplay: formatRelativeTime(lastActiveMs),
    latestSessionPath,
    latestSessionId,
    status: goalListStatus(
      record,
      live,
      // Not working, but its last turn never finished: the app closed, or it
      // was stopped, mid-work. Workers aren't known here, only the session.
      !live &&
        Boolean(record.startedAt) &&
        latestSessionPath !== null &&
        goalWasInterrupted(record, await lastMessages(latestSessionPath), []),
    ),
  };
}
