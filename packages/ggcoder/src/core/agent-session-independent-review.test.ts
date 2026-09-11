import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import type { IdealReviewStats } from "./ideal-review.js";
import { REVIEWER_TOOLS } from "./ideal-review-subagent.js";

interface ReviewInternals {
  settingsManager: { get(key: string): boolean };
  hookStats: IdealReviewStats;
  hookFileEditCounts: Map<string, number>;
  model: string;
  allowedTools?: string[];
  opts: { allowedTools?: string[] };
  subAgentManager?: unknown;
  independentReviewStarted: boolean;
  eventBus: { on(event: "hook", callback: (data: { kind: string }) => void): () => void };
  getHookFollowUpMessages(): Promise<Message[] | null>;
}

interface FakeSnapshot {
  agent_id: string;
  state: string;
  output?: string;
  error?: string;
}

const workspaces: string[] = [];
function makeWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "gg-independent-review-"));
  workspaces.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/a.ts"), "export const value = 1;\n");
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

/** Score 8 (≥ threshold 6): big change, many mutations, one failure. */
const highStakesStats: IdealReviewStats = {
  changedLines: 130,
  toolCalls: 9,
  toolFailures: 1,
  turns: 6,
  writeCalls: 1,
  editCalls: 3,
  bashCalls: 2,
};

/** Score 4: review-worthy but below the independent-reviewer threshold. */
const moderateStats: IdealReviewStats = {
  changedLines: 120,
  toolCalls: 8,
  toolFailures: 0,
  turns: 3,
  writeCalls: 1,
  editCalls: 1,
  bashCalls: 0,
};

function makeSession(stats: IdealReviewStats, fakeManager: unknown): ReviewInternals {
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd: makeWorkspace(),
    transient: true,
    systemPrompt: "test",
  });
  const internal = session as unknown as ReviewInternals;
  internal.settingsManager = { get: () => true };
  internal.hookStats = stats;
  internal.hookFileEditCounts.set("src/a.ts", 2);
  if (fakeManager) internal.subAgentManager = fakeManager;
  return internal;
}

function fakeManager(output: string) {
  const snapshot: FakeSnapshot = { agent_id: "reviewer-1", state: "completed", output };
  return {
    completionGateMessage: vi.fn(() => undefined),
    spawn: vi.fn(
      async (
        _taskName: string,
        _task: string,
        _agentName?: string,
        _overrides?: unknown,
      ): Promise<FakeSnapshot> => snapshot,
    ),
    wait: vi.fn(async () => ({ timed_out: false, agents: [snapshot] })),
    interrupt: vi.fn(async () => {}),
  };
}

describe("AgentSession independent Ideal reviewer", () => {
  it("announces review before starting and waiting for the independent reviewer", async () => {
    const manager = fakeManager("CLEAR");
    const internal = makeSession(highStakesStats, manager);
    const order: string[] = [];
    internal.eventBus.on("hook", (event) => order.push(event.kind));
    manager.spawn.mockImplementation(async () => {
      order.push("reviewer started");
      return { agent_id: "reviewer-1", state: "completed", output: "CLEAR" };
    });
    manager.wait.mockImplementation(async () => {
      order.push("reviewer finished");
      return {
        timed_out: false,
        agents: [{ agent_id: "reviewer-1", state: "completed", output: "CLEAR" }],
      };
    });
    await internal.getHookFollowUpMessages();
    expect(order).toEqual(["ideal", "reviewer started", "reviewer finished"]);
  });

  it("spawns on the ACTIVE model with read-only tools and prepends findings", async () => {
    const manager = fakeManager(
      "VERDICT: ISSUES\nFINDINGS:\n- src/a.ts: value should be validated before export",
    );
    const internal = makeSession(highStakesStats, manager);

    const messages = await internal.getHookFollowUpMessages();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const [, task, agentName, overrides] = manager.spawn.mock.calls[0] as unknown as [
      string,
      string,
      string | undefined,
      { model?: string; tools?: readonly string[] },
    ];
    // Fresh context (no agent-name routing) + the parent's live model + read-only tools.
    expect(agentName).toBeUndefined();
    expect(overrides.model).toBe("claude-sonnet-5");
    expect(overrides.tools).toEqual([...REVIEWER_TOOLS]);
    expect(task).toContain("independent code reviewer");

    expect(messages?.[0]?.content).toContain("independent reviewer");
    expect(messages?.[0]?.content).toContain("src/a.ts: value should be validated");
    // The in-thread review + coverage requirements ride in the same batch.
    expect(messages?.[1]?.content).toContain("Ideal?");
    expect(messages?.[1]?.content).toContain("src/a.ts");
    expect(internal.independentReviewStarted).toBe(true);
  });

  it("a CLEAN verdict injects nothing — only the in-thread review runs", async () => {
    const manager = fakeManager("VERDICT: CLEAN\nSolid work.");
    const internal = makeSession(highStakesStats, manager);

    const messages = await internal.getHookFollowUpMessages();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(messages?.length).toBe(1);
    expect(messages?.[0]?.content).toContain("Ideal?");
  });

  it("falls back to the in-thread review when the reviewer cannot be parsed", async () => {
    const manager = fakeManager("I could not finish the review");
    const internal = makeSession(highStakesStats, manager);

    const messages = await internal.getHookFollowUpMessages();
    expect(messages?.length).toBe(1);
    expect(messages?.[0]?.content).toContain("Ideal?");
  });

  it("times out, collects the straggler, and falls back without blocking", async () => {
    const manager = fakeManager("");
    manager.wait.mockResolvedValue({
      timed_out: true,
      agents: [{ agent_id: "reviewer-1", state: "running" }],
    });
    const internal = makeSession(highStakesStats, manager);

    const messages = await internal.getHookFollowUpMessages();
    expect(manager.interrupt).toHaveBeenCalledWith("reviewer-1", true);
    expect(messages?.length).toBe(1);
    expect(messages?.[0]?.content).toContain("Ideal?");
  });

  it("skips the reviewer entirely below the score threshold and on spawn failure", async () => {
    const lowScore = fakeManager("VERDICT: CLEAN");
    const below = makeSession(moderateStats, lowScore);
    await below.getHookFollowUpMessages();
    expect(lowScore.spawn).not.toHaveBeenCalled();

    const failing = {
      completionGateMessage: vi.fn(() => undefined),
      spawn: vi.fn(async () => {
        throw new Error("no worker entry");
      }),
      wait: vi.fn(async () => ({ timed_out: false, agents: [] })),
      interrupt: vi.fn(async () => {}),
    };
    const internal = makeSession(highStakesStats, failing);
    const messages = await internal.getHookFollowUpMessages();
    expect(messages?.[0]?.content).toContain("Ideal?");
  });

  it("runs at most once per run even across repeated review triggers", async () => {
    const manager = fakeManager("VERDICT: CLEAN");
    const internal = makeSession(highStakesStats, manager);
    await internal.getHookFollowUpMessages();
    // Simulate the review loop re-arming (coverage re-read) and stopping again.
    internal.hookFileEditCounts.set("src/a.ts", 3);
    await internal.getHookFollowUpMessages();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("falls back cleanly when the reviewer child process fails outright", async () => {
    const manager = fakeManager("");
    manager.wait.mockResolvedValue({
      timed_out: false,
      agents: [{ agent_id: "reviewer-1", state: "failed", error: "worker crashed" }],
    });
    const internal = makeSession(highStakesStats, manager);
    const messages = await internal.getHookFollowUpMessages();
    expect(messages?.length).toBe(1);
    expect(messages?.[0]?.content).toContain("Ideal?");
  });

  it("uses the CURRENT active model, not the session's startup model", async () => {
    const manager = fakeManager("VERDICT: CLEAN");
    const internal = makeSession(highStakesStats, manager);
    // Mid-run model switch: the reviewer must ride the live selection.
    internal.model = "glm-5.4-air";
    await internal.getHookFollowUpMessages();
    const overrides = manager.spawn.mock.calls[0]?.[3] as unknown as { model?: string };
    expect(overrides.model).toBe("glm-5.4-air");
  });

  it("degrades to in-thread review when no subagent manager exists", async () => {
    const internal = makeSession(highStakesStats, undefined);
    const messages = await internal.getHookFollowUpMessages();
    expect(messages?.length).toBe(1);
    expect(messages?.[0]?.content).toContain("Ideal?");
  });

  it("spawns no reviewer when the session is tool-restricted (no spawn_agent)", async () => {
    const manager = fakeManager("VERDICT: ISSUES\nFINDINGS:\n- src/a.ts: broken");
    const internal = makeSession(highStakesStats, manager);
    internal.opts = { allowedTools: ["read", "grep"] };
    const messages = await internal.getHookFollowUpMessages();
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(messages?.[0]?.content).toContain("Ideal?");
  });
});
