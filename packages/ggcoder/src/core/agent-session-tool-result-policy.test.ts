import { describe, expect, it } from "vitest";
import { resolveSessionToolResultCharLimit } from "./agent-session.js";

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
