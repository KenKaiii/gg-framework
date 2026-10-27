import fs from "node:fs/promises";

import {
  CHAT_AGENT_IDS,
  chatAgentSessionsDir,
  sessionsDirForChatAgent,
  type ChatAgentId,
} from "./chat-agents/index.js";
import {
  listForeignSessions,
  listRecentSessions,
  type RecentSession,
} from "./core/project-discovery.js";
import { MOTION_SESSIONS_QUERY, motionSessionsDir } from "./motion-agent/motion-agent.js";

const CODING_SESSION_LIMIT = 5;
const CHAT_SESSION_LIMIT = 30;
const MOTION_SESSION_LIMIT = 30;
/** Foreign rows are additive, so keep them a short tail under the native list. */
const FOREIGN_SESSION_LIMIT = 5;

export type SidecarSession = RecentSession & { chatAgent?: ChatAgentId };

/**
 * List coding or chat sessions using the caps exposed by the gg-app sidecar.
 *
 * `homeDir` only exists so tests can point the Claude Code / Codex lookup at a
 * fixture home; production always uses the real one.
 */
export async function listSidecarSessions(
  cwd: string,
  requestedAgent: string | null,
  coderSessionsDir: string,
  homeDir?: string,
  /** The project's GG-made worktrees: their conversations are listed with it. */
  worktreeCwds: readonly string[] = [],
): Promise<SidecarSession[]> {
  if (requestedAgent === MOTION_SESSIONS_QUERY) {
    return listRecentSessions(cwd, MOTION_SESSION_LIMIT, motionSessionsDir(coderSessionsDir));
  }
  if (requestedAgent !== "all") {
    // Chat agents have their own private stores; only the coding list (no
    // requested agent) shares a cwd with Claude Code and Codex.
    if (requestedAgent) {
      return listRecentSessions(
        cwd,
        CHAT_SESSION_LIMIT,
        sessionsDirForChatAgent(coderSessionsDir, requestedAgent),
      );
    }
    return listCodingSessions(cwd, coderSessionsDir, homeDir, worktreeCwds);
  }

  const groups = await Promise.all(
    CHAT_AGENT_IDS.map(async (agentId) => {
      const sessions = await listRecentSessions(
        cwd,
        CHAT_SESSION_LIMIT,
        chatAgentSessionsDir(coderSessionsDir, agentId),
      );
      return sessions.map((session) => ({ ...session, chatAgent: agentId }));
    }),
  );
  const dated = await Promise.all(
    groups.flat().map(async (session) => ({
      session,
      mtime: await fs
        .stat(session.path)
        .then((stat) => stat.mtimeMs)
        .catch(() => 0),
    })),
  );
  return dated
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, CHAT_SESSION_LIMIT)
    .map(({ session }) => session);
}

/**
 * GG Coder's own sessions for this project plus any Claude Code / Codex
 * transcripts recorded against the same cwd.
 *
 * The project picker already surfaces those stores, so a project can appear
 * *because* it has Claude Code history and then show an empty session list.
 * Foreign rows close that gap; the app imports one on click and opens it.
 *
 * A foreign store being slow or unreadable must never empty the native list,
 * so its failure degrades to "no foreign rows".
 */
async function listCodingSessions(
  cwd: string,
  coderSessionsDir: string,
  homeDir?: string,
  worktreeCwds: readonly string[] = [],
): Promise<SidecarSession[]> {
  const [native, foreign] = await Promise.all([
    listRecentSessions(cwd, CODING_SESSION_LIMIT, coderSessionsDir, worktreeCwds),
    listForeignSessions(cwd, FOREIGN_SESSION_LIMIT, homeDir).catch(() => []),
  ]);
  // Native first: a session already resumable here beats one that needs an
  // import, even when the foreign transcript is a little newer.
  return [...native, ...foreign];
}
