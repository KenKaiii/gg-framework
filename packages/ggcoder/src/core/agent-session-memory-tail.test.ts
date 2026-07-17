import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";

const observedPrompts = vi.hoisted(() => [] as string[]);
const agentLoopMock = vi.hoisted(() =>
  vi.fn((messages: Message[]) => {
    observedPrompts.push(String(messages[0]?.content ?? ""));
    return (async function* emptyLoop() {})();
  }),
);

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
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

let originalHome: string | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tail-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tail-project-"));
  process.env.HOME = tempHome;
  observedPrompts.length = 0;
  agentLoopMock.mockClear();
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

async function createSession(getSystemPromptTail?: () => string) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tempProject,
    systemPrompt: "stable role prompt",
    getSystemPromptTail,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  return session;
}

describe("AgentSession dynamic system prompt tail", () => {
  it("places the volatile tail after the cache marker during initialization", async () => {
    const session = await createSession(() => "memory v1");
    try {
      expect(session.getMessages()[0]?.content).toBe(
        "stable role prompt\n\n<!-- uncached -->\nmemory v1",
      );
    } finally {
      await session.dispose();
    }
  }, 15_000);

  it("refreshes changed memory immediately before every run", async () => {
    let memory = "memory v1";
    const session = await createSession(() => memory);
    try {
      memory = "memory v2";
      await session.prompt("first turn");
      memory = "memory v3";
      await session.prompt("second turn");
      expect(observedPrompts).toEqual([
        "stable role prompt\n\n<!-- uncached -->\nmemory v2",
        "stable role prompt\n\n<!-- uncached -->\nmemory v3",
      ]);
      expect(observedPrompts[1]?.match(/<!-- uncached -->/g)).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  });

  it("rebuilds the tail for a fresh session", async () => {
    let memory = "old memory";
    const session = await createSession(() => memory);
    try {
      memory = "new memory";
      await session.newSession();
      expect(session.getMessages()[0]?.content).toBe(
        "stable role prompt\n\n<!-- uncached -->\nnew memory",
      );
    } finally {
      await session.dispose();
    }
  });

  it("leaves ordinary sessions byte-for-byte unchanged", async () => {
    const session = await createSession();
    try {
      expect(session.getMessages()[0]?.content).toBe("stable role prompt");
      await session.prompt("ordinary turn");
      expect(observedPrompts).toEqual(["stable role prompt"]);
    } finally {
      await session.dispose();
    }
  });
});
