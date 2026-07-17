import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";

const shouldCompactMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());
const agentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return {
    ...actual,
    shouldCompact: shouldCompactMock,
    compact: compactMock,
  };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return {
    ...actual,
    agentLoop: agentLoopMock,
  };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return {
        connectAll: vi.fn(async () => []),
        dispose: vi.fn(async () => {}),
      };
    }),
  };
});

let originalHome: string | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-project-"));
  process.env.HOME = tmpHome;

  shouldCompactMock.mockReset();
  compactMock.mockReset();
  agentLoopMock.mockReset();

  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    anthropic: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
    autoCompact: true,
    compactThreshold: 0.1,
  });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("AgentSession worker auto-compaction", () => {
  it("auto-compacts transient JSON-mode worker sessions before the agent loop runs", async () => {
    const compactedMessages: Message[] = [
      { role: "system", content: "worker system prompt" },
      { role: "user", content: "[compacted worker context]\n\nDo worker task" },
    ];
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockResolvedValue({
      messages: compactedMessages,
      result: {
        compacted: true,
        originalCount: 2,
        newCount: 2,
        tokensBeforeEstimate: 100_000,
        tokensAfterEstimate: 1_000,
      },
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "worker done" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "worker system prompt",
      transient: true,
    });

    await session.initialize();
    await session.prompt("Do worker task");
    await session.dispose();

    expect(shouldCompactMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ role: "user", content: "Do worker task" }]),
      expect.any(Number),
      0.1,
      undefined,
      expect.any(Number),
    );
    expect(compactMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ role: "user", content: "Do worker task" }]),
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-test",
        apiKey: "test-access-token",
      }),
    );
    expect(agentLoopMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        { role: "user", content: "[compacted worker context]\n\nDo worker task" },
      ]),
      expect.objectContaining({ provider: "anthropic", model: "claude-test" }),
    );
  }, 15_000);
});

describe("AgentSession overflow recovery", () => {
  // Regression: the desktop app drives the loop through AgentSession (not the
  // TUI's useContextCompaction hook), and AgentSession never passed
  // `transformContext` — so a provider `request_too_large` / context-overflow
  // (the loop's force-compact path) had NO auto recovery and surfaced straight
  // to the user. This proves the loop's { force: true } call now triggers a
  // real compaction and hands the shrunken history back for retry.
  it("force-compacts and returns the shrunken history when the loop reports overflow", async () => {
    // Pre-turn compaction disabled so we isolate the overflow force path.
    shouldCompactMock.mockReturnValue(false);
    const compactedMessages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "[compacted]" },
    ];
    compactMock.mockResolvedValue({
      messages: compactedMessages,
      result: {
        compacted: true,
        originalCount: 6,
        newCount: 2,
        tokensBeforeEstimate: 500_000,
        tokensAfterEstimate: 2_000,
      },
    });

    let forceResult: Message[] | undefined;
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: { transformContext?: (m: Message[], o?: { force?: boolean }) => Promise<Message[]> },
    ) {
      // Non-force pre-call invocation must pass through untouched.
      const passthrough = await options.transformContext!(messages);
      expect(passthrough).toBe(messages);
      expect(compactMock).not.toHaveBeenCalled();
      // Force invocation (overflow) must compact and return the smaller array.
      forceResult = await options.transformContext!(messages, { force: true });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      transient: true,
    });
    await session.initialize();
    await session.prompt("do the thing");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(forceResult).toEqual(compactedMessages);
  });
});

/** Every .jsonl under the ggcoder session store — must stay empty for
 *  transient sessions (Ken chat/autopilot, subagent spawns). */
async function listSessionFiles(): Promise<string[]> {
  const sessionsDir = path.join(tmpHome, ".gg", "sessions");
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  await walk(sessionsDir);
  return out;
}

describe("transient sessions never leak to the session store", () => {
  // Regression: the Ken autopilot session (transient: true) was leaking one
  // 3-line "## Who you are … Ken Kai" session file per review cycle into the
  // project's session list — via compact() assigning a real sessionPath and
  // via newSession() (autopilot's per-cycle resetReviewer) creating a file
  // unconditionally.

  it("compact() keeps a transient session fully in memory — no session file", async () => {
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockResolvedValue({
      messages: [
        { role: "system", content: "ken system prompt" },
        { role: "user", content: "[compacted]" },
      ],
      result: {
        compacted: true,
        originalCount: 2,
        newCount: 2,
        tokensBeforeEstimate: 100_000,
        tokensAfterEstimate: 1_000,
      },
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "IGNORE" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "ken system prompt",
      transient: true,
    });
    await session.initialize();
    await session.prompt("review this turn");
    // Post-compaction persistence paths must all stay no-ops.
    await session.persistKenTurn("q", "a");
    await session.persistAutopilotMarker("done");
    await session.dispose();

    expect(compactMock).toHaveBeenCalled();
    expect(await listSessionFiles()).toEqual([]);
  });

  it("newSession() on a transient session creates no file and detaches the DAG leaf", async () => {
    shouldCompactMock.mockReturnValue(false);
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "ALL_CLEAR" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "ken system prompt",
      transient: true,
    });
    await session.initialize();
    await session.prompt("cycle 1");
    // Autopilot's per-cycle resetReviewer path.
    await session.newSession();
    await session.prompt("cycle 2");
    await session.dispose();

    expect(await listSessionFiles()).toEqual([]);
  });
});

describe("load-time auto-compaction deferral (deferLoadCompaction)", () => {
  // Regression: resuming an over-context session ran a summary LLM call (30s
  // timeout) inline in loadExistingSession — inside initialize(), which the
  // gg-app sidecar's readiness (waitForReady → the whole webview) is gated on.
  // A slow/hanging summary call froze the window for the full timeout. With
  // deferLoadCompaction the resume returns immediately and runLoop()'s
  // pre-run auto-compaction handles it on the first prompt.

  /** Create + persist a real session file, returning its path. */
  async function persistSession(): Promise<string> {
    shouldCompactMock.mockReturnValue(false);
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "first reply" });
      yield { type: "agent_done" };
    });
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
    });
    await session.initialize();
    await session.prompt("hello");
    await session.dispose();
    const files = await listSessionFiles();
    expect(files.length).toBeGreaterThan(0);
    return files[0]!;
  }

  const compactedResult = {
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "[compacted]" },
    ] as Message[],
    result: {
      compacted: true,
      originalCount: 3,
      newCount: 2,
      tokensBeforeEstimate: 500_000,
      tokensAfterEstimate: 2_000,
    },
  };

  it("defers compaction out of initialize() and runs it on the first prompt", async () => {
    const sessionPath = await persistSession();

    shouldCompactMock.mockReturnValue(true);
    compactMock.mockResolvedValue(compactedResult);
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "resumed reply" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await resumed.initialize();
    // Readiness path must NOT have paid for a summary LLM call.
    expect(compactMock).not.toHaveBeenCalled();

    // First prompt triggers runLoop()'s existing pre-run auto-compaction.
    await resumed.prompt("continue");
    expect(compactMock).toHaveBeenCalledTimes(1);
    await resumed.dispose();
  });

  it("still compacts inline during initialize() without the flag (CLI resume)", async () => {
    const sessionPath = await persistSession();

    shouldCompactMock.mockReturnValue(true);
    compactMock.mockResolvedValue(compactedResult);

    const { AgentSession } = await import("./agent-session.js");
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
    });
    await resumed.initialize();
    expect(compactMock).toHaveBeenCalledTimes(1);
    await resumed.dispose();
  });
});
