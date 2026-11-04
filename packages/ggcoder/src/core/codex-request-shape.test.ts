import { describe, expect, it } from "vitest";
import { resolveResponsesLite, resolveStrictTools } from "./codex-request-shape.js";

describe("resolveResponsesLite", () => {
  it.each([
    // setting, provider, model, expected stream option
    ["auto", "openai", "gpt-6-astra", false],
    ["auto", "openai", "gpt-6.1-sol", false],
    ["auto", "openai", "gpt-6-luna", false],
    ["on", "openai", "gpt-6-astra", true],
    ["off", "openai", "gpt-6.1-sol", false],
    ["auto", "openai", "gpt-5.5", undefined],
    ["on", "anthropic", "gpt-6-astra", undefined],
  ] as const)("%s / %s / %s → %s", (setting, provider, model, expected) => {
    expect(resolveResponsesLite(setting, provider, model)).toBe(expected);
  });
});

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
