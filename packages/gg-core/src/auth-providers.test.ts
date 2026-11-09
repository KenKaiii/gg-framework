import { describe, expect, it } from "vitest";
import type { Provider } from "@kenkaiiii/gg-ai";
import { getListedModels, getModelsForProvider, isHiddenProvider } from "./model-registry.js";
import {
  AUTH_PROVIDERS,
  authPriorityNote,
  describeAuthMethods,
  getAuthProvider,
  requiredKeyLabel,
} from "./auth-providers.js";

/**
 * The login screen advertises each provider's models in prose. Nothing else
 * ties that prose to the registry, so a model added or retired there silently
 * leaves the login copy lying (Fable 5 lingered on the list after retirement).
 * These tests are that tie.
 */
describe("AUTH_PROVIDERS descriptions match the model registry", () => {
  /**
   * Descriptions abbreviate after the first mention ("Claude Fable 5.2, Opus 5.5"
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
      "Fable 5.1",
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
  it("hides none: Gemini is listed with an API key", () => {
    expect(isHiddenProvider("gemini")).toBe(false);
    expect(AUTH_PROVIDERS.map((p) => p.value)).toContain("gemini");
    expect(getListedModels().some((m) => m.provider === "gemini")).toBe(true);
  });
});

describe("allowed sign-in methods", () => {
  it("offers a real sign-in only for Claude and ChatGPT", () => {
    const withOAuth = AUTH_PROVIDERS.filter((p) => p.methods.includes("oauth")).map((p) => p.value);
    expect(withOAuth).toEqual(["anthropic", "openai"]);
  });

  it("offers a pay-per-token key for every provider", () => {
    for (const p of AUTH_PROVIDERS) {
      expect(p.methods, p.value).toContain("apikey");
      expect(p.methodDetails.apikey, p.value).toBeDefined();
    }
  });

  it("labels the OpenAI sign-in Continue with ChatGPT and adds an OpenAI API key", () => {
    const methods = describeAuthMethods("openai");
    expect(methods.map((m) => m.label)).toEqual(["Continue with ChatGPT", "OpenAI API key"]);
    expect(methods[0]!.billing).toMatch(/ChatGPT plan/);
    expect(authPriorityNote("openai")).toMatch(/ChatGPT plan first/);
  });

  it("splits Kimi into a Kimi Code plan key and a Moonshot key", () => {
    const variants = getAuthProvider("moonshot")!.apiKeyVariants!;
    expect(variants.map((v) => [v.key, v.kind])).toEqual([
      ["kimi-code", "plan"],
      ["moonshot", "payg"],
    ]);
  });

  it("marks every variant as plan or pay-per-token, with its own storage key", () => {
    for (const p of AUTH_PROVIDERS) {
      const variants = p.apiKeyVariants ?? [];
      expect(new Set(variants.map((v) => v.key)).size, p.value).toBe(variants.length);
      for (const v of variants) {
        expect(["plan", "payg"], `${p.value}/${v.key}`).toContain(v.kind);
        expect(v.billing.length, `${p.value}/${v.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("tells GLM users the Coding Plan can't be used here", () => {
    expect(describeAuthMethods("glm")[0]!.when).toMatch(/Coding Plan/);
  });
});

describe("Anthropic auth methods", () => {
  it("offers Sign in with Claude (via Claude Code) and an API key", () => {
    const methods = describeAuthMethods("anthropic");
    expect(methods.map((m) => m.method)).toEqual(["oauth", "apikey"]);
    expect(methods[0]!.label).toBe("Sign in with Claude");
    expect(methods[0]!.when).toMatch(/Claude Code/);
    expect(methods[0]!.when).toMatch(/downloads/);
    expect(methods[1]!.label).toBe("Anthropic API key");
  });
});

describe("requiredKeyLabel", () => {
  it("names the key a plan-only or credits-only model needs", () => {
    expect(requiredKeyLabel("moonshot", ["kimi-code"])).toBe("Needs a Kimi Code plan key");
    expect(requiredKeyLabel("xiaomi", ["xiaomi-credits"])).toBe("Needs an API Credits key");
  });
  it("is undefined when any of the provider's keys runs the model", () => {
    expect(requiredKeyLabel("moonshot", ["kimi-code", "moonshot"])).toBeUndefined();
    expect(requiredKeyLabel("glm", ["glm"])).toBeUndefined();
  });
});
