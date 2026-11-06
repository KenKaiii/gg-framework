import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as GgCoreModule from "@kenkaiiii/gg-core";
import type * as McpModule from "./mcp/index.js";
import type { ClaudeCodeLoopOptions } from "./claude-code/loop.js";
import { useFakeHome } from "../test-support/fake-home.js";

const agentLoopMock = vi.hoisted(() => vi.fn());
const claudeCodeLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});
vi.mock("@kenkaiiii/gg-core", async () => {
  const actual = await vi.importActual<typeof GgCoreModule>("@kenkaiiii/gg-core");
  return { ...actual, resolveClaudeCodeBinary: () => "/fake/claude" };
});
vi.mock("./claude-code/loop.js", () => ({ claudeCodeLoop: claudeCodeLoopMock }));
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
const usage = { inputTokens: 10, outputTokens: 5 };
const timing = { startedAt: Date.now(), completedAt: Date.now(), providerDurationMs: 1 };

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

/** A Claude Code run: reports `id`, answers `reply`. */
function claudeCodeRun(id: string, reply: string) {
  return async function* (messages: Message[], opts: ClaudeCodeLoopOptions) {
    opts.claudeCode.onSessionId?.(id);
    messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
    yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
    yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
  };
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-cc-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-cc-project-"));
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset();
  claudeCodeLoopMock.mockReset();
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    "anthropic-claude-code": { via: "claude-code" },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), { autoCompact: false });
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function newSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
  });
  await session.initialize();
  return session;
}

describe("AgentSession on a Claude subscription", () => {
  it("runs through Claude Code, then resumes its session after a reload", async () => {
    const session = await newSession();
    const sessionPath = session.getState().sessionPath;
    claudeCodeLoopMock.mockImplementationOnce(claudeCodeRun("cc-1", "first answer"));
    await session.prompt("first question");

    expect(agentLoopMock).not.toHaveBeenCalled();
    const [firstMessages, firstOpts] = claudeCodeLoopMock.mock.calls[0] as [
      Message[],
      ClaudeCodeLoopOptions,
    ];
    expect(firstOpts.claudeCode).toMatchObject({ executable: "/fake/claude", cwd: tmpProject });
    expect(firstOpts.claudeCode.resume).toBeUndefined();
    expect(firstMessages[0]).toMatchObject({ role: "system" });
    expect(firstOpts.tools?.length).toBeGreaterThan(0);
    await session.dispose();

    const reopened = await newSession();
    await reopened.loadSession(sessionPath);
    claudeCodeLoopMock.mockImplementationOnce(claudeCodeRun("cc-1", "second answer"));
    await reopened.prompt("second question");
    const [, secondOpts] = claudeCodeLoopMock.mock.calls[1] as [Message[], ClaudeCodeLoopOptions];
    expect(secondOpts.claudeCode.resume).toBe("cc-1");
    await reopened.dispose();
  }, 20_000);

  it("starts a fresh Claude Code session after a branch rewrites history", async () => {
    const session = await newSession();
    claudeCodeLoopMock.mockImplementation(claudeCodeRun("cc-2", "answer"));
    await session.prompt("one");
    await session.prompt("two");
    const [, second] = claudeCodeLoopMock.mock.calls[1] as [Message[], ClaudeCodeLoopOptions];
    expect(second.claudeCode.resume).toBe("cc-2");

    await session.branch(2);
    await session.prompt("three");
    const [third] = claudeCodeLoopMock.mock.calls[2] as [Message[], ClaudeCodeLoopOptions];
    const [, thirdOpts] = claudeCodeLoopMock.mock.calls[2] as [Message[], ClaudeCodeLoopOptions];
    expect(thirdOpts.claudeCode.resume).toBeUndefined();
    expect(third.filter((m) => m.role !== "system").map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await session.dispose();
  }, 20_000);

  it("skips prewarm", async () => {
    const session = await newSession();
    expect(await session.prewarm()).toEqual({ ok: false, reason: "claude_code" });
    await session.dispose();
  });
});
