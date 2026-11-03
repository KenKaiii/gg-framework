import { loadAppSettings } from "./app-settings.js";
import path from "node:path";
import { listProjectFolders } from "../core/project-discovery.js";
import { json } from "./http.js";
import { log } from "../core/logger.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleProjectFolderRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/projects/folders") {
    // Every folder in the app's project folders, hidden ones included and
    // marked: "Open existing" on a paired device, which can't browse this
    // disk. Hiding tidies the list above; it must never lose a folder.
    void loadAppSettings()
      .then(async ({ projectsRoot, projectRoots, hiddenProjects }) => {
        const hidden = new Set((hiddenProjects ?? []).map((p) => path.resolve(p)));
        const folders = await listProjectFolders([projectsRoot, ...(projectRoots ?? [])]);
        return folders.map((f) => ({ ...f, hidden: hidden.has(path.resolve(f.path)) }));
      })
      .then((folders) => json(res, 200, { folders }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "listProjectFolders failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Couldn't list the project folders." });
      });
    return true;
  }

  return false;
}
