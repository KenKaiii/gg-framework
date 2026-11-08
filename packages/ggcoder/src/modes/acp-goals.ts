/**
 * Kleio Goals over ACP (`_gg/goals/*`, `_gg/goal/*`, `_gg/goal_state`): the pure
 * pieces, kept out of `acp-mode.ts` so the transport stays readable. The goal
 * list rows come from the same `summarizeGoal` the desktop sidecar uses.
 */
import path from "node:path";
import {
  createGoal,
  goalsRoot,
  listGoals,
  type GoalRecord,
  type GoalResult,
} from "../core/goals-store.js";
import { summarizeGoal, type GoalSummaryWithSessionId } from "../core/goal-summary.js";
import { SessionManager } from "../core/session-manager.js";
import type { SubAgentSnapshot } from "../core/subagent-manager.js";
import type { AppAttachment } from "../app-sidecar/attachments.js";

/** `_gg/goals/list` row: the sidecar's GoalSummary, addressed by session id. */
export interface AcpGoalSummary {
  id: string;
  name: string;
  goal: string;
  context: GoalRecord["context"];
  path: string;
  createdAt: string;
  lastActiveMs: number;
  lastActiveDisplay: string;
  /** The id `session/load` / `session/resume` take; null starts a fresh coordinator. */
  agentSessionId: string | null;
  /**
   * Standing instructions, so a client's goal settings can show what is set
   * (absent = none). The desktop app reads them from the record the same way.
   */
  instructions?: string;
  /**
   * `running` when some process holds the goal's run marker (this one, the
   * desktop app, another `kleio-coder acp`). A client that knows of a live run of
   * its own may still overlay `running` on top.
   */
  status: "briefing" | "running" | "paused" | "interrupted" | "idle";
}

/** pew2 wire `GoalWorker`. */
export interface AcpGoalWorker {
  id: string;
  name: string;
  agent?: string;
  state: "starting" | "running" | "completed" | "failed" | "interrupted" | "closed";
  activity?: string;
  startedAt?: number;
  elapsedMs?: number;
  toolUses?: number;
  model?: string;
  error?: string;
}

function toAcpSummary(
  summary: GoalSummaryWithSessionId,
  instructions: string | undefined,
): AcpGoalSummary {
  return {
    ...(instructions ? { instructions } : {}),
    id: summary.id,
    name: summary.name,
    goal: summary.goal,
    context: summary.context,
    path: summary.path,
    createdAt: summary.createdAt,
    lastActiveMs: summary.lastActiveMs,
    lastActiveDisplay: summary.lastActiveDisplay,
    agentSessionId: summary.latestSessionId,
    status: summary.status,
  };
}

function sessionsDir(agentDir: string): string {
  return path.join(agentDir, "sessions");
}

/** Every goal, most recently active first. */
export async function listAcpGoals(agentDir: string): Promise<AcpGoalSummary[]> {
  const sessions = new SessionManager(sessionsDir(agentDir));
  const goals = await listGoals(goalsRoot(agentDir));
  const rows = await Promise.all(
    goals.map(async (g) =>
      toAcpSummary(await summarizeGoal(sessions, g.dir, g.record), g.record.instructions),
    ),
  );
  rows.sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.id.localeCompare(b.id));
  return rows;
}

/** Create a goal from `_gg/goals/create` params; the store's own error text on failure. */
export async function createAcpGoal(
  agentDir: string,
  params: unknown,
): Promise<GoalResult<AcpGoalSummary>> {
  const input =
    params && typeof params === "object"
      ? (params as { name?: unknown; goal?: unknown; context?: unknown; instructions?: unknown })
      : {};
  const created = await createGoal(
    goalsRoot(agentDir),
    {
      name: typeof input.name === "string" ? input.name : "",
      goal: typeof input.goal === "string" ? input.goal : "",
      context: Array.isArray(input.context)
        ? input.context.filter((p): p is string => typeof p === "string")
        : [],
      ...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}),
    },
    new Date(),
  );
  if (!created.ok) return created;
  const sessions = new SessionManager(sessionsDir(agentDir));
  return {
    ok: true,
    value: toAcpSummary(
      await summarizeGoal(sessions, created.value.dir, created.value.record),
      created.value.record.instructions,
    ),
  };
}

/** The worker roster for `_gg/goal_state`. A reaped worker reads as closed. */
export function goalWorkers(snapshots: readonly SubAgentSnapshot[]): AcpGoalWorker[] {
  return snapshots.map((s) => ({
    id: s.agent_id,
    name: s.task_name,
    ...(s.agent_name ? { agent: s.agent_name } : {}),
    state: s.state === "reaped" ? "closed" : s.state,
    ...(s.current_activity ? { activity: s.current_activity } : {}),
    startedAt: s.started_at,
    elapsedMs: s.elapsed_ms,
    toolUses: s.tool_use_count,
    ...(s.model ? { model: s.model } : {}),
    ...(s.error ? { error: s.error } : {}),
  }));
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * ACP `image` prompt blocks as the app's attachment shape, so they take the
 * same `prepareAttachments` → `promptWithAttachments` path the desktop does.
 * Blocks carrying only a `uri` (no inline data) are skipped.
 */
export function acpImageAttachments(blocks: unknown): AppAttachment[] {
  if (!Array.isArray(blocks)) return [];
  const out: AppAttachment[] = [];
  for (const block of blocks) {
    const entry = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (entry?.type !== "image" || typeof entry.data !== "string" || !entry.data) continue;
    const mediaType = typeof entry.mimeType === "string" ? entry.mimeType : "image/png";
    const ext = IMAGE_EXTENSIONS[mediaType] ?? "img";
    out.push({
      kind: "image",
      name: `image-${out.length + 1}.${ext}`,
      mediaType,
      data: entry.data,
    });
  }
  return out;
}
