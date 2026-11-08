/**
 * Pushed notifications must reach the model on the steering path — a finished
 * child or an exited background build should arrive on its own, without the
 * agent spending a turn on wait_agent/task_output, and without displacing
 * anything the user queued.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgAgentModule from "@kleio/agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";
import { NOTIFICATION_DRAIN_MAX_CHARS } from "./agent-notifications.js";
import { NOTIFICATION_PREFIX, STEERING_PREFIX } from "./steering.js";

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

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-notify-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-notify-project-"));
  restoreHome = useFakeHome(tmpHome);
  agentLoopMock.mockReset();
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test",
        refreshToken: "test",
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

/** Reach the private members the agent loop drives through its option hooks. */
interface SessionInternals {
  notifications: AgentNotificationQueue;
  getHookSteeringMessages: () => Array<{ role: string; content: unknown }> | null;
}

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
  const internals = session as unknown as SessionInternals;
  return { session, internals };
}

describe("AgentSession pushed notifications", () => {
  it("injects queued notifications as one framed steering message", async () => {
    const { session, internals } = await makeSession();
    try {
      internals.notifications.enqueue("subagent", "a1", 'Child agent "one" is completed.', {
        terminal: true,
      });
      internals.notifications.enqueue("process", "p1", "Build exited 0.", { terminal: true });

      const messages = internals.getHookSteeringMessages();
      expect(messages).toHaveLength(1);
      const content = messages![0]!.content as string;
      expect(content.startsWith(NOTIFICATION_PREFIX)).toBe(true);
      expect(content).toContain('Child agent "one" is completed.');
      expect(content).toContain("Build exited 0.");
      expect(content.length).toBeLessThanOrEqual(
        NOTIFICATION_PREFIX.length + NOTIFICATION_DRAIN_MAX_CHARS + 8,
      );

      // Consumed exactly once — a second poll must not re-inject them.
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 15_000);

  it("never displaces user steering — both ride out in the same batch", async () => {
    const { session, internals } = await makeSession();
    try {
      session.queueMessage("also check the tests");
      internals.notifications.enqueue("subagent", "a1", 'Child agent "one" is completed.', {
        terminal: true,
      });

      const messages = internals.getHookSteeringMessages();
      expect(messages).toHaveLength(2);
      // User steering first: it is an instruction, the notification is a fact.
      expect(messages![0]!.content).toBe(`${STEERING_PREFIX}also check the tests`);
      expect(messages![1]!.content).toContain(NOTIFICATION_PREFIX);
      expect(session.getQueuedCount()).toBe(0);
    } finally {
      await session.dispose();
    }
  }, 15_000);

  it("returns null when nothing is pending", async () => {
    const { session, internals } = await makeSession();
    try {
      expect(internals.getHookSteeringMessages()).toBeNull();
    } finally {
      await session.dispose();
    }
  }, 15_000);
});

describe("AgentSession idle wake", () => {
  it("runs from an urgent background alert as a hidden status update", async () => {
    const { session, internals } = await makeSession();
    try {
      let alerts = 0;
      session.onBackgroundAlert(() => {
        alerts += 1;
      });
      const seen: Array<{ role: string; content: unknown; provenance?: unknown }> = [];
      agentLoopMock.mockImplementation(async function* (
        messages: Array<{ role: string; content: unknown; provenance?: unknown }>,
      ) {
        seen.push(...messages);
        messages.push({ role: "assistant", content: "CI failed on Windows; fixing." });
        yield {
          type: "agent_done",
          totalTurns: 1,
          totalUsage: { inputTokens: 0, outputTokens: 0 },
        };
      });

      // Progress is not an alert: nothing to wake for.
      internals.notifications.enqueue("process", "p0", "Build still running.");
      expect(alerts).toBe(0);
      expect(await session.continueFromNotifications()).toBe(false);
      expect(agentLoopMock).not.toHaveBeenCalled();

      internals.notifications.enqueue(
        "process",
        "p1",
        "Background process p1 exited with code 1.",
        {
          terminal: true,
          urgent: true,
        },
      );
      expect(alerts).toBe(1);
      expect(session.hasPendingBackgroundAlert()).toBe(true);
      const humanBefore = session.getHumanPromptSeq();

      expect(await session.continueFromNotifications()).toBe(true);
      const wake = seen.at(-1);
      expect(wake?.role).toBe("user");
      expect(String(wake?.content).startsWith(NOTIFICATION_PREFIX)).toBe(true);
      expect(String(wake?.content)).toContain("exited with code 1");
      expect(String(wake?.content)).toContain("already finished your turn");
      expect(wake?.provenance).toEqual({
        source: "runtime",
        kind: "notification",
        visibility: "hidden",
      });
      // Delivered once; not a human prompt, so it does not reset wake budgets.
      expect(session.hasPendingBackgroundAlert()).toBe(false);
      expect(session.getHumanPromptSeq()).toBe(humanBefore);
    } finally {
      await session.dispose();
    }
  }, 15_000);
});
