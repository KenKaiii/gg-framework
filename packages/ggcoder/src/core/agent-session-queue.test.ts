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
import { useFakeHome } from "../test-support/fake-home.js";

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

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-queue-project-"));
  restoreHome = useFakeHome(tmpHome);
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
  restoreHome?.();
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

describe("AgentSession queue — per-message cancellation", () => {
  it("lists pending messages with stable ids", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      session.queueMessage("second");
      const listed = session.listQueuedMessages();
      expect(listed.map((m) => m.text)).toEqual(["first", "second"]);
      // Ids must be distinct and stable across reads, since the client holds
      // them between rendering a cancel affordance and the click arriving.
      expect(new Set(listed.map((m) => m.id)).size).toBe(2);
      expect(session.listQueuedMessages().map((m) => m.id)).toEqual(listed.map((m) => m.id));
    } finally {
      await session.dispose();
    }
  });

  it("cancels one message by id and leaves the rest in order", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      session.queueMessage("second");
      session.queueMessage("third");
      const [, middle] = session.listQueuedMessages();

      expect(session.cancelQueuedMessage(middle!.id)).toBe(true);
      expect(session.listQueuedMessages().map((m) => m.text)).toEqual(["first", "third"]);
      expect(session.getQueuedCount()).toBe(2);
    } finally {
      await session.dispose();
    }
  });

  it("reports false for an id that already drained, rather than throwing", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      const [only] = session.listQueuedMessages();
      session.takeNextQueuedMessage();

      // The normal race: the agent consumed it between render and click.
      expect(session.cancelQueuedMessage(only!.id)).toBe(false);
      expect(session.getQueuedCount()).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it("does not reuse ids after a cancel, so a stale click cannot hit a new message", async () => {
    const session = await makeSession();
    try {
      session.queueMessage("first");
      const [first] = session.listQueuedMessages();
      session.cancelQueuedMessage(first!.id);
      session.queueMessage("second");

      const [second] = session.listQueuedMessages();
      expect(second!.id).not.toBe(first!.id);
      // A late click carrying the old id must be a no-op, not a cancel of the
      // message that happens to occupy the same position now.
      expect(session.cancelQueuedMessage(first!.id)).toBe(false);
      expect(session.listQueuedMessages().map((m) => m.text)).toEqual(["second"]);
    } finally {
      await session.dispose();
    }
  });
});

describe("AgentSession queue — delivery", () => {
  it("keeps a taken message listed as queued until it lands in the transcript", async () => {
    // Regression: Claude Code takes queued messages at once but reads them at
    // its next turn. Announcing the drain on take made the "queued" look vanish
    // the instant a message was sent.
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      transient: true,
    });
    await session.initialize();
    const drains: number[] = [];
    session.eventBus.on("queue_drained", (d) => drains.push(d.count));
    const seen: Array<{ list: unknown; cancelled: boolean; drains: number }> = [];
    agentLoopMock.mockImplementation(async function* (
      messages: unknown[],
      opts: { getSteeringMessages: () => Array<{ content: unknown }> | null },
    ) {
      session.queueMessage("also check the logs");
      const [taken] = opts.getSteeringMessages() ?? [];
      const id = session.listQueuedMessages()[0]?.id ?? "";
      seen.push({
        list: session.listQueuedMessages(),
        cancelled: session.cancelQueuedMessage(id),
        drains: drains.length,
      });
      messages.push(taken);
      yield { type: "steering_message", content: taken!.content };
      seen.push({ list: session.listQueuedMessages(), cancelled: false, drains: drains.length });
      messages.push({ role: "assistant", content: "done" });
      yield { type: "agent_done", totalTurns: 1, totalUsage: { inputTokens: 0, outputTokens: 0 } };
    });
    try {
      await session.prompt("start");
      expect(seen[0]).toEqual({
        list: [{ id: expect.any(String), text: "also check the logs", delivering: true }],
        cancelled: false,
        drains: 0,
      });
      expect(seen[1]).toEqual({ list: [], cancelled: false, drains: 1 });
      expect(drains).toEqual([0]);
    } finally {
      await session.dispose();
    }
  }, 15_000);
});
