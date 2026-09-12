import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { resetInternalDiagnosticsCacheForTests } from "./internal-diagnostics.js";

const agentLoopMock = vi.hoisted(() => vi.fn());

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

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let tmpDiagDir: string;

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 40 };
const timing = { startedAt: Date.now(), completedAt: Date.now(), providerDurationMs: 1 };

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-diagwire-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-diagwire-project-"));
  tmpDiagDir = path.join(tmpHome, "diag");
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset();
  process.env.GG_DIAGNOSTICS_DIR = tmpDiagDir;
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), { autoCompact: false });
});

afterEach(async () => {
  delete process.env.GG_DIAGNOSTICS_DIR;
  delete process.env.GG_INTERNAL;
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** The AgentSession modules read the cached flag once per process state, so
 * tests must reset before (re)initializing a session under a new flag value. */
async function newSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
  });
  await session.initialize();
  return session;
}

describe("internal diagnostics wiring in AgentSession", () => {
  it("flag ON: registers session_stats + /diagnose and records turns", async () => {
    process.env.GG_INTERNAL = "1";
    resetInternalDiagnosticsCacheForTests();
    const session = await newSession();

    // Tool is registered and callable.
    const statsTool = (session as unknown as { tools: { name: string }[] }).tools.find(
      (t) => t.name === "session_stats",
    );
    expect(statsTool).toBeDefined();
    const out = await (
      statsTool as unknown as { execute: (args: Record<string, unknown>) => Promise<string> }
    ).execute({});
    expect(out).toContain("reuse");

    // Slash command exists.
    const diag = session.slashCommands.get("diagnose");
    expect(diag).toBeDefined();

    // A run with a turn_end produces a diagnostics record on disk.
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "done" });
      yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });
    await session.prompt("hello");
    await session.dispose();

    const files = await fs.readdir(tmpDiagDir);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
    const record = JSON.parse(await fs.readFile(path.join(tmpDiagDir, files[0]), "utf8")) as {
      totals: { turns: number; cacheRead: number };
      endedAt?: number;
    };
    expect(record.totals.turns).toBe(1);
    expect(record.totals.cacheRead).toBe(40);
    expect(record.endedAt).toBeDefined(); // dispose finalized the record
  }, 15_000);

  it("flag OFF: no session_stats tool, no /diagnose, nothing written", async () => {
    delete process.env.GG_INTERNAL;
    resetInternalDiagnosticsCacheForTests();
    const session = await newSession();

    const tools = (session as unknown as { tools: { name: string }[] }).tools;
    expect(tools.some((t) => t.name === "session_stats")).toBe(false);
    expect(session.slashCommands.get("diagnose")).toBeUndefined();

    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "done" });
      yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });
    await session.prompt("hello");
    await session.dispose();

    await expect(fs.readdir(tmpDiagDir)).rejects.toThrow(); // dir never created
  }, 15_000);
});
