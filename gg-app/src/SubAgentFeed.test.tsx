import { describe, expect, it } from "vitest";
import { formatSubAgentTokens } from "./SubAgentFeed";

describe("formatSubAgentTokens", () => {
  it("adds Anthropic cache writes to fresh input for provider-neutral usage", () => {
    expect(
      formatSubAgentTokens({ input: 2, output: 500, cacheRead: 80_000, cacheWrite: 12_000 }),
    ).toBe("↑ 12.0k · ↻ 80k cached · ↓ 500");
  });

  it("keeps OpenAI non-cached input unchanged", () => {
    expect(formatSubAgentTokens({ input: 50_000, output: 800, cacheRead: 65_000 })).toBe(
      "↑ 50k · ↻ 65k cached · ↓ 800",
    );
  });
});
