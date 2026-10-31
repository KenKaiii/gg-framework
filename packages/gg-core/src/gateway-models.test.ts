import { describe, expect, it } from "vitest";
import {
  FALLBACK_GATEWAY_CONTEXT_WINDOW,
  formatGatewayModelId,
  gatewayModelInfo,
  gatewayWireModelId,
  parseGatewayCatalog,
  parseGatewayModelId,
} from "./gateway-models.js";

/**
 * Shape taken from a real OpenRouter-compatible gateway's `/v1/models` — the
 * fields this feature exists to read. A plainer gateway (ids only) must still
 * work, falling back to conservative defaults.
 */
const OPENROUTER_STYLE = {
  data: [
    {
      id: "deepseek-flash",
      name: "DeepSeek-V4.1-Flash",
      limit: { context: 524288, output: 65536 },
      reasoning_parameters: { efforts: ["low", "high", "xhigh", "max"] },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_length: 524288,
      max_output_length: 65536,
      pricing: { prompt: 6e-7, completion: 1.2e-6 },
      supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
    },
    {
      id: "embed-only",
      name: "Embedding Model",
      context_length: 8192,
      supported_features: ["embeddings"],
      pricing: { prompt: 1e-8 },
    },
    {
      id: "qwen/qwen3.8-max",
      name: "Qwen3.8 Max",
      context_length: 1_000_000,
      max_output_length: 131_072,
      pricing: { prompt: 3e-6 },
      supported_features: ["tools"],
    },
  ],
};

describe("parseGatewayCatalog", () => {
  it("maps the endpoint's own metadata onto ModelInfo", () => {
    const { models } = parseGatewayCatalog("openrouter", OPENROUTER_STYLE);
    const flash = models.find((m) => m.id === "openrouter/deepseek-flash");
    expect(flash).toBeDefined();
    expect(flash!.contextWindow).toBe(524288);
    expect(flash!.maxOutputTokens).toBe(65536);
    expect(flash!.supportsThinking).toBe(true);
    expect(flash!.maxThinkingLevel).toBe("max");
    // The endpoint's own ladder is kept, so the picker offers these rungs and
    // the wire can send the chosen one verbatim ("max" instead of "xhigh").
    expect(flash!.thinkingLevels).toEqual(["low", "high", "xhigh", "max"]);
    expect(flash!.supportsImages).toBe(true);
    expect(flash!.supportsVideo).toBe(false);
    expect(flash!.costTier).toBe("low");
    expect(flash!.provider).toBe("openrouter");
    expect(flash!.name).toBe("DeepSeek-V4.1-Flash");
    expect(flash!.authStorageKeys).toEqual(["openrouter"]);
  });

  it("keeps ids that already contain a slash", () => {
    const { models } = parseGatewayCatalog("openrouter", OPENROUTER_STYLE);
    const qwen = models.find((m) => m.id === "openrouter/qwen/qwen3.8-max");
    expect(qwen).toBeDefined();
    expect(gatewayWireModelId(qwen!.id)).toBe("qwen/qwen3.8-max");
    expect(qwen!.costTier).toBe("medium");
  });

  it("drops models that can't call tools, and counts them", () => {
    const { models, skippedNoTools } = parseGatewayCatalog("openrouter", OPENROUTER_STYLE);
    expect(models.map((m) => m.id)).not.toContain("openrouter/embed-only");
    expect(skippedNoTools).toBe(1);
  });

  it("falls back conservatively when the endpoint declares nothing", () => {
    const { models } = parseGatewayCatalog("openrouter", { data: [{ id: "bare-model" }] });
    expect(models).toHaveLength(1);
    expect(models[0].contextWindow).toBe(FALLBACK_GATEWAY_CONTEXT_WINDOW);
    expect(models[0].maxOutputTokens).toBeLessThanOrEqual(8192);
    expect(models[0].supportsThinking).toBe(false);
    expect(models[0].costTier).toBe("medium");
  });

  it("ignores payloads that aren't a model list", () => {
    expect(parseGatewayCatalog("openrouter", null).models).toEqual([]);
    expect(parseGatewayCatalog("openrouter", { error: "nope" }).models).toEqual([]);
  });
});

describe("gateway model ids", () => {
  it("namespaces so a gateway model can't shadow another provider's id", () => {
    expect(formatGatewayModelId("openrouter", "deepseek-flash")).toBe(
      "openrouter/deepseek-flash",
    );
    expect(parseGatewayModelId("openrouter/deepseek-flash")).toEqual({
      provider: "openrouter",
      rawId: "deepseek-flash",
    });
    expect(parseGatewayModelId("openrouter/qwen/qwen3.8-max")).toEqual({
      provider: "openrouter",
      rawId: "qwen/qwen3.8-max",
    });
  });

  it("leaves static ids alone (they must go out unchanged)", () => {
    expect(gatewayWireModelId("qwen/qwen3.8-max")).toBe("qwen/qwen3.8-max");
    expect(gatewayWireModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(parseGatewayModelId("local/ep/model")).toBeUndefined();
  });
});

describe("gatewayModelInfo", () => {
  it("rejects entries without a usable id", () => {
    expect(gatewayModelInfo("openrouter", {})).toBeUndefined();
    expect(gatewayModelInfo("openrouter", { id: "   " })).toBeUndefined();
    expect(gatewayModelInfo("openrouter", "nope")).toBeUndefined();
  });
});
