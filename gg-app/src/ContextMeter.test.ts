import { describe, expect, it } from "vitest";
import { getContextPercent } from "./ContextMeter";

describe("getContextPercent", () => {
  it("uses the explicit Sol context window supplied for a custom Azure deployment", () => {
    expect(getContextPercent(210_000, 1_050_000)).toBe(20);
  });

  it("clamps conservative or missing context windows safely", () => {
    expect(getContextPercent(210_000, 128_000)).toBe(100);
    expect(getContextPercent(210_000, undefined)).toBe(0);
  });
});
