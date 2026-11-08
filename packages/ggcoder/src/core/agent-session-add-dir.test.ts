import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kleio/agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

vi.mock("@kleio/agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kleio/agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

let restoreHome: (() => void) | undefined;
let tempHome: string;
let tempProject: string;
let sibling: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "add-dir-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "add-dir-project-"));
  sibling = await fs.mkdtemp(path.join(os.tmpdir(), "add-dir-sibling-"));
  restoreHome = useFakeHome(tempHome);
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
    fs.rm(sibling, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

async function createSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tempProject,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  return session;
}

describe("AgentSession.addDirectory", () => {
  it("adds a root and names it in the rebuilt system prompt", async () => {
    const session = await createSession();
    try {
      expect(session.getAdditionalRoots()).toEqual([]);
      const result = await session.addDirectory(sibling);
      expect(result).toEqual({ ok: true, root: path.resolve(sibling) });
      expect(session.getAdditionalRoots()).toEqual([path.resolve(sibling)]);

      const systemPrompt = String(session.getMessages()[0]?.content ?? "");
      expect(systemPrompt).toContain("Additional roots:");
      expect(systemPrompt).toContain(session.getAdditionalRoots()[0]!);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("keeps the cached system prompt byte-identical once a conversation exists", async () => {
    // A goal attaching a folder mid-run rebuilt the prompt and re-sent ~75k
    // uncached tokens; the env-delta note tells the model instead.
    const session = await createSession();
    try {
      session.getMessages().push({ role: "user", content: "earlier turn" });
      const before = session.getMessages()[0]?.content;
      expect(await session.addDirectory(sibling)).toMatchObject({ ok: true });
      expect(session.getMessages()[0]?.content).toBe(before);
      expect(await session.removeDirectory(sibling)).toMatchObject({ ok: true });
      expect(session.getMessages()[0]?.content).toBe(before);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("removes an added root and rejects roots that were never added", async () => {
    const session = await createSession();
    try {
      expect(await session.removeDirectory(sibling)).toMatchObject({ ok: false });
      expect(await session.addDirectory(sibling)).toMatchObject({ ok: true });
      expect(await session.removeDirectory(sibling)).toEqual({
        ok: true,
        root: path.resolve(sibling),
      });
      expect(session.getAdditionalRoots()).toEqual([]);
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain("Additional roots:");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("offers and runs the custom commands of an added root, the project's winning a shared name", async () => {
    // A goal's attached repos are added roots: their `.gg/commands` must show
    // in the slash menu and expand like the project's own.
    const write = async (root: string, name: string, body: string): Promise<void> => {
      await fs.mkdir(path.join(root, ".gg", "commands"), { recursive: true });
      await fs.writeFile(
        path.join(root, ".gg", "commands", `${name}.md`),
        `---\ndescription: ${name} from ${path.basename(root)}\n---\n${body}`,
      );
    };
    await write(tempProject, "shared", "project body");
    await write(sibling, "shared", "sibling body");
    await write(sibling, "deploy", "deploy body");
    const session = await createSession();
    try {
      expect((await session.loadCustomCommands()).map((c) => c.name)).toEqual(["shared"]);
      expect(await session.willExpandPromptTemplate("/deploy")).toBe(false);

      await session.addDirectory(sibling);
      const commands = await session.loadCustomCommands();
      expect(commands.map((c) => c.name).sort()).toEqual(["deploy", "shared"]);
      expect(commands.find((c) => c.name === "shared")?.prompt).toContain("project body");
      expect(await session.willExpandPromptTemplate("/deploy")).toBe(true);

      await session.removeDirectory(sibling);
      expect((await session.loadCustomCommands()).map((c) => c.name)).toEqual(["shared"]);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("rejects a file, a missing path, and a duplicate", async () => {
    const session = await createSession();
    try {
      const file = path.join(sibling, "a.txt");
      await fs.writeFile(file, "x");

      expect(await session.addDirectory(file)).toMatchObject({ ok: false });
      expect(await session.addDirectory(path.join(sibling, "nope"))).toMatchObject({ ok: false });
      expect(await session.addDirectory(tempProject)).toMatchObject({ ok: false });

      expect(await session.addDirectory(sibling)).toMatchObject({ ok: true });
      expect(await session.addDirectory(sibling)).toMatchObject({ ok: false });
      expect(session.getAdditionalRoots()).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
