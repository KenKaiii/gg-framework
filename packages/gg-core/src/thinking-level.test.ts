import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeModels, registerRuntimeModels } from "./model-registry.js";
import {
  clampThinkingForPlanMode,
  getLowestThinkingLevel,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./thinking-level.js";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";

describe("getLowestThinkingLevel", () => {
  it.each([
    ["anthropic", "claude-opus-5-5"],
    ["openai", "gpt-6.1-sol"],
    ["gemini", "gemini-3.8-flash"],
    ["glm", "glm-5.3"],
    ["deepseek", "deepseek-v4-pro"],
    ["xai", "grok-4.7"],
    ["moonshot", "kimi-k3"],
  ] as const)("is the first rung of %s %s's own ladder, never off", (provider, model) => {
    const lowest = getLowestThinkingLevel(provider, model);

    expect(lowest).toBeDefined();
    expect(lowest).toBe(getSupportedThinkingLevels(provider, model)[0]);
  });

  it("is undefined only for a model that cannot reason at all", () => {
    expect(getLowestThinkingLevel("huggingface", "moonshotai/Kimi-K2.7-Code")).toBeUndefined();
  });
});

describe("thinking-level helpers", () => {
  it("cycles GPT-6 Astra through the full six-rung ladder up to ultra", () => {
    expect(getSupportedThinkingLevels("openai", "gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getNextThinkingLevel("openai", "gpt-6-astra", undefined)).toBe("low");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "max")).toBe("ultra");
    expect(getNextThinkingLevel("openai", "gpt-6-astra", "ultra")).toBeUndefined();
  });

  it("keeps the legacy medium/high ladder for unregistered custom GPT ids", () => {
    expect(getSupportedThinkingLevels("openai", "gpt-5.2")).toEqual(["medium", "high"]);
    expect(getNextThinkingLevel("openai", "gpt-5.2", "high")).toBeUndefined();
  });

  it("exposes Ultra only for GPT-6 models that support proactive delegation", () => {
    const baseLevels = ["low", "medium", "high", "xhigh", "max"];
    expect(getSupportedThinkingLevels("openai", "gpt-6.1-sol")).toEqual([...baseLevels, "ultra"]);
    expect(getSupportedThinkingLevels("openai", "gpt-6-luna")).toEqual(baseLevels);
    expect(getNextThinkingLevel("openai", "gpt-6.1-sol", "max")).toBe("ultra");
    expect(getNextThinkingLevel("openai", "gpt-6.1-sol", "ultra")).toBeUndefined();
  });

  it("cycles Anthropic adaptive Opus models through max, including xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-opus-5-5", "max")).toBeUndefined();
  });

  it("cycles Sonnet 5.5 through max, including its new xhigh level", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-sonnet-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-sonnet-5-5", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("anthropic", "claude-sonnet-5-5", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("anthropic", "claude-sonnet-5-5", "max")).toBeUndefined();
    expect(isThinkingLevelSupported("anthropic", "claude-sonnet-5-5", "xhigh")).toBe(true);
    expect(isThinkingLevelSupported("anthropic", "claude-sonnet-5", "xhigh")).toBe(false);
  });

  it("cycles Haiku 5.5 through the full adaptive ladder, including xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-haiku-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-haiku-5-5", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("anthropic", "claude-haiku-5-5", "max")).toBeUndefined();
  });

  it("cycles Claude Fable 5.1 through the adaptive ladder without xhigh", () => {
    expect(getSupportedThinkingLevels("anthropic", "claude-fable-5-1")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getNextThinkingLevel("anthropic", "claude-fable-5-1", "high")).toBe("max");
    expect(isThinkingLevelSupported("anthropic", "claude-fable-5-1", "xhigh")).toBe(false);
  });

  it("cycles xAI Grok 4.7 through low, medium, high, and its xhigh rung", () => {
    expect(getSupportedThinkingLevels("xai", "grok-4.7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getNextThinkingLevel("xai", "grok-4.7", undefined)).toBe("low");
    expect(getNextThinkingLevel("xai", "grok-4.7", "low")).toBe("medium");
    expect(getNextThinkingLevel("xai", "grok-4.7", "medium")).toBe("high");
    expect(getNextThinkingLevel("xai", "grok-4.7", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("xai", "grok-4.7", "xhigh")).toBeUndefined();
    expect(isThinkingLevelSupported("xai", "grok-4.7", "xhigh")).toBe(true);
    expect(isThinkingLevelSupported("xai", "grok-4.7", "max")).toBe(false);
  });

  it("cycles Sakana Fugu through high and xhigh", () => {
    expect(getSupportedThinkingLevels("sakana", "fugu")).toEqual(["high", "xhigh"]);
    expect(getSupportedThinkingLevels("sakana", "fugu-max")).toEqual(["high", "xhigh"]);
    expect(getSupportedThinkingLevels("sakana", "fugu-ultra")).toEqual(["high", "xhigh", "max"]);
    expect(getNextThinkingLevel("sakana", "fugu-ultra", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("sakana", "fugu-ultra", "max")).toBeUndefined();
    expect(getNextThinkingLevel("sakana", "fugu", undefined)).toBe("high");
    expect(getNextThinkingLevel("sakana", "fugu", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("sakana", "fugu", "xhigh")).toBeUndefined();
    expect(isThinkingLevelSupported("sakana", "fugu", "medium")).toBe(false);
  });

  it.each(["deepseek-v4-pro", "deepseek-flash"])(
    "cycles %s through low, high, max and off",
    (model) => {
      expect(getSupportedThinkingLevels("deepseek", model)).toEqual(["low", "high", "max"]);
      expect(getNextThinkingLevel("deepseek", model, undefined)).toBe("low");
      expect(getNextThinkingLevel("deepseek", model, "low")).toBe("high");
      expect(getNextThinkingLevel("deepseek", model, "high")).toBe("max");
      expect(getNextThinkingLevel("deepseek", model, "max")).toBeUndefined();
      expect(isThinkingLevelSupported("deepseek", model, "xhigh")).toBe(false);
    },
  );

  it("cycles Kimi K3 through its server-declared low, high, max ladder", () => {
    expect(getSupportedThinkingLevels("moonshot", "kimi-k3")).toEqual(["low", "high", "max"]);
    // K2.8 Preview declares the same ladder as K3.
    expect(getSupportedThinkingLevels("moonshot", "kimi-for-coding")).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(getNextThinkingLevel("moonshot", "kimi-k3", undefined)).toBe("low");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "low")).toBe("high");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "high")).toBe("max");
    expect(getNextThinkingLevel("moonshot", "kimi-k3", "max")).toBeUndefined();
    expect(isThinkingLevelSupported("moonshot", "kimi-k3", "medium")).toBe(false);
  });

  it("cycles GLM-5.3 through the endpoint's declared effort ladder", () => {
    // Verified live: an unlisted effort 400s with `none, minimal, low, medium,
    // high, xhigh, max`. `none` is what the thinking toggle already does and
    // `minimal` has no ThinkingLevel counterpart, so five rungs are exposed.
    expect(getSupportedThinkingLevels("glm", "glm-5.3")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("glm", "glm-5.3", undefined)).toBe("low");
    expect(getNextThinkingLevel("glm", "glm-5.3", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("glm", "glm-5.3", "xhigh")).toBe("max");
    expect(getNextThinkingLevel("glm", "glm-5.3", "max")).toBeUndefined();
    expect(isThinkingLevelSupported("glm", "glm-5.3", "ultra")).toBe(false);
  });

  it("keeps non-cycling providers at their model's sole supported effort", () => {
    expect(getSupportedThinkingLevels("moonshot", "kimi-k2.7-code")).toEqual(["high"]);
    expect(getNextThinkingLevel("moonshot", "kimi-k2.7-code", undefined)).toBe("high");
    expect(getNextThinkingLevel("moonshot", "kimi-k2.7-code", "high")).toBeUndefined();
  });
});

describe("local models", () => {
  const base = {
    provider: "local" as const,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low" as const,
    maxThinkingLevel: "high" as const,
  };

  afterEach(() => clearRuntimeModels());

  it("offers no levels for a local model that does not reason", () => {
    registerRuntimeModels([
      { ...base, id: "local/ollama/plain", name: "plain", supportsThinking: false },
    ]);

    expect(getSupportedThinkingLevels("local", "local/ollama/plain")).toEqual([]);
    // Toggling thinking is a no-op instead of sending a reasoning_effort the
    // server would reject.
    expect(getNextThinkingLevel("local", "local/ollama/plain", undefined)).toBeUndefined();
    expect(isThinkingLevelSupported("local", "local/ollama/plain", "high")).toBe(false);
  });

  it("offers the generic ladder for a thinking-capable local model", () => {
    registerRuntimeModels([
      { ...base, id: "local/ollama/qwen3", name: "qwen3", supportsThinking: true },
    ]);

    expect(getSupportedThinkingLevels("local", "local/ollama/qwen3")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("cycles an Ollama model up to max, then off", () => {
    // Ollama accepts low/medium/high/max on reasoning_effort (verified on 0.32),
    // so discovery gives its models a "max" ceiling.
    registerRuntimeModels([
      {
        ...base,
        id: "local/ollama/qwen3",
        name: "qwen3",
        supportsThinking: true,
        maxThinkingLevel: "max",
      },
    ]);
    const next = (current: ThinkingLevel | undefined) =>
      getNextThinkingLevel("local", "local/ollama/qwen3", current);

    expect(getSupportedThinkingLevels("local", "local/ollama/qwen3")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(next(undefined)).toBe("low");
    expect(next("low")).toBe("medium");
    expect(next("medium")).toBe("high");
    expect(next("high")).toBe("max");
    expect(next("max")).toBeUndefined();
  });

  it("stops at high on servers that never declared max", () => {
    registerRuntimeModels([
      {
        ...base,
        id: "local/vllm/qwen3",
        name: "qwen3",
        supportsThinking: true,
        maxThinkingLevel: "high",
      },
    ]);

    const levels = getSupportedThinkingLevels("local", "local/vllm/qwen3");

    expect(levels).toEqual(["low", "medium", "high"]);
    expect(getNextThinkingLevel("local", "local/vllm/qwen3", "high")).toBeUndefined();
    expect(isThinkingLevelSupported("local", "local/vllm/qwen3", "max")).toBe(false);
  });

  it("never offers xhigh on any local model — no local server accepts it", () => {
    registerRuntimeModels([
      {
        ...base,
        id: "local/ollama/qwen3",
        name: "qwen3",
        supportsThinking: true,
        maxThinkingLevel: "max",
      },
    ]);

    expect(getSupportedThinkingLevels("local", "local/ollama/qwen3")).not.toContain("xhigh");
    expect(isThinkingLevelSupported("local", "local/ollama/qwen3", "xhigh")).toBe(false);
  });

  it("offers nothing for an unknown local id (never discovered)", () => {
    expect(getSupportedThinkingLevels("local", "local/ollama/ghost")).toEqual([]);
  });

  it("caps plan-mode thinking at medium, mirroring the Codex plan preset", () => {
    expect(clampThinkingForPlanMode("ultra")).toBe("medium");
    expect(clampThinkingForPlanMode("max")).toBe("medium");
    expect(clampThinkingForPlanMode("xhigh")).toBe("medium");
    expect(clampThinkingForPlanMode("high")).toBe("medium");
    expect(clampThinkingForPlanMode("medium")).toBe("medium");
    expect(clampThinkingForPlanMode("low")).toBe("low");
    expect(clampThinkingForPlanMode(undefined)).toBeUndefined();
  });
});

describe("MiniMax thinking levels", () => {
  it("offers M3.1 Flash's full low→max effort ladder and cycles through it", () => {
    expect(getSupportedThinkingLevels("minimax", "MiniMax-M3.1-Flash")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getNextThinkingLevel("minimax", "MiniMax-M3.1-Flash", "high")).toBe("xhigh");
    expect(getNextThinkingLevel("minimax", "MiniMax-M3.1-Flash", "max")).toBeUndefined();
  });

  it("keeps M3 as a plain on/off toggle", () => {
    expect(getSupportedThinkingLevels("minimax", "MiniMax-M3")).toEqual(["high"]);
  });
});
