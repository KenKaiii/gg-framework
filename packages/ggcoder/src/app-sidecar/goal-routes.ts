import type http from "node:http";
import path from "node:path";
import {
  createGoal,
  deleteGoal,
  goalKickoffPrompt,
  goalNeedsKickoff,
  goalPhase,
  goalResumePrompt,
  goalSettingsNote,
  goalWasInterrupted,
  setGoalCritterModel,
  setGoalPaused,
  updateGoal,
  goalsRoot,
  listGoals,
  markGoalKickoff,
  type GoalRecord,
} from "../core/goals-store.js";
import { goalRunningElsewhere } from "../core/goal-run-marker.js";
import {
  GOAL_RUNTIME_PROVENANCE,
  goalListStatus,
  summarizeGoal,
  type GoalSummary,
} from "../core/goal-summary.js";
import { getModel } from "../core/model-registry.js";
import { goalCritterPick } from "../goals-agent/goals-agent.js";
import { SessionManager } from "../core/session-manager.js";
import { log } from "../core/logger.js";
import { readBody, json } from "./http.js";
import type { SessionRouteContext } from "./route-context.js";

const KICKOFF_PROVENANCE = GOAL_RUNTIME_PROVENANCE;

export { goalListStatus, type GoalSummary };

/** The sidecar's row: the shared summary without the ACP-only session id. */
async function summarize(
  sessions: SessionManager,
  dir: string,
  record: GoalRecord,
  busy = false,
): Promise<GoalSummary> {
  const { latestSessionId: _latestSessionId, ...summary } = await summarizeGoal(
    sessions,
    dir,
    record,
    busy,
  );
  return summary;
}

/** Goal list, create, and the coordinator's automatic first reply. */
export function handleGoalRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/goals") {
    const sessions = new SessionManager(ctx.paths.sessionsDir);
    void listGoals(goalsRoot(ctx.paths.agentDir))
      .then((goals) =>
        Promise.all(goals.map((g) => summarize(sessions, g.dir, g.record, ctx.busyAt(g.dir)))),
      )
      .then((goals) => {
        goals.sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.id.localeCompare(b.id));
        json(res, 200, { goals });
      })
      .catch((err) => {
        log("ERROR", "app-sidecar", "listGoals failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't read your goals" });
      });
    return true;
  }

  if (method === "POST" && url === "/goals") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const input =
        body && typeof body === "object"
          ? (body as { name?: unknown; goal?: unknown; context?: unknown; instructions?: unknown })
          : {};
      try {
        const created = await createGoal(
          goalsRoot(ctx.paths.agentDir),
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
        if (!created.ok) {
          json(res, 400, { error: created.error });
          return;
        }
        const sessions = new SessionManager(ctx.paths.sessionsDir);
        json(res, 200, {
          goal: await summarize(sessions, created.value.dir, created.value.record),
        });
      } catch (err) {
        log("ERROR", "app-sidecar", "createGoal failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't create the goal" });
      }
    });
    return true;
  }

  // Deleting removes the goal folder and its coordinator sessions. Refused
  // while another window has the goal open, or while this window is running in
  // it, so no live session is left working in a folder that no longer exists.
  if (method === "POST" && url === "/goals/delete") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let id: unknown;
      try {
        id = (JSON.parse(raw) as { id?: unknown } | null)?.id;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (typeof id !== "string" || !id) {
        json(res, 400, { error: "Missing goal id" });
        return;
      }
      const root = goalsRoot(ctx.paths.agentDir);
      const dir = path.join(root, id);
      const holders = ctx.sessionIdsAt(dir);
      if (holders.some((holder) => holder !== ctx.sessionId)) {
        json(res, 409, { error: "This goal is open in another window. Close it there first." });
        return;
      }
      const ownsIt = holders.includes(ctx.sessionId);
      if (ownsIt && (ctx.running || ctx.runClaim.active || ctx.autopilotActive)) {
        json(res, 409, { error: "This goal is still working. Stop it first." });
        return;
      }
      try {
        const deleted = await deleteGoal(root, ctx.paths.sessionsDir, id);
        if (!deleted.ok) {
          json(res, 404, { error: deleted.error });
          return;
        }
        if (ownsIt) ctx.goal = null;
        json(res, 200, { ok: true });
      } catch (err) {
        log("ERROR", "app-sidecar", "deleteGoal failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't delete the goal" });
      }
    });
    return true;
  }

  // Pin the model Kleio Goals' workers run on, or clear it (null) so they follow
  // Kleio Goals. Applies to the next worker started; running ones keep theirs,
  // so this needs no run lock.
  if (method === "POST" && url === "/goal/critter-model") {
    const goal = ctx.goal;
    if (!goal) {
      json(res, 404, { error: "This window is not a goal" });
      return true;
    }
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let requested: string | null;
      try {
        const parsed = (JSON.parse(raw) as { model?: unknown } | null)?.model;
        requested = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      try {
        let pick: { provider: string; model: string } | null = null;
        if (requested !== null) {
          const target = getModel(requested);
          if (!target) {
            json(res, 404, { error: `unknown model: ${requested}` });
            return;
          }
          if (!(await ctx.auth.hasProviderAuth(target.provider))) {
            json(res, 400, { error: `Connect ${target.provider} first to use ${target.name}.` });
            return;
          }
          // Workers run in parallel and unwatched; real-money spend multiplies.
          if (target.billing?.paid) {
            json(res, 400, {
              error: `${target.name} spends real money, so it's only for your main chat. Pick another model for the workers.`,
            });
            return;
          }
          pick = { provider: target.provider, model: target.id };
        }
        const updated = await setGoalCritterModel(goal.dir, pick);
        if (!updated) {
          json(res, 404, { error: "Unknown goal" });
          return;
        }
        ctx.goal = { dir: goal.dir, record: updated };
        const payload = {
          id: updated.id,
          phase: goalPhase(updated),
          critterModel: goalCritterPick(updated)?.model ?? null,
        };
        ctx.broadcast("goal_state", payload);
        json(res, 200, payload);
      } catch (err) {
        log("ERROR", "app-sidecar", "set critter model failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't change the workers' model" });
      }
    });
    return true;
  }

  // Change this goal's attached folders/files or standing instructions. Kleio
  // Goals' brief is fixed for a session (prompt cache), so the change reaches
  // it in the goal's next session; refused mid-run so no worker is left
  // working from a folder that was just detached.
  if (method === "POST" && url === "/goal/update") {
    const goal = ctx.goal;
    if (!goal) {
      json(res, 404, { error: "This window is not a goal" });
      return true;
    }
    if (ctx.running || ctx.runClaim.active || ctx.autopilotActive) {
      json(res, 409, { error: "This goal is still working. Pause it first." });
      return true;
    }
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      try {
        const updated = await updateGoal(goal.dir, body as Parameters<typeof updateGoal>[1]);
        if (!updated.ok) {
          json(res, 400, { error: updated.error });
          return;
        }
        ctx.goal = { dir: goal.dir, record: updated.value };
        // Kleio Goals' brief is fixed for the session (prompt cache): tell it the
        // new settings at its next turn instead, and they're in the brief from
        // the next session on.
        ctx.session.notify("goal-settings", goalSettingsNote(updated.value));
        for (const item of updated.value.context) {
          if (item.kind !== "folder") continue;
          const added = await ctx.session.addDirectory(item.path);
          if (!added.ok && !added.error.startsWith("Already in the workspace")) {
            log("WARN", "app-sidecar", "goal context folder unavailable", { error: added.error });
          }
        }
        json(res, 200, {
          context: updated.value.context,
          instructions: updated.value.instructions ?? "",
        });
      } catch (err) {
        log("ERROR", "app-sidecar", "update goal failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't update the goal" });
      }
    });
    return true;
  }

  // Pause: the app stops the current run (POST /cancel, which also stops its
  // workers) and the goal stays put, even across a restart, until resumed.
  if (method === "POST" && url === "/goal/pause") {
    const goal = ctx.goal;
    if (!goal) {
      json(res, 404, { error: "This window is not a goal" });
      return true;
    }
    void setGoalPaused(goal.dir, true, new Date())
      .then((updated) => {
        if (!updated) {
          json(res, 404, { error: "Unknown goal" });
          return;
        }
        ctx.goal = { dir: goal.dir, record: updated };
        const payload = { id: updated.id, phase: goalPhase(updated), paused: true };
        ctx.broadcast("goal_state", payload);
        json(res, 200, payload);
      })
      .catch((err: unknown) => {
        log("ERROR", "app-sidecar", "pause goal failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't pause the goal" });
      });
    return true;
  }

  // Carry a goal on: after a pause, or when its window opens after the app
  // was closed mid-work. Lifts any pause, then, if the goal was cut off
  // (a worker interrupted, or Kleio Goals' own turn unfinished), runs once with
  // the resume note so Kleio Goals checks what's done and continues. Idempotent:
  // nothing to resume answers { resumed: false }.
  if (method === "POST" && url === "/goal/resume") {
    const goal = ctx.goal;
    if (!goal) {
      json(res, 404, { error: "This window is not a goal" });
      return true;
    }
    if (ctx.running || ctx.runClaim.active || ctx.autopilotActive) {
      json(res, 200, { resumed: false });
      return true;
    }
    if (!ctx.runClaim.claim()) {
      json(res, 200, { resumed: false });
      return true;
    }
    void (async () => {
      const wasPaused = Boolean(goal.record.pausedAt);
      const record = wasPaused
        ? ((await setGoalPaused(goal.dir, false, new Date())) ?? goal.record)
        : goal.record;
      ctx.goal = { dir: goal.dir, record };
      if (wasPaused) {
        ctx.broadcast("goal_state", { id: record.id, phase: goalPhase(record), paused: false });
      }
      // Never resume a goal another process is running (the phone, through
      // `kleio-coder acp`): that would start a second coordinator on it.
      const cutOff =
        !goalRunningElsewhere(goal.dir) &&
        (wasPaused ||
          goalWasInterrupted(record, ctx.session.getMessages(), ctx.session.listSubAgents()));
      if (!cutOff) {
        json(res, 200, { resumed: false });
        return;
      }
      json(res, 202, { resumed: true });
      await ctx.runAgent(record.name, () =>
        ctx.session.prompt(goalResumePrompt(record), KICKOFF_PROVENANCE),
      );
    })()
      .catch((err: unknown) => {
        log("ERROR", "app-sidecar", "goal resume failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) json(res, 500, { error: "Couldn't resume the goal" });
      })
      .finally(() => ctx.runClaim.release());
    return true;
  }

  // Idempotent: the app calls this whenever it opens a goal that still needs
  // its first reply. Only the first call on a fresh goal starts a run.
  if (method === "POST" && url === "/goal/kickoff") {
    const goal = ctx.goal;
    if (!goal) {
      json(res, 404, { error: "This window is not a goal" });
      return true;
    }
    if (!goalNeedsKickoff(goal.record, ctx.session.getMessages())) {
      json(res, 200, { started: false });
      return true;
    }
    if (ctx.running || ctx.runClaim.active || ctx.autopilotActive) {
      json(res, 409, { error: "The agent is busy" });
      return true;
    }
    // Claim synchronously so a racing prompt queues instead of starting a
    // second run while the kickoff record is being written.
    if (!ctx.runClaim.claim()) {
      json(res, 409, { error: "The agent is busy" });
      return true;
    }
    void markGoalKickoff(goal.dir, new Date())
      .then(async (updated) => {
        if (!updated) {
          json(res, 200, { started: false });
          return;
        }
        ctx.goal = { dir: goal.dir, record: updated };
        json(res, 202, { started: true });
        await ctx.runAgent(updated.name, () =>
          ctx.session.prompt(goalKickoffPrompt(updated), KICKOFF_PROVENANCE),
        );
      })
      .catch((err) => {
        log("ERROR", "app-sidecar", "goal kickoff failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) json(res, 500, { error: "Couldn't start the goal" });
      })
      .finally(() => ctx.runClaim.release());
    return true;
  }

  return false;
}
