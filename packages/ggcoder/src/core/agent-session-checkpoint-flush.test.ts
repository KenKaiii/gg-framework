import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kleio/ai";
import type * as GgAgentModule from "@kleio/agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";

const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@kleio/agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kleio/agent");
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

const usage = { inputTokens: 10, outputTokens: 5 };
const timing = { startedAt: Date.now(), completedAt: Date.now(), providerDurationMs: 1 };

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function sessionFiles(): Promise<string[]> {
  const root = path.join(tmpHome, ".gg", "sessions");
  const found: string[] = [];
  for (const dir of await fs.readdir(root).catch(() => [])) {
    for (const file of await fs.readdir(path.join(root, dir))) {
      if (file.endsWith(".jsonl")) found.push(path.join(root, dir, file));
    }
  }
  return found;
}

/** Roles of the `message` entries currently on disk, in file order. */
async function persistedRoles(sessionPath: string): Promise<string[]> {
  const raw = await fs.readFile(sessionPath, "utf-8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { type?: string; message?: { role: string } })
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message!.role);
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-checkpoint-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-checkpoint-project-"));
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset();
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), { autoCompact: false });
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("step-boundary persistence", () => {
  it("credits a full-file cat from the finished step as a read", async () => {
    // A .txt file starts no language server, so nothing keeps a handle open in
    // the project folder after dispose (Windows would refuse to delete it).
    await fs.writeFile(path.join(tmpProject, "a.txt"), "one\ntwo\n");
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();

    let writeError: unknown = "not run";
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      opts: { tools: Array<{ name: string; execute: (a: unknown, c: unknown) => unknown }> },
    ) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_call", id: "b1", name: "bash", args: { command: "cat a.txt" } }],
      });
      yield { type: "turn_end", turn: 1, stopReason: "tool_use", usage, timing };
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "b1", content: "one\ntwo\n" }],
      });
      yield { type: "checkpoint", turn: 1 };

      const write = opts.tools.find((t) => t.name === "write");
      try {
        await write?.execute(
          { file_path: "a.txt", content: "replaced\n" },
          { signal: new AbortController().signal, toolCallId: "w1" },
        );
        writeError = null;
      } catch (err) {
        writeError = err;
      }
      messages.push({ role: "assistant", content: "done" });
      yield { type: "turn_end", turn: 2, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 2, totalUsage: usage };
    });

    await session.prompt("rewrite a.txt");
    expect(writeError).toBeNull();
    expect(await fs.readFile(path.join(tmpProject, "a.txt"), "utf-8")).toBe("replaced\n");
    await session.dispose();
  }, 15_000);

  it("writes each step to disk before the loop returns", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    const sessionPath = session.getState().sessionPath;

    // Snapshot the file at each point the loop reaches, so we can prove the
    // writes happen DURING the run rather than in one flush at the end.
    const snapshots: string[][] = [];
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      snapshots.push(await persistedRoles(sessionPath));

      messages.push({ role: "assistant", content: "step one" });
      yield { type: "turn_end", turn: 1, stopReason: "tool_use", usage, timing };
      snapshots.push(await persistedRoles(sessionPath));

      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "output one" }],
      });
      yield { type: "checkpoint", turn: 1 };
      snapshots.push(await persistedRoles(sessionPath));

      messages.push({ role: "assistant", content: "all done" });
      yield { type: "turn_end", turn: 2, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 2, totalUsage: usage };
    });

    await session.prompt("do the thing");

    expect(snapshots).toEqual([["user"], ["user", "assistant"], ["user", "assistant", "tool"]]);
    expect(await persistedRoles(sessionPath)).toEqual(["user", "assistant", "tool", "assistant"]);
    await session.dispose();
  }, 15_000);

  it("never double-writes a message the backstop flush also sees", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    const sessionPath = session.getState().sessionPath;

    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "reply" });
      yield { type: "turn_end", turn: 1, stopReason: "tool_use", usage, timing };
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "out" }],
      });
      yield { type: "checkpoint", turn: 1 };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });

    await session.prompt("do the thing");
    expect(await persistedRoles(sessionPath)).toEqual(["user", "assistant", "tool"]);
    await session.dispose();
  }, 15_000);

  it("surfaces a crashed run on reload, once, without resuming it", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    const sessionPath = session.getState().sessionPath;

    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "reply" });
      yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });
    await session.prompt("do the thing");

    // Simulate the crash: a run opened the journal and the process died before
    // it could close it. (The sidecar's RunLifecycle owns the real pairing.)
    await session.persistRunStarted(7);
    await session.dispose();

    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: sessionPath,
    });
    await resumed.initialize();

    const interrupted = resumed.getAppMarkers().filter((m) => m.kind === "interrupted_run");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.data.generation).toBe(7);
    // Surfaced only — the dead run is not replayed.
    expect(agentLoopMock).toHaveBeenCalledTimes(1);
    await resumed.dispose();

    // Reopening again must not re-report it: detection closed the journal.
    const reopened = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: sessionPath,
    });
    await reopened.initialize();
    expect(reopened.getAppMarkers().filter((m) => m.kind === "interrupted_run")).toHaveLength(1);
    await reopened.dispose();
  }, 20_000);

  it("writes nothing for a transient session", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      transient: true,
    });
    await session.initialize();
    expect(session.getState().sessionPath).toBe("");

    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "reply" });
      yield { type: "turn_end", turn: 1, stopReason: "tool_use", usage, timing };
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "out" }],
      });
      yield { type: "checkpoint", turn: 1 };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });

    await session.prompt("do the thing");

    // A subagent transcript must never reach `ggcoder continue`.
    expect(await sessionFiles()).toEqual([]);
    await session.dispose();
  }, 15_000);
});
