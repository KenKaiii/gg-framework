import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "@kenkaiiii/gg-ai";
import { MODELS } from "@kenkaiiii/gg-core/models";
import type { AzureOpenAIEnvironment } from "./core/auth-storage.js";
import { registerConfiguredAzureModel } from "./core/model-registry.js";
import {
  clampThinkingLevel,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  resolveInitialThinkingLevel,
} from "./core/thinking-level.js";

const environment: AzureOpenAIEnvironment = {
  AZURE_OPENAI_API_KEY: "azure-test-secret",
  AZURE_OPENAI_BASE_URL:
    "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
  AZURE_OPENAI_DEPLOYMENT: "customer-production-chat",
  AZURE_OPENAI_MODEL_ID: "gpt-5.6-sol",
};
const modelId = "azure:customer-production-chat";
const conservativeDeployment = "unidentified-production-chat";
const conservativeModelId = `azure:${conservativeDeployment}`;

afterEach(() => {
  for (const id of [modelId, conservativeModelId]) {
    const index = MODELS.findIndex((model) => model.id === id);
    if (index !== -1) MODELS.splice(index, 1);
  }
});

describe("Azure sidecar thinking state", () => {
  it("cycles a custom Azure deployment mapped to Sol through Ultra", () => {
    const model = registerConfiguredAzureModel(environment)!;

    expect(getSupportedThinkingLevels(model.provider, model.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getNextThinkingLevel(model.provider, model.id, undefined)).toBe("low");
    expect(getNextThinkingLevel(model.provider, model.id, "max")).toBe("ultra");
  });

  it("preserves Ultra when recreating a custom Azure deployment mapped to Sol", () => {
    const model = registerConfiguredAzureModel(environment)!;

    expect(clampThinkingLevel(model.provider, model.id, "ultra")).toBe("ultra");
    expect(resolveInitialThinkingLevel(model.provider, model.id, true, "ultra")).toBe("ultra");
  });

  it("disables stale Ultra after Azure reload selects a conservative deployment", async () => {
    registerConfiguredAzureModel(environment);
    const exactIndex = MODELS.findIndex((model) => model.id === modelId);
    MODELS.splice(exactIndex, 1);

    const reloadedModel = registerConfiguredAzureModel({
      ...environment,
      AZURE_OPENAI_DEPLOYMENT: conservativeDeployment,
      AZURE_OPENAI_MODEL_ID: undefined,
    })!;
    const recreatedLevel = resolveInitialThinkingLevel(
      reloadedModel.provider,
      reloadedModel.id,
      true,
      "ultra",
    );

    expect(recreatedLevel).toBeUndefined();

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 1, output_tokens: 1 } },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    await stream({
      provider: "azure",
      model: conservativeDeployment,
      messages: [{ role: "user", content: "Hello" }],
      apiKey: environment.AZURE_OPENAI_API_KEY,
      baseUrl: environment.AZURE_OPENAI_BASE_URL,
      thinking: recreatedLevel,
      fetch: fetchMock,
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody).not.toHaveProperty("reasoning");
    expect(requestBody).not.toHaveProperty("include");
  });
});
