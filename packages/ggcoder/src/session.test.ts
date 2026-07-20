import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  getMostRecentSession,
  listSessions,
  loadSession,
  persistMessage,
} from "./session.js";
import { archiveColdSession, archiveSessionPath } from "./core/session-storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("legacy session API storage delegation", () => {
  it("lists and resumes compressed v2 storage through stale plain and archive paths", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "gg-legacy-session-"));
    tempDirs.push(sessionsDir);
    const cwd = "/project/legacy-api";
    const session = await createSession(cwd, "anthropic", "test-model", sessionsDir);
    await persistMessage(session, { role: "user", content: "legacy request" });
    await persistMessage(session, { role: "assistant", content: "legacy response" });
    await archiveColdSession(session.path);

    const listed = await listSessions(cwd, sessionsDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe(archiveSessionPath(session.path));
    expect(await getMostRecentSession(cwd, sessionsDir)).toBe(archiveSessionPath(session.path));

    const stalePlain = await loadSession(session.path, sessionsDir);
    expect(stalePlain.header).toMatchObject({ version: 1, id: session.id, cwd });
    expect(stalePlain.messages).toEqual([
      { role: "user", content: "legacy request" },
      { role: "assistant", content: "legacy response" },
    ]);

    const staleArchive = await loadSession(archiveSessionPath(session.path), sessionsDir);
    expect(staleArchive.header.id).toBe(session.id);
    expect(staleArchive.messages).toHaveLength(2);
  });
});
