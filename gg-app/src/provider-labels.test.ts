import { describe, expect, it } from "vitest";
import { groupByProvider, providerLabel, providerRank } from "./provider-labels";

describe("providerLabel", () => {
  it("uses the same wording as the login hub's tiles", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("xai")).toBe("xAI (Grok)");
    expect(providerLabel("glm")).toBe("Z.AI (GLM)");
    expect(providerLabel("local")).toBe("Local");
  });

  it("falls back to the raw id for an unknown provider", () => {
    expect(providerLabel("brand-new-vendor")).toBe("brand-new-vendor");
  });

  it("labels and orders the Hugging Face group alongside the other gateways", () => {
    expect(providerLabel("huggingface")).toBe("Hugging Face");
    // Sits with the gateway cluster, after DeepSeek and before Sakana/OpenRouter.
    expect(providerRank("deepseek")).toBeLessThan(providerRank("huggingface"));
    expect(providerRank("huggingface")).toBeLessThan(providerRank("sakana"));
  });
});

describe("providerRank", () => {
  it("pins local last, after even unknown providers", () => {
    expect(providerRank("anthropic")).toBeLessThan(providerRank("openai"));
    expect(providerRank("openrouter")).toBeLessThan(providerRank("unknown-vendor"));
    expect(providerRank("unknown-vendor")).toBeLessThan(providerRank("local"));
  });
});

describe("groupByProvider", () => {
  const models = [
    { id: "gpt-6.1-sol", provider: "openai" },
    { id: "claude-sonnet-5", provider: "anthropic" },
    { id: "local/ollama/qwen3", provider: "local" },
    { id: "claude-opus-5-5", provider: "anthropic" },
    { id: "grok-4.5", provider: "xai" },
  ];

  it("groups by provider in registry order with local last", () => {
    expect(groupByProvider(models).map((g) => g.provider)).toEqual([
      "anthropic",
      "openai",
      "xai",
      "local",
    ]);
  });

  it("preserves each provider's curated model order", () => {
    const anthropic = groupByProvider(models).find((g) => g.provider === "anthropic")!;
    expect(anthropic.models.map((m) => m.id)).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
    expect(anthropic.label).toBe("Anthropic");
  });

  it("keeps every model exactly once", () => {
    const grouped = groupByProvider(models).flatMap((g) => g.models);
    expect(grouped).toHaveLength(models.length);
    expect(new Set(grouped.map((m) => m.id)).size).toBe(models.length);
  });

  it("returns nothing for an empty list", () => {
    expect(groupByProvider([])).toEqual([]);
  });

  it("sorts unknown providers alphabetically between known ones and local", () => {
    expect(
      groupByProvider([
        { id: "z", provider: "zeta-labs" },
        { id: "l", provider: "local" },
        { id: "a", provider: "alpha-labs" },
        { id: "c", provider: "anthropic" },
      ]).map((g) => g.provider),
    ).toEqual(["anthropic", "alpha-labs", "zeta-labs", "local"]);
  });

  it("gives each local endpoint its own group, after the providers", () => {
    const groups = groupByProvider([
      { id: "local/kilo/minimax/minimax-m2:free", provider: "local", endpoint: "Kilo AI Gateway" },
      { id: "local/lmstudio/qwen3", provider: "local", endpoint: "LM Studio" },
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "local/kilo/x-ai/grok-code-fast-1", provider: "local", endpoint: "Kilo AI Gateway" },
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Anthropic",
      "Local · Kilo AI Gateway",
      "Local · LM Studio",
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
    expect(groups[1]?.models).toHaveLength(2);
  });
});
