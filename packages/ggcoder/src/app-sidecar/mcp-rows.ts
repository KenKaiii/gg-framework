import {
  type MCPScope,
  type MCPServerConfig,
  loadServers,
  MCPClientManager,
} from "../core/mcp/index.js";
import { loadSavedSettings, projectScopeAllowed } from "../config.js";

// ── MCP server management (mirrors `ggcoder mcp`) ───────────────────────────
// The webview's MCP modal lists configured servers with live connection status,
// adds them via the same paste-a-`claude mcp add …` grammar, and removes them.
// All persistence + connection logic lives in core/mcp (single source of truth);
// these helpers only shape it for the wire.

/** One wire row for the MCP list: a server config joined with its live status. */
interface McpWireRow {
  name: string;
  scope: MCPScope;
  ok: boolean;
  toolCount: number;
  error?: string;
  kind: "stdio" | "http";
  summary: string;
  /** True when the server needs an interactive OAuth login before it connects. */
  requiresAuth?: boolean;
}

/** A short transport summary for display (URL for http/sse, command+args for stdio). */
function mcpRowSummary(config: MCPServerConfig): string {
  if (config.url) return config.url;
  return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
}

/** Load + connect every server, returning one wire row per server. Mirrors the
 *  CLI dashboard's buildRows (connectAllDetailed, then dispose). Empty list
 *  short-circuits before spawning any stdio process / opening any HTTP conn.
 *  Project-scope servers run repo-controlled commands, so unless the user
 *  trusts them (trustProjectMcpServers) they are reported blocked WITHOUT
 *  being connected — even a status probe would spawn the process. */
export async function buildMcpRows(cwd: string, settingsFile: string): Promise<McpWireRow[]> {
  const scoped = await loadServers(cwd);
  if (scoped.length === 0) return [];

  const settings = loadSavedSettings(settingsFile);
  const allowProject = projectScopeAllowed(
    settings.trustProjectMcpServers,
    settings.trustedProjects,
    cwd,
  );
  const connectable = scoped.filter((s) => allowProject || s.scope !== "project");
  const blocked = scoped.filter((s) => !allowProject && s.scope === "project");

  const manager = new MCPClientManager();
  try {
    const results =
      connectable.length > 0
        ? await manager.connectAllDetailed(connectable.map((s) => s.config))
        : [];
    return [
      ...connectable.map((s): McpWireRow => {
        const result = results.find((r) => r.name === s.config.name);
        return {
          name: s.config.name,
          scope: s.scope,
          ok: result?.ok ?? false,
          toolCount: result?.toolCount ?? 0,
          error: result?.error,
          kind: s.config.url ? "http" : "stdio",
          summary: mcpRowSummary(s.config),
          requiresAuth: result?.requiresAuth,
        };
      }),
      ...blocked.map((s): McpWireRow => ({
        name: s.config.name,
        scope: s.scope,
        ok: false,
        toolCount: 0,
        error:
          "Project-scope server not connected — this repo's .gg/mcp.json runs " +
          "repo-controlled commands. Add or re-add a server in this project via " +
          "the MCP modal to trust it.",
        kind: (s.config.url ? "http" : "stdio") as "http" | "stdio",
        summary: mcpRowSummary(s.config),
      })),
    ];
  } finally {
    await manager.dispose();
  }
}

/** Probe a single server's connection before persisting it. Never throws — a
 *  failed probe returns ok:false with a human-readable error so the config can
 *  still be saved. Mirrors the CLI's probeServer. */
export async function probeMcp(
  config: MCPServerConfig,
): Promise<{ ok: boolean; toolCount: number; error?: string; requiresAuth?: boolean }> {
  const manager = new MCPClientManager();
  try {
    const result = await manager.probe(config);
    return {
      ok: result.ok,
      toolCount: result.toolCount,
      error: result.error,
      requiresAuth: result.requiresAuth,
    };
  } finally {
    await manager.dispose();
  }
}
