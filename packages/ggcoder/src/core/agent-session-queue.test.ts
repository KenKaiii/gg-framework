/**
 * Queue semantics the sidecar's stranded-queue drain depends on: a message
 * queued while autopilot reviews (no run in flight) must come back OUT of the
 * queue intact — text AND attachments — in FIFO order, exactly once.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";

const agentLoopMock = vi.hoisted(() => vi.fn());

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

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-project-"));
  process.env.HOME = tmpHome;
  agentLoopMock.mockReset();
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function makeSession() {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    systemPrompt: "test system prompt",
    transient: true,
  });
  await session.initialize();
  return session;
}

describe("AgentSession queue — takeNextQueuedMessage", () => {
  it("returns queued messages FIFO with attachments preserved, then null", async () => {
    const session = await makeSession();
    try {
      const att = {
        kind: "image" as const,
        name: "x.png",
        mediaType: "image/png",
        data: "AAAA",
        path: "/x.png",
      };
      expect(session.queueMessage("first")).toBe(1);
      expect(session.queueMessage("second", [att])).toBe(2);
      expect(session.getQueuedCount()).toBe(2);

      const a = session.takeNextQueuedMessage();
      expect(a).toEqual({ text: "first", attachments: [] });
      const b = session.takeNextQueuedMessage();
      expect(b?.text).toBe("second");
      // Attachments survive the take — drainQueue would have dropped them.
      expect(b?.attachments).toEqual([att]);

      expect(session.getQueuedCount()).toBe(0);
      expect(session.takeNextQueuedMessage()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 15_000);

  it("take and drain never double-deliver the same message", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("only one");
      expect(session.takeNextQueuedMessage()?.text).toBe("only one");
      // Already taken — a subsequent cancel-path drain finds nothing.
      expect(session.drainQueue()).toBe("");
      expect(session.getQueuedCount()).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it("drainQueue still returns merged text for the cancel path", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("alpha");
      session.queueMessage("beta");
      expect(session.drainQueue()).toBe("alpha\n\nbeta");
      expect(session.takeNextQueuedMessage()).toBeNull();
    } finally {
      await session.dispose();
    }
  });
});
