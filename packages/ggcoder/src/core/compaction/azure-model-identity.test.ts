import { afterEach, describe, expect, it } from "vitest";
import type { AzureOpenAIEnvironment } from "../auth-storage.js";
import { MODELS, getContextWindow, registerConfiguredAzureModel } from "../model-registry.js";
import { shouldCompact } from "./compactor.js";

const baseEnvironment: AzureOpenAIEnvironment = {
  AZURE_OPENAI_API_KEY: "azure-test-secret",
  AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/responses",
  AZURE_OPENAI_DEPLOYMENT: "customer-production-chat",
};

const registeredIds = [
  "azure:customer-production-chat",
  "azure:gpt-5.6-sol",
  "azure:unknown-production-chat",
] as const;

afterEach(() => {
  for (const id of registeredIds) {
    const index = MODELS.findIndex((model) => model.id === id);
    if (index !== -1) MODELS.splice(index, 1);
  }
});

describe("Azure compaction model identity", () => {
  it("does not compact a custom deployment at the old conservative threshold when mapped to Sol", () => {
    const model = registerConfiguredAzureModel({
      ...baseEnvironment,
      AZURE_OPENAI_MODEL_ID: "gpt-5.6-sol",
    })!;

    const contextWindow = getContextWindow(model.id, { provider: "azure" });
    expect(contextWindow).toBe(1_050_000);
    expect(shouldCompact([], contextWindow, 0.85, 150_000)).toBe(false);
  });

  it("does not compact an exact legacy Sol deployment at the old conservative threshold", () => {
    const model = registerConfiguredAzureModel({
      ...baseEnvironment,
      AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
    })!;

    const contextWindow = getContextWindow(model.id, { provider: "azure" });
    expect(model.modelIdentity).toBe("gpt-5.6-sol");
    expect(contextWindow).toBe(1_050_000);
    expect(shouldCompact([], contextWindow, 0.85, 283_927)).toBe(false);
  });

  it("compacts conservatively when an explicit identity is unknown", () => {
    const model = registerConfiguredAzureModel({
      ...baseEnvironment,
      AZURE_OPENAI_DEPLOYMENT: "unknown-production-chat",
      AZURE_OPENAI_MODEL_ID: "unknown-model",
    })!;

    const contextWindow = getContextWindow(model.id, { provider: "azure" });
    expect(contextWindow).toBe(128_000);
    expect(shouldCompact([], contextWindow, 0.85, 150_000)).toBe(true);
  });
});
