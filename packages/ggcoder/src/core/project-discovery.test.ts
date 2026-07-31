import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../config.js";
import { encodeCwd } from "./encode-cwd.js";
import {
  discoverProjects,
  discoverProjectsRootFolders,
  discoveryPathKey,
  isAbsoluteCwd,
  listRecentSessions,
  mergeDiscoveredProjects,
  type DiscoveredProject,
} from "./project-discovery.js";
import { SessionManager } from "./session-manager.js";
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

  it("lists direct child folders without session history and excludes files", async () => {
    const root = path.join(tmp, "projects");
    const child = path.join(root, "never-opened");
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(path.join(root, "notes.txt"), "not a project");

    const projects = await discoverProjectsRootFolders(root);

    expect(projects.map((project) => project.path)).toEqual([path.resolve(child)]);
    expect(projects[0]?.sources).toEqual(["ggcoder"]);
  });

  it("returns no root projects for a missing or blank root", async () => {
    await expect(discoverProjectsRootFolders(path.join(tmp, "missing"))).resolves.toEqual([]);
    await expect(discoverProjectsRootFolders("   ")).resolves.toEqual([]);
  });

  it("collapses normalized duplicates, merges sources, and sorts newest first", () => {
    const duplicate = path.join(tmp, "projects", "Alpha");
    const older: DiscoveredProject = {
      name: "Alpha",
      path: duplicate,
      lastActiveMs: 10,
      lastActiveDisplay: "old",
      sources: ["ggcoder"],
    };
    const history: DiscoveredProject = {
      ...older,
      path: path.join(duplicate, ".", "..", "Alpha"),
      lastActiveMs: 30,
      sources: ["claude-code"],
    };
    const newest: DiscoveredProject = {
      name: "Beta",
      path: path.join(tmp, "projects", "Beta"),
      lastActiveMs: 50,
      lastActiveDisplay: "new",
      sources: ["codex"],
    };

    const merged = mergeDiscoveredProjects([older, history, newest], "linux");

    expect(merged).toHaveLength(2);
    expect(merged.map((project) => project.name)).toEqual(["Beta", "Alpha"]);
    expect(merged[1]?.lastActiveMs).toBe(30);
    expect(merged[1]?.sources).toEqual(["ggcoder", "claude-code"]);
  });

  it("uses a case-insensitive resolved comparison key on Windows", () => {
    const mixed = path.join(tmp, "Projects", "Alpha");
    expect(discoveryPathKey(mixed, "win32")).toBe(path.resolve(mixed).toLowerCase());
    expect(discoveryPathKey(mixed, "linux")).toBe(path.resolve(mixed));
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

  // Windows regression: the cwd extractors used to accept only POSIX absolute
  // paths (`startsWith("/")`), so every `C:\…` header was rejected, discovery
  // fell through to the lossy directory-name decode, and the project vanished
  // from the picker. Runs on every platform — the header guard is under test.
  it("accepts a Windows-style absolute cwd header", async () => {
    const projectPath = path.join(tmp, "projects", "winapp");
    await fs.mkdir(projectPath, { recursive: true });
    await writeSession(path.join(state.sessionsDir, "C_Users_dev_winapp"), projectPath);

    // The guard itself must accept every absolute form we can be handed.
    expect(isAbsoluteCwd("C:\\Users\\dev\\winapp")).toBe(true);
    expect(isAbsoluteCwd("c:/Users/dev/winapp")).toBe(true);
    expect(isAbsoluteCwd("\\\\server\\share\\winapp")).toBe(true);
    expect(isAbsoluteCwd("/Users/dev/winapp")).toBe(true);
    expect(isAbsoluteCwd("relative/winapp")).toBe(false);

    const projects = await discoverProjects();
    expect(projects.find((p) => p.path === projectPath)).toBeDefined();
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

/**
 * REAL Windows round-trip — runs only on an actual Windows host (the CI
 * `windows-latest` matrix leg), skipped everywhere else.
 *
 * Every other test in this file fakes Windows by feeding in `C:\…` strings on a
 * POSIX host, which cannot catch the class of bug that actually bit users: the
 * cwd the OS hands us, the folder name `encodeCwd` derives from it, and the
 * path discovery reconstructs must agree on a REAL filesystem with real drive
 * letters, real backslashes, and case-insensitive lookups. This drives the
 * genuine writer (`SessionManager.create`) rather than hand-written JSON, so
 * the write side and the read side are proven against each other.
 */
describe.skipIf(process.platform !== "win32")("real Windows session round-trip", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-win-rt-"));
    state.sessionsDir = path.join(tmp, ".gg", "sessions");
    await fs.mkdir(state.sessionsDir, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(path.join(tmp, "home"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("a session written by SessionManager is discoverable at its real C:\\ path", async () => {
    const projectPath = path.join(tmp, "projects", "win-app");
    await fs.mkdir(projectPath, { recursive: true });

    // Sanity-check the premise: on Windows this really is a drive-letter path.
    expect(projectPath).toMatch(/^[A-Za-z]:\\/);

    const manager = new SessionManager(state.sessionsDir);
    const created = await manager.create(projectPath, "anthropic", "claude-sonnet-5", {
      preview: "windows round trip",
    });
    // listRecentSessions deliberately skips header-only sessions, so a real
    // session needs at least one message to be resumable from the picker.
    await manager.appendEntry(created.path, {
      type: "message",
      id: "33333333-3333-3333-3333-333333333333",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hi" },
    });
    // The real writer must have produced a folder name with no illegal
    // characters — a stray `:` or `\` here is an ENOENT at session-create time.
    expect(path.dirname(created.path)).toBe(path.join(state.sessionsDir, encodeCwd(projectPath)));
    expect(path.basename(path.dirname(created.path))).not.toMatch(/[<>:"|?*\\/]/);

    const projects = await discoverProjects();
    const found = projects.find((p) => p.path === projectPath);
    expect(found).toBeDefined();
    expect(found?.name).toBe("win-app");
    expect(found?.sources).toContain("ggcoder");

    // …and the same path resolves back to the session for the picker's
    // "recent sessions" list.
    const recent = await listRecentSessions(projectPath, 5, state.sessionsDir);
    expect(recent.map((s) => s.id)).toContain(created.id);
  });

  it("survives a path with spaces and a literal underscore", async () => {
    // `C:\Users\<name>\…` routinely contains spaces; the underscore is the
    // separator `encodeCwd` uses, so a literal one is the lossy-decode trap.
    const projectPath = path.join(tmp, "My Projects", "gg_app");
    await fs.mkdir(projectPath, { recursive: true });

    const manager = new SessionManager(state.sessionsDir);
    await manager.create(projectPath, "anthropic", "claude-sonnet-5");

    const projects = await discoverProjects();
    expect(projects.find((p) => p.path === projectPath)?.name).toBe("gg_app");
  });

  it("normalizes an extended-length cwd so it isn't a duplicate project", async () => {
    // Rust's canonicalize() ALWAYS produces `\\?\C:\…`, so that's what shipped
    // builds recorded in session headers. encodeCwd normalizes the prefix away,
    // so both forms already share ONE store directory — but the header cwd is
    // read back verbatim, so without matching normalization on the read side
    // the same project surfaced twice: `C:\proj` AND `\\?\C:\proj`.
    const projectPath = path.join(tmp, "projects", "extended");
    await fs.mkdir(projectPath, { recursive: true });

    const manager = new SessionManager(state.sessionsDir);
    await manager.create(`\\\\?\\${projectPath}`, "anthropic", "claude-sonnet-5");
    await manager.create(projectPath, "anthropic", "claude-sonnet-5");

    const projects = await discoverProjects();
    expect(projects.filter((p) => p.path === projectPath)).toHaveLength(1);
    // A prefixed path must never reach the picker.
    expect(projects.every((p) => !p.path.startsWith("\\\\?\\"))).toBe(true);
  });
});
