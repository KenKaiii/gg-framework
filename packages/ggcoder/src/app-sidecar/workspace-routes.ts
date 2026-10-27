import type http from "node:http";
import path from "node:path";
import { sessionToMarkdown, defaultExportFilename } from "../core/session-export.js";
import {
  installPlugin,
  listInstalledPlugins,
  removePlugin,
} from "../core/extensions/plugin-bundles.js";
import { discoverProjects } from "../core/project-discovery.js";
import { listWorktrees } from "./worktrees.js";
import { goalsRoot } from "../core/goals-store.js";
import { listSidecarSessions } from "../app-sidecar-sessions.js";
import { log } from "../core/logger.js";
import { readBody, json } from "./http.js";
import { parseToolDetail } from "./history.js";
import { searchProjectFiles } from "./file-search.js";
import { loadAppSettings, updateAppSettings } from "./app-settings.js";
import type { SessionRouteContext } from "./route-context.js";

export function handleWorkspaceRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/plugins") {
    void listInstalledPlugins(ctx.paths.extensionsDir)
      .then((plugins) => json(res, 200, { plugins }))
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (method === "POST" && url === "/plugins/install") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      try {
        const bundlePath = (JSON.parse(raw) as { bundlePath?: unknown }).bundlePath;
        if (typeof bundlePath !== "string" || !path.isAbsolute(bundlePath)) {
          json(res, 400, { error: "bundlePath must be an absolute path" });
          return;
        }
        const plugin = await installPlugin(bundlePath, ctx.paths.extensionsDir);
        json(res, 200, { plugin, restartRequired: true });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/plugins/")) {
    const pluginId = decodeURIComponent(url.slice("/plugins/".length));
    void removePlugin(pluginId, ctx.paths.extensionsDir)
      .then(() => json(res, 200, { removed: pluginId, restartRequired: true }))
      .catch((error) => {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  // Dismiss a project from the picker (or restore it with hidden:false). The
  // path is kept rather than the row: sessions in scratch dirs keep
  // re-surfacing, so the user's decision has to outlive any one scan.
  if (method === "POST" && url === "/projects/hidden") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { path?: string; hidden?: boolean };
      try {
        body = JSON.parse(raw) as { path?: string; hidden?: boolean };
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const target = body.path?.trim();
      if (!target) {
        json(res, 400, { error: "path is required" });
        return;
      }
      const key = path.resolve(target);
      try {
        const current = await updateAppSettings((settings) => {
          const next = new Set((settings.hiddenProjects ?? []).map((p) => path.resolve(p)));
          if (body.hidden === false) next.delete(key);
          else next.add(key);
          settings.hiddenProjects = next.size > 0 ? Array.from(next) : undefined;
          return next;
        });
        json(res, 200, { hidden: Array.from(current) });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (method === "GET" && url === "/projects") {
    // Session stores (ggcoder + Claude Code + Codex) for projects with
    // history, plus a filesystem scan of the configured projects folder so
    // projects you have not opened yet are still listed.
    void loadAppSettings()
      .then(({ projectsRoot, projectRoots, hiddenProjects }) =>
        discoverProjects({
          projectsRoot,
          extraRoots: projectRoots,
          hiddenPaths: hiddenProjects,
          // Goal workspaces have their own list; they are not coding projects.
          // GG-made worktrees are listed under their project, not as projects.
          excludeRoots: [goalsRoot(ctx.paths.agentDir), path.join(ctx.paths.agentDir, "worktrees")],
        }),
      )
      .then((projects) => json(res, 200, { projects }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "discoverProjects failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 200, { projects: [] });
      });
    return true;
  }

  if (method === "GET" && url.startsWith("/sessions")) {
    const target = new URL(url, `http://${ctx.host}`).searchParams.get("cwd");
    if (!target) {
      json(res, 400, { error: "missing cwd query param" });
      return true;
    }
    const requestedAgent = new URL(url, `http://${ctx.host}`).searchParams.get("chatAgent");
    // An omitted chatAgent means coding history; chat callers identify one
    // agent or request the combined, recency-sorted "all" listing; the
    // reserved value "motion" lists Motion sessions.
    // A project's GG-made worktrees are not projects of their own: their
    // conversations (moved there from the branch picker) are listed here.
    const worktrees = requestedAgent
      ? Promise.resolve([])
      : listWorktrees(target, path.join(ctx.paths.agentDir, "worktrees"))
          .then((list) => (list?.worktrees ?? []).filter((w) => w.managed).map((w) => w.path))
          .catch(() => []);
    void worktrees
      .then((cwds) =>
        listSidecarSessions(target, requestedAgent, ctx.paths.sessionsDir, undefined, cwds),
      )
      .then((sessions) => json(res, 200, { sessions }))
      .catch(() => json(res, 200, { sessions: [] }));
    return true;
  }

  if (method === "GET" && url.startsWith("/files")) {
    const q = new URL(url, `http://${ctx.host}`).searchParams.get("q") ?? "";
    void searchProjectFiles(ctx.cwd, q)
      .then((files) => json(res, 200, { files }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "searchProjectFiles failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 200, { files: [] });
      });
    return true;
  }

  // Markdown transcript export for the app's download button. Serialized
  // here rather than in the webview because the webview's transcript model
  // deliberately keeps tool activity in the LiveToolPanel — exporting from
  // there would hand the user a coding session with the coding missing.
  // `?name=1` asks for the suggested filename only (the save dialog needs it
  // before there is a path), so the markdown never crosses IPC twice.
  if (method === "GET" && (url === "/export" || url.startsWith("/export?"))) {
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const st = ctx.session.getState();
    const filename = defaultExportFilename(ctx.mode);
    if (query.get("name") === "1") {
      json(res, 200, { filename });
      return true;
    }
    const markdown = sessionToMarkdown(
      {
        mode: ctx.mode,
        cwd: ctx.cwd,
        provider: st.provider,
        model: st.model,
        ...(st.sessionId ? { sessionId: st.sessionId } : {}),
      },
      ctx.session.getMessages(),
      { toolDetail: parseToolDetail(query.get("tools")) },
    );
    json(res, 200, { filename, markdown });
    void ctx.trophies.count("exports", ctx.sessionId);
    return true;
  }

  return false;
}
