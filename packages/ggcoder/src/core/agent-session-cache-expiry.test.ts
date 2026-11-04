/**
 * Session wiring for the cold-prompt-cache notice: `getCacheExpiryStatus`
 * anchors on the last successful cache-using request (here a prewarm) and
 * reports expiry against an injected clock.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { stream, StreamResult, type StreamEvent, type StreamResponse } from "@kleio/ai";

vi.mock("@kleio/ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

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
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cache-expiry-home-"));
  restoreHome = useFakeHome(tempHome);
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
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tempHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("AgentSession.getCacheExpiryStatus", () => {
  it("is age_unknown before any request, warm after a prewarm, expired past the TTL", async () => {
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
    try {
      expect(session.getCacheExpiryStatus()).toBeNull(); // empty chat
      session
        .getMessages()
        .push(
          { role: "user", content: "x".repeat(400_000) },
          { role: "assistant", content: "done" },
        );
      expect(session.getCacheExpiryStatus()).toMatchObject({
        provider: "anthropic",
        expired: true,
        reason: "age_unknown",
        notable: true,
      });

      const before = Date.now();
      expect((await session.prewarm()).ok).toBe(true);
      const warm = session.getCacheExpiryStatus();
      expect(warm).toMatchObject({ expired: false, notable: false, reason: null });
      expect(warm?.lastRequestAt).toBeGreaterThanOrEqual(before);
      expect(warm?.ttlMs).toBe(warm!.expiresAt! - warm!.lastRequestAt!);
      expect(warm?.prefixTokens).toBeGreaterThanOrEqual(40_000);

      const cold = session.getCacheExpiryStatus(warm!.expiresAt!);
      expect(cold).toMatchObject({ expired: true, reason: "idle", notable: true });
      expect(cold?.sessionId).toBe(warm?.sessionId);
    } finally {
      await session.dispose();
    }
  }, 30_000);
});
