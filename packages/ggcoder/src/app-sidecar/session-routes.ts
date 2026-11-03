import { json } from "./http.js";
import { getSupportedThinkingLevels } from "../core/thinking-level.js";
import { getModel } from "../core/model-registry.js";
import type { SseClient } from "./session-types.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

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
      running: ctx.running,
      runState: ctx.runLifecycle.state,
      ready: true,
      thinkingLevel: ctx.session.getThinkingLevel() ?? null,
      supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
      supportsVideo: getModel(st.model)?.supportsVideo ?? false,
      autopilot: ctx.autopilot,
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
          running: ctx.running,
          reviewPending: ctx.autopilotActive,
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
