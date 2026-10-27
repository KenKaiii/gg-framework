/**
 * Anthropic cache prewarm must send the exact prefix the next real turn will
 * use (system, tools, thinking, cache options, history) — otherwise it writes a
 * cache entry the real turn never reads.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { stablePrefixEnd } from "./compaction/tool-result-pruner.js";
import {
  stream,
  StreamResult,
  type Message,
  type StreamEvent,
  type StreamResponse,
} from "@kenkaiiii/gg-ai";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

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
let tempHome: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prewarm-home-"));
  restoreHome = useFakeHome(tempHome);
  agentLoopMock.mockReset().mockImplementation(async function* () {
    yield* [];
  });
  vi.mocked(stream)
    .mockReset()
    .mockImplementation(
      () =>
        new StreamResult(
          (async function* (): AsyncGenerator<StreamEvent, StreamResponse> {
            yield* [];
            return {
              message: { role: "assistant", content: "." },
              stopReason: "max_tokens",
              usage: { inputTokens: 3, outputTokens: 1, cacheWrite: 9000 },
            };
          })(),
        ),
    );
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "claude-code-version.json"),
    JSON.stringify({ version: "2.1.75", fetchedAt: Date.now() }),
  );
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: { accessToken: "t", refreshToken: "t", expiresAt: Date.now() + 3_600_000 },
      openai: { accessToken: "t", refreshToken: "t", expiresAt: Date.now() + 3_600_000 },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tempHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function createSession(historyChars: number) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-fable-5-1",
    cwd: process.cwd(),
    systemPrompt: "stable role prompt",
    thinkingLevel: "high",
    transient: true,
    selfCorrectionHooks: false,
  });
  await session.initialize();
  session
    .getMessages()
    .push(
      { role: "user", content: "x".repeat(historyChars) },
      { role: "assistant", content: "done" },
    );
  return session;
}

describe("AgentSession.prewarm", () => {
  it("sends the same system/tools/thinking/history prefix as the next real prompt", async () => {
    const session = await createSession(40_000);
    try {
      const result = await session.prewarm();
      expect(result).toMatchObject({ ok: true, reason: "warmed" });
      expect(vi.mocked(stream)).toHaveBeenCalledTimes(1);
      const warm = vi.mocked(stream).mock.calls[0]?.[0];
      expect(warm?.prewarm).toBe(true);

      await session.prompt("next question");
      const [realMessages, real] = agentLoopMock.mock.calls[0] as [
        Message[],
        Record<string, unknown>,
      ];
      for (const key of [
        "provider",
        "model",
        "tools",
        "webSearch",
        "maxTokens",
        "thinking",
        "cacheRetention",
        "promptCacheKey",
        "transportSessionId",
        "userAgent",
      ]) {
        // The loop takes webSearch as a per-request getter (native search can
        // be attached mid-run); parity is about the value the request carries.
        const realValue =
          typeof real[key] === "function" ? (real[key] as () => unknown)() : real[key];
        expect(warm?.[key as keyof typeof warm]).toEqual(realValue);
      }
      // Prewarm ends at the last user turn; the real request extends it.
      const warmMessages = warm?.messages ?? [];
      expect(warmMessages.length).toBeGreaterThan(1);
      expect(warmMessages.at(-1)?.role).toBe("user");
      expect(realMessages.slice(0, warmMessages.length)).toEqual(warmMessages);
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("warms the language-pack system prompt the first real turn will send", async () => {
    // Default (non-custom) prompt in a TypeScript project: style packs are
    // detected at run start, so a prewarm that skipped detection warmed a
    // shorter system block and the real turn missed the whole cached history.
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prewarm-ts-"));
    await fs.writeFile(path.join(project, "tsconfig.json"), "{}");
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-fable-5-1",
      cwd: project,
      thinkingLevel: "high",
      transient: true,
      selfCorrectionHooks: false,
    });
    try {
      await session.initialize();
      session
        .getMessages()
        .push(
          { role: "user", content: "x".repeat(40_000) },
          { role: "assistant", content: "done" },
        );
      expect(await session.prewarm()).toMatchObject({ ok: true });
      const warmSystem = vi.mocked(stream).mock.calls[0]?.[0].messages[0];

      await session.prompt("next question");
      const [realMessages] = agentLoopMock.mock.calls[0] as [Message[]];
      expect(String(warmSystem?.content)).toContain("### TypeScript");
      expect(warmSystem).toEqual(realMessages[0]);
    } finally {
      await session.dispose();
      await fs.rm(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("skips when the next prompt will compact the history anyway", async () => {
    // threshold 0.1 of 1M = 100K-token trigger; ~143K tokens of history
    await fs.writeFile(
      path.join(tempHome, ".gg", "settings.json"),
      JSON.stringify({ compactThreshold: 0.1 }),
    );
    const session = await createSession(500_000);
    // compaction needs at least four messages
    session
      .getMessages()
      .push({ role: "user", content: "and then?" }, { role: "assistant", content: "ok" });
    try {
      expect(await session.prewarm()).toMatchObject({ ok: false, reason: "compaction_due" });
      expect(vi.mocked(stream)).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("applies a due tool-output prune first, so the next request warms and prunes nothing", async () => {
    // threshold 0.1 of 1M: prune is due from 50K tokens, compaction from 100K;
    // ten ~8.6K-token tool results (~86K) sit between the two.
    await fs.writeFile(
      path.join(tempHome, ".gg", "settings.json"),
      JSON.stringify({ compactThreshold: 0.1 }),
    );
    const session = await createSession(1_000);
    const history = session.getMessages();
    for (let i = 0; i < 10; i++) {
      const id = `toolu_${i}`;
      history.push(
        { role: "user", content: `step ${i}` },
        {
          role: "assistant",
          content: [{ type: "tool_call", id, name: "bash", args: { command: `cat part${i}.log` } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: id, content: `${i}`.repeat(30_000) }],
        },
        { role: "assistant", content: `noted part ${i}` },
      );
    }
    try {
      expect(await session.prewarm()).toMatchObject({ ok: true, reason: "warmed" });
      const warmMessages = vi.mocked(stream).mock.calls[0]?.[0].messages ?? [];
      expect(JSON.stringify(warmMessages)).toContain("[Pruned:");

      await session.prompt("next question");
      const [realMessages, real] = agentLoopMock.mock.calls[0] as [
        Message[],
        {
          transformContext: (m: Message[], o: { pendingMessages: Message[] }) => Promise<Message[]>;
        },
      ];
      expect(realMessages.slice(0, warmMessages.length)).toEqual(warmMessages);
      // The request's own context transform finds nothing further to prune (it
      // only pins the cache anchor the prewarm's prune left pending).
      const content = (messages: Message[]) => JSON.stringify(messages.map((m) => m.content));
      const before = content(realMessages);
      await real.transformContext(realMessages, { pendingMessages: [] });
      expect(content(realMessages)).toBe(before);
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("pins the cache anchor where a prune left history stable, one step later", async () => {
    // threshold 0.1 of 1M: prune is due from 50K tokens, compaction from 100K.
    await fs.writeFile(
      path.join(tempHome, ".gg", "settings.json"),
      JSON.stringify({ compactThreshold: 0.1 }),
    );
    const session = await createSession(1_000);
    const history = session.getMessages();
    for (let i = 0; i < 10; i++) {
      const id = `toolu_${i}`;
      history.push(
        {
          role: "assistant",
          content: [{ type: "tool_call", id, name: "bash", args: { command: `cat part${i}.log` } }],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: id, content: `${i}`.repeat(30_000) }],
        },
      );
    }
    try {
      await session.prompt("next question");
      const [loopMessages, loop] = agentLoopMock.mock.calls[0] as [
        Message[],
        {
          transformContext: (m: Message[], o: { pendingMessages: Message[] }) => Promise<Message[]>;
        },
      ];
      const anchored = () => loopMessages.filter((m) => m.cacheAnchor === true);

      // Step 1 prunes; the request it feeds still reads through the old anchor.
      await loop.transformContext(loopMessages, { pendingMessages: [] });
      expect(JSON.stringify(loopMessages)).toContain("[Pruned:");
      expect(anchored()).toEqual([]);
      const expected = stablePrefixEnd(loopMessages);
      expect(expected).toBeDefined();

      // Step 2 moves the anchor there and prunes nothing in the same request.
      const before = JSON.stringify(loopMessages);
      await loop.transformContext(loopMessages, { pendingMessages: [] });
      expect(anchored()).toEqual([expected]);
      expect(JSON.stringify(loopMessages.map(({ cacheAnchor: _, ...m }) => m))).toBe(
        JSON.stringify(JSON.parse(before).map(({ cacheAnchor: _, ...m }: Message) => m)),
      );
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("skips below 4k estimated tokens", async () => {
    const session = await createSession(100);
    try {
      expect(await session.prewarm()).toMatchObject({ ok: false, reason: "too_small" });
      expect(vi.mocked(stream)).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("skips within the cache TTL after a prewarm or a real request", async () => {
    const session = await createSession(40_000);
    try {
      expect((await session.prewarm()).ok).toBe(true);
      expect(await session.prewarm()).toMatchObject({ ok: false, reason: "cache_fresh" });
      expect(vi.mocked(stream)).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
    const fresh = await createSession(40_000);
    try {
      await fresh.prompt("real turn");
      expect(await fresh.prewarm()).toMatchObject({ ok: false, reason: "cache_fresh" });
      expect(vi.mocked(stream)).toHaveBeenCalledTimes(1);
    } finally {
      await fresh.dispose();
    }
  }, 30_000);

  it("skips while a run is active", async () => {
    const session = await createSession(40_000);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    agentLoopMock.mockImplementation(async function* () {
      await gate;
      yield* [];
    });
    try {
      const run = session.prompt("long task");
      await vi.waitFor(() => expect(agentLoopMock).toHaveBeenCalled());
      expect(await session.prewarm()).toMatchObject({ ok: false, reason: "run_active" });
      release();
      await run;
      expect(vi.mocked(stream)).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  }, 30_000);

  it("aborts an in-flight prewarm when a prompt starts", async () => {
    const session = await createSession(40_000);
    vi.mocked(stream).mockImplementation(
      (options) =>
        new StreamResult(
          (async function* (): AsyncGenerator<StreamEvent, StreamResponse> {
            yield* [];
            await new Promise<void>((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
            throw new Error("unreachable");
          })(),
          options.signal,
        ),
    );
    try {
      const warm = session.prewarm();
      await vi.waitFor(() => expect(vi.mocked(stream)).toHaveBeenCalled());
      await session.prompt("go");
      expect(await warm).toMatchObject({ ok: false, reason: "aborted" });
      expect(vi.mocked(stream).mock.calls[0]?.[0].signal?.aborted).toBe(true);
    } finally {
      await session.dispose();
    }
  }, 30_000);
});
