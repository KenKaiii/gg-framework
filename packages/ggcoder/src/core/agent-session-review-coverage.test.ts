import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import type { IdealReviewStats, ReviewCoverageTracker } from "./ideal-review.js";

interface ReviewInternals {
  settingsManager: { get(key: string): boolean };
  hookStats: IdealReviewStats;
  hookFileEditCounts: Map<string, number>;
  reviewCoverage: ReviewCoverageTracker;
  subAgentManager?: { completionGateMessage(): string | undefined };
  getHookFollowUpMessages(): Message[] | null;
}

describe("AgentSession Ideal review coverage gate", () => {
  it("repeats fail-closed follow-ups until every post-injection changed file is read", () => {
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/project",
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.hookStats = {
      changedLines: 130,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    };
    internal.hookFileEditCounts.set("src/a.ts", 1);

    // A pre-review read and a model-authored claim cannot satisfy the gate.
    internal.reviewCoverage.recordRead("src/a.ts");
    const first = internal.getHookFollowUpMessages();
    expect(first?.[0]?.content).toContain("Ideal?");
    expect(first?.[0]?.content).toContain("- src/a.ts");
    const missingA = internal.getHookFollowUpMessages();
    expect(missingA?.[0]?.content).toContain("- src/a.ts");

    // A successful review-time edit expands expected coverage.
    internal.reviewCoverage.recordChanged("src/b.ts");
    internal.reviewCoverage.recordRead("src/a.ts");
    const missingB = internal.getHookFollowUpMessages();
    expect(missingB?.[0]?.content).toContain("- src/b.ts");

    internal.reviewCoverage.recordRead("/project/src/b.ts");
    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });

  it("suppresses only Ideal review while Ken owns autopilot verification", () => {
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/project",
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.hookStats = {
      changedLines: 130,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    };
    internal.hookFileEditCounts.set("src/a.ts", 1);

    session.setIdealReviewSuppressed(true);
    expect(internal.getHookFollowUpMessages()).toBeNull();

    session.setIdealReviewSuppressed(false);
    expect(internal.getHookFollowUpMessages()?.[0]?.content).toContain("Ideal?");
  });

  it("prioritizes the child completion gate before Ideal review", () => {
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/project",
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.subAgentManager = {
      completionGateMessage: () => "Collect child agent recovered-child before finishing.",
    };

    expect(internal.getHookFollowUpMessages()).toEqual([
      { role: "user", content: "Collect child agent recovered-child before finishing." },
    ]);
  });
});
