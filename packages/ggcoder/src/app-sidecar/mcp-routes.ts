import { buildMcpRows, probeMcp } from "./mcp-rows.js";
import { json, readBody } from "./http.js";
import { log } from "../core/logger.js";
import {
  type MCPScope,
  parseMcpAddCommand,
  addServer,
  removeServer,
  McpOAuthStore,
  getServer,
  MCPClientManager,
} from "../core/mcp/index.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleMcpRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // ── MCP server management (mirrors `ggcoder mcp`) ──────────────────
  // `targetCwd` (project scope) overrides the window cwd so a server can be
  // added/removed for ANY discovered project, not just this window's. Global
  // scope ignores it (always ~/.gg/mcp.json).
  if (method === "GET" && (url === "/mcp" || url.startsWith("/mcp?"))) {
    const targetCwd = new URL(url, `http://${ctx.host}`).searchParams.get("cwd") ?? ctx.cwd;
    void buildMcpRows(targetCwd, ctx.paths.settingsFile)
      .then((servers) => json(res, 200, { servers }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "buildMcpRows failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 200, { servers: [] });
      });
    return true;
  }

  if (method === "POST" && url === "/mcp/add") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let line: string;
      let scopeValue: string;
      let bodyCwd: string | undefined;
      try {
        const body = JSON.parse(raw) as {
          line?: string;
          scope?: string;
          cwd?: string;
        };
        line = body.line ?? "";
        scopeValue = body.scope ?? "global";
        bodyCwd = body.cwd;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const scope: MCPScope = scopeValue === "project" ? "project" : "global";
      if (scope === "project" && !bodyCwd) {
        json(res, 400, { error: "project scope requires a project (cwd)." });
        return;
      }
      const targetCwd = bodyCwd ?? ctx.cwd;
      const parsed = parseMcpAddCommand(line);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return;
      }
      const config = parsed.value.config;
      try {
        // Best-effort probe — never blocks the save. A failed connect is
        // surfaced to the UI but the config is still persisted (mirrors the
        // CLI). probeMcp swallows connect errors; the try/catch guards the
        // persist step so a write failure returns a 500 instead of becoming
        // an unhandled rejection that would crash the sidecar.
        const probe = await probeMcp(config);
        const saved = await addServer(config, scope, targetCwd, true);
        if (!saved.ok) {
          json(res, 400, { error: saved.error });
          return;
        }
        // Adding a project-scope server is an explicit trust signal — the
        // user chose to put a server in this repo's .gg/mcp.json. Auto-trust
        // the project so all project-scope servers connect on next load.
        if (scope === "project") {
          await ctx.session.trustProject(targetCwd);
        }
        json(res, 200, {
          ok: true,
          name: config.name,
          connected: probe.ok,
          toolCount: probe.toolCount,
          error: probe.error,
          requiresAuth: probe.requiresAuth,
        });
      } catch (err) {
        json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return true;
  }

  if (method === "POST" && url === "/mcp/remove") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let name: string;
      let scopeValue: string;
      let bodyCwd: string | undefined;
      try {
        const body = JSON.parse(raw) as {
          name?: string;
          scope?: string;
          cwd?: string;
        };
        name = body.name ?? "";
        scopeValue = body.scope ?? "global";
        bodyCwd = body.cwd;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!name.trim()) {
        json(res, 400, { error: "missing server name" });
        return;
      }
      const scope: MCPScope = scopeValue === "project" ? "project" : "global";
      if (scope === "project" && !bodyCwd) {
        json(res, 400, { error: "project scope requires a project (cwd)." });
        return;
      }
      const targetCwd = bodyCwd ?? ctx.cwd;
      const removed = await removeServer(name, scope, targetCwd);
      // Drop any saved OAuth tokens for this server so a re-add starts clean.
      await new McpOAuthStore().clear(name).catch(() => {});
      json(res, 200, { removed });
    });
    return true;
  }

  // Interactive OAuth login for a remote (HTTP) MCP server. The browser is
  // opened by the webview in response to the broadcast `mcp_auth_url` event;
  // progress + outcome stream via `mcp_auth_status` / `mcp_auth_done` /
  // `mcp_auth_error`. Responds 202 immediately and runs the flow in the
  // background (the browser round-trip can take a while).
  if (method === "POST" && url === "/mcp/login") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let name: string;
      let scopeValue: string;
      let bodyCwd: string | undefined;
      try {
        const body = JSON.parse(raw) as { name?: string; scope?: string; cwd?: string };
        name = body.name ?? "";
        scopeValue = body.scope ?? "global";
        bodyCwd = body.cwd;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!name.trim()) {
        json(res, 400, { error: "missing server name" });
        return;
      }
      const scope: MCPScope = scopeValue === "project" ? "project" : "global";
      const targetCwd = bodyCwd ?? ctx.cwd;
      const scoped = await getServer(name, targetCwd);
      if (!scoped || scoped.scope !== scope) {
        json(res, 404, { error: `No "${name}" server found.` });
        return;
      }
      if (!scoped.config.url) {
        json(res, 400, { error: "Login is only supported for HTTP MCP servers." });
        return;
      }
      json(res, 202, { accepted: true });
      ctx.broadcast("mcp_auth_status", { name, message: "Starting login\u2026" });
      const manager = new MCPClientManager();
      try {
        const result = await manager.login(scoped.config, (authUrl) => {
          ctx.broadcast("mcp_auth_url", { name, url: authUrl });
        });
        if (result.ok) {
          ctx.broadcast("mcp_auth_done", { name, toolCount: result.toolCount });
        } else {
          ctx.broadcast("mcp_auth_error", { name, message: result.error ?? "Login failed." });
        }
      } catch (err) {
        ctx.broadcast("mcp_auth_error", {
          name,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await manager.dispose().catch(() => {});
      }
    });
    return true;
  }

  return false;
}
