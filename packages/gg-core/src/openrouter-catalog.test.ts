import { afterEach, describe, expect, it } from "vitest";
import { parseOpenRouterCatalog } from "./openrouter-catalog.js";
import {
  getAllModels,
  getModel,
  getModelsForProvider,
  getProviderCatalog,
  setProviderCatalog,
} from "./model-registry.js";
import { getSupportedThinkingLevels } from "./thinking-level.js";

// Trimmed from the live https://openrouter.ai/api/v1/models response shape.
const BODY = {
  data: [
    {
      id: "tencent/hy4",
      name: "Tencent: Hy4",
      context_length: 1048576,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000000417", completion: "0.0000012505" },
      top_provider: { context_length: 1048576, max_completion_tokens: 65536 },
      supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "tool_choice", "tools"],
      reasoning: {
        mandatory: false,
        supported_efforts: ["high", "low", "none"],
        default_effort: "high",
      },
    },
    {
      id: "openrouter/auto",
      name: "Auto Router",
      context_length: 2000000,
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "-1" },
      top_provider: { context_length: null, max_completion_tokens: null },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "acme/no-tools",
      context_length: 32768,
      supported_parameters: ["temperature"],
    },
    { id: "", supported_parameters: ["tools"], context_length: 8192 },
  ],
};

afterEach(() => setProviderCatalog("openrouter", undefined));

describe("parseOpenRouterCatalog", () => {
  it("maps the live schema: tools, image input, effort ladder, output cap", () => {
    const { models, skipped } = parseOpenRouterCatalog(BODY);

    expect(skipped).toBe(2);
    expect(models.map((m) => m.id)).toEqual(["tencent/hy4", "openrouter/auto"]);
    expect(models[0]).toMatchObject({
      provider: "openrouter",
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      supportsImages: true,
      supportsThinking: true,
      thinkingLevels: ["low", "high"],
      maxThinkingLevel: "high",
      defaultThinkingLevel: "high",
      costTier: "low",
    });
    // OpenRouter's own router ids keep their real `openrouter/` prefix.
    expect(models[1]).toMatchObject({
      id: "openrouter/auto",
      contextWindow: 2000000,
      maxOutputTokens: 16384,
      supportsImages: false,
      supportsThinking: false,
    });
    expect(models[1]).not.toHaveProperty("thinkingLevels");
  });

  it("returns nothing for a body that isn't a catalog", () => {
    expect(parseOpenRouterCatalog({ error: "nope" })).toEqual({ models: [], skipped: 0 });
    expect(parseOpenRouterCatalog(null)).toEqual({ models: [], skipped: 0 });
  });
});

describe("setProviderCatalog", () => {
  it("replaces the provider's static rows in listings but keeps them resolvable", () => {
    const staticOpenRouter = getModelsForProvider("openrouter");
    expect(staticOpenRouter.length).toBeGreaterThan(0);
    const { models } = parseOpenRouterCatalog(BODY);

    setProviderCatalog("openrouter", models);

    expect(getModelsForProvider("openrouter").map((m) => m.id)).toEqual([
      "tencent/hy4",
      "openrouter/auto",
    ]);
    expect(getModel("tencent/hy4")?.provider).toBe("openrouter");
    // A session saved on a static row still resolves it.
    expect(getModel(staticOpenRouter[0]!.id)).toBeDefined();
    expect(getSupportedThinkingLevels("openrouter", "tencent/hy4")).toEqual(["low", "high"]);
  });

  it("drops a synced row whose id is another provider's static model", () => {
    const foreign = getAllModels().find((m) => m.provider !== "openrouter")!;
    const installed = setProviderCatalog("openrouter", [
      { ...parseOpenRouterCatalog(BODY).models[0]!, id: foreign.id },
    ]);

    expect(installed).toEqual([]);
    expect(getModel(foreign.id)?.provider).toBe(foreign.provider);
  });

  it("restores the static list when cleared", () => {
    setProviderCatalog("openrouter", parseOpenRouterCatalog(BODY).models);
    setProviderCatalog("openrouter", undefined);

    expect(getProviderCatalog("openrouter")).toBeUndefined();
    expect(getModelsForProvider("openrouter").some((m) => m.id === "tencent/hy4")).toBe(false);
  });
});
