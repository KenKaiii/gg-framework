import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Provider, Usage } from "@kenkaiiii/gg-ai";
import type { TransformContextOptions } from "@kenkaiiii/gg-agent";
import type * as CompactorModule from "./compaction/compactor.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import { MODELS } from "./model-registry.js";
import { estimateConversationTokens } from "./compaction/token-estimator.js";
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

function compactionResult(messages: Message[], compacted = true) {
  return {
    messages,
    result: {
      compacted,
      ...(compacted ? {} : { reason: "too_few_messages" }),
      originalCount: compacted ? 6 : messages.length,
      newCount: messages.length,
      tokensBeforeEstimate: 180_000,
      tokensAfterEstimate: compacted ? 2_000 : 180_000,
    },
  };
}

const providerModels = MODELS.filter(
  (model, index, models) =>
    models.findIndex((candidate) => candidate.provider === model.provider) === index,
).map((model) => ({ provider: model.provider, model: model.id }));

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-project-"));
  process.env.HOME = tmpHome;

  shouldCompactMock.mockReset();
  compactMock.mockReset();
  agentLoopMock.mockReset();

  const authProviders = [
    "anthropic",
    "openai",
    "sakana",
    "xai",
    "gemini",
    "moonshot",
    "glm",
    "minimax",
    "xiaomi",
    "xiaomi-credits",
    "deepseek",
    "openrouter",
  ];
  await writeJson(
    path.join(tmpHome, ".gg", "auth.json"),
    Object.fromEntries(
      authProviders.map((provider) => [
        provider,
        {
          accessToken: `test-${provider}-token`,
          refreshToken: `test-${provider}-refresh`,
          expiresAt: Date.now() + 3_600_000,
          ...(provider === "openai" ? { accountId: "chatgpt-account" } : {}),
        },
      ]),
    ),
  );
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
    );
    expect(compactMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ role: "user", content: "Do worker task" }]),
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-test",
        apiKey: "test-anthropic-token",
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

describe("AgentSession stale tool-output pruning", () => {
  it("stubs superseded reads in-place during the pre-step transform", async () => {
    shouldCompactMock.mockReturnValue(false);
    let capturedMessages: Message[] = [];

    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      messages.push(
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "old-read", name: "read", args: { file_path: "src/a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "old-read", content: "x".repeat(150_000) }],
        },
        { role: "user", content: "turn 2" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "new-read", name: "read", args: { file_path: "src/a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "new-read", content: "fresh" }],
        },
        { role: "user", content: "turn 3" },
      );
      capturedMessages = await options.transformContext!(messages, { pendingMessages: [] });
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
    await session.prompt("prune me");
    await session.dispose();

    const results = capturedMessages
      .filter((msg) => msg.role === "tool")
      .flatMap((msg) => (Array.isArray(msg.content) ? msg.content : []));
    const oldRead = results.find((r) => r.type === "tool_result" && r.toolCallId === "old-read");
    const newRead = results.find((r) => r.type === "tool_result" && r.toolCallId === "new-read");
    expect(oldRead?.content).toContain("superseded by a newer read");
    expect(newRead?.content).toBe("fresh");
    expect(compactMock).not.toHaveBeenCalled();
  });

  it("discards the turn's provider usage after a prune so freed tokens defer compaction", async () => {
    shouldCompactMock.mockReturnValue(false);

    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      messages.push(
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "old-read", name: "read", args: { file_path: "src/a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "old-read", content: "x".repeat(150_000) }],
        },
        { role: "user", content: "turn 2" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "new-read", name: "read", args: { file_path: "src/a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "new-read", content: "fresh" }],
        },
        { role: "user", content: "turn 3" },
      );
      // Usage counted the soon-to-be-pruned 150k-char read. After the prune
      // it must NOT reach shouldCompact — estimation on the pruned history
      // takes over instead.
      await options.transformContext!(messages, {
        usage: { inputTokens: 180_000, outputTokens: 500 },
        pendingMessages: [],
      });
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
    await session.prompt("prune usage fallback");
    await session.dispose();

    // The transform after the in-loop mutation is the last shouldCompact call;
    // its actualTokens argument must be an estimate of the pruned history,
    // far below the stale 180k usage figure.
    const lastCall = shouldCompactMock.mock.calls.at(-1)!;
    const actualTokens = lastCall[3] as number;
    expect(actualTokens).toBeLessThan(50_000);
  });
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
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      // Non-force pre-call invocation must pass through untouched.
      const passthrough = await options.transformContext!(messages, { pendingMessages: [] });
      expect(passthrough).toBe(messages);
      expect(compactMock).not.toHaveBeenCalled();
      // Force invocation (overflow) must compact and return the smaller array.
      forceResult = await options.transformContext!(messages, {
        force: true,
        pendingMessages: [],
      });
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

describe("AgentSession mid-turn compaction", () => {
  it("compacts non-forced in-flight history exactly at the configured 80% boundary", async () => {
    await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
      autoCompact: true,
      compactThreshold: 0.8,
    });
    const pendingMessage: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "t1",
          content: "pending tool output ".repeat(8),
        },
      ],
    };
    const usage: Usage = {
      inputTokens: 159_900,
      cacheRead: 30,
      cacheWrite: 20,
      outputTokens: 40,
    };

    shouldCompactMock.mockImplementation(
      (_messages, contextWindow: number, threshold: number, actualTokens?: number) =>
        actualTokens !== undefined && actualTokens >= Math.ceil(contextWindow * threshold),
    );
    const compactedMessages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "[compacted in-flight history]" },
    ];
    compactMock.mockResolvedValue(compactionResult(compactedMessages));

    let transformed: Message[] | undefined;
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: {} }],
      });
      messages.push(pendingMessage);
      transformed = await options.transformContext!(messages, {
        usage,
        pendingMessages: [pendingMessage],
      });
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
    await session.prompt("run a tool loop");
    await session.dispose();

    // Computed after the run: the anchored usage sample calibrates the token
    // estimator, so the pending-message estimate must use the same calibrated
    // ratio the transform used when it called shouldCompact.
    const expectedActiveTokens =
      usage.inputTokens +
      usage.cacheRead! +
      usage.cacheWrite! +
      usage.outputTokens +
      estimateConversationTokens([pendingMessage]);
    expect(expectedActiveTokens).toBeGreaterThanOrEqual(160_000);

    expect(transformed).toEqual(compactedMessages);
    expect(shouldCompactMock).toHaveBeenCalledWith(
      expect.any(Array),
      200_000,
      0.8,
      expectedActiveTokens,
    );
    expect(compactMock.mock.calls.at(-1)?.[0]).toContainEqual(pendingMessage);
  });

  it("reuses authoritative usage for the first context check of the next prompt", async () => {
    const usage: Usage = { inputTokens: 120_000, outputTokens: 100 };
    shouldCompactMock.mockImplementation(
      (_messages, contextWindow: number, threshold: number, actualTokens?: number) =>
        actualTokens !== undefined && actualTokens >= Math.ceil(contextWindow * threshold),
    );
    compactMock.mockResolvedValue(
      compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted across prompts]" },
      ]),
    );

    let run = 0;
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      run += 1;
      await options.transformContext!(messages, { pendingMessages: [] });
      if (run === 1) {
        messages.push({ role: "assistant", content: "first response" });
        yield {
          type: "turn_end",
          turn: 1,
          stopReason: "end_turn",
          usage,
          timing: {
            startedAt: 1,
            completedAt: 2,
            providerDurationMs: 1,
          },
        };
      }
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-fable-5",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      transient: true,
    });
    await session.initialize();
    await session.prompt("first prompt");
    await session.prompt("second prompt");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(
      shouldCompactMock.mock.calls.some(
        (call) => typeof call[3] === "number" && call[3] >= usage.inputTokens + usage.outputTokens,
      ),
    ).toBe(true);
  });

  it.each(providerModels)(
    "$provider uses the same normalized usage formula",
    async ({ provider, model }) => {
      await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
        autoCompact: true,
        compactThreshold: 0.8,
      });
      shouldCompactMock.mockReturnValue(false);
      const usage: Usage = {
        inputTokens: 100,
        cacheRead: 30,
        cacheWrite: 20,
        outputTokens: 40,
      };
      const expectedActiveTokens = 190;

      agentLoopMock.mockImplementation(async function* (
        messages: Message[],
        options: {
          transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
        },
      ) {
        await options.transformContext!(messages, {
          usage,
          pendingMessages: [],
        });
        yield { type: "agent_done" };
      });

      const { AgentSession } = await import("./agent-session.js");
      const session = new AgentSession({
        provider: provider as Provider,
        model,
        cwd: tmpProject,
        systemPrompt: "system prompt",
        transient: true,
      });
      await session.initialize();
      await session.prompt("test normalized usage");
      await session.dispose();

      expect(shouldCompactMock.mock.calls.some((call) => call[3] === expectedActiveTokens)).toBe(
        true,
      );
    },
    15_000,
  );

  it("honors a custom threshold during a non-forced transform", async () => {
    await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
      autoCompact: true,
      compactThreshold: 0.65,
    });
    shouldCompactMock.mockReturnValue(false);
    const usage: Usage = { inputTokens: 1_000, outputTokens: 100 };

    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      await options.transformContext!(messages, { usage, pendingMessages: [] });
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
    await session.prompt("custom threshold");
    await session.dispose();

    expect(shouldCompactMock).toHaveBeenCalledWith(expect.any(Array), 200_000, 0.65, 1_100);
  });

  it("honors autoCompact false for non-forced calls but force bypasses settings and cooldown", async () => {
    await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
      autoCompact: false,
      compactThreshold: 0.8,
    });
    const compactedMessages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "[forced compaction]" },
    ];
    compactMock
      .mockResolvedValueOnce(
        compactionResult(
          [
            { role: "system", content: "system prompt" },
            { role: "user", content: "too little history" },
            { role: "assistant", content: "reply" },
          ],
          false,
        ),
      )
      .mockResolvedValueOnce(compactionResult(compactedMessages));

    let nonForcedResult: Message[] | undefined;
    let forcedResult: Message[] | undefined;
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      nonForcedResult = await options.transformContext!(messages, { pendingMessages: [] });
      await options.transformContext!(messages, { force: true, pendingMessages: [] });
      forcedResult = await options.transformContext!(messages, {
        force: true,
        pendingMessages: [],
      });
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
    await session.prompt("force despite settings");
    await session.dispose();

    expect(nonForcedResult).toBeDefined();
    expect(shouldCompactMock).not.toHaveBeenCalled();
    expect(compactMock).toHaveBeenCalledTimes(2);
    expect(forcedResult).toEqual(compactedMessages);
  });

  it("cools down after a non-forced no-op instead of retrying every tool step", async () => {
    shouldCompactMock.mockImplementation(
      (_messages, _contextWindow, _threshold, actualTokens?: number) => actualTokens !== undefined,
    );
    compactMock.mockImplementation(async (messages: Message[]) =>
      compactionResult([...messages], false),
    );

    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      const transformOptions: TransformContextOptions = {
        usage: { inputTokens: 180_000, outputTokens: 1_000 },
        pendingMessages: [],
      };
      await options.transformContext!(messages, transformOptions);
      await options.transformContext!(messages, transformOptions);
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
    await session.prompt("no-op cooldown");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
  });

  it("cools down after a failed proactive summary", async () => {
    shouldCompactMock.mockImplementation(
      (_messages, _contextWindow, _threshold, actualTokens?: number) => actualTokens !== undefined,
    );
    compactMock.mockRejectedValue(new Error("summary unavailable"));

    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      const transformOptions: TransformContextOptions = {
        usage: { inputTokens: 180_000, outputTokens: 1_000 },
        pendingMessages: [],
      };
      await options.transformContext!(messages, transformOptions);
      await options.transformContext!(messages, transformOptions);
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
    await session.prompt("failure cooldown");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
  });

  it("continues the run and cools down across prompts after pre-run compaction fails", async () => {
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockRejectedValue(new Error("summary unavailable"));
    agentLoopMock.mockImplementation(async function* () {
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
    await session.prompt("first prompt");
    await session.prompt("second prompt");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(agentLoopMock).toHaveBeenCalledTimes(2);
  });

  it("cools down across prompts after pre-run compaction is a no-op", async () => {
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockImplementation(async (messages: Message[]) =>
      compactionResult([...messages], false),
    );
    agentLoopMock.mockImplementation(async function* () {
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
    await session.prompt("first prompt");
    await session.prompt("second prompt");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(agentLoopMock).toHaveBeenCalledTimes(2);
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
