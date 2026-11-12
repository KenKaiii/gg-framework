import { loadSavedSettings, projectScopeAllowed } from "../config.js";
import type { AgentSession, McpServerChange } from "../core/agent-session.js";
import { log } from "../core/logger.js";
import { loadServers, type MCPServerConfig } from "../core/mcp/index.js";

/**
 * One server's config as a session in `cwd` would load it at startup:
 * project scope wins over global, and project servers count only when the
 * project is trusted (same rule as getAllMcpServers).
 */
export async function effectiveMcpServer(
  name: string,
  cwd: string,
  settingsFile: string,
): Promise<MCPServerConfig | undefined> {
  const settings = loadSavedSettings(settingsFile);
  const allowProject = projectScopeAllowed(
    settings.trustProjectMcpServers,
    settings.trustedProjects,
    cwd,
  );
  const scoped = await loadServers(cwd);
  return scoped.find((s) => s.config.name === name && (allowProject || s.scope !== "project"))
    ?.config;
}

/**
 * Bring every open window's session in line with the saved config for one
 * server, so an add/remove takes effect without a restart. Per session id:
 * what changed there, or null when nothing did. Never throws.
 */
export async function syncMcpServerAcross(
  targets: Iterable<{ id: string; cwd: string; session: AgentSession }>,
  name: string,
  settingsFile: string,
): Promise<Map<string, McpServerChange | null>> {
  // Entries keep the targets' order, not the order the sessions finish in.
  const entries = await Promise.all(
    [...targets].map(async (target): Promise<[string, McpServerChange | null]> => {
      try {
        const config = await effectiveMcpServer(name, target.cwd, settingsFile);
        return [target.id, await target.session.applyMcpServerChange(name, config)];
      } catch (err) {
        log("WARN", "app-sidecar", "mcp live sync failed", {
          name,
          message: err instanceof Error ? err.message : String(err),
        });
        return [target.id, null];
      }
    }),
  );
  return new Map(entries);
}
