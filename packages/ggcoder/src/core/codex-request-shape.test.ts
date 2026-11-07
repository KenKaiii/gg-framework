import { describe, expect, it } from "vitest";
import { resolveStrictTools } from "./codex-request-shape.js";

describe("resolveStrictTools", () => {
  it.each([
    ["auto", "openai", false],
    ["off", "openai", false],
    ["on", "openai", true],
    ["auto", "anthropic", undefined],
    ["on", "deepseek", undefined],
  ] as const)("%s / %s → %s", (setting, provider, expected) => {
    expect(resolveStrictTools(setting, provider)).toBe(expected);
  });
});
