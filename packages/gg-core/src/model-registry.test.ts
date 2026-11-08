import { afterEach, describe, expect, it } from "vitest";
import { FAST_MODE_SUFFIX, resolveFastModeModel } from "@kleio/ai";
import { XIAOMI_CREDITS_KEY } from "./auth-storage.js";
import {
  MODELS,
  type ModelInfo,
  clearRuntimeModels,
  getAllModels,
  getModel,
  registerRuntimeModels,
  getAuthStorageKey,
  getAuthStorageKeys,
  getContextWindow,
  getDefaultModel,
  getDefaultThinkingLevel,
  getModelsForProvider,
  getSummaryModel,
  getToolResultCharLimit,
  isPaidModel,
  usesOpenAICodexTransport,
  withoutPaidTier,
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
  "huggingface",
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

  it("registers fast-mode entries as the same model as their base, wired in gg-ai", () => {
    const fastIds = MODELS.filter((m) => m.id.endsWith(FAST_MODE_SUFFIX)).map((m) => m.id);
    expect(fastIds).toEqual([
      "claude-opus-5-5-fast",
      "gpt-6-astra-fast",
      "gpt-6.1-sol-fast",
      "gpt-6-luna-fast",
    ]);
    for (const id of fastIds) {
      const { id: _id, name, billing, ...fast } = getModel(id) as ModelInfo;
      const resolved = resolveFastModeModel(fast.provider, id);
      expect(resolved.fast, `${id} resolves in gg-ai`).toBe(true);
      const { id: _baseId, name: baseName, ...base } = getModel(resolved.model) as ModelInfo;
      expect(fast, `${id} metadata matches ${resolved.model}`).toEqual(base);
      expect(name).toBe(`${baseName} Fast`);
      // Every fast tier changes what the user pays, so it must say so.
      expect(billing, `${id} declares its billing`).toBeDefined();
      expect(base.billing, `${resolved.model} bills normally`).toBeUndefined();
    }
    // Claude fast mode spends real money (usage credits); Codex fast spends plan allowance.
    expect(getModel("claude-opus-5-5-fast")?.billing?.paid).toBe(true);
    expect(getModel("gpt-6.1-sol-fast")?.billing?.paid).toBe(false);
    // Only a real-money tier is ever stripped back to the standard model.
    expect(isPaidModel("claude-opus-5-5-fast")).toBe(true);
    expect(withoutPaidTier("claude-opus-5-5-fast")).toBe("claude-opus-5-5");
    expect(withoutPaidTier("gpt-6.1-sol-fast")).toBe("gpt-6.1-sol-fast");
    expect(withoutPaidTier("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(withoutPaidTier("not-a-model")).toBe("not-a-model");
    // Compaction summaries never land on a fast (premium) tier.
    expect(getSummaryModel("openai", "gpt-6.1-sol-fast").id).toBe("gpt-6-luna");
    expect(getSummaryModel("anthropic", "claude-opus-5-5-fast").id).toBe("claude-sonnet-5-5");
  });

  it("treats MiMo UltraSpeed as real money and strips it back to MiMo-V2.6-Pro", () => {
    // UltraSpeed only runs on pay-per-token API Credits, never the Token Plan.
    expect(isPaidModel("mimo-v2.6-pro-ultraspeed")).toBe(true);
    expect(withoutPaidTier("mimo-v2.6-pro-ultraspeed")).toBe("mimo-v2.6-pro");
    expect(isPaidModel("mimo-v2.6-pro")).toBe(false);
  });

  it("gives every paid model a registered, same-provider, unpaid standard model", () => {
    for (const model of getAllModels().filter((m) => m.billing?.paid === true)) {
      const standard = model.billing?.standardModel;
      expect(standard, `${model.id} names its standard model`).toBeDefined();
      const target = standard ? getModel(standard) : undefined;
      expect(target, `${model.id} → ${standard} is registered`).toBeDefined();
      expect(target?.provider, `${model.id} → ${standard} same provider`).toBe(model.provider);
      expect(isPaidModel(standard ?? ""), `${model.id} → ${standard} is unpaid`).toBe(false);
      expect(withoutPaidTier(model.id)).toBe(standard);
    }
  });

  it("never strips a paid model back to a paid id when its standard model is missing", () => {
    // Fail closed: a paid runtime model with no usable standard model falls
    // back to the provider default, not to itself.
    registerRuntimeModels([
      {
        ...(getModel("mimo-v2.6-pro-ultraspeed") as ModelInfo),
        id: "mimo-test-paid-orphan",
        billing: { label: "paid", detail: "paid", paid: true, standardModel: "not-registered" },
      },
    ]);
    try {
      const fallback = withoutPaidTier("mimo-test-paid-orphan");
      expect(fallback).not.toBe("mimo-test-paid-orphan");
      expect(isPaidModel(fallback)).toBe(false);
      expect(getModel(fallback)).toBeDefined();
    } finally {
      clearRuntimeModels((m) => m.id === "mimo-test-paid-orphan");
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

describe("Claude Sonnet 5.5", () => {
  it("replaces Sonnet 5 in the catalog and Anthropic defaults", () => {
    const model = getModel("claude-sonnet-5-5");
    expect(model).toEqual({
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      supportsImages: true,
      supportsVideo: false,
      costTier: "medium",
      defaultThinkingLevel: "medium",
      maxThinkingLevel: "max",
    });
    expect(getModelsForProvider("anthropic")).toContain(model);
    expect(getModel("claude-sonnet-5")).toBeUndefined();
    expect(getDefaultModel("anthropic")).toBe(model);
    expect(getSummaryModel("anthropic", "claude-opus-5-5")).toBe(model);
  });
});

describe("Claude Haiku 5.5", () => {
  it("replaces Haiku 4.5 in the catalog", () => {
    const model = getModel("claude-haiku-5-5");
    expect(model).toEqual({
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      supportsImages: true,
      supportsVideo: false,
      costTier: "low",
      defaultThinkingLevel: "medium",
      maxThinkingLevel: "max",
    });
    expect(getModelsForProvider("anthropic")).toContain(model);
    expect(getModel("claude-haiku-4-5-20251001")).toBeUndefined();
    expect(getModel("claude-haiku-4-5")).toBeUndefined();
  });
});

describe("getSummaryModel when the catalog changes", () => {
  /**
   * Edit the real catalog for one assertion, then put it back exactly — the
   * same change a future model update makes to `MODELS`.
   */
  function withCatalog(edit: (models: ModelInfo[]) => void, assert: () => void): void {
    const original = [...MODELS];
    try {
      edit(MODELS);
      assert();
    } finally {
      MODELS.splice(0, MODELS.length, ...original);
    }
  }

  function withoutModel(id: string, assert: () => void): void {
    withCatalog((models) => {
      const index = models.findIndex((m) => m.id === id);
      expect(index, `${id} is in the catalog`).toBeGreaterThanOrEqual(0);
      models.splice(index, 1);
    }, assert);
  }

  it("summarizes on the current model instead of crashing when Sonnet 5.5 is removed", () => {
    // Regression: the Anthropic pick was a hardcoded id with a non-null
    // assertion, so removing Sonnet 5.5 broke every Anthropic compaction.
    withoutModel("claude-sonnet-5-5", () => {
      expect(getSummaryModel("anthropic", "claude-opus-5-5").id).toBe("claude-opus-5-5");
    });
  });

  it("picks up a newly added model carrying the summary tag, with no code change", () => {
    const sonnetNext: ModelInfo = {
      ...(getModel("claude-sonnet-5-5") as ModelInfo),
      id: "claude-sonnet-6",
      name: "Claude Sonnet 6",
    };
    withCatalog(
      (models) => {
        // A new Sonnet replaces 5.5, listed where its predecessor was.
        const index = models.findIndex((m) => m.id === "claude-sonnet-5-5");
        models.splice(index, 1, sonnetNext);
      },
      () => {
        expect(getSummaryModel("anthropic", "claude-opus-5-5")).toBe(sonnetNext);
      },
    );
  });

  it.each([
    ["openai", "gpt-6-luna", "gpt-6.1-sol"],
    ["glm", "glm-5.3-flash", "glm-5.3"],
    ["deepseek", "deepseek-flash", "deepseek-v4-pro"],
    ["huggingface", "openai/gpt-oss-120b", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
  ] as const)(
    "falls back to the current %s model when its cheap %s is removed",
    (provider, cheapId, currentId) => {
      expect(getSummaryModel(provider, currentId).id).toBe(cheapId);
      withoutModel(cheapId, () => {
        expect(getSummaryModel(provider, currentId).id).toBe(currentId);
      });
    },
  );

  it("keeps a provider without a summary tier on the current model", () => {
    expect(getSummaryModel("moonshot", "kimi-k3").id).toBe("kimi-k3");
    expect(getSummaryModel("xai", "grok-4.7").id).toBe("grok-4.7");
  });

  it("never throws for any provider's default model", () => {
    for (const provider of PROVIDERS) {
      const current = getDefaultModel(provider);
      const summary = getSummaryModel(provider, current.id);
      // Never crosses providers — the user may only have this one connected.
      expect(summary.provider).toBe(provider);
    }
  });
});

describe("GPT-6.1 Sol", () => {
  it("replaces GPT-6 Sol in the catalog and OpenAI defaults", () => {
    const model = getModel("gpt-6.1-sol");
    expect(model).toEqual({
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      provider: "openai",
      contextWindow: 1_050_000,
      codexContextWindow: 272_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      defaultThinkingLevel: "low",
      supportsImages: true,
      supportsVideo: false,
      costTier: "medium",
      maxThinkingLevel: "ultra",
    });
    expect(getModelsForProvider("openai")).toContain(model);
    expect(getModel("gpt-6-sol")).toBeUndefined();
    expect(getDefaultModel("openai")).toBe(model);
  });
});

describe("model registry context windows", () => {
  it.each([
    ["gpt-6-astra", 1_050_000],
    ["gpt-6.1-sol", 1_050_000],
    ["gpt-6-luna", 1_050_000],
  ] as const)("uses the %s public API context window without an OAuth account", (model, limit) => {
    expect(getContextWindow(model, { provider: "openai" })).toBe(limit);
  });

  it.each([
    ["gpt-6-astra", 272_000],
    ["gpt-6.1-sol", 272_000],
    ["gpt-6-luna", 272_000],
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
    expect(getToolResultCharLimit("gpt-6.1-sol", { provider: "openai" })).toBeUndefined();
    expect(
      getToolResultCharLimit("claude-sonnet-5-5", {
        provider: "anthropic",
        accountId: "acct_123",
      }),
    ).toBeUndefined();
  });

  it("keeps non-OpenAI providers on their model context windows", () => {
    expect(usesOpenAICodexTransport({ provider: "anthropic", accountId: "acct_123" })).toBe(false);
    expect(
      getContextWindow("claude-sonnet-5-5", { provider: "anthropic", accountId: "acct_123" }),
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
      "kimi-for-coding",
      "kimi-k2.7-code",
    ]);
    // K2.8 Preview only exists on the Kimi sign-in endpoint, and is never
    // mislabelled with the K2.7 name it replaced behind the rolling alias.
    expect(getModel("kimi-for-coding")).toMatchObject({
      name: "Kimi K2.8 Preview",
      contextWindow: 1_048_576,
      maxThinkingLevel: "max",
      authStorageKeys: ["moonshot-oauth"],
    });
    expect(getAuthStorageKeys("moonshot", "kimi-for-coding")).toEqual(["moonshot-oauth"]);
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
    // Models without a declared default start at their registry max regardless of endpoint.
    expect(
      getDefaultThinkingLevel("kimi-k2.7-code", { baseUrl: "https://api.kimi.com/coding/v1" }),
    ).toBe("high");
  });

  it("starts the Claude 5.5 family at medium, matching the API and Claude Code", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-5-5-fast",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]) {
      expect(getDefaultThinkingLevel(id)).toBe("medium");
      // Ceiling unchanged — users can still opt up to max.
      expect(getModel(id)?.maxThinkingLevel).toBe("max");
    }
  });

  it("starts Codex models at their catalog default, not the ladder ceiling", () => {
    // openai/codex models.json `default_reasoning_level`: the deep-reasoning
    // models (Astra, GPT-6.1 Sol) ship "low", GPT-6 Luna "medium". Defaulting to
    // maxThinkingLevel made fresh Astra sessions reason at max effort.
    expect(getDefaultThinkingLevel("gpt-6-astra")).toBe("low");
    expect(getDefaultThinkingLevel("gpt-6.1-sol")).toBe("low");
    expect(getDefaultThinkingLevel("gpt-6-luna")).toBe("medium");
    // Ceilings are unchanged — users can still opt up.
    expect(getModel("gpt-6-astra")?.maxThinkingLevel).toBe("ultra");
    expect(getModel("gpt-6-luna")?.maxThinkingLevel).toBe("max");
  });

  it("pairs GLM-5.3 with its Flash sibling, both at a max thinking ceiling", () => {
    expect(getDefaultModel("glm")).toMatchObject({
      id: "glm-5.3",
      name: "GLM-5.3",
      provider: "glm",
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
      // `max` is the top rung GLM declares, and Z.AI's own default effort.
      maxThinkingLevel: "max",
    });
    expect(getDefaultThinkingLevel("glm-5.3")).toBe("max");
    // Flash is natively multimodal, so its attachments stay inline instead of
    // taking the zai_vision MCP detour that `supportsImages: false` triggers.
    expect(getModel("glm-5.3-flash")).toMatchObject({
      name: "GLM-5.3-Flash",
      contextWindow: 1_000_000,
      supportsImages: true,
      costTier: "low",
      maxThinkingLevel: "max",
    });
    // Only the 5.3 pair ships: the older ids route to strictly worse coding for
    // the same plan quota, and the coding endpoint already answers glm-5.2
    // requests as glm-5.3. Saved sessions on any of them fall back to the
    // provider default.
    expect(getModelsForProvider("glm").map((model) => model.id)).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
    ]);
    for (const retired of ["glm-5.2", "glm-5.1", "glm-4.7", "glm-4.7-flash"]) {
      expect(getModel(retired), `${retired} retired`).toBeUndefined();
    }
    // Flash is the cheap sibling, so summary routing drops to it instead of
    // paying 5.3 rates for compaction.
    expect(getSummaryModel("glm", "glm-5.3").id).toBe("glm-5.3-flash");
  });

  it("defaults xAI to Grok 4.7 alone, retiring the superseded 4.6/4.5 ids", () => {
    expect(getDefaultModel("xai")).toMatchObject({
      id: "grok-4.7",
      name: "Grok 4.7",
      provider: "xai",
      contextWindow: 500_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
      supportsImages: true,
      supportsVideo: false,
      maxThinkingLevel: "xhigh",
    });
    expect(getDefaultThinkingLevel("grok-4.7")).toBe("xhigh");
    expect(getModelsForProvider("xai").map((model) => model.id)).toEqual(["grok-4.7"]);
    // Only the newest Grok ships — saved sessions on 4.6/4.5 fall back to the
    // provider default.
    for (const retired of ["grok-4.6", "grok-4.5"]) {
      expect(getModel(retired), `${retired} retired`).toBeUndefined();
    }
  });

  it("defaults MiniMax to M3.1 Flash, the model plan keys cover, and keeps M3", () => {
    expect(getDefaultModel("minimax")).toMatchObject({
      id: "MiniMax-M3.1-Flash",
      name: "MiniMax M3.1 Flash",
      provider: "minimax",
      contextWindow: 1_000_000,
      supportsImages: true,
      supportsVideo: true,
      maxThinkingLevel: "max",
    });
    expect(getModelsForProvider("minimax").map((model) => model.id)).toEqual([
      "MiniMax-M3.1-Flash",
      "MiniMax-M3",
    ]);
    expect(getContextWindow("MiniMax-M3", { provider: "minimax" })).toBe(1_000_000);
  });

  it("every other provider defaults to a single-entry [provider] auth-storage key", () => {
    expect(getAuthStorageKeys("anthropic", "claude-sonnet-5-5")).toEqual(["anthropic"]);
    expect(getAuthStorageKey("anthropic", "claude-sonnet-5-5")).toBe("anthropic");
  });

  it("defaults Xiaomi to the full-modal MiMo-V2.6-Pro and retires the V2.5 ids", () => {
    expect(getDefaultModel("xiaomi")).toMatchObject({
      id: "mimo-v2.6-pro",
      name: "MiMo-V2.6-Pro",
      provider: "xiaomi",
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsThinking: true,
      // The whole V2.6 series is natively full-modal — Pro is no longer
      // text-only the way V2.5-Pro was.
      supportsImages: true,
      supportsVideo: true,
      maxVideoBytes: 36 * 1024 * 1024,
    });
    expect(getModelsForProvider("xiaomi").map((model) => model.id)).toEqual([
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro-ultraspeed",
    ]);
    // V2.5 ids deprecate on the platform 2026-10-21 — retired here, saved
    // sessions fall back to the provider default.
    for (const retired of ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2.5-pro-ultraspeed"]) {
      expect(getModel(retired), `${retired} retired`).toBeUndefined();
    }
  });

  it("mimo-v2.6-pro / mimo-v2.6-flash prefer the Token Plan key but fall back to API Credits", () => {
    expect(getAuthStorageKeys("xiaomi", "mimo-v2.6-pro")).toEqual(["xiaomi", XIAOMI_CREDITS_KEY]);
    expect(getAuthStorageKeys("xiaomi", "mimo-v2.6-flash")).toEqual(["xiaomi", XIAOMI_CREDITS_KEY]);
    // getAuthStorageKey() is the FIRST preference, not the only option.
    expect(getAuthStorageKey("xiaomi", "mimo-v2.6-pro")).toBe("xiaomi");
  });

  it("mimo-v2.6-pro-ultraspeed is API-Credits only, with no Token Plan fallback", () => {
    expect(getAuthStorageKeys("xiaomi", "mimo-v2.6-pro-ultraspeed")).toEqual([XIAOMI_CREDITS_KEY]);
    expect(getAuthStorageKey("xiaomi", "mimo-v2.6-pro-ultraspeed")).toBe(XIAOMI_CREDITS_KEY);
  });

  it("registers a Code Assist-supported Gemini default", () => {
    expect(getDefaultModel("gemini")).toMatchObject({
      id: "gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      provider: "gemini",
    });
    // New public GA releases are opt-in: retain the working OAuth default.
    expect(getModelsForProvider("gemini").map((model) => model.id)).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
      "gemini-3-flash",
      "gemini-3.1-pro-preview",
    ]);
    for (const id of ["gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
      expect(getModel(id)).toMatchObject({
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsImages: true,
        supportsVideo: true,
        maxThinkingLevel: "high",
      });
      // Summaries intentionally stay on the selected Gemini model.
      expect(getSummaryModel("gemini", id).id).toBe(id);
    }
    // Retired: Google routes gemini-3.7-flash to 3.8 Flash since 2026-10-08.
    expect(getModel("gemini-3.7-flash")).toBeUndefined();
    expect(getContextWindow("gemini-3.1-flash-lite", { provider: "gemini" })).toBe(1_048_576);
    expect(getContextWindow("gemini-3-flash", { provider: "gemini" })).toBe(1_048_576);
  });

  it("retargets deepseek-v4-pro to the 0813 stable build under the same id", () => {
    expect(getDefaultModel("deepseek")).toMatchObject({
      id: "deepseek-v4-pro",
      // Decimal 1M, as DeepSeek's own harness sizes it (DEFAULT_CONTEXT_WINDOW).
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      supportsImages: false,
      costTier: "medium",
      maxThinkingLevel: "max",
    });
  });

  it("serves exactly DeepSeek's live models, with V4.1 Flash reading images", () => {
    expect(getModelsForProvider("deepseek").map((model) => model.id)).toEqual([
      "deepseek-v4-pro",
      "deepseek-flash",
    ]);
    expect(getModel("deepseek-flash")).toMatchObject({
      name: "DeepSeek V4.1 Flash",
      supportsImages: true,
      supportsVideo: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      maxThinkingLevel: "max",
    });
    // Retired V4 Flash ids only route temporarily, so they are not registered.
    expect(getModel("deepseek-v4-flash")).toBeUndefined();
    expect(getModel("deepseek-v4-flash-vision-exp")).toBeUndefined();
    expect(getSummaryModel("deepseek", "deepseek-v4-pro").id).toBe("deepseek-flash");
    expect(
      getModelsForProvider("deepseek").every((model) => model.maxOutputTokens === 384_000),
    ).toBe(true);
  });

  it("enables Qwen image/video input with bounded inline video payloads", () => {
    expect(getDefaultModel("openrouter")).toMatchObject({
      id: "qwen/qwen3.8-max",
      supportsImages: true,
      supportsVideo: true,
      maxVideoBytes: 20 * 1024 * 1024,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    });
  });

  it("registers Sakana's Fugu Max beside Fugu and Fugu Ultra", () => {
    expect(getModelsForProvider("sakana").map((model) => model.id)).toEqual([
      "fugu",
      "fugu-max",
      "fugu-ultra",
    ]);
    expect(getModel("fugu-max")).toMatchObject({
      supportsImages: true,
      maxThinkingLevel: "xhigh",
    });
  });

  it("registers Hugging Face router models with Hub repo ids and a cheap summary sibling", () => {
    expect(getDefaultModel("huggingface")).toMatchObject({
      id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      provider: "huggingface",
      contextWindow: 262_144,
      maxOutputTokens: 131_072,
      // The Coder line is non-thinking, so the registry reports it that way
      // even though the provider transport supports reasoning_effort models.
      supportsThinking: false,
      costTier: "medium",
    });
    // gpt-oss-120b is the low-tier sibling for compaction summaries.
    expect(getSummaryModel("huggingface", "Qwen/Qwen3-Coder-480B-A35B-Instruct").id).toBe(
      "openai/gpt-oss-120b",
    );
    expect(getModel("openai/gpt-oss-120b")).toMatchObject({
      supportsThinking: true,
      maxThinkingLevel: "high",
      costTier: "low",
    });
  });
});

describe("runtime model registry", () => {
  const local: ModelInfo = {
    id: "local/ollama/qwen3-coder:30b",
    name: "qwen3-coder:30b (Ollama)",
    provider: "local",
    contextWindow: 262_144,
    maxOutputTokens: 4096,
    supportsThinking: true,
    supportsImages: false,
    supportsVideo: false,
    costTier: "low",
    maxThinkingLevel: "high",
    authStorageKeys: ["local:ollama"],
  };

  afterEach(() => clearRuntimeModels());

  it("makes registered models resolvable exactly like static ones", () => {
    expect(getModel(local.id)).toBeUndefined();

    registerRuntimeModels([local]);

    expect(getModel(local.id)).toBe(local);
    expect(getModelsForProvider("local").map((m) => m.id)).toEqual([local.id]);
    expect(getContextWindow(local.id)).toBe(262_144);
    expect(getAuthStorageKeys("local", local.id)).toEqual(["local:ollama"]);
    expect(getAllModels()).toHaveLength(MODELS.length + 1);
  });

  it("replaces an entry re-registered under the same id", () => {
    registerRuntimeModels([local]);
    registerRuntimeModels([{ ...local, contextWindow: 8192 }]);

    expect(getAllModels().filter((m) => m.id === local.id)).toHaveLength(1);
    expect(getContextWindow(local.id)).toBe(8192);
  });

  it("clears selectively by predicate and leaves static models alone", () => {
    registerRuntimeModels([
      local,
      { ...local, id: "local/vllm/x", authStorageKeys: ["local:vllm"] },
    ]);

    clearRuntimeModels((m) => m.authStorageKeys?.[0] === "local:vllm");

    expect(getModelsForProvider("local").map((m) => m.id)).toEqual([local.id]);

    clearRuntimeModels();

    expect(getModelsForProvider("local")).toEqual([]);
    expect(getAllModels()).toHaveLength(MODELS.length);
  });

  it("never throws for getDefaultModel('local'), before or after discovery", () => {
    expect(getDefaultModel("local")).toMatchObject({ provider: "local" });

    registerRuntimeModels([local]);

    expect(getDefaultModel("local")).toBe(local);
  });
});
