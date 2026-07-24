import { describe, expect, it } from "vitest";
import { XIAOMI_CREDITS_KEY } from "./auth-storage.js";
import {
  MODELS,
  getAuthStorageKey,
  getAuthStorageKeys,
  getContextWindow,
  getDefaultModel,
  getDefaultThinkingLevel,
  getFastModel,
  getModelsForProvider,
  getToolResultCharLimit,
  usesOpenAICodexTransport,
} from "./model-registry.js";

const PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "moonshot",
  "glm",
  "minimax",
  "xiaomi",
  "deepseek",
  "openrouter",
  "sakana",
  "xai",
] as const;
const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const COST_TIERS = ["low", "medium", "high"] as const;

describe("model registry invariants", () => {
  it("has unique ids and coherent required metadata for every entry", () => {
    const ids = new Set<string>();

    for (const model of MODELS) {
      expect(ids.has(model.id), `${model.id} is duplicated`).toBe(false);
      ids.add(model.id);
      expect(model.id, `${model.id} id`).toEqual(expect.any(String));
      expect(model.name, `${model.id} name`).toEqual(expect.any(String));
      expect(PROVIDERS, `${model.id} provider`).toContain(model.provider);
      expect(model.contextWindow, `${model.id} contextWindow`).toBeGreaterThan(0);
      expect(Number.isInteger(model.contextWindow), `${model.id} contextWindow integer`).toBe(true);
      expect(model.maxOutputTokens, `${model.id} maxOutputTokens`).toBeGreaterThan(0);
      expect(Number.isInteger(model.maxOutputTokens), `${model.id} maxOutputTokens integer`).toBe(
        true,
      );
      expect(
        model.maxOutputTokens,
        `${model.id} maxOutputTokens <= contextWindow`,
      ).toBeLessThanOrEqual(model.contextWindow);
      expect(typeof model.supportsThinking, `${model.id} supportsThinking`).toBe("boolean");
      expect(typeof model.supportsImages, `${model.id} supportsImages`).toBe("boolean");
      expect(typeof model.supportsVideo, `${model.id} supportsVideo`).toBe("boolean");
      expect(COST_TIERS, `${model.id} costTier`).toContain(model.costTier);
      expect(THINKING_LEVELS, `${model.id} maxThinkingLevel`).toContain(model.maxThinkingLevel);
      if (!model.supportsThinking) {
        expect(model.maxThinkingLevel, `${model.id} non-thinking max level`).toBe("low");
      }
      if (model.codexContextWindow !== undefined) {
        expect(model.provider, `${model.id} codexContextWindow provider`).toBe("openai");
        expect(model.codexContextWindow, `${model.id} codexContextWindow`).toBeGreaterThan(0);
        expect(
          Number.isInteger(model.codexContextWindow),
          `${model.id} codexContextWindow integer`,
        ).toBe(true);
        expect(
          model.codexContextWindow,
          `${model.id} codexContextWindow <= contextWindow`,
        ).toBeLessThanOrEqual(model.contextWindow);
        expect(
          model.maxOutputTokens,
          `${model.id} maxOutputTokens <= codexContextWindow`,
        ).toBeLessThanOrEqual(model.codexContextWindow);
      }
    }
  });

  it("returns a registered default model for every provider", () => {
    for (const provider of PROVIDERS) {
      const defaultModel = getDefaultModel(provider);
      expect(defaultModel.provider, `${provider} default provider`).toBe(provider);
      expect(MODELS, `${provider} default registered`).toContain(defaultModel);
    }
  });
});

describe("getFastModel", () => {
  it("routes to a low-tier sibling within the same provider", () => {
    for (const provider of PROVIDERS) {
      const current = getDefaultModel(provider);
      const fast = getFastModel(provider, current.id);
      // Never crosses providers — the user may only have this one connected.
      expect(fast.provider).toBe(provider);
      const hasLowTier = getModelsForProvider(provider).some((m) => m.costTier === "low");
      if (hasLowTier) {
        expect(fast.costTier).toBe("low");
      } else {
        // No cheap sibling — gracefully keeps the current model.
        expect(fast.id).toBe(current.id);
      }
    }
  });

  it("picks Haiku for Anthropic and Luna for OpenAI", () => {
    expect(getFastModel("anthropic", "claude-opus-5").costTier).toBe("low");
    expect(getFastModel("openai", "gpt-5.6-sol").id).toBe("gpt-5.6-luna");
  });
});

describe("model registry context windows", () => {
  it.each([
    ["gpt-5.5", 1_050_000],
    ["gpt-5.6-sol", 1_050_000],
    ["gpt-5.6-terra", 1_050_000],
    ["gpt-5.6-luna", 1_050_000],
  ] as const)("uses the %s public API context window without an OAuth account", (model, limit) => {
    expect(getContextWindow(model, { provider: "openai" })).toBe(limit);
  });

  it.each([
    ["gpt-5.5", 272_000],
    ["gpt-5.6-sol", 272_000],
    ["gpt-5.6-terra", 272_000],
    ["gpt-5.6-luna", 272_000],
  ] as const)("uses the %s Codex product window for OpenAI OAuth", (model, limit) => {
    const options = { provider: "openai" as const, accountId: "acct_123" };
    expect(usesOpenAICodexTransport(options)).toBe(true);
    expect(getContextWindow(model, options)).toBe(limit);
    expect(getToolResultCharLimit(model, options)).toBe(40_000);
  });

  it("caps custom OpenAI model IDs on Codex transport", () => {
    expect(
      getToolResultCharLimit("custom-codex-model", {
        provider: "openai",
        accountId: "acct_123",
      }),
    ).toBe(40_000);
  });

  it("keeps the generic tool-output allowance outside Codex OAuth", () => {
    expect(getToolResultCharLimit("gpt-5.6-sol", { provider: "openai" })).toBeUndefined();
    expect(
      getToolResultCharLimit("claude-sonnet-5", {
        provider: "anthropic",
        accountId: "acct_123",
      }),
    ).toBeUndefined();
  });

  it("keeps non-OpenAI providers on their model context windows", () => {
    expect(usesOpenAICodexTransport({ provider: "anthropic", accountId: "acct_123" })).toBe(false);
    expect(
      getContextWindow("claude-sonnet-5", { provider: "anthropic", accountId: "acct_123" }),
    ).toBe(1_000_000);
  });

  it("defaults Moonshot to multimodal K3 while retaining K2.7 Code", () => {
    expect(getDefaultModel("moonshot")).toMatchObject({
      id: "kimi-k3",
      name: "Kimi K3",
      provider: "moonshot",
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      supportsThinking: true,
      supportsImages: true,
      supportsVideo: true,
      maxThinkingLevel: "max",
    });
    expect(getModelsForProvider("moonshot").map((model) => model.id)).toEqual([
      "kimi-k3",
      "kimi-k2.7-code",
    ]);
    expect(getContextWindow("kimi-k3", { provider: "moonshot" })).toBe(1_048_576);
  });

  it("starts Kimi K3 at the endpoint's declared default effort, kimi-code-style", () => {
    // Kimi For Coding OAuth endpoint declares default_effort "high" …
    expect(getDefaultThinkingLevel("kimi-k3", { baseUrl: "https://api.kimi.com/coding/v1" })).toBe(
      "high",
    );
    // … the public Moonshot API declares "max" …
    expect(getDefaultThinkingLevel("kimi-k3", { baseUrl: "https://api.moonshot.ai/v1" })).toBe(
      "max",
    );
    // … and no stored endpoint (e.g. API-key-only auth) means the public API.
    expect(getDefaultThinkingLevel("kimi-k3")).toBe("max");
    // Every other model starts at its registry max regardless of endpoint.
    expect(
      getDefaultThinkingLevel("kimi-k2.7-code", { baseUrl: "https://api.kimi.com/coding/v1" }),
    ).toBe("high");
    expect(getDefaultThinkingLevel("claude-opus-5")).toBe("max");
    expect(getDefaultThinkingLevel("claude-opus-5")).toBe("max");
  });

  it("defaults MiniMax to the multimodal M3 with a 1M context window", () => {
    expect(getDefaultModel("minimax")).toMatchObject({
      id: "MiniMax-M3",
      name: "MiniMax M3",
      provider: "minimax",
      contextWindow: 1_000_000,
      supportsImages: true,
      supportsVideo: true,
    });
    expect(getModelsForProvider("minimax").map((model) => model.id)).toEqual(["MiniMax-M3"]);
    expect(getContextWindow("MiniMax-M3", { provider: "minimax" })).toBe(1_000_000);
  });

  it("every other provider defaults to a single-entry [provider] auth-storage key", () => {
    expect(getAuthStorageKeys("anthropic", "claude-sonnet-5")).toEqual(["anthropic"]);
    expect(getAuthStorageKey("anthropic", "claude-sonnet-5")).toBe("anthropic");
  });

  it("mimo-v2.5-pro / mimo-v2.5 prefer the Token Plan key but fall back to API Credits", () => {
    expect(getAuthStorageKeys("xiaomi", "mimo-v2.5-pro")).toEqual(["xiaomi", XIAOMI_CREDITS_KEY]);
    expect(getAuthStorageKeys("xiaomi", "mimo-v2.5")).toEqual(["xiaomi", XIAOMI_CREDITS_KEY]);
    // getAuthStorageKey() is the FIRST preference, not the only option.
    expect(getAuthStorageKey("xiaomi", "mimo-v2.5-pro")).toBe("xiaomi");
  });

  it("mimo-v2.5-pro-ultraspeed is API-Credits only, with no Token Plan fallback", () => {
    expect(getAuthStorageKeys("xiaomi", "mimo-v2.5-pro-ultraspeed")).toEqual([XIAOMI_CREDITS_KEY]);
    expect(getAuthStorageKey("xiaomi", "mimo-v2.5-pro-ultraspeed")).toBe(XIAOMI_CREDITS_KEY);
  });

  it("registers a Code Assist-supported Gemini default", () => {
    expect(getDefaultModel("gemini")).toMatchObject({
      id: "gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      provider: "gemini",
    });
    expect(getModelsForProvider("gemini").map((model) => model.id)).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3-flash",
      "gemini-3.1-pro-preview",
    ]);
    expect(getContextWindow("gemini-3.1-flash-lite", { provider: "gemini" })).toBe(1_048_576);
    expect(getContextWindow("gemini-3-flash", { provider: "gemini" })).toBe(1_048_576);
  });
});
