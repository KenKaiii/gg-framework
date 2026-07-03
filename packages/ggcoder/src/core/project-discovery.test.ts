import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../config.js";
import { encodeCwd } from "./encode-cwd.js";
import { discoverProjects } from "./project-discovery.js";

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
