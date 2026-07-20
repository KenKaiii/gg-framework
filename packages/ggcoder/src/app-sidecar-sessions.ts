import fs from "node:fs/promises";

import {
  CHAT_AGENT_IDS,
  chatAgentSessionsDir,
  sessionsDirForChatAgent,
  type ChatAgentId,
} from "./chat-agents/index.js";
import { listRecentSessions, type RecentSession } from "./core/project-discovery.js";

const CODING_SESSION_LIMIT = 5;
const CHAT_SESSION_LIMIT = 30;

export type SidecarSession = RecentSession & { chatAgent?: ChatAgentId };

/** List coding or chat sessions using the caps exposed by the gg-app sidecar. */
export async function listSidecarSessions(
  cwd: string,
  requestedAgent: string | null,
  coderSessionsDir: string,
): Promise<SidecarSession[]> {
  if (requestedAgent !== "all") {
    const sessionsDir = requestedAgent
      ? sessionsDirForChatAgent(coderSessionsDir, requestedAgent)
      : coderSessionsDir;
    const sessionLimit = requestedAgent ? CHAT_SESSION_LIMIT : CODING_SESSION_LIMIT;
    return listRecentSessions(cwd, sessionLimit, sessionsDir);
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
