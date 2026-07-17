import { describe, expect, it } from "vitest";
import {
  resolveSessionToolResultCharLimit,
  resolveSessionTurnToolResultCharLimit,
} from "./agent-session.js";

describe("AgentSession tool-result policy", () => {
  it("passes the Codex 10k-token approximation for OpenAI OAuth sessions", () => {
    expect(resolveSessionToolResultCharLimit("gpt-5.6-sol", "openai", "acct_123")).toBe(40_000);
  });

  it("retains the generic context-relative allowance for other transports", () => {
    expect(resolveSessionToolResultCharLimit("claude-sonnet-5", "anthropic", "acct_123")).toBe(
      1_050_000,
    );
    expect(resolveSessionToolResultCharLimit("gpt-5.6-sol", "openai")).toBe(1_102_500);
  });
});

describe("AgentSession per-turn tool-result budget", () => {
  it("scales with the context window at 15% of context chars", () => {
    // claude-sonnet-5: 1M-token window → ceiling applies.
    expect(resolveSessionTurnToolResultCharLimit("claude-sonnet-5", "anthropic", "acct_123")).toBe(
      240_000,
    );
    // OpenAI public API gpt-5.6-sol: 15% of ctx*3.5, within floor/ceiling.
    const publicApi = resolveSessionTurnToolResultCharLimit("gpt-5.6-sol", "openai");
    expect(publicApi).toBeGreaterThanOrEqual(100_000);
    expect(publicApi).toBeLessThanOrEqual(240_000);
  });

  it("floors at 100KB so small windows still allow two full-size reads", () => {
    expect(
      resolveSessionTurnToolResultCharLimit("unknown-model", "openai", "acct_123"),
    ).toBeGreaterThanOrEqual(100_000);
  });
});
