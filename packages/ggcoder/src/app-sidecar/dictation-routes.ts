import { daemonJson, daemonReadBody } from "./http.js";
import { log } from "../core/logger.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleDictationRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // ── Dictation's speech model (daemon-level: one Whisper for every client) ──
  // GET: where the model is. POST /dictation/prepare: start getting it ready
  // (download, then load) or join the run under way, answering at once with
  // the status. Both carry reason codes only; the details are in this log.
  if (method === "GET" && url === "/dictation") {
    void daemon.dictation.status().then(
      (status) => daemonJson(res, 200, status),
      (error: unknown) => {
        log("ERROR", "app-sidecar", "dictation status failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        daemonJson(res, 500, { error: "Couldn't check dictation." });
      },
    );
    return true;
  }

  if (method === "POST" && url === "/dictation/prepare") {
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      daemon.dictation.prepare();
      try {
        const status = await daemon.dictation.status();
        log("INFO", "app-sidecar", "dictation prepare", { state: status.state });
        daemonJson(res, 200, status);
      } catch (error) {
        log("ERROR", "app-sidecar", "dictation status failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        daemonJson(res, 500, { error: "Couldn't check dictation." });
      }
    });
    return true;
  }

  return false;
}
