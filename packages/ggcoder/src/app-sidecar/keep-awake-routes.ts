import { daemonJson, daemonReadBody } from "./http.js";
import { SettingsManager } from "../core/settings-manager.js";
import { log } from "../core/logger.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleKeepAwakeRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // Keep-awake is app-wide (one OS assertion for every window), so its
  // setting lives at the daemon level and applies live to in-flight runs.
  if (method === "GET" && url === "/keep-awake") {
    daemonJson(res, 200, { enabled: daemon.keepAwake.isEnabled });
    return true;
  }
  if (method === "POST" && url === "/keep-awake") {
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let enabled: unknown;
      try {
        enabled = (JSON.parse(raw) as { enabled?: unknown }).enabled;
      } catch {
        enabled = undefined;
      }
      if (typeof enabled !== "boolean") {
        daemonJson(res, 400, { error: "enabled must be a boolean" });
        return;
      }
      daemon.keepAwake.setEnabled(enabled);
      try {
        const sm = new SettingsManager(daemon.paths.settingsFile);
        await sm.load();
        await sm.set("keepAwake", enabled);
      } catch (err) {
        log("WARN", "app-sidecar", "failed to persist keepAwake", { err: String(err) });
      }
      daemonJson(res, 200, { enabled });
    });
    return true;
  }
  return false;
}
