import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as GgCoreModule from "@kenkaiiii/gg-core";
import type * as McpModule from "./mcp/index.js";
import type * as LiveSessionModule from "./claude-code/live-session.js";
import type * as LoggerModule from "./logger.js";
import type { ClaudeCodeLoopOptions } from "./claude-code/live-session.js";
import { useFakeHome } from "../test-support/fake-home.js";

const agentLoopMock = vi.hoisted(() => vi.fn());
const claudeCodeLoopMock = vi.hoisted(() => vi.fn());
/** Every Claude Code process the session started, with why each was closed. */
const processes = vi.hoisted(() => [] as { closed: string[] }[]);
const logMock = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", async () => {
  const actual = await vi.importActual<typeof LoggerModule>("./logger.js");
  return { ...actual, log: logMock };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});
vi.mock("@kenkaiiii/gg-core", async () => {
  const actual = await vi.importActual<typeof GgCoreModule>("@kenkaiiii/gg-core");
  return { ...actual, resolveClaudeCodeBinary: () => "/fake/claude" };
});
vi.mock("./claude-code/live-session.js", async () => {
  const actual = await vi.importActual<typeof LiveSessionModule>("./claude-code/live-session.js");
  class FakeLiveSession {
    closed: string[] = [];
    busy = false;
    sessionId: string | undefined;
    constructor() {
      processes.push(this);
    }
    get alive() {
      return this.closed.length === 0;
    }
    async setEffort() {
      return true;
    }
    close(reason: string) {
      this.closed.push(reason);
    }
    run(messages: Message[], opts: ClaudeCodeLoopOptions) {
      const onSessionId = (id: string) => {
        this.sessionId = id;
        opts.claudeCode.onSessionId?.(id);
      };
      return claudeCodeLoopMock(messages, {
        ...opts,
        claudeCode: { ...opts.claudeCode, onSessionId },
      });
    }
  }
  return { ...actual, ClaudeCodeLiveSession: FakeLiveSession };
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

/** Where Claude Code keeps its copy of session `id`. */
function transcriptPath(id: string): string {
  return path.join(tmpHome, ".gg", "claude-code", "config", "projects", "-proj", `${id}.jsonl`);
}

/** A Claude Code run: reports `id`, saves its transcript, answers `reply`. */
function claudeCodeRun(id: string, reply: string) {
  return async function* (messages: Message[], opts: ClaudeCodeLoopOptions) {
    opts.claudeCode.onSessionId?.(id);
    await fs.mkdir(path.dirname(transcriptPath(id)), { recursive: true });
    await fs.writeFile(transcriptPath(id), "{}\n");
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
  processes.length = 0;
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

  it("lists the on-demand tools a restored conversation already used", async () => {
    // Regression: a new process listed only the core tools, so Claude Code
    // refused the restored conversation's next `task_output` call.
    const names = (call: number) =>
      (claudeCodeLoopMock.mock.calls[call] as [Message[], ClaudeCodeLoopOptions])[1].tools?.map(
        (tool) => tool.name,
      );
    const session = await newSession();
    const sessionPath = session.getState().sessionPath;
    claudeCodeLoopMock.mockImplementationOnce(async function* (
      messages: Message[],
      opts: ClaudeCodeLoopOptions,
    ) {
      opts.claudeCode.onSessionId?.("cc-1");
      await fs.mkdir(path.dirname(transcriptPath("cc-1")), { recursive: true });
      await fs.writeFile(transcriptPath("cc-1"), "{}\n");
      messages.push(
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "call-1", name: "task_output", args: { id: "p1" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call-1", content: "still running" }],
        },
        { role: "assistant", content: [{ type: "text", text: "the server is up" }] },
      );
      yield { type: "turn_end", turn: 1, stopReason: "end_turn", usage, timing };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });
    await session.prompt("start the server");
    expect(names(0)).not.toContain("task_output");
    await session.dispose();

    const reopened = await newSession();
    await reopened.loadSession(sessionPath);
    claudeCodeLoopMock.mockImplementationOnce(claudeCodeRun("cc-1", "second answer"));
    await reopened.prompt("is it still up?");
    expect(names(1)).toContain("task_output");
    expect(names(1)?.slice(0, names(0)?.length)).toEqual(names(0));
    await reopened.dispose();
  }, 20_000);

  it("seeds a fresh Claude Code session when the transcript to resume is gone", async () => {
    // Regression guard for the transcript retention pass: Claude Code fails a
    // resume it has no transcript for, so GG's own history must seed it instead.
    const session = await newSession();
    claudeCodeLoopMock.mockImplementationOnce(claudeCodeRun("cc-old", "first answer"));
    await session.prompt("first question");
    await fs.rm(transcriptPath("cc-old"));

    claudeCodeLoopMock.mockImplementationOnce(claudeCodeRun("cc-new", "second answer"));
    await session.prompt("second question");
    const [messages, opts] = claudeCodeLoopMock.mock.calls[1] as [Message[], ClaudeCodeLoopOptions];
    expect(opts.claudeCode.resume).toBeUndefined();
    // The whole history goes along, for the fresh session's seed.
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await session.dispose();
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

  it("keeps the cache warm for Claude Code's hour after a turn", async () => {
    // Regression: Claude Code turns never recorded a cache touch, so the
    // "This chat's cache expired" notice showed right after every run.
    const session = await newSession();
    claudeCodeLoopMock.mockImplementationOnce(claudeCodeRun("cc-3", "answer"));
    await session.prompt("question");
    const now = Date.now();
    expect(session.getCacheExpiryStatus(now)).toMatchObject({ expired: false, ttlMs: 3_600_000 });
    expect(session.getCacheExpiryStatus(now + 61 * 60_000)).toMatchObject({
      expired: true,
      reason: "idle",
    });
    await session.dispose();
  }, 20_000);

  it("logs cache health and retries per turn, as the public-API route does", async () => {
    const session = await newSession();
    claudeCodeLoopMock.mockImplementationOnce(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: [{ type: "text", text: "answer" }] });
      yield { type: "retry", reason: "overloaded", attempt: 1, maxAttempts: 10, delayMs: 500 };
      yield {
        type: "turn_end",
        turn: 1,
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 40, cacheRead: 700, cacheWrite: 200 },
        timing: { startedAt: 1_000, completedAt: 4_000, providerDurationMs: 3_000, ttftMs: 800 },
      };
      yield { type: "agent_done", totalTurns: 1, totalUsage: usage };
    });
    await session.prompt("question");
    await session.dispose();

    expect(logMock).toHaveBeenCalledWith("INFO", "stream", "cache_health", {
      promptTokens: 1_000,
      cacheRead: 700,
      cacheWrite: 200,
      ratio: 0.7,
      ttftMs: 800,
      providerDurationMs: 3_000,
      outputTokens: 40,
      provider: "anthropic",
      model: expect.any(String),
      transport: "claude_code",
    });
    expect(logMock).toHaveBeenCalledWith("INFO", "stream", "retry", {
      reason: "overloaded",
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      transport: "claude_code",
    });
  }, 20_000);

  it("skips prewarm", async () => {
    const session = await newSession();
    expect(await session.prewarm()).toEqual({ ok: false, reason: "claude_code" });
    await session.dispose();
  });

  it("keeps one Claude Code process across prompts until history or settings change", async () => {
    const session = await newSession();
    claudeCodeLoopMock.mockImplementation(claudeCodeRun("cc-4", "answer"));
    await session.prompt("one");
    await session.prompt("two");
    expect(processes).toHaveLength(1);
    expect(processes[0]!.closed).toEqual([]);

    await session.branch(2);
    await session.prompt("three");
    expect(processes).toHaveLength(2);
    expect(processes[0]!.closed).toEqual(["history or effort changed"]);

    await session.switchModel("anthropic", "claude-haiku-5-5");
    await session.prompt("four");
    expect(processes).toHaveLength(3);
    expect(processes[1]!.closed).toEqual(["changed: model"]);

    await session.newSession();
    expect(processes[2]!.closed).toEqual(["new session"]);
    await session.prompt("five");
    expect(processes).toHaveLength(4);
    await session.dispose();
    expect(processes[3]!.closed).toEqual(["shutdown"]);
  }, 20_000);

  it("marks a reply that answered a question as already read by Claude Code", async () => {
    const session = await newSession();
    const seen: { text: string; alreadyRead: boolean }[] = [];
    claudeCodeLoopMock.mockImplementation(async function* (
      messages: Message[],
      opts: ClaudeCodeLoopOptions,
    ) {
      session.queueMessage("typed over the question", [], { answeredAsk: true });
      session.queueMessage("a plain steer");
      for (const message of (await opts.getSteeringMessages?.()) ?? []) {
        seen.push({
          text: JSON.stringify(message.content),
          alreadyRead: opts.steeringAlreadyRead?.(message) ?? false,
        });
      }
      yield* claudeCodeRun("cc-ask", "answer")(messages, opts);
    });
    await session.prompt("go");
    expect(seen.map((s) => s.alreadyRead)).toEqual([true, false]);
    expect(seen[0]!.text).toContain("typed over the question");
    await session.dispose();
  });

  it("reuses the process after the SDK stamps its version into the env", async () => {
    // Regression: the SDK sets process.env.CLAUDE_AGENT_SDK_VERSION on its first
    // query(), which read as an env change and restarted every chat's second message.
    const saved = process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    try {
      const session = await newSession();
      claudeCodeLoopMock.mockImplementation(claudeCodeRun("cc-5", "answer"));
      await session.prompt("one");
      process.env.CLAUDE_AGENT_SDK_VERSION = "0.0.0-test";
      await session.prompt("two");
      expect(processes).toHaveLength(1);
      await session.dispose();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION;
      else process.env.CLAUDE_AGENT_SDK_VERSION = saved;
    }
  }, 20_000);
});
