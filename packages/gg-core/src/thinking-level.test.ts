import { describe, expect, it } from "vitest";
import {
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./thinking-level.js";

describe("thinking-level helpers", () => {
  it("cycles OpenAI GPT models through supported reasoning efforts", () => {
    expect(getSupportedThinkingLevels("openai", "gpt-5.5")).toEqual(["medium", "high", "xhigh"]);
    expect(getNextThinkingLevel("openai", "gpt-5.5", undefined)).toBe("medium");
    expect(getNextThinkingLevel("openai", "gpt-5.5", "medium")).toBe("high");
    expect(getNextThinkingLevel("openai", "gpt-5.5", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("openai", "gpt-5.5", "xhigh")).toBeUndefined();
  });

  it("cycles Anthropic adaptive Opus models through max, including xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-opus-4-8", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-opus-4-8", "max")).toBeUndefined();
  });

  it("cycles Anthropic adaptive Sonnet models without xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-sonnet-4-6", "high")).toBe("max");
    expect(isThinkingLevelSupported("anthropic", "claude-sonnet-4-6", "xhigh")).toBe(false);
  });

  it("keeps non-cycling providers binary at their model max", () => {
    expect(getSupportedThinkingLevels("moonshot", "kimi-k2.6")).toEqual(["high"]);
    expect(getNextThinkingLevel("moonshot", "kimi-k2.6", undefined)).toBe("high");
    expect(getNextThinkingLevel("moonshot", "kimi-k2.6", "high")).toBeUndefined();
  });
});
