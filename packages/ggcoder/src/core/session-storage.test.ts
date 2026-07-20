import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCwd } from "./encode-cwd.js";
import { SessionManager, type CustomEntry, type MessageEntry } from "./session-manager.js";
import {
  archiveColdSession,
  archiveSessionPath,
  MAX_PERSISTED_TOOL_TEXT_CHARS,
  openSessionReadStream,
  plainSessionPath,
  resolveSessionPath,
  sessionAssetDir,
  SESSION_TEMP_MARKER,
} from "./session-storage.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-session-storage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function messageEntry(message: MessageEntry["message"], id = crypto.randomUUID()): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
}

async function streamText(filePath: string): Promise<string> {
  const { stream } = await openSessionReadStream(filePath);
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

describe("session entry storage normalization", () => {
  it("bounds persisted tool text to 40KB while leaving the live message unchanged", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const created = await manager.create("/project/tool-text", "anthropic", "test-model");
    const fullText = `${"head".repeat(8_000)}${"tail".repeat(8_000)}`;
    const entry = messageEntry({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "tool-1", content: fullText }],
    });

    await manager.appendEntry(created.path, entry);

    expect((entry.message as { content: { content: string }[] }).content[0]!.content).toBe(
      fullText,
    );
    const persisted = JSON.parse((await readFile(created.path, "utf8")).trim().split("\n")[1]!) as {
      message: { content: { content: string }[] };
    };
    const storedText = persisted.message.content[0]!.content;
    expect(storedText).toHaveLength(MAX_PERSISTED_TOOL_TEXT_CHARS);
    expect(storedText).toContain("Session storage truncated this tool result");
    expect(storedText.startsWith(fullText.slice(0, 100))).toBe(true);
    expect(storedText.endsWith(fullText.slice(-100))).toBe(true);
  });

  it("omits path-backed tool media without duplicating its base64", async () => {
    const root = await makeTempDir();
    const sourcePath = path.join(root, "source.png");
    await writeFile(sourcePath, Buffer.from("durable-image"));
    const manager = new SessionManager(root);
    const created = await manager.create("/project/path-media", "anthropic", "test-model");
    const base64 = Buffer.from("duplicated-image").toString("base64");

    await manager.appendEntry(
      created.path,
      messageEntry({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "read-1",
            content: [
              { type: "text", text: `Read image file ${sourcePath} [image/png]` },
              { type: "image", mediaType: "image/png", data: base64 },
            ],
          },
        ],
      }),
    );

    const raw = await readFile(created.path, "utf8");
    expect(raw).not.toContain(base64);
    expect(raw).toContain(sourcePath);
    expect(existsSync(sessionAssetDir(created.path))).toBe(false);
    const loaded = await manager.load(created.path);
    const toolMessage = manager.getMessages(loaded.entries)[0] as {
      role: "tool";
      content: { content: { type: string; text?: string }[] }[];
    };
    expect(toolMessage.content[0]!.content.some((block) => block.type === "image")).toBe(false);
    expect(toolMessage.content[0]!.content.at(-1)?.text).toContain("read the source again");
  });

  it("externalizes reusable media assets, hydrates exact bytes, and degrades missing assets", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const created = await manager.create("/project/assets", "gemini", "test-model");
    const mediaBytes = Buffer.from("same-media-content");
    const base64 = mediaBytes.toString("base64");

    await manager.appendEntry(
      created.path,
      messageEntry({
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: base64 }],
      }),
    );
    await manager.appendEntry(
      created.path,
      messageEntry({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "pathless",
            content: [{ type: "image", mediaType: "image/png", data: base64 }],
          },
        ],
      }),
    );

    const assets = await readdir(sessionAssetDir(created.path));
    expect(assets).toEqual([crypto.createHash("sha256").update(mediaBytes).digest("hex")]);
    const raw = await readFile(created.path, "utf8");
    expect(raw).not.toContain(base64);
    expect(raw).toContain("gg-session-asset:v1:");

    const loaded = await manager.load(created.path);
    const messages = manager.getMessages(loaded.entries);
    expect((messages[0] as { content: { data: string }[] }).content[0]!.data).toBe(base64);
    expect(
      (messages[1] as { content: { content: { data: string }[] }[] }).content[0]!.content[0]!.data,
    ).toBe(base64);

    await unlink(path.join(sessionAssetDir(created.path), assets[0]!));
    const missing = await manager.load(created.path);
    const missingUser = manager.getMessages(missing.entries)[0] as {
      content: { type: string; text?: string }[];
    };
    expect(missingUser.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("unavailable") }),
    ]);
  });

  it("suppresses newly appended legacy display projections", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const created = await manager.create("/project/display", "anthropic", "test-model");
    const display: CustomEntry = {
      type: "custom",
      kind: "display_item",
      data: { version: 1, item: { id: "row", kind: "assistant", text: "duplicate" } },
      id: "display-row",
      parentId: null,
      timestamp: new Date().toISOString(),
    };
    await manager.appendEntry(created.path, display);
    expect((await readFile(created.path, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("cold session archive safety", () => {
  it("normalizes and compresses cold JSONL, preserves mtime, dedupes listing, and resumes through both paths", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const cwd = "/project/archive";
    const created = await manager.create(cwd, "anthropic", "test-model");
    await manager.appendEntry(
      created.path,
      messageEntry({ role: "user", content: "hello archive" }),
    );
    const display: CustomEntry = {
      type: "custom",
      kind: "display_item",
      data: { version: 1, item: { id: "legacy", kind: "assistant" } },
      id: "legacy-display",
      parentId: null,
      timestamp: new Date().toISOString(),
    };
    await writeFile(created.path, `${JSON.stringify(display)}\nmalformed legacy line\n`, {
      flag: "a",
    });
    const oldTime = new Date(Date.now() - 10 * 86_400_000);
    await utimes(created.path, oldTime, oldTime);

    const archived = await archiveColdSession(created.path);
    const archivePath = archiveSessionPath(created.path);
    expect(archived.archived).toBe(true);
    expect(archived.removedDisplayItems).toBe(1);
    expect(await resolveSessionPath(created.path)).toBe(archivePath);
    expect(Math.abs((await stat(archivePath)).mtimeMs - oldTime.getTime())).toBeLessThan(2_000);
    const compressedText = gunzipSync(await readFile(archivePath)).toString("utf8");
    expect(compressedText).not.toContain("display_item");
    expect(compressedText).toContain("malformed legacy line");

    const listed = await manager.list(cwd);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.path).toBe(archivePath);

    const fromStalePlainPath = await manager.load(created.path);
    expect(fromStalePlainPath.path).toBe(created.path);
    expect(manager.getMessages(fromStalePlainPath.entries)[0]).toMatchObject({
      content: "hello archive",
    });
    expect(plainSessionPath(await resolveSessionPath(archivePath))).toBe(created.path);

    const fromStaleArchivePath = await manager.load(archivePath);
    expect(fromStaleArchivePath.path).toBe(created.path);
    expect(fromStaleArchivePath.header.id).toBe(created.id);
  });

  it("never swaps an archive over a source that changes during compression and cleans partial temps", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const created = await manager.create("/project/race", "anthropic", "test-model");
    const incompressible = crypto.randomBytes(12 * 1024 * 1024).toString("base64");
    await writeFile(created.path, `${incompressible}\n`, { flag: "a" });

    const archiving = archiveColdSession(created.path);
    const directory = path.dirname(created.path);
    let sawTemp = false;
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if ((await readdir(directory)).some((name) => name.includes(SESSION_TEMP_MARKER))) {
        sawTemp = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(sawTemp).toBe(true);
    await writeFile(created.path, "changed-during-archive\n", { flag: "a" });
    await expect(archiving).rejects.toThrow("changed while archiving");

    expect(await resolveSessionPath(created.path)).toBe(created.path);
    expect(await readFile(created.path, "utf8")).toContain("changed-during-archive");
    expect(existsSync(archiveSessionPath(created.path))).toBe(false);
    expect((await readdir(directory)).some((name) => name.includes(SESSION_TEMP_MARKER))).toBe(
      false,
    );
  });

  it("ignores partial maintenance files in listing and removes old ones during maintenance", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const cwd = "/project/partial";
    const created = await manager.create(cwd, "anthropic", "test-model");
    await manager.appendEntry(created.path, messageEntry({ role: "user", content: "kept" }));
    const partial = path.join(root, encodeCwd(cwd), `orphan.jsonl${SESSION_TEMP_MARKER}123`);
    await writeFile(partial, "partial gzip bytes");
    const oldTime = new Date(Date.now() - 2 * 86_400_000);
    await utimes(partial, oldTime, oldTime);

    expect(await manager.list(cwd)).toHaveLength(1);
    const metrics = await manager.runMaintenance({ retentionDays: 30 });
    expect(metrics.deletedFiles).toBe(1);
    expect(existsSync(partial)).toBe(false);
  });

  it("reads a retained gzip stream without thawing when only discovery is needed", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const created = await manager.create("/project/read", "anthropic", "test-model");
    await manager.appendEntry(created.path, messageEntry({ role: "user", content: "stream me" }));
    await archiveColdSession(created.path);
    expect(await streamText(created.path)).toContain("stream me");
    expect(await resolveSessionPath(created.path)).toBe(archiveSessionPath(created.path));
  });
});

describe("logical retention", () => {
  it("deletes plain/archive redirects and adjacent assets as one logical session", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const created = await manager.create("/project/retention", "gemini", "test-model");
    await manager.appendEntry(
      created.path,
      messageEntry({
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            data: Buffer.from("retained-asset").toString("base64"),
          },
        ],
      }),
    );
    const oldTime = new Date(Date.now() - 45 * 86_400_000);
    await utimes(created.path, oldTime, oldTime);
    await archiveColdSession(created.path);

    const result = await manager.pruneOldSessions({ maxAgeDays: 30 });
    expect(result.deletedFiles).toBeGreaterThanOrEqual(3);
    expect(existsSync(created.path)).toBe(false);
    expect(existsSync(archiveSessionPath(created.path))).toBe(false);
    expect(existsSync(sessionAssetDir(created.path))).toBe(false);
  });

  it("protects registered active sessions and explicit keep paths", async () => {
    const root = await makeTempDir();
    const manager = new SessionManager(root);
    const active = await manager.create("/project/protected", "anthropic", "test-model");
    const explicit = await manager.create("/project/protected", "anthropic", "test-model");
    const oldTime = new Date(Date.now() - 90 * 86_400_000);
    await Promise.all([
      utimes(active.path, oldTime, oldTime),
      utimes(explicit.path, oldTime, oldTime),
    ]);
    manager.registerActivePath(active.path);

    const result = await manager.pruneOldSessions({ maxAgeDays: 30, keepPaths: [explicit.path] });
    expect(result.deletedFiles).toBe(0);
    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(explicit.path)).toBe(true);
    manager.unregisterActivePath(active.path);
  });
});
