import { goalNeedsKickoff, goalPhase, goalWasInterrupted } from "../core/goals-store.js";
import { goalRunningElsewhere } from "../core/goal-run-marker.js";
import { goalCritterPick } from "../goals-agent/goals-agent.js";
import { json } from "./http.js";
import { getSupportedThinkingLevels } from "../core/thinking-level.js";
import { getModel } from "../core/model-registry.js";
import type { SseClient } from "./session-types.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

/**
 * The app needs to know a code window is a goal (title, back navigation,
 * automatic first reply). Null for every ordinary session. Shared by GET
 * /state and the events stream's "ready" frame, which the app swaps its
 * whole state for on every (re)connect.
 */
function goalStatePayload(ctx: SessionRouteContext) {
  const goal = ctx.goal;
  if (!goal) return null;
  return {
    id: goal.record.id,
    name: goal.record.name,
    needsKickoff: goalNeedsKickoff(goal.record, ctx.session.getMessages()),
    phase: goalPhase(goal.record),
    paused: Boolean(goal.record.pausedAt),
    // Started, not paused, and cut off mid-work: the app asks it to carry on.
    // Not while another process is running it: resuming would start a
    // second coordinator on the same goal.
    needsResume:
      goalWasInterrupted(goal.record, ctx.session.getMessages(), ctx.session.listSubAgents()) &&
      !goalRunningElsewhere(goal.dir),
    instructions: goal.record.instructions ?? "",
    context: goal.record.context,
    // The workers' pinned model; null: they follow Kleio Goals' model.
    critterModel: goalCritterPick(goal.record)?.model ?? null,
  };
}

export function handleSessionRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/state") {
    const st = ctx.session.getState();
    json(res, 200, {
      ...st,
      mode: ctx.mode,
      chatAgent: ctx.chatAgent,
      // Skills the safety scan kept out; the app shows each once (toast).
      blockedSkills: ctx.session.getBlockedSkills(),
      installedThreats: ctx.session
        .getInstalledThreats()
        .map(({ key, message }) => ({ key, message })),
      goal: goalStatePayload(ctx),
      // Questions still waiting on the user, for a window rebuilding its
      // transcript (history has the tool call, not the open card).
      openAskPrompts: ctx.asks.openPrompts(),
      running: ctx.running,
      runState: ctx.runLifecycle.state,
      ready: true,
      thinkingLevel: ctx.session.getThinkingLevel() ?? null,
      supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
      supportsVideo: getModel(st.model)?.supportsVideo ?? false,
      autopilot: ctx.autopilot,
      cacheExpiry: ctx.session.getCacheExpiryStatus(),
      // `GET /history?images=refs` and `GET /history-images` are here: an
      // app may load a chat's images as they're scrolled to.
      historyImageRefs: true,
      // Questions still parked on the user, so a client that attaches late
      // (a phone opening a push) can re-show the band.
      pendingAsks: ctx.asks.pending(),
      ...ctx.kenStatePayload(),
      ...ctx.footerExtras(),
    });
    return true;
  }

  if (method === "GET" && url === "/progress") {
    json(res, 200, ctx.progress.snapshot());
    return true;
  }

  if (method === "GET" && url === "/memories") {
    void ctx.memoryStore
      .snapshot()
      .then((snapshot) => json(res, 200, snapshot))
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/memories/")) {
    const id = decodeURIComponent(url.slice("/memories/".length));
    if (!id) {
      json(res, 400, { error: "memory id is required" });
      return true;
    }
    void ctx.memoryStore
      .forget(id)
      .then(() => ctx.memoryStore.snapshot())
      .then((snapshot) => json(res, 200, snapshot))
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (method === "GET" && url === "/jiwa") {
    void ctx.jiwaStore
      .snapshot()
      .then((snapshot) => json(res, 200, snapshot))
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/jiwa/")) {
    const id = decodeURIComponent(url.slice("/jiwa/".length));
    if (!id) {
      json(res, 400, { error: "Jiwa entry id is required" });
      return true;
    }
    void ctx.jiwaStore
      .forget(id)
      .then(() => ctx.jiwaStore.snapshot())
      .then((snapshot) => json(res, 200, snapshot))
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (method === "GET" && (url === "/events" || url.startsWith("/events?"))) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`retry: 1000\n\n`);
    const client: SseClient = { id: ++ctx.clientSeq, res };
    ctx.clients.add(client);
    const st = ctx.session.getState();
    res.write(
      `data: ${JSON.stringify({
        type: "ready",
        data: {
          ...st,
          mode: ctx.mode,
          chatAgent: ctx.chatAgent,
          // Skills the safety scan kept out; the app shows each once (toast).
          blockedSkills: ctx.session.getBlockedSkills(),
          installedThreats: ctx.session
            .getInstalledThreats()
            .map(({ key, message }) => ({ key, message })),
          // The app replaces its state with this on every (re)connect: a goal
          // window must stay a goal (live bug: after a daemon restart it fell
          // back to a plain project screen).
          goal: goalStatePayload(ctx),
          // The questions this daemon can still take an answer to. After a
          // daemon restart the app's open cards belong to a run that died;
          // it closes any not listed here instead of leaving a dead button.
          openAsks: ctx.asks.openIds(),
          // And the questions themselves: a reloaded window lost its cards
          // while the agent still waits on one.
          openAskPrompts: ctx.asks.openPrompts(),
          running: ctx.running,
          reviewPending: ctx.autopilotActive,
          // A reconnecting window (reload/reopen) re-opens the review box for
          // a plan still waiting on the user, regardless of earlier offers.
          pendingPlan: ctx.pendingPlanForHuman(-1),
          runState: ctx.runLifecycle.state,
          thinkingLevel: ctx.session.getThinkingLevel() ?? null,
          supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
          supportsVideo: getModel(st.model)?.supportsVideo ?? false,
          autopilot: ctx.autopilot,
          ...ctx.kenStatePayload(),
          ...ctx.footerExtras(),
        },
      })}\n\n`,
    );
    const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
      ctx.clients.delete(client);
    });
    return true;
  }

  return false;
}
