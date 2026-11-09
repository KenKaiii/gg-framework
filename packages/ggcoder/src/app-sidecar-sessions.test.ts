import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHAT_FOLDER_NAME, chatAgentSessionsDir } from "./chat-agents/index.js";
import { listSidecarSessions } from "./app-sidecar-sessions.js";
import { motionSessionsDir } from "./motion-agent/motion-agent.js";
import { encodeCwd } from "./core/encode-cwd.js";
import { archiveColdSession, archiveSessionPath } from "./core/session-storage.js";
import { importForeignSession } from "./core/foreign-session-import.js";
import { SessionManager } from "./core/session-manager.js";

/**
 * Write a Claude Code transcript into a fixture `~/.claude/projects` dir.
 * Claude's directory encoding is ambiguous, so the cwd it records inside the
 * records — not the folder name — is what discovery matches on.
 */
async function writeClaudeTranscript(
  homeDir: string,
  cwd: string,
  sessionId: string,
  prompt: string,
): Promise<string> {
  // The folder name is deliberately only *shaped* like Claude's encoding: since
  // discovery reads the cwd out of the records, the exact name is irrelevant to
  // what these tests assert. It does have to be a VALID single directory name on
  // the host though — collapsing only "/" left Windows paths as `-C:\Users\...`,
  // whose drive colon and backslashes made `mkdir` fail with ENOENT. Fold both
  // separators and the drive colon into dashes so the fixture is portable.
  const encoded = `-${cwd.replace(/[\\/:]/g, "-")}`;
  const projectDir = path.join(homeDir, ".claude", "projects", encoded);
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const stamp = new Date().toISOString();
  const records = [
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      uuid: "u1",
      timestamp: stamp,
      cwd,
      message: { role: "user", content: prompt },
    },
    {
      parentUuid: "u1",
      isSidechain: false,
      type: "assistant",
      uuid: "a1",
      timestamp: stamp,
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
    },
  ];
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

async function writeSessions(
  sessionsRoot: string,
  cwd: string,
  prefix: string,
  count: number,
): Promise<void> {
  const projectSessionsDir = path.join(sessionsRoot, encodeCwd(cwd));
  await fs.mkdir(projectSessionsDir, { recursive: true });

  for (let index = 0; index < count; index++) {
    const timestamp = new Date(Date.now() + index * 1_000).toISOString();
    const file = path.join(projectSessionsDir, `${prefix}-${index}.jsonl`);
    const records = [
      {
        type: "session",
        version: 2,
        id: `${prefix}-${index}`,
        conversationId: `${prefix}-${index}`,
        timestamp,
        cwd,
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
      {
        type: "message",
        id: `${prefix}-message-${index}`,
        timestamp,
        message: { role: "user", content: `Session ${index}` },
      },
    ];
    await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const modified = new Date(timestamp);
    await fs.utimes(file, modified, modified);
  }
}

describe("gg-app sidecar session listings", () => {
  let tmp: string;
  let cwd: string;
  let coderSessionsDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-sidecar-sessions-"));
    cwd = path.join(tmp, "project");
    coderSessionsDir = path.join(tmp, "sessions");
    await fs.mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns up to 30 chat sessions while coding remains capped at 5", async () => {
    await writeSessions(coderSessionsDir, cwd, "coding", 31);
    await writeSessions(chatAgentSessionsDir(coderSessionsDir, "general"), cwd, "chat", 31);

    const codingSessions = await listSidecarSessions(cwd, null, coderSessionsDir);
    const chatSessions = await listSidecarSessions(cwd, "all", coderSessionsDir);

    expect(codingSessions).toHaveLength(5);
    expect(codingSessions.map((session) => session.id)).toEqual([
      "coding-30",
      "coding-29",
      "coding-28",
      "coding-27",
      "coding-26",
    ]);
    expect(chatSessions).toHaveLength(30);
    expect(chatSessions[0]).toMatchObject({ id: "chat-30", chatAgent: "general" });
    expect(chatSessions.at(-1)).toMatchObject({ id: "chat-1", chatAgent: "general" });
  });

  it("surfaces a Claude Code session for the project and opens it as a resumable GG Coder session", async () => {
    const home = path.join(tmp, "home");
    const transcript = await writeClaudeTranscript(
      home,
      cwd,
      "cc-session-1",
      "Add a retry to the fetch helper.",
    );

    // 1. It shows up in the session list, tagged with where it came from.
    const sessions = await listSidecarSessions(cwd, null, coderSessionsDir, home);
    const foreign = sessions.find((session) => session.source === "claude-code");
    expect(foreign).toBeDefined();
    expect(foreign?.path).toBe(transcript);
    expect(foreign?.preview).toBe("Add a retry to the fetch helper.");
    expect(foreign?.messageCount).toBe(2);

    // 2. Clicking it (import-then-open) yields a real, loadable GG Coder session.
    const sessionManager = new SessionManager(coderSessionsDir);
    const imported = await importForeignSession({
      filePath: foreign!.path,
      sessionManager,
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd,
    });
    const loaded = await sessionManager.load(imported.sessionPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.header.cwd).toBe(cwd);
    expect(
      sessionManager.getMessages(loaded!.entries, loaded!.header.leafId).map((m) => m.role),
    ).toEqual(["user", "assistant"]);

    // 3. It now also appears as a NATIVE row, so the next open skips the import.
    const after = await listSidecarSessions(cwd, null, coderSessionsDir, home);
    const native = after.find((session) => session.path === imported.sessionPath);
    expect(native).toBeDefined();
    expect(native?.source).toBeUndefined();
  });

  it("keeps native sessions listed ahead of foreign ones", async () => {
    const home = path.join(tmp, "home");
    await writeClaudeTranscript(home, cwd, "cc-session-2", "Foreign prompt.");
    await writeSessions(coderSessionsDir, cwd, "coding", 2);

    const sessions = await listSidecarSessions(cwd, null, coderSessionsDir, home);
    const firstForeignIndex = sessions.findIndex((session) => session.source === "claude-code");
    const lastNativeIndex = sessions.map((session) => session.source).lastIndexOf(undefined);
    expect(firstForeignIndex).toBeGreaterThan(-1);
    expect(firstForeignIndex).toBeGreaterThan(lastNativeIndex);
  });

  it("ignores a Claude Code session recorded against a different project", async () => {
    const home = path.join(tmp, "home");
    const otherCwd = path.join(tmp, "other-project");
    await fs.mkdir(otherCwd, { recursive: true });
    await writeClaudeTranscript(home, otherCwd, "cc-elsewhere", "Not this project.");

    const sessions = await listSidecarSessions(cwd, null, coderSessionsDir, home);
    expect(sessions.some((session) => session.source === "claude-code")).toBe(false);
  });

  it("lists only Motion's own sessions for the motion query", async () => {
    await writeSessions(coderSessionsDir, cwd, "coding", 2);
    await writeSessions(chatAgentSessionsDir(coderSessionsDir, "general"), cwd, "chat", 2);
    await writeSessions(motionSessionsDir(coderSessionsDir), cwd, "motion", 3);

    const motionSessions = await listSidecarSessions(cwd, "motion", coderSessionsDir);
    const chatSessions = await listSidecarSessions(cwd, "all", coderSessionsDir);

    expect(motionSessions.map((session) => session.id)).toEqual([
      "motion-2",
      "motion-1",
      "motion-0",
    ]);
    expect(chatSessions.some((session) => session.id.startsWith("motion"))).toBe(false);
  });

  it("lists chats saved in the GG Chat folder alongside older ones saved against the projects root", async () => {
    const chatRoot = chatAgentSessionsDir(coderSessionsDir, "general");
    const chatFolder = path.join(cwd, CHAT_FOLDER_NAME);
    await writeSessions(chatRoot, cwd, "legacy", 1);
    await writeSessions(chatRoot, chatFolder, "current", 1);

    const all = await listSidecarSessions(chatFolder, "all", coderSessionsDir);
    const general = await listSidecarSessions(chatFolder, "general", coderSessionsDir);
    const legacyRoot = await listSidecarSessions(cwd, "all", coderSessionsDir);

    expect(all.map((session) => session.id).sort()).toEqual(["current-0", "legacy-0"]);
    expect(general.map((session) => session.id).sort()).toEqual(["current-0", "legacy-0"]);
    expect(legacyRoot.map((session) => session.id)).toEqual(["legacy-0"]);
  });

  it("does not mix foreign sessions into a chat-agent listing", async () => {
    const home = path.join(tmp, "home");
    await writeClaudeTranscript(home, cwd, "cc-session-3", "Foreign prompt.");

    const chatSessions = await listSidecarSessions(cwd, "general", coderSessionsDir, home);
    expect(chatSessions.some((session) => session.source === "claude-code")).toBe(false);
  });

  it("lists archived coding and chat sessions once despite their redirect counterparts", async () => {
    const chatRoot = chatAgentSessionsDir(coderSessionsDir, "general");
    await writeSessions(coderSessionsDir, cwd, "coding-archive", 1);
    await writeSessions(chatRoot, cwd, "chat-archive", 1);
    const codingPlain = path.join(coderSessionsDir, encodeCwd(cwd), "coding-archive-0.jsonl");
    const chatPlain = path.join(chatRoot, encodeCwd(cwd), "chat-archive-0.jsonl");
    await Promise.all([archiveColdSession(codingPlain), archiveColdSession(chatPlain)]);

    const codingSessions = await listSidecarSessions(cwd, null, coderSessionsDir);
    const chatSessions = await listSidecarSessions(cwd, "general", coderSessionsDir);
    expect(codingSessions).toHaveLength(1);
    expect(codingSessions[0]?.path).toBe(archiveSessionPath(codingPlain));
    expect(chatSessions).toHaveLength(1);
    expect(chatSessions[0]?.path).toBe(archiveSessionPath(chatPlain));
  });
});
