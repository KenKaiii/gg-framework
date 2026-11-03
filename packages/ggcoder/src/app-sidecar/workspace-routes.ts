import {
  listInstalledPlugins,
  installPlugin,
  removePlugin,
} from "../core/extensions/plugin-bundles.js";
import { json, readBody } from "./http.js";
import path from "node:path";
import {
  loadAppSettings,
  appSettingsFile,
  saveAppSettings,
  isValidProjectName,
} from "./app-settings.js";
import fs from "node:fs/promises";
import { resolveAppSettingsPaths, projectsWithin } from "../core/app-settings-paths.js";
import os from "node:os";
import { discoverProjects } from "../core/project-discovery.js";
import { log } from "../core/logger.js";
import { listSidecarSessions } from "../app-sidecar-sessions.js";
import { searchProjectFiles } from "./file-search.js";
import { defaultExportFilename, sessionToMarkdown } from "../core/session-export.js";
import { parseToolDetail } from "./history.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

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

  if (method === "GET" && url === "/settings") {
    // `configured` is true only when the user explicitly saved a projects root
    // (the gg-app.json file exists with a value) — not when we fall back to the
    // default. The home screen gates "Your Projects" on this.
    void (async () => {
      const s = await loadAppSettings();
      let configured: boolean;
      try {
        const raw = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as {
          projectsRoot?: string;
        };
        configured = typeof raw.projectsRoot === "string" && raw.projectsRoot.trim().length > 0;
      } catch {
        configured = false;
      }
      // A folder the embedder chose is a choice too: nothing to set up first.
      configured ||= resolveAppSettingsPaths(process.env, os.homedir()).projectsRootFromEnv;
      // Only projectsRoot + configured flag are webview-facing; the
      // per-project model map is internal persistence, never shipped out.
      json(res, 200, { projectsRoot: s.projectsRoot, configured });
    })();
    return true;
  }

  if (method === "POST" && url === "/settings") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let projectsRoot: string;
      try {
        projectsRoot = (JSON.parse(raw) as { projectsRoot?: string }).projectsRoot ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!projectsRoot.trim()) {
        json(res, 400, { error: "projectsRoot is required" });
        return;
      }
      // Read-modify-write so the per-project model map survives a projectsRoot
      // change (a naive overwrite would drop every window's saved model).
      const s = await loadAppSettings();
      s.projectsRoot = projectsRoot;
      await saveAppSettings(s);
      json(res, 200, { projectsRoot });
    });
    return true;
  }

  if (method === "POST" && url === "/create-project") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let name: string;
      try {
        name = (JSON.parse(raw) as { name?: string }).name ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      name = name.trim();
      if (!isValidProjectName(name)) {
        json(res, 400, {
          error: "Project name must be lowercase letters, digits, and dashes (e.g. my-project).",
        });
        return;
      }
      const { projectsRoot } = await loadAppSettings();
      const dir = path.join(projectsRoot, name);
      try {
        // Refuse to clobber an existing directory.
        const exists = await fs
          .stat(dir)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          json(res, 409, { error: `A folder named "${name}" already exists.` });
          return;
        }
        await fs.mkdir(dir, { recursive: true });
        json(res, 200, { path: dir });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
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
        const settings = await loadAppSettings();
        const current = new Set((settings.hiddenProjects ?? []).map((p) => path.resolve(p)));
        if (body.hidden === false) current.delete(key);
        else current.add(key);
        settings.hiddenProjects = current.size > 0 ? Array.from(current) : undefined;
        await saveAppSettings(settings);
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
    // An embedder can ask for its own projects only (the Kleio host), so the
    // list never mixes in folders other tools opened on the same machine.
    void loadAppSettings()
      .then(async ({ projectsRoot, projectRoots, hiddenProjects }) => {
        const projects = await discoverProjects({
          projectsRoot,
          extraRoots: projectRoots,
          hiddenPaths: hiddenProjects,
        });
        return resolveAppSettingsPaths(process.env, os.homedir()).ownProjectsOnly
          ? projectsWithin(projects, [projectsRoot, ...(projectRoots ?? [])])
          : projects;
      })
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
    void listSidecarSessions(target, requestedAgent, ctx.paths.sessionsDir)
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
    return true;
  }

  return false;
}
