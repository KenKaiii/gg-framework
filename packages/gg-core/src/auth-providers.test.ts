import { describe, expect, it } from "vitest";
import type { Provider } from "@kenkaiiii/gg-ai";
import { getListedModels, getModelsForProvider, isHiddenProvider } from "./model-registry.js";
import { AUTH_PROVIDERS } from "./auth-providers.js";

/**
 * The login screen advertises each provider's models in prose. Nothing else
 * ties that prose to the registry, so a model added or retired there silently
 * leaves the login copy lying (Fable 5 lingered on the list after retirement).
 * These tests are that tie.
 */
describe("AUTH_PROVIDERS descriptions match the model registry", () => {
  /**
   * Descriptions abbreviate after the first mention ("Claude Fable 5.1, Opus 5.5"
   * — not "Claude Opus 5"), so a model counts as listed when either its full
   * registry name or that name minus its leading brand word appears.
   */
  function mentions(description: string, modelName: string): boolean {
    if (description.includes(modelName)) return true;
    const withoutBrand = modelName.split(" ").slice(1).join(" ");
    return withoutBrand.length > 0 && description.includes(withoutBrand);
  }

  it.each(AUTH_PROVIDERS.map((p) => [p.value, p.description] as const))(
    "%s lists every registered model",
    (provider, description) => {
      const models = getModelsForProvider(provider as Provider);
      expect(models.length, `${provider} has no registered models`).toBeGreaterThan(0);
      for (const model of models) {
        expect(mentions(description, model.name), `${provider} omits ${model.name}`).toBe(true);
      }
    },
  );

  it("names no model the registry has retired", () => {
    const retired = [
      "Fable 5,",
      "Opus 5,",
      "Sonnet 5,",
      "Opus 4.8",
      "Opus 4.7",
      "Opus 4.6",
      "GPT-5.4",
      "GPT-6 Sol",
      "Grok 4.4",
    ];
    for (const { value, description } of AUTH_PROVIDERS) {
      for (const name of retired) {
        expect(description, `${value} still advertises ${name}`).not.toContain(name);
      }
    }
  });
});

describe("hidden providers", () => {
  it("are left out of the login list and the unfiltered model lists", () => {
    // Gemini is hidden until a sign-in path works for personal accounts.
    expect(isHiddenProvider("gemini")).toBe(true);
    expect(AUTH_PROVIDERS.map((p) => p.value)).not.toContain("gemini");
    expect(getListedModels().some((m) => m.provider === "gemini")).toBe(false);
    // The registry itself keeps the models, so un-hiding is a one-line change.
    expect(getModelsForProvider("gemini").length).toBeGreaterThan(0);
    expect(AUTH_PROVIDERS.map((p) => p.value)).toContain("anthropic");
  });
});
