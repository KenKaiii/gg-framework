import { describe, expect, it } from "vitest";
import {
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./thinking-level.js";

describe("getNextThinkingLevel", () => {
  it("cycles GPT-6.2 Astra through low, medium, high, xhigh, max, ultra, then off", () => {
    expect(getNextThinkingLevel("openai", "gpt-6.2-astra", undefined)).toBe("low");
    expect(getNextThinkingLevel("openai", "gpt-6.2-astra", "low")).toBe("medium");
    expect(getNextThinkingLevel("openai", "gpt-6.2-astra", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("openai", "gpt-6.2-astra", "max")).toBe("ultra");
    expect(getNextThinkingLevel("openai", "gpt-6.2-astra", "ultra")).toBeUndefined();
  });

  it("recognizes every OpenAI GPT cycle level as supported", () => {
    expect(getSupportedThinkingLevels("openai", "gpt-6.2-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(isThinkingLevelSupported("openai", "gpt-6.2-astra", "medium")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6.2-astra", "xhigh")).toBe(true);
    expect(isThinkingLevelSupported("openai", "gpt-6.2-astra", "ultra")).toBe(true);
  });

  it("cycles Anthropic adaptive models through low, medium, high, xhigh, max, then off", () => {
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", undefined)).toBe("low");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "low")).toBe("medium");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "medium")).toBe("high");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "max")).toBeUndefined();
  });

  it("recognizes Anthropic adaptive effort levels supported by each model", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getSupportedThinkingLevels("anthropic", "claude-sonnet-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(isThinkingLevelSupported("anthropic", "claude-opus-5-5", "max")).toBe(true);
  });

  it("keeps non-GPT OpenAI models as a binary max-thinking toggle", () => {
    expect(getNextThinkingLevel("openai", "o3", undefined)).toBe("high");
    expect(getNextThinkingLevel("openai", "o3", "high")).toBeUndefined();
  });
});
