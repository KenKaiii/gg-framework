import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatAgentSessionsDir } from "./chat-agents/index.js";
import { listSidecarSessions } from "./app-sidecar-sessions.js";
import { encodeCwd } from "./core/encode-cwd.js";
import { archiveColdSession, archiveSessionPath } from "./core/session-storage.js";

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
