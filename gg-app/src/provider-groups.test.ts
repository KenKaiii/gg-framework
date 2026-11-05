import { describe, expect, it } from "vitest";
import { brainTier, groupProviders, providerGroupOf } from "./provider-groups";

describe("groupProviders", () => {
  it("groups by country in display order and keeps each group's provider order", () => {
    const list = ["deepseek", "anthropic", "openrouter", "moonshot", "sakana", "openai"].map(
      (value) => ({ value }),
    );
    expect(groupProviders(list).map((g) => [g.group.id, g.providers.map((p) => p.value)])).toEqual([
      ["us", ["anthropic", "openai"]],
      ["cn", ["deepseek", "moonshot"]],
      ["jp", ["sakana"]],
      ["gw", ["openrouter"]],
    ]);
  });

  it("puts an unknown provider in Other instead of dropping it", () => {
    expect(providerGroupOf("newlab")).toBe("other");
    expect(groupProviders([{ value: "newlab" }]).map((g) => g.group.name)).toEqual(["Other"]);
  });
});

describe("brainTier", () => {
  it("climbs with connections and reaches the top step only with every provider in", () => {
    expect([0, 1, 2, 3, 4, 6, 7, 10].map((n) => brainTier(n, 11))).toEqual([
      0, 1, 2, 2, 3, 3, 4, 4,
    ]);
    expect(brainTier(11, 11)).toBe(5);
    expect(brainTier(3, 3)).toBe(5);
    expect(brainTier(0, 0)).toBe(0);
  });
});
