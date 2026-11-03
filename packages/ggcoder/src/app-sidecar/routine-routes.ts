import { daemonJson, daemonReadBody } from "./http.js";
import { validateInput as validateRoutineInput } from "../routines.js";
import fs from "node:fs/promises";
import { log } from "../core/logger.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleRoutineRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // ── Routines (daemon-level; a routine outlives any window) ──────────
  if (method === "GET" && url === "/routines") {
    // `sessions` includes finished routines' sessions on purpose: a Kleio
    // host mirrors these into its replay ring, and a one-shot routine is
    // gone from `routines` the instant it fires.
    daemonJson(res, 200, {
      ...daemon.routinesPayload(),
      sessions: daemon.routineRunner.sessions(),
    });
    return true;
  }

  if (method === "POST" && url === "/routines") {
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        daemonJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      const v = validateRoutineInput(body);
      if (!v.ok) {
        daemonJson(res, 400, { error: v.error.message });
        return;
      }
      try {
        if (!(await fs.stat(v.value.cwd)).isDirectory()) throw new Error("not a directory");
      } catch {
        daemonJson(res, 400, { error: `cwd is not a directory on this host: ${v.value.cwd}` });
        return;
      }
      const r = await daemon.routineStore.add(v.value);
      if (!r.ok) {
        daemonJson(res, r.error.kind === "limit" ? 409 : 500, { error: r.error.message });
        return;
      }
      log("INFO", "app-sidecar", "routine added", {
        id: r.value.id,
        intervalMs: String(r.value.intervalMs),
        runCount: String(r.value.runCount),
      });
      daemon.broadcastAll("routines", daemon.routinesPayload());
      daemonJson(res, 200, { routine: r.value });
    });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/routines/")) {
    const rid = decodeURIComponent(url.slice("/routines/".length));
    void (async () => {
      const r = await daemon.routineStore.remove(rid);
      if (!r.ok) {
        daemonJson(res, r.error.kind === "not_found" ? 404 : 500, { error: r.error.message });
        return;
      }
      await daemon.routineRunner.release(rid);
      log("INFO", "app-sidecar", "routine removed", { id: rid });
      daemon.broadcastAll("routines", daemon.routinesPayload());
      daemonJson(res, 200, { ok: true });
    })();
    return true;
  }

  return false;
}
