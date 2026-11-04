import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kleio/agent";
import type { AgentTool } from "@kleio/agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { DEFERRED_TOOL_NAMES } from "../tools/tool-tiers.js";

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

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "tiers-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "tiers-project-"));
  restoreHome = useFakeHome(tempHome);
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
  restoreHome?.();
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(tempHome, ".gg", "settings.json"),
    JSON.stringify(settings),
    "utf-8",
  );
}

async function createSession(extra: Record<string, unknown> = {}) {
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
    ...extra,
  });
  await session.initialize();
  return session;
}

/** The live tool array is private; tiering is precisely a claim about it. */
function liveToolNames(session: unknown): string[] {
  return (session as { tools: { name: string }[] }).tools.map((t) => t.name);
}

describe("AgentSession built-in tool tiering", () => {
  it("keeps deferred schemas out of the live set but names them in the prompt", async () => {
    const session = await createSession();
    try {
      const live = liveToolNames(session);
      const prompt = String(session.getMessages()[0]?.content ?? "");

      expect(live).toContain("tool_search");
      expect(prompt).toContain("On demand (call by name;");

      const deferredHere = DEFERRED_TOOL_NAMES.filter((name) => prompt.includes(`- **${name}**:`));
      expect(deferredHere.length).toBeGreaterThan(0);
      for (const name of deferredHere) {
        expect(live, `${name} should not carry a schema`).not.toContain(name);
      }
      // Core tools are unaffected.
      for (const name of ["read", "edit", "bash", "grep"]) {
        expect(live).toContain(name);
      }
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("discovers UI libraries in a normal session and executes the promoted tool offline", async () => {
    const session = await createSession();
    try {
      const prompt = String(session.getMessages()[0]?.content ?? "");
      expect(prompt).toContain("**ui_registry**");
      expect(prompt).toContain("**ui_adopt**");
      const tools = (session as unknown as { tools: AgentTool[] }).tools;
      const originalNames = tools.map((tool) => tool.name);
      const context = { signal: new AbortController().signal, toolCallId: "ui-discovery-test" };
      await tools
        .find((tool) => tool.name === "tool_search")!
        .execute({ query: "ui_registry ui_adopt Bklit Kokonut Motion" }, context);
      expect(tools.slice(0, originalNames.length).map((tool) => tool.name)).toEqual(originalNames);
      expect(tools.map((tool) => tool.name)).toContain("ui_registry");
      expect(tools.map((tool) => tool.name)).toContain("ui_adopt");
      const result = await tools
        .find((tool) => tool.name === "ui_registry")!
        .execute({ action: "motion" }, context);
      expect(JSON.parse(String(result)).kind).toBe("animation-api");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("loads wait_agent as soon as spawn_agent succeeds, skipping the tool_search turn", async () => {
    // spawn_agent only exists when an agent is defined.
    await fs.mkdir(path.join(tempHome, ".gg", "agents"), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, ".gg", "agents", "owl.md"),
      "---\nname: owl\ndescription: Read-only helper\ntools: read\n---\nYou read code.\n",
    );
    const session = await createSession({ globalSubagents: true });
    try {
      const tools = (session as unknown as { tools: AgentTool[] }).tools;
      expect(liveToolNames(session)).not.toContain("wait_agent");
      // spawn_agent is deferred too; the agent loop loads it on first call.
      expect(liveToolNames(session)).not.toContain("spawn_agent");
      const resolve = (
        session as unknown as { promoteDeferredBuiltin(name: string): AgentTool | undefined }
      ).promoteDeferredBuiltin.bind(session);
      const spawn = resolve("spawn_agent")!;
      expect(liveToolNames(session).at(-1)).toBe("spawn_agent");
      expect(tools.at(-1)).toBe(spawn);
      const context = { signal: new AbortController().signal, toolCallId: "spawn-promote-test" };
      const subAgents = (
        session as unknown as { subAgentManager: { spawn: (...a: unknown[]) => Promise<unknown> } }
      ).subAgentManager;
      const spawnSpy = vi.spyOn(subAgents, "spawn");

      // A spawn that starts nothing fails and must not change the tool list.
      spawnSpy.mockRejectedValueOnce(new Error("At most 8 agents may run at once"));
      await expect(
        spawn.execute({ tasks: [{ task_name: "x", task: "y" }] }, context),
      ).rejects.toThrow(/No agent started/);
      expect(liveToolNames(session)).not.toContain("wait_agent");

      const before = liveToolNames(session);
      spawnSpy.mockResolvedValue({ agent_id: "abcd1234", task_name: "scan", state: "running" });
      await spawn.execute({ tasks: [{ task_name: "scan", task: "look" }] }, context);

      const after = liveToolNames(session);
      // Appended once, after every existing tool, so the cached prefix holds.
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.filter((name) => name === "wait_agent")).toEqual(["wait_agent"]);
      await spawn.execute({ tasks: [{ task_name: "scan2", task: "look" }] }, context);
      expect(liveToolNames(session)).toEqual(after);
      // The prompt index stops advertising it once it carries its own schema.
      const index = (
        session as unknown as { deferredToolNamesForPrompt(live: string[]): string[] }
      ).deferredToolNamesForPrompt(after);
      expect(index).not.toContain("wait_agent");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("loads a deferred built-in called by name, and the task tools once bash backgrounds", async () => {
    const session = await createSession();
    try {
      const resolve = (
        session as unknown as { promoteDeferredBuiltin(name: string): AgentTool | undefined }
      ).promoteDeferredBuiltin.bind(session);
      const before = liveToolNames(session);
      expect(before).not.toContain("find");
      expect(before).not.toContain("task_output");

      expect(resolve("find")?.name).toBe("find");
      expect(resolve("not_a_tool")).toBeUndefined();
      expect(liveToolNames(session)).toEqual([...before, "find"]);

      const tools = (session as unknown as { tools: AgentTool[] }).tools;
      const bash = tools.find((tool) => tool.name === "bash");
      const context = { signal: new AbortController().signal, toolCallId: "bg-promote-test" };
      await bash?.execute({ command: "true" }, context);
      expect(liveToolNames(session)).not.toContain("task_output");
      const bg = await bash?.execute({ command: "true", run_in_background: true }, context);
      const id = /id="([^"]+)"/.exec(String(bg))?.[1];
      expect(liveToolNames(session).slice(-3)).toEqual(["task_output", "task_send", "task_stop"]);
      if (id) {
        const output = tools.find((tool) => tool.name === "task_output");
        await output?.execute({ id, wait_ms: 5_000 }, context);
      }
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("registers tool_search even with no MCP server connected", async () => {
    const session = await createSession();
    try {
      expect(liveToolNames(session).filter((n) => n === "tool_search")).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("appends tool_search after the core tools, never reordering them", async () => {
    const session = await createSession();
    try {
      const live = liveToolNames(session);
      expect(live.indexOf("tool_search")).toBe(live.length - 1);
      expect(live.indexOf("read")).toBeLessThan(live.indexOf("edit"));
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("gives allowedTools sessions every requested tool eagerly", async () => {
    const requested = ["read", "grep", "source_path", "screenshot"];
    const session = await createSession({ allowedTools: requested });
    try {
      const live = liveToolNames(session);
      for (const name of requested) expect(live, `${name} missing`).toContain(name);
      // No deferral means no catalog and no discovery tool to promote from.
      expect(live).not.toContain("tool_search");
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain("Available on demand");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("ships every built-in eagerly when deferredBuiltinTools is off", async () => {
    await writeSettings({ deferredBuiltinTools: false });
    const session = await createSession();
    try {
      const live = liveToolNames(session);
      expect(live).toContain("source_path");
      expect(live).toContain("screenshot");
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain("Available on demand");
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
