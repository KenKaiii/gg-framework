import { mkdtemp, readFile, rm, utimes, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  KEN_TURN_CUSTOM_KIND,
  AUTOPILOT_MARKER_CUSTOM_KIND,
  type SessionEntry,
  type CustomEntry,
} from "./session-manager.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-session-manager-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function entry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hi" },
  };
}

describe("SessionManager persistence failure handling", () => {
  it("appendEntry does not throw when the write fails (e.g. disk full)", async () => {
    const manager = new SessionManager(await makeTempDir());
    const badPath = path.join("/nonexistent-gg-dir", "session.jsonl");

    const errors: NodeJS.ErrnoException[] = [];
    manager.onPersistError = (error) => errors.push(error);

    await expect(manager.appendEntry(badPath, entry("a"))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("ENOENT");
  });

  it("reports a persistence failure only once per error code", async () => {
    const manager = new SessionManager(await makeTempDir());
    const badPath = path.join("/nonexistent-gg-dir", "session.jsonl");

    let calls = 0;
    manager.onPersistError = () => {
      calls += 1;
    };

    await manager.appendEntry(badPath, entry("a"));
    await manager.appendEntry(badPath, entry("b"));
    await manager.updateLeaf(badPath, "leaf-1");
    expect(calls).toBe(1);
  });

  it("appendEntry still writes normally when the disk is healthy", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const created = await manager.create(sessionsDir, "anthropic", "test-model");

    await manager.appendEntry(created.path, entry("ok"));
    const content = await readFile(created.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ type: "message", id: "ok" });
  });
});

function kenEntry(id: string, data: unknown, kind: string = KEN_TURN_CUSTOM_KIND): CustomEntry {
  return { type: "custom", kind, id, parentId: null, timestamp: new Date().toISOString(), data };
}

describe("SessionManager.getKenTurns", () => {
  const manager = new SessionManager("/unused");

  it("reads valid Ken turns in file order", () => {
    const entries: SessionEntry[] = [
      kenEntry("k1", { version: 1, question: "what next?", reply: "do X", afterMessageCount: 0 }),
      entry("m1"),
      kenEntry("k2", { version: 1, question: "and now?", reply: "do Y", afterMessageCount: 1 }),
    ];
    const turns = manager.getKenTurns(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ question: "what next?", reply: "do X", afterMessageCount: 0 });
    expect(turns[1]).toMatchObject({ question: "and now?", reply: "do Y", afterMessageCount: 1 });
  });

  it("ignores message entries and other custom kinds", () => {
    const entries: SessionEntry[] = [
      entry("m1"),
      kenEntry("d1", { version: 1, item: { kind: "x", id: "y" } }, "display_item"),
      kenEntry("k1", { version: 1, question: "q", reply: "r", afterMessageCount: 2 }),
    ];
    expect(manager.getKenTurns(entries)).toHaveLength(1);
  });

  it("drops malformed Ken payloads (missing fields / wrong version)", () => {
    const entries: SessionEntry[] = [
      kenEntry("k1", { version: 2, question: "q", reply: "r" }),
      kenEntry("k2", { version: 1, question: "q" }),
      kenEntry("k3", { version: 1, reply: "r" }),
      kenEntry("k4", null),
      kenEntry("k5", { version: 1, question: "ok", reply: "good", afterMessageCount: 3 }),
    ];
    const turns = manager.getKenTurns(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ question: "ok", reply: "good", afterMessageCount: 3 });
  });

  it("defaults a missing afterMessageCount to 0", () => {
    const turns = manager.getKenTurns([kenEntry("k1", { version: 1, question: "q", reply: "r" })]);
    expect(turns[0]?.afterMessageCount).toBe(0);
  });

  it("round-trips Ken turns through a written session file", async () => {
    const sessionsDir = await makeTempDir();
    const manager2 = new SessionManager(sessionsDir);
    const created = await manager2.create(sessionsDir, "anthropic", "test-model");
    await manager2.appendEntry(created.path, entry("m1"));
    await manager2.appendEntry(
      created.path,
      kenEntry("k1", {
        version: 1,
        question: "persist me",
        reply: "persisted",
        afterMessageCount: 1,
      }),
    );
    const loaded = await manager2.load(created.path);
    // The Ken turn must NOT appear in the LLM message history.
    const msgs = manager2.getMessages(loaded.entries, loaded.header.leafId);
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain("persist me");
    // But it must be readable as a Ken turn.
    const turns = manager2.getKenTurns(loaded.entries);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ question: "persist me", reply: "persisted" });
  });
});

function autopilotEntry(
  id: string,
  data: unknown,
  kind: string = AUTOPILOT_MARKER_CUSTOM_KIND,
): CustomEntry {
  return { type: "custom", kind, id, parentId: null, timestamp: new Date().toISOString(), data };
}

describe("SessionManager.getAutopilotMarkers", () => {
  const manager = new SessionManager("/unused");

  it("reads valid autopilot markers in file order", () => {
    const entries: SessionEntry[] = [
      autopilotEntry("a1", { version: 1, phase: "prompted", body: "fix X", afterMessageCount: 0 }),
      entry("m1"),
      autopilotEntry("a2", { version: 1, phase: "done", afterMessageCount: 1 }),
    ];
    const markers = manager.getAutopilotMarkers(entries);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ phase: "prompted", body: "fix X", afterMessageCount: 0 });
    expect(markers[1]).toMatchObject({ phase: "done", afterMessageCount: 1 });
  });

  it("ignores message entries and other custom kinds", () => {
    const entries: SessionEntry[] = [
      entry("m1"),
      autopilotEntry("d1", { version: 1, item: { kind: "x", id: "y" } }, "display_item"),
      autopilotEntry("k1", { version: 1, question: "q", reply: "r" }, KEN_TURN_CUSTOM_KIND),
      autopilotEntry("a1", {
        version: 1,
        phase: "human",
        reason: "ambiguous",
        afterMessageCount: 2,
      }),
    ];
    expect(manager.getAutopilotMarkers(entries)).toHaveLength(1);
  });

  it("drops malformed autopilot payloads (bad version / unknown phase)", () => {
    const entries: SessionEntry[] = [
      autopilotEntry("a1", { version: 2, phase: "done" }),
      autopilotEntry("a2", { version: 1, phase: "unknown" }),
      autopilotEntry("a3", { version: 1 }),
      autopilotEntry("a4", null),
      autopilotEntry("a5", { version: 1, phase: "capped", afterMessageCount: 3 }),
    ];
    const markers = manager.getAutopilotMarkers(entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ phase: "capped", afterMessageCount: 3 });
  });

  it("defaults a missing afterMessageCount to 0", () => {
    const markers = manager.getAutopilotMarkers([
      autopilotEntry("a1", { version: 1, phase: "done" }),
    ]);
    expect(markers[0]?.afterMessageCount).toBe(0);
  });

  it("round-trips an autopilot marker through a written session file", async () => {
    const sessionsDir = await makeTempDir();
    const manager2 = new SessionManager(sessionsDir);
    const created = await manager2.create(sessionsDir, "anthropic", "test-model");
    await manager2.appendEntry(created.path, entry("m1"));
    await manager2.appendEntry(
      created.path,
      autopilotEntry("a1", {
        version: 1,
        phase: "human",
        reason: "needs a call",
        afterMessageCount: 1,
      }),
    );
    const loaded = await manager2.load(created.path);
    // The marker must NOT appear in the LLM message history.
    const msgs = manager2.getMessages(loaded.entries, loaded.header.leafId);
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain("needs a call");
    // But it must be readable as an autopilot marker.
    const markers = manager2.getAutopilotMarkers(loaded.entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ phase: "human", reason: "needs a call" });
  });
});

describe("SessionManager.getMostRecent", () => {
  it("returns the session most recently spoken in, not the newest-created", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const cwd = "/proj/continue";

    // Session A is created first, then session B (newer header timestamp).
    const sessionA = await manager.create(cwd, "anthropic", "test-model");
    await new Promise((r) => setTimeout(r, 5));
    const sessionB = await manager.create(cwd, "anthropic", "test-model");

    // We chat in B first, then send the LAST message to A.
    await manager.appendEntry(sessionB.path, entry("b-msg"));
    await new Promise((r) => setTimeout(r, 5));
    await manager.appendEntry(sessionA.path, entry("a-msg"));

    const mostRecent = await manager.getMostRecent(cwd);
    expect(mostRecent).toBe(sessionA.path);
  });
});

describe("SessionManager.pruneOldSessions", () => {
  async function makeAgedSession(
    manager: SessionManager,
    cwd: string,
    ageDays: number,
  ): Promise<string> {
    const created = await manager.create(cwd, "anthropic", "test-model");
    const past = new Date(Date.now() - ageDays * 86_400_000);
    await utimes(created.path, past, past);
    return created.path;
  }

  it("deletes sessions older than the retention window and keeps recent ones", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const oldPath = await makeAgedSession(manager, "/proj/a", 45);
    const recentPath = await makeAgedSession(manager, "/proj/a", 5);

    const result = await manager.pruneOldSessions({ maxAgeDays: 30 });

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(recentPath)).toBe(true);
  });

  it("never deletes paths listed in keepPaths, even when old", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const activePath = await makeAgedSession(manager, "/proj/b", 90);

    const result = await manager.pruneOldSessions({ maxAgeDays: 30, keepPaths: [activePath] });

    expect(result.deletedFiles).toBe(0);
    expect(existsSync(activePath)).toBe(true);
  });

  it("removes project dirs left empty and is a no-op when retention is 0", async () => {
    const sessionsDir = await makeTempDir();
    const manager = new SessionManager(sessionsDir);
    const oldPath = await makeAgedSession(manager, "/proj/c", 60);

    const disabled = await manager.pruneOldSessions({ maxAgeDays: 0 });
    expect(disabled.deletedFiles).toBe(0);
    expect(existsSync(oldPath)).toBe(true);

    await manager.pruneOldSessions({ maxAgeDays: 30 });
    expect(existsSync(oldPath)).toBe(false);
    expect(await readdir(sessionsDir)).toHaveLength(0);
  });
});
