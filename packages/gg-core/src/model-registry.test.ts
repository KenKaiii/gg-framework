import { describe, expect, it } from "vitest";
import {
  MODELS,
  getContextWindow,
  getDefaultModel,
  getModelsForProvider,
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
] as const;
const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
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

describe("model registry context windows", () => {
  it("uses the public API context window for OpenAI API-key requests", () => {
    expect(getContextWindow("gpt-5.5", { provider: "openai" })).toBe(1_050_000);
    expect(getContextWindow("gpt-5.4", { provider: "openai" })).toBe(1_050_000);
  });

  it("uses the Codex product context window for OpenAI OAuth requests", () => {
    const options = { provider: "openai" as const, accountId: "acct_123" };

    expect(usesOpenAICodexTransport(options)).toBe(true);
    expect(getContextWindow("gpt-5.5", options)).toBe(272_000);
    expect(getContextWindow("gpt-5.4", options)).toBe(272_000);
  });

  it("keeps non-OpenAI providers on their model context windows", () => {
    expect(usesOpenAICodexTransport({ provider: "anthropic", accountId: "acct_123" })).toBe(false);
    expect(
      getContextWindow("claude-sonnet-4-6", { provider: "anthropic", accountId: "acct_123" }),
    ).toBe(1_000_000);
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

  it("registers a Code Assist-supported Gemini default", () => {
    expect(getDefaultModel("gemini")).toMatchObject({
      id: "gemini-3.1-flash-lite-preview",
      name: "Gemini 3.1 Flash Lite Preview",
      provider: "gemini",
    });
    expect(getModelsForProvider("gemini").map((model) => model.id)).toEqual([
      "gemini-3.1-flash-lite-preview",
      "gemini-3.5-flash",
    ]);
    expect(getContextWindow("gemini-3.1-flash-lite-preview", { provider: "gemini" })).toBe(
      1_048_576,
    );
    expect(getContextWindow("gemini-3.5-flash", { provider: "gemini" })).toBe(1_048_576);
  });
});
