/**
 * Adding or removing an MCP server mid-session takes effect without a
 * restart: tools land in the tool_search catalog, the model is told by an
 * appended note, and the cached system prompt and tool prefix stay untouched.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { useFakeHome } from "../test-support/fake-home.js";
import type { MCPServerConfig } from "./mcp/types.js";

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
});

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp",
  "__fixtures__",
  "lifecycle-mcp-server.mjs",
);

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-hot-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-hot-project-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
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
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

interface Internals {
  getHookSteeringMessages: () => Array<{ role: string; content: unknown }> | null;
  tools: AgentTool[];
}

const life: MCPServerConfig = {
  name: "life",
  command: process.execPath,
  args: [FIXTURE],
  timeout: 10_000,
  shared: false,
};

async function makeSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  return { session, internals: session as unknown as Internals };
}

function tool(internals: Internals, name: string): AgentTool {
  const found = internals.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const ctx = () => ({ signal: new AbortController().signal, toolCallId: "t" });

describe("AgentSession MCP hot-load", () => {
  it("adds a server's tools to tool_search and tells the model, append-only", async () => {
    const { session, internals } = await makeSession();
    try {
      const systemBefore = String(session.getMessages()[0]?.content ?? "");
      const toolsBefore = internals.tools.map((t) => t.name);

      const change = await session.applyMcpServerChange("life", life);
      expect(change).toMatchObject({ name: "life", connected: true, removed: false });
      expect(change!.toolCount).toBeGreaterThan(0);

      // Cached prefix untouched: same system prompt, existing tools in the same order.
      expect(String(session.getMessages()[0]?.content ?? "")).toBe(systemBefore);
      expect(internals.tools.map((t) => t.name).slice(0, toolsBefore.length)).toEqual(toolsBefore);

      const steering = internals.getHookSteeringMessages();
      expect(steering).toHaveLength(1);
      expect(String(steering![0]!.content)).toContain('MCP server "life"');
      expect(String(steering![0]!.content)).toContain("mcp__life__echo");
      expect(internals.getHookSteeringMessages()).toBeNull();

      // The agent can find and call it.
      const found = await tool(internals, "tool_search").execute({ query: "echo text" }, ctx());
      expect(JSON.stringify(found)).toContain("mcp__life__echo");
      const echoed = await tool(internals, "mcp__life__echo").execute({ text: "hello" }, ctx());
      expect(JSON.stringify(echoed)).toContain("hello");

      // Same config again: nothing to do.
      expect(await session.applyMcpServerChange("life", life)).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("removes a server: promoted tools refuse calls and the model is told", async () => {
    const { session, internals } = await makeSession();
    try {
      await session.applyMcpServerChange("life", life);
      internals.getHookSteeringMessages();
      await tool(internals, "tool_search").execute({ query: "echo text" }, ctx());
      const echo = tool(internals, "mcp__life__echo");

      const change = await session.applyMcpServerChange("life", undefined);
      expect(change).toMatchObject({ name: "life", removed: true });
      await expect(echo.execute({ text: "x" }, ctx())).rejects.toThrow(/was removed/);
      const steering = internals.getHookSteeringMessages();
      expect(String(steering![0]!.content)).toContain('"life" was removed');

      const search = await tool(internals, "tool_search").execute({ query: "pid" }, ctx());
      expect(JSON.stringify(search)).not.toContain("mcp__life__pid");
      expect(await session.applyMcpServerChange("life", undefined)).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("delivers the note with the next prompt when idle", async () => {
    const { session } = await makeSession();
    try {
      await session.applyMcpServerChange("life", life);
      await session.prompt("hi");
      const texts = session.getMessages().map((m) => String(m.content));
      const note = texts.findIndex((t) => t.includes("MCP update"));
      expect(note).toBeGreaterThan(0);
      expect(texts[note + 1]).toBe("hi");
    } finally {
      await session.dispose();
    }
  }, 30_000);
});
