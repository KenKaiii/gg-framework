/**
 * Anthropic cache prewarm must send the exact prefix the next real turn will
 * use (system, tools, thinking, cache options, history) — otherwise it writes a
 * cache entry the real turn never reads.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kleio/agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import {
  stream,
  StreamResult,
  type Message,
  type StreamEvent,
  type StreamResponse,
} from "@kleio/ai";

vi.mock("@kleio/ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

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
        expect(warm?.[key as keyof typeof warm]).toEqual(real[key]);
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
