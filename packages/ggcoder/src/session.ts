import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import type { SessionHeader, SessionMessageEntry, SessionEntry, SessionInfo } from "./types.js";
import {
  SessionManager,
  type MessageEntry as ManagedMessageEntry,
} from "./core/session-manager.js";

const SESSION_DIR = path.join(os.homedir(), ".gg", "sessions");
const sessionManager = new SessionManager(SESSION_DIR);

// ── Create Session ──────────────────────────────────────────

export interface Session {
  id: string;
  path: string;
  append(entry: SessionEntry): Promise<void>;
}

export async function createSession(
  cwd: string,
  provider: string,
  model: string,
  sessionsDir = SESSION_DIR,
): Promise<Session> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  const created = await manager.create(cwd, provider as Provider, model);
  return {
    id: created.id,
    path: created.path,
    async append(entry: SessionEntry) {
      if (entry.type !== "message") return;
      const managedEntry: ManagedMessageEntry = {
        type: "message",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: entry.timestamp,
        message: entry.message,
      };
      await manager.appendEntry(created.path, managedEntry);
    },
  };
}

// ── Load Session ────────────────────────────────────────────

export async function loadSession(
  sessionPath: string,
  sessionsDir = SESSION_DIR,
): Promise<{ header: SessionHeader; messages: Message[] }> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  const loaded = await manager.load(sessionPath);
  const header: SessionHeader = {
    type: "session",
    version: 1,
    id: loaded.header.id,
    timestamp: loaded.header.timestamp,
    cwd: loaded.header.cwd,
    provider: loaded.header.provider,
    model: loaded.header.model,
  };
  return {
    header,
    messages: manager.getMessages(loaded.entries, loaded.header.leafId),
  };
}

// ── List Sessions ───────────────────────────────────────────

export async function listSessions(cwd: string, sessionsDir = SESSION_DIR): Promise<SessionInfo[]> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.list(cwd);
}

// ── Get Most Recent Session ─────────────────────────────────

export async function getMostRecentSession(
  cwd: string,
  sessionsDir = SESSION_DIR,
): Promise<string | null> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.getMostRecent(cwd);
}

// ── Persist Messages ────────────────────────────────────────

export function persistMessage(session: Session, message: Message): Promise<void> {
  const entry: SessionMessageEntry = {
    type: "message",
    timestamp: new Date().toISOString(),
    message,
  };
  return session.append(entry);
}
