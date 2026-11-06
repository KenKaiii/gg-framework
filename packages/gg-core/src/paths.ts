import path from "node:path";
import os from "node:os";

export interface AppPaths {
  agentDir: string;
  sessionsDir: string;
  subagentSessionsDir: string;
  subagentsDir: string;
  settingsFile: string;
  authFile: string;
  telegramFile: string;
  agentHomeFile: string;
  mcpFile: string;
  mcpAuthFile: string;
  /** Cached MCP tool catalog, so a cold start can answer tool_search honestly. */
  mcpCatalogFile: string;
  logFile: string;
  skillsDir: string;
  extensionsDir: string;
  agentsDir: string;
  progressFile: string;
  progressBackupFile: string;
  /** Earned trophies and the counters that unlock them. */
  trophiesFile: string;
  /** On-demand Claude Code binaries for "Sign in with Claude", one dir per version. */
  claudeCodeDir: string;
  /** GG Coder's own Claude Code login (CLAUDE_CONFIG_DIR), separate from the user's. */
  claudeCodeConfigDir: string;
}

export function getAppPaths(): AppPaths {
  const agentDir = path.join(os.homedir(), ".gg");
  return {
    agentDir,
    sessionsDir: path.join(agentDir, "sessions"),
    subagentSessionsDir: path.join(agentDir, "subagent-sessions"),
    subagentsDir: path.join(agentDir, "subagents"),
    settingsFile: path.join(agentDir, "settings.json"),
    authFile: path.join(agentDir, "auth.json"),
    telegramFile: path.join(agentDir, "telegram.json"),
    agentHomeFile: path.join(agentDir, "agent-home.json"),
    mcpFile: path.join(agentDir, "mcp.json"),
    mcpAuthFile: path.join(agentDir, "mcp-auth.json"),
    mcpCatalogFile: path.join(agentDir, "mcp-catalog.json"),
    logFile: path.join(agentDir, "debug.log"),
    skillsDir: path.join(agentDir, "skills"),
    extensionsDir: path.join(agentDir, "extensions"),
    agentsDir: path.join(agentDir, "agents"),
    progressFile: path.join(agentDir, "progress.json"),
    progressBackupFile: path.join(agentDir, "progress.backup.json"),
    trophiesFile: path.join(agentDir, "trophies.json"),
    claudeCodeDir: path.join(agentDir, "claude-code"),
    claudeCodeConfigDir: path.join(agentDir, "claude-code", "config"),
  };
}
