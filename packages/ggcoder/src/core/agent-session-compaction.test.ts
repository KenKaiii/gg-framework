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
import { useFakeHome } from "../test-support/fake-home.js";

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

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function compactionResult(
  messages: Message[],
  compacted = true,
  contextSelection?: CompactorModule.CompactionContextSelection,
) {
  return {
    messages,
    result: {
      compacted,
      ...(compacted ? {} : { reason: "too_few_messages" }),
      originalCount: compacted ? 6 : messages.length,
      newCount: messages.length,
      tokensBeforeEstimate: 180_000,
      tokensAfterEstimate: compacted ? 2_000 : 180_000,
      ...(contextSelection ? { contextSelection } : {}),
    },
  };
}

const providerModels = MODELS.filter(
  (model, index, models) =>
    models.findIndex((candidate) => candidate.provider === model.provider) === index,
).map((model) => ({ provider: model.provider, model: model.id }));

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-project-"));
  restoreHome = useFakeHome(tmpHome);

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
    "huggingface",
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
  restoreHome?.();
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
    await session.setApprovedPlan("/tmp/approved-plan.md");
    await session.prompt("Do worker task");
    await session.dispose();

    expect(shouldCompactMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Do worker task" }),
      ]),
      expect.any(Number),
      0.1,
      undefined,
      expect.any(Number),
    );
    expect(compactMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Do worker task" }),
      ]),
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-test",
        apiKey: "test-anthropic-token",
        targetTokens: 20_000,
        approvedPlanPath: "/tmp/approved-plan.md",
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

describe("AgentSession compaction persistence", () => {
  it("persists the compaction summary as a new checkpoint in the session log", async () => {
    // "Model-visible means logged" — the compacted history that replaces the
    // conversation is exactly what the next model request will be derived
    // from, so it must land in a NEW persisted session file (the old file
    // stays as the parent for history reconstruction).
    shouldCompactMock.mockReturnValue(false); // manual compact() below, no pre-run auto-compaction
    compactMock.mockResolvedValue({
      messages: [
        { role: "system", content: "worker system prompt" },
        {
          role: "user",
          content: "[session compacted] Summary of earlier work: the task was started.",
        },
      ],
      result: {
        compacted: true,
        originalCount: 3,
        newCount: 2,
        tokensBeforeEstimate: 100_000,
        tokensAfterEstimate: 500,
      },
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "working on it" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    // Non-transient: compact() takes the lease branch that persists a
    // compaction checkpoint (transient sessions compact in memory only).
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "worker system prompt",
    });
    await session.initialize();
    await session.prompt("Do the task.");
    const preCompactPath = session.getState().sessionPath;

    await session.compact();
    expect(compactMock).toHaveBeenCalledTimes(1);
    const postCompactPath = session.getState().sessionPath;
    await session.dispose();

    // The compacted branch is a NEW session file...
    expect(postCompactPath).toBeTruthy();
    expect(postCompactPath).not.toBe(preCompactPath);

    // ...whose persisted rows are the replacement history, not the old one.
    const rows = (await fs.readFile(postCompactPath!, "utf-8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type?: string; message?: Message });
    const texts = rows
      .filter((row) => row.type === "message" && row.message)
      .map((row) =>
        typeof row.message!.content === "string"
          ? row.message!.content
          : JSON.stringify(row.message!.content),
      );
    expect(texts.some((t) => t.includes("[session compacted] Summary of earlier work"))).toBe(true);
    expect(texts.some((t) => t.includes("Do the task."))).toBe(false);
  }, 15_000);
});

/** A 150k-char read superseded by a later read of the same file. */
function supersededReadHistory(): Message[] {
  return [
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
    { role: "tool", content: [{ type: "tool_result", toolCallId: "new-read", content: "fresh" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "latest", name: "grep", args: { pattern: "x" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "latest", content: "latest evidence" }],
    },
    { role: "user", content: "turn 3" },
  ];
}

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
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "latest", name: "grep", args: { pattern: "x" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "latest", content: "latest evidence" }],
        },
        { role: "user", content: "turn 3" },
      );
      // Big enough context for pruning to pay for the cache rewrite.
      capturedMessages = await options.transformContext!(messages, {
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

  it("leaves tool output alone while the context is far below the compaction limit", async () => {
    // Live goal at 117k of a 1M window: each prune freed ~20k tokens but
    // re-sent 70–100k uncached, so a small context must not be pruned.
    shouldCompactMock.mockReturnValue(false);
    let capturedMessages: Message[] = [];

    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      messages.push(...supersededReadHistory());
      capturedMessages = await options.transformContext!(messages, {
        usage: { inputTokens: 1_000, outputTokens: 100 },
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
    await session.prompt("small context");
    await session.dispose();

    const oldRead = capturedMessages
      .filter((msg) => msg.role === "tool")
      .flatMap((msg) => (Array.isArray(msg.content) ? msg.content : []))
      .find((r) => r.type === "tool_result" && r.toolCallId === "old-read");
    expect(oldRead?.content).toBe("x".repeat(150_000));
  });

  it("takes the freed tokens off the provider's count after a prune, never re-estimating the history", async () => {
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
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "latest", name: "grep", args: { pattern: "x" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "latest", content: "latest evidence" }],
        },
        { role: "user", content: "turn 3" },
      );
      // Usage counted the soon-to-be-pruned 150k-char read. After the prune
      // the count must come down by the freed tokens, but stay anchored to
      // the provider's figure: a whole-history estimate rides a shared
      // chars-per-token ratio that once read a 234K MiMo context as ~400K.
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

    // The in-loop decision after the prune: below the stale 180,500 (the
    // freed tokens defer compaction), but still the provider's count minus
    // what was freed — at most 150k chars / 2 chars-per-token = 75k — not an
    // estimate of the (tiny, synthetic) history, which would be far lower.
    const numericCalls = shouldCompactMock.mock.calls
      .map((call) => call[3])
      .filter((tokens): tokens is number => typeof tokens === "number");
    expect(numericCalls.length).toBeGreaterThan(0);
    const afterPrune = numericCalls[0] ?? 0;
    expect(afterPrune).toBeLessThan(180_500);
    expect(afterPrune).toBeGreaterThanOrEqual(180_500 - 75_000);
    // The post-turn probe carries no stale figure either.
    for (const actualTokens of numericCalls.slice(1)) {
      expect(actualTokens).toBeLessThan(180_500);
    }
  });
});

describe("AgentSession post-turn compaction", () => {
  it("compacts in the background after the final response instead of on the next prompt's critical path", async () => {
    // Below threshold before the run, above it once the run's usage lands —
    // exactly the case where the old pre-run-only path charged the next
    // prompt the summarizer latency.
    let overThreshold = false;
    let compactFinished = false;
    shouldCompactMock.mockImplementation(() => overThreshold);
    compactMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      compactFinished = true;
      overThreshold = false; // compacted history is below the threshold again
      return compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted]" },
      ] as Message[]);
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "final answer" });
      overThreshold = true;
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

    // The turn completed WITHOUT waiting on the still-running background
    // compaction — that is the whole point of the post-turn path.
    expect(compactFinished).toBe(false);
    await vi.waitFor(() => expect(compactFinished).toBe(true));
    expect(compactMock).toHaveBeenCalledTimes(1);

    // The next prompt must not compact again (pre-run sees the already-
    // compacted history) and must not be delayed by the finished background
    // compaction's promise tracking.
    await session.prompt("next turn");
    expect(compactMock).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it("newSession() waits for a background compaction so it can't restore the old history", async () => {
    // Accepting a plan resets into a fresh session. A post-turn compaction
    // still running at that moment used to land afterwards and swap the whole
    // planning conversation back in, dropping the approved plan.
    let overThreshold = false;
    let releaseCompaction: (() => void) | undefined;
    let compactFinished = false;
    shouldCompactMock.mockImplementation(() => overThreshold);
    compactMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseCompaction = resolve;
      });
      overThreshold = false;
      compactFinished = true;
      return compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted planning history]" },
      ] as Message[]);
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "plan submitted" });
      overThreshold = true;
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
    await session.prompt("plan the thing");
    await vi.waitFor(() => expect(releaseCompaction).toBeDefined());

    const reset = session.newSession(true);
    // Let the reset get going while the compaction is still parked, then
    // release it and let both settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseCompaction?.();
    await reset;
    await vi.waitFor(() => expect(compactFinished).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const texts = session.getMessages().map((message) => JSON.stringify(message.content));
    expect(texts.some((text) => text.includes("compacted planning history"))).toBe(false);
    expect(session.getMessages().filter((message) => message.role !== "system")).toHaveLength(0);
    await session.dispose();
  });

  it("skips post-turn compaction when a compaction already ran this turn or input is queued", async () => {
    let overThreshold = true;
    shouldCompactMock.mockImplementation(() => overThreshold);
    compactMock.mockImplementation(async () => {
      overThreshold = false;
      return compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted]" },
      ] as Message[]);
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "reply" });
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

    // Case 1: pre-run compaction already handled this turn — the post-turn
    // probe must not fire a second compaction for the same boundary.
    await session.prompt("needs compacting");
    expect(compactMock).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compactMock).toHaveBeenCalledTimes(1);

    // Case 2: user input queued while the run was live — the post-turn path
    // must defer to the queued turn instead of racing it.
    overThreshold = true;
    session.queueMessage("already waiting");
    await session.prompt("another run");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(compactMock).toHaveBeenCalledTimes(2); // pre-run of this turn only
    await session.dispose();
  });

  it("does not drop a prompt that arrives while the background compaction is running", async () => {
    let overThreshold = false;
    let compactFinished = false;
    const loopSnapshots: string[][] = [];
    shouldCompactMock.mockImplementation(() => overThreshold);
    compactMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      compactFinished = true;
      overThreshold = false;
      return compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted]" },
      ] as Message[]);
    });
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      loopSnapshots.push(
        messages.map((m) => (typeof m.content === "string" ? m.content : "<blocks>")),
      );
      messages.push({ role: "assistant", content: "reply" });
      overThreshold = true;
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
    await session.prompt("first turn");
    expect(compactFinished).toBe(false); // background compaction is mid-flight

    // Races the 25ms compaction. Without settling first, this message is
    // pushed onto the array the background compact() is about to replace —
    // silently dropped from the model's view of the conversation.
    await session.prompt("arrived mid-compaction");

    expect(loopSnapshots.length).toBe(2);
    expect(loopSnapshots[1]).toContain("arrived mid-compaction");
    await vi.waitFor(() => expect(compactFinished).toBe(true));
    expect(compactMock).toHaveBeenCalledTimes(1);
    await session.dispose();
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
      160_000, // policy.targetTokens: 0.8 × 200K window (anthropic carries no latency cap)
    );
    expect(compactMock.mock.calls.at(-1)?.[0]).toContainEqual(pendingMessage);
  });

  it("keeps the run's post-compaction messages when the run then fails", async () => {
    shouldCompactMock.mockReturnValue(true);
    // A fresh array per call, like the real compactor.
    compactMock.mockImplementation(async () =>
      compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted in-flight history]" },
      ]),
    );
    const postCompaction: Message[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "t2", name: "read", args: {} }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "t2", content: "out" }] },
    ];
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      // Mirrors agentLoop: adopt the compacted history in place, keep going, then fail.
      const transformed = await options.transformContext!(messages, { pendingMessages: [] });
      messages.length = 0;
      messages.push(...transformed, ...postCompaction);
      yield {
        type: "turn_end",
        turn: 1,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      throw new Error("provider rejected the request");
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
    await expect(session.prompt("run a tool loop")).rejects.toThrow("provider rejected");
    const history = session.getMessages();
    await session.dispose();

    expect(history.slice(-2)).toEqual(postCompaction);
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
      model: "claude-fable-5-1",
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

  it("clears authoritative usage after compaction and does not recompact unchanged context", async () => {
    await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
      autoCompact: true,
      compactThreshold: 0.85,
    });
    const trigger = 170_000;
    let hasCompacted = false;
    const activeTokensAfterCompaction: number[] = [];
    shouldCompactMock.mockImplementation(
      (_messages, _contextWindow, _threshold, actualTokens?: number) => {
        if (hasCompacted && actualTokens !== undefined)
          activeTokensAfterCompaction.push(actualTokens);
        return actualTokens !== undefined && actualTokens >= trigger;
      },
    );
    compactMock.mockImplementation(async () => {
      hasCompacted = true;
      return compactionResult([
        { role: "system", content: "system prompt" },
        { role: "user", content: "[compacted below target]" },
      ]);
    });

    let run = 0;
    agentLoopMock.mockImplementation(async function* (
      messages: Message[],
      options: {
        transformContext?: (m: Message[], o: TransformContextOptions) => Promise<Message[]>;
      },
    ) {
      run += 1;
      await options.transformContext!(messages, { pendingMessages: [] });
      messages.push({ role: "assistant", content: `response ${run}` });
      if (run === 1) {
        yield {
          type: "turn_end",
          turn: 1,
          stopReason: "end_turn",
          usage: { inputTokens: 180_000, outputTokens: 1_000 },
          timing: { startedAt: 1, completedAt: 2, providerDurationMs: 1 },
        };
      }
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-fable-5-1",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      transient: true,
    });
    await session.initialize();
    await session.prompt("first prompt");
    await session.prompt("second prompt triggers compaction");
    await session.prompt("third prompt stays below target");
    await session.dispose();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(activeTokensAfterCompaction.length).toBeGreaterThan(0);
    expect(activeTokensAfterCompaction.every((tokens) => tokens < trigger)).toBe(true);
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

    expect(shouldCompactMock).toHaveBeenCalledWith(
      expect.any(Array),
      200_000,
      0.65,
      1_100,
      130_000, // policy.targetTokens: 0.65 × 200K
    );
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

describe("AgentSession compaction events", () => {
  it("marks a skipped compaction as unsuccessful", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      transient: true,
    });
    await session.initialize();

    compactMock.mockResolvedValue(compactionResult([...session.getMessages()], false));
    const events: Array<{ compacted: boolean; originalCount: number; newCount: number }> = [];
    session.eventBus.on("compaction_end", (event) => events.push(event));

    await session.compact({ accessToken: "token" });

    expect(events).toEqual([{ compacted: false, originalCount: 1, newCount: 1 }]);
    await session.dispose();
  });

  it("emits query-selection token statistics when the compactor ran retrieval", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      transient: true,
    });
    await session.initialize();

    compactMock.mockResolvedValue(
      compactionResult([...session.getMessages()], false, {
        strategy: "query_aware",
        selectedMessages: 8,
        selectedTokens: 1200,
        droppedMessages: 4,
        queryTerms: 3,
      }),
    );
    const events: unknown[] = [];
    session.eventBus.on("compaction_end", (event) => events.push(event));

    await session.compact({ accessToken: "token" });

    expect(events).toEqual([
      {
        compacted: false,
        originalCount: 1,
        newCount: 1,
        selectionStrategy: "query_aware",
        selectedMessages: 8,
        selectedTokens: 1200,
        droppedMessages: 4,
        queryTerms: 3,
      },
    ]);
    await session.dispose();
  });
});

describe("AgentSession.getContextUsage", () => {
  it("reports the model window and drops after a compaction", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const model = MODELS[0]!;
    const session = new AgentSession({
      provider: model.provider,
      model: model.id,
      cwd: tmpProject,
      systemPrompt: "system prompt",
      transient: true,
    });
    await session.initialize();

    const messages = session.getMessages();
    for (let i = 0; i < 40; i += 1) {
      messages.push({ role: "user", content: "a fairly long user message ".repeat(20) });
    }

    const before = session.getContextUsage();
    expect(before.size).toBeGreaterThan(0);
    expect(before.used).toBeGreaterThan(0);
    // No authoritative pricing exists yet, so cost is omitted rather than
    // reported as zero — a client showing $0.00 would be stating a fact we
    // do not have.
    expect(before.costUsd).toBeUndefined();

    compactMock.mockResolvedValue(compactionResult([messages[0]!], true));
    await session.compact({ accessToken: "test-token" });

    const after = session.getContextUsage();
    // Clients detect compaction from exactly this: used falls, size does not.
    expect(after.used).toBeLessThan(before.used);
    expect(after.size).toBe(before.size);
    await session.dispose();
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

  it("coordinates simultaneous compactions and adopts the single checkpoint", async () => {
    const sessionPath = await persistSession();
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return compactedResult;
    });

    const { AgentSession } = await import("./agent-session.js");
    const first = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    const second = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await Promise.all([first.initialize(), second.initialize()]);

    const credentials = { accessToken: "test-token" };
    await Promise.all([
      first.compact(credentials, "automatic"),
      second.compact(credentials, "automatic"),
    ]);

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(first.getState().sessionPath).toBe(second.getState().sessionPath);
    expect(first.getState().sessionPath).not.toBe(sessionPath);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("rebases stale compaction onto a divergent canonical checkpoint", async () => {
    const sessionPath = await persistSession();
    shouldCompactMock.mockReturnValue(false);
    agentLoopMock.mockImplementation(async function* (messages: Message[]) {
      messages.push({ role: "assistant", content: "canonical reply" });
      yield { type: "agent_done" };
    });
    compactMock.mockImplementation(async (messages: Message[]) => {
      const hasCanonicalProgress = messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("canonical progress"),
      );
      return {
        ...compactedResult,
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "user",
            content: hasCanonicalProgress ? "[compacted canonical progress]" : "[compacted stale]",
          },
        ] as Message[],
      };
    });

    const { AgentSession } = await import("./agent-session.js");
    const creator = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    const stale = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await Promise.all([creator.initialize(), stale.initialize()]);

    await creator.prompt("canonical progress");
    shouldCompactMock.mockReturnValue(true);
    await creator.compact({ accessToken: "test-anthropic-token" }, "automatic");
    await stale.compact({ accessToken: "test-anthropic-token" }, "automatic");

    const staleCompactionInput = compactMock.mock.calls[1]?.[0] as Message[];
    expect(staleCompactionInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "[compacted canonical progress]" }),
      ]),
    );
    expect(stale.getMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "[compacted canonical progress]" }),
      ]),
    );
    await Promise.all([creator.dispose(), stale.dispose()]);
  });

  it("deduplicates unchanged no-op attempts but lets manual compaction retry", async () => {
    const sessionPath = await persistSession();
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockImplementation(async (messages: Message[]) =>
      compactionResult([...messages], false),
    );

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await session.initialize();
    const credentials = { accessToken: "test-token" };

    await session.compact(credentials, "automatic");
    await session.compact(credentials, "automatic");
    expect(compactMock).toHaveBeenCalledTimes(1);

    await session.compact(credentials, "manual");
    expect(compactMock).toHaveBeenCalledTimes(2);
    expect(session.getState().sessionPath).toBe(sessionPath);
    await session.dispose();
  });

  it("resolves a stale below-threshold checkpoint path before loading history", async () => {
    const sessionPath = await persistSession();
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockResolvedValue(compactedResult);

    const { AgentSession } = await import("./agent-session.js");
    const creator = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await creator.initialize();
    await creator.compact({ accessToken: "test-anthropic-token" }, "automatic");
    const checkpointPath = creator.getState().sessionPath;
    await creator.dispose();

    shouldCompactMock.mockReturnValue(false);
    const resumed = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await resumed.initialize();

    expect(resumed.getState().sessionPath).toBe(checkpointPath);
    expect(resumed.getMessages()).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "[compacted]" })]),
    );
    expect(compactMock).toHaveBeenCalledTimes(1);
    await resumed.dispose();
  });

  it("adopts a checkpoint created after deferred load before persisting the prompt", async () => {
    const sessionPath = await persistSession();
    shouldCompactMock.mockReturnValue(true);
    compactMock.mockResolvedValue(compactedResult);
    agentLoopMock.mockImplementation(async function* () {
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const creator = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    const follower = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "system prompt",
      sessionId: sessionPath,
      deferLoadCompaction: true,
    });
    await Promise.all([creator.initialize(), follower.initialize()]);
    await creator.compact({ accessToken: "test-token" }, "automatic");
    const checkpointPath = creator.getState().sessionPath;

    shouldCompactMock.mockReturnValue(false);
    await follower.prompt("continue from the shared checkpoint");

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(follower.getState().sessionPath).toBe(checkpointPath);
    expect(follower.getMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "[compacted]" }),
        expect.objectContaining({ content: "continue from the shared checkpoint" }),
      ]),
    );
    await Promise.all([creator.dispose(), follower.dispose()]);
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

describe("AgentSession plan state and dispose", () => {
  it("keeps the cached system prompt byte-identical across plan toggles mid-conversation", async () => {
    shouldCompactMock.mockReturnValue(false);
    agentLoopMock.mockImplementation(async function* () {
      yield { type: "agent_done" };
    });
    const planPath = path.join(tmpProject, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\n## Steps\n1. Do it\n", "utf-8");
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      transient: true,
    });
    await session.initialize();
    const internals = session as unknown as { messages: Message[] };
    await session.prompt("hello");
    const before = internals.messages[0]?.content;

    await session.setPlanMode(true);
    expect(session.getPlanMode()).toBe(true); // tool restrictions read this ref
    expect(internals.messages[0]?.content).toBe(before);
    await session.prompt("plan it");
    await session.setPlanMode(false);
    await session.setApprovedPlan(planPath);
    await session.prompt("go");
    const history = [...internals.messages];
    await session.dispose();

    expect(history[0]?.content).toBe(before);
    const notices = history
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((c) => c.startsWith("Plan state update"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("## Plan Mode (ACTIVE)");
    expect(notices[1]).toContain("## Plan Mode (OFF)");
    expect(notices[1]).toContain("<approved_plan>");
  });

  it("caps dispose's wait for a hanging post-turn compaction and aborts it", async () => {
    const { AgentSession, DISPOSE_COMPACTION_WAIT_MS } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      transient: true,
    });
    await session.initialize();
    const abort = new AbortController();
    const internals = session as unknown as {
      postTurnCompaction?: Promise<void>;
      postTurnCompactionAbort?: AbortController;
    };
    internals.postTurnCompactionAbort = abort;
    internals.postTurnCompaction = new Promise<void>(() => {}); // never settles
    const started = Date.now();
    await session.dispose();
    expect(abort.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(DISPOSE_COMPACTION_WAIT_MS + 2_000);
  });
});
