import crypto from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type MessageEntry, type SessionEntry } from "./session-manager.js";
import {
  archiveColdSession,
  hydrateSessionEntry,
  openSessionReadStream,
  resolveSessionPath,
} from "./session-storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function message(message: MessageEntry["message"], timestamp: string): MessageEntry {
  return { type: "message", id: crypto.randomUUID(), parentId: null, timestamp, message };
}

/** The pre-optimization loader: hydrates every line. */
async function referenceEntries(sessionPath: string): Promise<SessionEntry[]> {
  const effective = await resolveSessionPath(sessionPath);
  const { stream, close } = await openSessionReadStream(effective);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const entries: SessionEntry[] = [];
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string };
        if (parsed.type === "session") continue;
        entries.push(await hydrateSessionEntry(parsed as SessionEntry, effective));
      } catch {
        // malformed
      }
    }
  } finally {
    rl.close();
    close();
  }
  return entries;
}

async function fixture(): Promise<{ manager: SessionManager; root: string; sessionPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "gg-session-equiv-"));
  tempDirs.push(root);
  const manager = new SessionManager(root);
  const created = await manager.create("/project/equiv", "anthropic", "test-model");
  const png = Buffer.from("equivalence-asset").toString("base64");
  await manager.appendEntry(
    created.path,
    message(
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: png },
        ],
      },
      "2026-01-01T00:00:01.000Z",
    ),
  );
  await manager.appendEntry(
    created.path,
    message(
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      "2026-01-01T00:00:02.000Z",
    ),
  );
  await manager.appendEntry(
    created.path,
    message(
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "t1",
            content: [{ type: "image", mediaType: "image/png", data: png }],
          },
        ],
      } as unknown as MessageEntry["message"],
      "2026-01-01T00:00:03.000Z",
    ),
  );
  await manager.appendEntry(created.path, {
    type: "custom",
    kind: "verification_state",
    data: { ok: true },
    timestamp: "2026-01-01T00:00:04.000Z",
  } as unknown as SessionEntry);
  await appendFile(created.path, "{not json\n");
  return { manager, root, sessionPath: created.path };
}

describe("session load equivalence (old vs optimized)", () => {
  it("loads identical entries for plain sessions with .assets", async () => {
    const { manager, sessionPath } = await fixture();
    const loaded = await manager.load(sessionPath);
    expect(loaded.entries).toEqual(await referenceEntries(sessionPath));
    expect(JSON.stringify(loaded.entries)).toContain(
      Buffer.from("equivalence-asset").toString("base64"),
    );
  });

  it("loads identical entries through a gg_session_redirect stub to a .jsonl.gz", async () => {
    const { manager, sessionPath } = await fixture();
    await archiveColdSession(sessionPath);
    const before = await referenceEntries(sessionPath);
    const chain = await manager.loadCheckpointChain(sessionPath);
    expect(chain.at(-1)?.entries).toEqual(before);
    expect((await manager.load(sessionPath)).entries).toEqual(before);
  });

  it("list()/getMostRecent() are identical cold and when served from the info index", async () => {
    const { manager, root } = await fixture();
    const cold = await manager.list("/project/equiv");
    expect(cold[0]?.messageCount).toBe(3);
    expect(cold[0]?.lastActivity).toBe("2026-01-01T00:00:03.000Z");
    const fresh = new SessionManager(root);
    expect(await fresh.list("/project/equiv")).toEqual(cold);
    expect(await fresh.getMostRecent("/project/equiv")).toBe(cold[0]?.path);
  });
});
