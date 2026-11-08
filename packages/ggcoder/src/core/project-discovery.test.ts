import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../config.js";
import { encodeCwd } from "./encode-cwd.js";
import {
  CHAT_FILES_FOLDER,
  discoverProjects,
  isAbsoluteCwd,
  listProjectFolders,
  listRecentSessions,
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

/** Start a session through the real writer, then record one user message. */
async function createUsedSession(cwd: string): Promise<void> {
  const manager = new SessionManager(state.sessionsDir);
  const session = await manager.create(cwd, "anthropic", "claude-sonnet-5");
  await manager.appendEntry(session.path, {
    type: "message",
    id: "33333333-3333-3333-3333-333333333333",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hi" },
  });
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
    vi.unstubAllEnvs();
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

  it("lists folders in the configured projects root that have no sessions yet", async () => {
    const root = path.join(tmp, "gg-projects");
    await fs.mkdir(path.join(root, "never-opened"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
    // Where chats keep their files: a research report is not a project.
    await fs.mkdir(path.join(root, CHAT_FILES_FOLDER, "london-ai-jobs"), { recursive: true });

    const projects = await discoverProjects({ projectsRoot: root });

    const found = projects.find((p) => p.path === path.join(root, "never-opened"));
    expect(found).toBeDefined();
    expect(found?.sources).toEqual(["folder"]);
    // Build output and dotfolders are not projects.
    expect(projects.some((p) => p.path.endsWith("node_modules"))).toBe(false);
    expect(projects.some((p) => p.path.endsWith(".hidden"))).toBe(false);
    expect(projects.some((p) => p.path.includes(CHAT_FILES_FOLDER))).toBe(false);
  });

  it("follows a symlinked project folder (readdir reports it as neither file nor dir)", async () => {
    const root = path.join(tmp, "gg-projects");
    await fs.mkdir(root, { recursive: true });
    const real = path.join(tmp, "elsewhere", "linked-project");
    await fs.mkdir(real, { recursive: true });
    await fs.symlink(real, path.join(root, "linked-project"), "dir");
    // A dangling link must not become a phantom row.
    await fs.symlink(path.join(tmp, "gone"), path.join(root, "dangling"), "dir");

    const projects = await discoverProjects({ projectsRoot: root });

    expect(projects.some((p) => p.path === path.join(root, "linked-project"))).toBe(true);
    expect(projects.some((p) => p.path === path.join(root, "dangling"))).toBe(false);
  });

  it("omits hidden projects regardless of which store surfaced them", async () => {
    const root = path.join(tmp, "gg-projects");
    const hidden = path.join(root, "scratch");
    const kept = path.join(root, "kept");
    await fs.mkdir(hidden, { recursive: true });
    await fs.mkdir(kept, { recursive: true });
    await writeSession(path.join(state.sessionsDir, encodeCwd(hidden)), hidden);

    const projects = await discoverProjects({
      projectsRoot: root,
      // Unnormalized on purpose: hiding is keyed by resolved path.
      hiddenPaths: [hidden + path.sep + "."],
    });

    expect(projects.some((p) => p.path === hidden)).toBe(false);
    expect(projects.some((p) => p.path === kept)).toBe(true);
  });

  it("never lists Goal workspaces as projects", async () => {
    const root = path.join(tmp, "gg-projects");
    const goals = path.join(tmp, "agent", "goals");
    const goal = path.join(goals, "api-latency");
    const kept = path.join(root, "kept");
    await fs.mkdir(goal, { recursive: true });
    await fs.mkdir(kept, { recursive: true });
    // A goal's coordinator writes ordinary sessions keyed by its folder.
    await writeSession(path.join(state.sessionsDir, encodeCwd(goal)), goal);

    const projects = await discoverProjects({ projectsRoot: root, excludeRoots: [goals] });

    expect(projects.some((p) => p.path === goal)).toBe(false);
    expect(projects.some((p) => p.path === kept)).toBe(true);
  });

  it("scans explicitly configured extra roots", async () => {
    const root = path.join(tmp, "gg-projects");
    const extra = path.join(tmp, "second-home");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(extra, "over-here"), { recursive: true });

    const projects = await discoverProjects({ projectsRoot: root, extraRoots: [extra] });

    // One project is far short of the inference threshold, so this only lists
    // because the root was configured explicitly.
    expect(projects.some((p) => p.path === path.join(extra, "over-here"))).toBe(true);
  });

  it("merges a folder row into the session row instead of duplicating it", async () => {
    const root = path.join(tmp, "gg-projects");
    const projectPath = path.join(root, "opened");
    await fs.mkdir(projectPath, { recursive: true });
    await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);

    const projects = await discoverProjects({ projectsRoot: root });

    const rows = projects.filter((p) => p.path === projectPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources).toEqual(["ggcoder", "folder"]);
  });

  it("keeps session recency when a folder mtime is newer", async () => {
    const root = path.join(tmp, "gg-projects");
    const projectPath = path.join(root, "opened");
    await fs.mkdir(projectPath, { recursive: true });
    const store = path.join(state.sessionsDir, encodeCwd(projectPath));
    await writeSession(store, projectPath);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(store, "session.jsonl"), old, old);

    const projects = await discoverProjects({ projectsRoot: root });

    // The folder was just created (mtime = now); a checkout touching the
    // directory must not present the project as freshly worked in.
    const found = projects.find((p) => p.path === projectPath);
    expect(found?.lastActiveMs).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it("lists a project only once one of its sessions records a message", async () => {
    // A session writes its header as soon as it starts, before anything is
    // typed, so a header-only store means the folder was opened, not used.
    const openedOnly = path.join(tmp, "projects", "opened-only");
    const used = path.join(tmp, "projects", "used");
    await fs.mkdir(openedOnly, { recursive: true });
    await fs.mkdir(used, { recursive: true });
    await new SessionManager(state.sessionsDir).create(openedOnly, "anthropic", "claude-sonnet-5");
    await createUsedSession(used);

    const projects = await discoverProjects();

    expect(projects.some((p) => p.path === openedOnly)).toBe(false);
    expect(projects.some((p) => p.path === used)).toBe(true);
  });

  it("does not let a newer never-used session refresh a project's recency", async () => {
    const projectPath = path.join(tmp, "projects", "reopened");
    await fs.mkdir(projectPath, { recursive: true });
    const store = path.join(state.sessionsDir, encodeCwd(projectPath));
    await writeSession(store, projectPath);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(store, "session.jsonl"), old, old);
    await new SessionManager(state.sessionsDir).create(projectPath, "anthropic", "claude-sonnet-5");

    const projects = await discoverProjects();

    const found = projects.find((p) => p.path === projectPath);
    expect(found?.lastActiveMs).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it("infers an extra project root from several known projects sharing a parent", async () => {
    const other = path.join(tmp, "elsewhere");
    for (const name of ["one", "two", "three"]) {
      const projectPath = path.join(other, name);
      await fs.mkdir(projectPath, { recursive: true });
      await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    }
    await fs.mkdir(path.join(other, "never-opened"), { recursive: true });

    const projects = await discoverProjects();

    // Three known siblings make `elsewhere` a root, so its unopened sibling lists too.
    const found = projects.find((p) => p.path === path.join(other, "never-opened"));
    expect(found?.sources).toEqual(["folder"]);
  });

  it("does not infer the temp directory through a symlink alias", async () => {
    const transientRoot = path.join(tmp, "transient-real");
    const tempAlias = path.join(tmp, "transient-alias");
    await fs.mkdir(transientRoot, { recursive: true });
    await fs.symlink(transientRoot, tempAlias, "dir");
    vi.spyOn(os, "tmpdir").mockReturnValue(tempAlias);

    for (const name of ["one", "two", "three"]) {
      const projectPath = path.join(transientRoot, name);
      await fs.mkdir(projectPath, { recursive: true });
      await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    }
    const unrelatedFolder = path.join(transientRoot, "unrelated-temp-folder");
    await fs.mkdir(unrelatedFolder, { recursive: true });

    const projects = await discoverProjects();

    expect(projects.some((project) => project.path === unrelatedFolder)).toBe(false);
  });

  it("headless on macOS: never touches Documents/Desktop — not as a root, not for a session cwd", async () => {
    // Unattended, even a stat() below these parks on a privacy dialog nobody
    // can answer. Sessions under them are skipped; nothing else changes.
    vi.stubEnv("GG_APP_HEADLESS", "1");
    const home = path.join(tmp, "home");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const documents = path.join(home, "Documents");
    for (const name of ["one", "two", "three"]) {
      const projectPath = path.join(documents, name);
      await fs.mkdir(projectPath, { recursive: true });
      await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    }
    await fs.mkdir(path.join(documents, "never-opened"), { recursive: true });
    const elsewhere = path.join(home, "code", "fine");
    await fs.mkdir(elsewhere, { recursive: true });
    await writeSession(path.join(state.sessionsDir, encodeCwd(elsewhere)), elsewhere);
    const statSpy = vi.spyOn(fs, "stat");

    const projects = await discoverProjects({ projectsRoot: documents });

    expect(projects.map((p) => p.path)).toEqual([elsewhere]);
    const touched = statSpy.mock.calls.map((c) => String(c[0]));
    expect(touched.some((p) => p.startsWith(documents))).toBe(false);
  });

  it("attended (no headless flag): Documents is scanned like any other folder", async () => {
    const home = path.join(tmp, "home");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const documents = path.join(home, "Documents");
    for (const name of ["one", "two", "three"]) {
      const projectPath = path.join(documents, name);
      await fs.mkdir(projectPath, { recursive: true });
      await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    }
    await fs.mkdir(path.join(documents, "never-opened"), { recursive: true });

    const projects = await discoverProjects();

    expect(projects.some((p) => p.path === path.join(documents, "never-opened"))).toBe(true);
  });

  it("does not infer a hidden folder, or a folder inside one, as a project root", async () => {
    // Throwaway checkouts often live inside tool folders, e.g. PR worktrees at
    // `<repo>/.gg/pr62`. Several sessions there must not turn the tool folder
    // into a projects root and list its uploads/plans/skills as projects.
    const toolFolder = path.join(tmp, "repo", ".gg");
    const insideHidden = path.join(tmp, ".cache", "checkouts");
    for (const parent of [toolFolder, insideHidden]) {
      for (const name of ["pr1", "pr2", "pr3"]) {
        const projectPath = path.join(parent, name);
        await fs.mkdir(projectPath, { recursive: true });
        await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
      }
      await fs.mkdir(path.join(parent, "uploads"), { recursive: true });
    }

    const projects = await discoverProjects();

    // Checkouts that really had sessions stay listed; the tool folder's other
    // contents do not.
    expect(projects.some((p) => p.path === path.join(toolFolder, "pr1"))).toBe(true);
    expect(projects.some((p) => p.path === path.join(toolFolder, "uploads"))).toBe(false);
    expect(projects.some((p) => p.path === path.join(insideHidden, "uploads"))).toBe(false);
  });

  it("does not infer a root from too few projects, nor scan the home directory", async () => {
    const sparse = path.join(tmp, "sparse");
    for (const name of ["only-one", "only-two"]) {
      const projectPath = path.join(sparse, name);
      await fs.mkdir(projectPath, { recursive: true });
      await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    }
    await fs.mkdir(path.join(sparse, "never-opened"), { recursive: true });

    // Home holds plenty of non-project dirs, so it is never inferred as a root
    // even when several sessions point at its direct children.
    const home = path.join(tmp, "home");
    for (const name of ["h1", "h2", "h3"]) {
      const projectPath = path.join(home, name);
      await fs.mkdir(projectPath, { recursive: true });
      await writeSession(path.join(state.sessionsDir, encodeCwd(projectPath)), projectPath);
    }
    await fs.mkdir(path.join(home, "Music"), { recursive: true });

    const projects = await discoverProjects();

    expect(projects.some((p) => p.path === path.join(sparse, "never-opened"))).toBe(false);
    expect(projects.some((p) => p.path === path.join(home, "Music"))).toBe(false);
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

    await createUsedSession(projectPath);

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

    await createUsedSession(`\\\\?\\${projectPath}`);
    await createUsedSession(projectPath);

    const projects = await discoverProjects();
    expect(projects.filter((p) => p.path === projectPath)).toHaveLength(1);
    // A prefixed path must never reach the picker.
    expect(projects.every((p) => !p.path.startsWith("\\\\?\\"))).toBe(true);
  });
});

describe("listProjectFolders", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-folders-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists every project folder in the roots by name, skipping build and dot folders", async () => {
    const root = path.join(tmp, "kleio-projects");
    for (const name of ["zeta", "Alpha", "beta", "node_modules", ".git"]) {
      await fs.mkdir(path.join(root, name), { recursive: true });
    }
    await fs.writeFile(path.join(root, "notes.txt"), "not a folder");

    const folders = await listProjectFolders([root]);

    expect(folders).toEqual([
      { name: "Alpha", path: path.join(root, "Alpha") },
      { name: "beta", path: path.join(root, "beta") },
      { name: "zeta", path: path.join(root, "zeta") },
    ]);
  });

  it("lists each folder once when roots repeat, and skips roots that are missing", async () => {
    const root = path.join(tmp, "projects");
    const extra = path.join(tmp, "more");
    await fs.mkdir(path.join(root, "one"), { recursive: true });
    await fs.mkdir(path.join(extra, "two"), { recursive: true });

    const folders = await listProjectFolders([
      root,
      ` ${root}${path.sep} `,
      extra,
      "",
      path.join(tmp, "gone"),
    ]);

    expect(folders.map((f) => f.path)).toEqual([path.join(root, "one"), path.join(extra, "two")]);
  });
});
