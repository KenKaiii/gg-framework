// The window's live preview controls: start (optionally with a typed dev
// server address), stop and status. Answered for the window session in the
// `x-gg-session` header, before the request reaches that session.
import type http from "node:http";
import { log } from "../../core/logger.js";
import { daemonJson, daemonReadBody } from "../http.js";
import type { SessionContext } from "../session-types.js";
import type { LivePreviewManager } from "./manager.js";

export function handleLivePreviewRoutes(
  manager: LivePreviewManager,
  ctx: SessionContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (!url.startsWith("/live-preview/")) return false;
  if (method === "GET" && url === "/live-preview/status") {
    daemonJson(res, 200, manager.status(ctx.id));
    return true;
  }
  if (method === "POST" && url === "/live-preview/stop") {
    void manager.stop(ctx.id).then(
      (status) => daemonJson(res, 200, status),
      (err: unknown) => daemonJson(res, 500, { error: errorText(err) }),
    );
    return true;
  }
  if (method === "POST" && url === "/live-preview/start") {
    // The preview's own session has no window to preview from.
    if (manager.isPreviewSession(ctx.id) || ctx.mode !== "code") {
      daemonJson(res, 400, { error: "Live preview starts from a code window." });
      return true;
    }
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { url?: unknown } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        daemonJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (body.url !== undefined && body.url !== null && typeof body.url !== "string") {
        daemonJson(res, 400, { error: "url must be a string" });
        return;
      }
      try {
        const status = await manager.start(ctx, {
          ...(typeof body.url === "string" ? { url: body.url } : {}),
        });
        daemonJson(res, 200, status);
      } catch (err) {
        log("ERROR", "live-preview", "start failed", { message: errorText(err) });
        daemonJson(res, 500, { error: `Couldn't start the live preview: ${errorText(err)}` });
      }
    });
    return true;
  }
  daemonJson(res, 404, { error: "not found" });
  return true;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
