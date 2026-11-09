import { describe, expect, it } from "vitest";
import { anthropicMinCacheableTokens } from "./cache-minimums.js";

describe("anthropicMinCacheableTokens", () => {
  it.each([
    ["claude-haiku-4-5-20251001", 4096],
    ["claude-opus-4-6", 4096],
    ["claude-opus-4-5-20251101", 4096],
    ["claude-sonnet-4-5-20250929", 1024],
    ["claude-opus-5-5", 512],
    ["claude-haiku-5-5", 512],
    ["claude-fable-5-2", 512],
    ["unknown-model", 1024],
  ])("%s → %i", (model, min) => {
    expect(anthropicMinCacheableTokens(model)).toBe(min);
  });
});
