import { daemonReadBody, daemonJson } from "./http.js";
import path from "node:path";
import {
  deleteChatSession,
  parseStoredSessionKind,
  listStoredSessions,
  readStoredSession,
} from "../app-sidecar-sessions.js";
import { log } from "../core/logger.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleStoredSessionRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // Permanently delete a saved chat (every generation): POST /sessions/delete
  // { path }. Daemon-level so it can refuse while any window has it open.
  if (method === "POST" && url === "/sessions/delete") {
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      const started = Date.now();
      let body: { path?: unknown } = {};
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        // `null`, arrays and primitives are valid JSON but not a body.
        if (typeof parsed === "object" && parsed !== null) body = parsed as typeof body;
      } catch {
        /* invalid body → rejected as an invalid path below */
      }
      const name = typeof body.path === "string" ? path.basename(body.path) : "";
      try {
        const openPaths = [...daemon.sessions.values()]
          .map((ctx) => ctx.session.getState().sessionPath || ctx.sessionPath || "")
          .filter(Boolean);
        const result = await deleteChatSession({
          path: body.path,
          coderSessionsDir: daemon.paths.sessionsDir,
          openPaths,
        });
        if (result.status === "ok") {
          log("INFO", "app-sidecar", "chat deleted", {
            file: name,
            removed: String(result.removed),
            ms: String(Date.now() - started),
          });
          daemonJson(res, 200, { ok: true, removed: result.removed });
        } else {
          log("WARN", "app-sidecar", "chat delete refused", {
            file: name,
            reason: result.status,
            ms: String(Date.now() - started),
          });
          daemonJson(res, result.status === "busy" ? 409 : 400, { error: result.message });
        }
      } catch (err) {
        log("ERROR", "app-sidecar", "chat delete failed", {
          file: name,
          error: err instanceof Error ? err.name : "unknown",
          ms: String(Date.now() - started),
        });
        daemonJson(res, 500, { error: "The chat could not be deleted." });
      }
    });
    return true;
  }

  // Saved chats and coding sessions, read-only, for Kleio's voice (through
  // kleio-host): GET /stored-sessions?kind=chat|code lists the newest, and
  // GET /stored-sessions/<id>?kind=… reads one's latest messages. The id is
  // looked up in that same listing, never used as a path.
  if (
    method === "GET" &&
    (url.startsWith("/stored-sessions?") || url.startsWith("/stored-sessions/"))
  ) {
    const started = Date.now();
    const query = new URL(url, `http://${daemon.host}`);
    const kind = parseStoredSessionKind(query.searchParams.get("kind"));
    const id = query.pathname.startsWith("/stored-sessions/")
      ? query.pathname.slice("/stored-sessions/".length)
      : null;
    const asked = Number(query.searchParams.get("limit"));
    const limit = Number.isInteger(asked) && asked > 0 ? asked : undefined;
    if (!kind || id === "" || (id !== null && id.includes("/"))) {
      daemonJson(res, 400, { error: "bad request" });
      return true;
    }
    const work =
      id === null
        ? listStoredSessions({ kind, coderSessionsDir: daemon.paths.sessionsDir, limit }).then(
            (sessions) => {
              log("INFO", "app-sidecar", "stored sessions listed", {
                kind,
                count: String(sessions.length),
                ms: String(Date.now() - started),
              });
              daemonJson(res, 200, { sessions });
            },
          )
        : readStoredSession({
            kind,
            id,
            coderSessionsDir: daemon.paths.sessionsDir,
            limit,
            files: query.searchParams.get("files") === "1",
          }).then((read) => {
            log("INFO", "app-sidecar", "stored session read", {
              kind,
              found: String(read !== null),
              messages: String(read?.messages.length ?? 0),
              files: String(read?.files?.length ?? "-"),
              ms: String(Date.now() - started),
            });
            if (read) daemonJson(res, 200, read);
            else daemonJson(res, 404, { error: "no such session" });
          });
    void work.catch((err: unknown) => {
      log("ERROR", "app-sidecar", "stored sessions failed", {
        kind,
        error: err instanceof Error ? err.name : "unknown",
        ms: String(Date.now() - started),
      });
      daemonJson(res, 500, { error: "The sessions could not be read." });
    });
    return true;
  }

  return false;
}
