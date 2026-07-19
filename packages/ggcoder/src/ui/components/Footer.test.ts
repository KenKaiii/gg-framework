import { describe, expect, it } from "vitest";
import { getFooterContextPercent } from "./Footer.js";

describe("Footer route-aware context percentage", () => {
  it("uses the larger public window for API-key OpenAI routes", () => {
    expect(
      getFooterContextPercent("gpt-5.6-terra", 64_000, {
        provider: "openai",
      }),
    ).toBe(6);
  });

  it("uses the Codex product cap for OAuth OpenAI routes", () => {
    expect(
      getFooterContextPercent("gpt-5.6-terra", 64_000, {
        provider: "openai",
        accountId: "acct_123",
      }),
    ).toBe(24);
  });
});
