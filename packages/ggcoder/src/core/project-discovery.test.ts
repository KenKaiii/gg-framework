import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../config.js";
import { encodeCwd } from "./encode-cwd.js";
import { discoverProjects, listRecentSessions } from "./project-discovery.js";
import { archiveColdSession, archiveSessionPath } from "./session-storage.js";

// Holder the hoisted mock reads at call time (vi.mock is hoisted above imports,
// so it can't close over a value assigned later without this indirection).
const state = { sessionsDir: "" };

vi.mock("../config.js", async (orig) => {
  const actual = await orig<typeof ConfigModule>();
  return {
    ...actual,
    getAppPaths: () => ({ ...actual.getAppPaths(), sessionsDir: state.sessionsDir }),
  };
});

/** Write a minimal ggcoder session file (header + one message) into `dir`. */
async function writeSession(dir: string, cwd: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const header = JSON.stringify({
    type: "session",
    version: 2,
    id: "11111111-1111-1111-1111-111111111111",
    timestamp: new Date().toISOString(),
    cwd,
    provider: "anthropic",
    model: "claude-sonnet-5",
  });
  const message = JSON.stringify({
    type: "message",
    id: "22222222-2222-2222-2222-222222222222",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hi" },
  });
  await fs.writeFile(path.join(dir, "session.jsonl"), `${header}\n${message}\n`, "utf-8");
}

async function writeSessionRecords(
  cwd: string,
  fileName: string,
  options: {
    id: string;
    conversationId?: string;
    preview?: string;
    timestamp: string;
    records: unknown[];
  },
): Promise<string> {
  const dir = path.join(state.sessionsDir, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const header = {
    type: "session",
    version: 2,
    id: options.id,
    conversationId: options.conversationId,
    preview: options.preview,
    timestamp: options.timestamp,
    cwd,
    provider: "anthropic",
    model: "claude-sonnet-5",
    leafId: null,
  };
  await fs.writeFile(
    file,
    [header, ...options.records].map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
  const modified = new Date(options.timestamp);
  await fs.utimes(file, modified, modified);
  return file;
}

describe("discoverProjects (ggcoder store)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-discovery-"));
    state.sessionsDir = path.join(tmp, ".gg", "sessions");
    await fs.mkdir(state.sessionsDir, { recursive: true });
    // Point Claude/Codex discovery at an empty home so they contribute nothing.
    vi.spyOn(os, "homedir").mockReturnValue(path.join(tmp, "home"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists a project whose folder name contains an underscore (regression)", async () => {
    // Real project path with a literal underscore — the lossy slash→underscore
    // decode would resolve this to `.../projects/my/app`, which doesn't exist,
    // so the project used to silently vanish from the picker.
    const projectPath = path.join(tmp, "projects", "my_app");
    await fs.mkdir(projectPath, { recursive: true });
    await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);

    const projects = await discoverProjects();

    const found = projects.find((p) => p.path === projectPath);
    expect(found).toBeDefined();
    expect(found?.name).toBe("my_app");
    expect(found?.sources).toContain("ggcoder");
    // The lossy decode must NOT surface as a phantom project.
    expect(projects.some((p) => p.path === path.join(tmp, "projects", "my", "app"))).toBe(false);
  });

  it("keys the project off the header cwd, not the directory name", async () => {
    // The real cwd lives in the session header; the directory name is only a
    // lossy hint. Prove the header wins by giving the dir an arbitrary name
    // (as happens for a copied/renamed session store) whose underscore-decode
    // would resolve somewhere else entirely — the project must still resolve to
    // the header's true underscore path.
    const projectPath = path.join(tmp, "projects", "my_app");
    await fs.mkdir(projectPath, { recursive: true });
    await writeSession(path.join(state.sessionsDir, "arbitrary-store-name"), projectPath);

    const projects = await discoverProjects();
    const found = projects.find((p) => p.path === projectPath);
    expect(found).toBeDefined();
    expect(found?.name).toBe("my_app");
    // The decode of "arbitrary-store-name" (an existing-looking rel path) must
    // not surface as its own phantom project.
    expect(projects.some((p) => p.path.endsWith("arbitrary-store-name"))).toBe(false);
  });

  it("lists recent sessions only from an explicit agent session root", async () => {
    const projectPath = path.join(tmp, "projects", "shared-root");
    const chatSessionsDir = path.join(tmp, ".gg", "chat-sessions", "general");
    await fs.mkdir(projectPath, { recursive: true });
    await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    await writeSession(path.join(chatSessionsDir, encodeCwd(projectPath)), projectPath);

    const coder = await listRecentSessions(projectPath);
    const chat = await listRecentSessions(projectPath, 5, chatSessionsDir);

    expect(coder).toHaveLength(1);
    expect(chat).toHaveLength(1);
    expect(coder[0]?.path.startsWith(state.sessionsDir)).toBe(true);
    expect(chat[0]?.path.startsWith(chatSessionsDir)).toBe(true);
  });

  it("skips compaction summaries and autopilot injections when choosing a preview", async () => {
    const projectPath = path.join(tmp, "projects", "clean-preview");
    await fs.mkdir(projectPath, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeSessionRecords(projectPath, "internal-prompts.jsonl", {
      id: "internal-prompts",
      timestamp,
      records: [
        {
          type: "message",
          timestamp,
          message: { role: "user", content: "[Previous conversation summary]\n### Goal" },
        },
        {
          type: "message",
          timestamp,
          message: {
            role: "user",
            content:
              "[Autopilot] This turn was triggered by Ken, GG Coder's automated reviewer — fix it",
          },
        },
        {
          type: "message",
          timestamp,
          message: { role: "user", content: "Keep the original project title" },
        },
      ],
    });

    const sessions = await listRecentSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.preview).toBe("Keep the original project title");
  });

  it("collapses compaction checkpoints and keeps a legacy saved label", async () => {
    const projectPath = path.join(tmp, "projects", "checkpoint-title");
    await fs.mkdir(projectPath, { recursive: true });
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    await writeSessionRecords(projectPath, "old.jsonl", {
      id: "old-session",
      conversationId: "conversation-root",
      timestamp: older,
      records: [
        {
          type: "message",
          timestamp: older,
          message: { role: "user", content: "A very long original request" },
        },
        { type: "label", timestamp: older, label: "Legacy session title" },
      ],
    });
    const newestPath = await writeSessionRecords(projectPath, "new.jsonl", {
      id: "new-checkpoint",
      conversationId: "conversation-root",
      timestamp: newer,
      records: [
        {
          type: "message",
          timestamp: newer,
          message: { role: "user", content: "[Previous conversation summary]\n### Goal" },
        },
        { type: "label", timestamp: newer, label: "Legacy session title" },
      ],
    });

    const sessions = await listRecentSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.path).toBe(newestPath);
    expect(sessions[0]?.preview).toBe("Legacy session title");
  });

  it("uses a checkpoint header preview when compacted messages contain only internal prompts", async () => {
    const projectPath = path.join(tmp, "projects", "checkpoint-preview");
    await fs.mkdir(projectPath, { recursive: true });
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    await writeSessionRecords(projectPath, "old.jsonl", {
      id: "old-session",
      conversationId: "conversation-root",
      timestamp: older,
      records: [
        {
          type: "message",
          timestamp: older,
          message: { role: "user", content: "Original user request" },
        },
      ],
    });
    const newestPath = await writeSessionRecords(projectPath, "new.jsonl", {
      id: "new-checkpoint",
      conversationId: "conversation-root",
      preview: "Original user request",
      timestamp: newer,
      records: [
        {
          type: "message",
          timestamp: newer,
          message: { role: "user", content: "[Previous conversation summary]\n### Goal" },
        },
      ],
    });

    const sessions = await listRecentSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.path).toBe(newestPath);
    expect(sessions[0]?.preview).toBe("Original user request");
  });

  it("discovers and deduplicates an archived GG Coder session", async () => {
    const projectPath = path.join(tmp, "projects", "archived");
    await fs.mkdir(projectPath, { recursive: true });
    const timestamp = new Date().toISOString();
    const plainPath = await writeSessionRecords(projectPath, "archived.jsonl", {
      id: "archived-session",
      timestamp,
      records: [
        {
          type: "message",
          id: "archived-message",
          parentId: null,
          timestamp,
          message: { role: "user", content: "Archived request" },
        },
      ],
    });
    await archiveColdSession(plainPath);
    const corruptArchive = path.join(path.dirname(plainPath), "newer-corrupt.jsonl.gz");
    await fs.writeFile(corruptArchive, Buffer.from([0x1f, 0x8b, 0x00, 0x01]));
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(corruptArchive, future, future);
    const sessions = await listRecentSessions(projectPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.path).toBe(archiveSessionPath(plainPath));
    expect(sessions[0]?.preview).toBe("Archived request");
    expect((await discoverProjects()).some((project) => project.path === projectPath)).toBe(true);
  });
  it("uses the first user prompt when a new session has no saved label", async () => {
    const projectPath = path.join(tmp, "projects", "prompt-preview");
    await fs.mkdir(projectPath, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeSessionRecords(projectPath, "unlabelled.jsonl", {
      id: "unlabelled-session",
      timestamp,
      records: [
        {
          type: "message",
          timestamp,
          message: { role: "user", content: "Replace title generation with project context" },
        },
        {
          type: "message",
          timestamp,
          message: { role: "assistant", content: "Done." },
        },
      ],
    });

    const sessions = await listRecentSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.preview).toBe("Replace title generation with project context");
  });

  // The best-effort decode only round-trips for underscore-free absolute paths
  // (that's the whole point of the header fix). macOS's own os.tmpdir() contains
  // a literal underscore, so this test roots its project under posix /tmp to get
  // an underscore-free path; skip on Windows where that root doesn't exist.
  it.skipIf(process.platform === "win32")(
    "falls back to underscore decode when a session file carries no cwd header",
    async () => {
      const root = await fs.mkdtemp("/tmp/ggfallback-");
      try {
        // Legacy/headerless session dir: no `type:"session"` line. The decode
        // still lists it as long as the decoded path exists on disk.
        const projectPath = path.join(root, "legacy");
        await fs.mkdir(projectPath, { recursive: true });
        const dir = path.join(state.sessionsDir, encodeCwd(projectPath));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "session.jsonl"),
          `${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`,
          "utf-8",
        );

        const projects = await discoverProjects();
        expect(projects.find((p) => p.path === projectPath)).toBeDefined();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
