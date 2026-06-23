import { describe, it, expect } from "vitest";
import type { Provider } from "@kenkaiiii/gg-ai";
import { getDefaultModel } from "./model-registry.js";
import { resolveStartOrFallback, type ProviderAuthLookup } from "./resolve-start.js";

const ALL: Provider[] = [
  "anthropic",
  "xiaomi",
  "openai",
  "gemini",
  "glm",
  "moonshot",
  "minimax",
  "deepseek",
  "openrouter",
  "sakana",
];

/** Fake auth lookup: only the providers in `set` are "logged in". */
function auth(...connected: Provider[]): ProviderAuthLookup {
  const set = new Set<string>(connected);
  return { hasProviderAuth: async (p) => set.has(p) };
}

describe("resolveStartOrFallback", () => {
  it("falls back to preferred + default model when no provider is logged in", async () => {
    const res = await resolveStartOrFallback(auth(), ALL, "anthropic", undefined);
    expect(res.loggedIn).toBe(false);
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(getDefaultModel("anthropic").id);
  });

  it("honors a non-anthropic preferred provider in the logged-out fallback", async () => {
    const res = await resolveStartOrFallback(auth(), ALL, "openai", undefined);
    expect(res.loggedIn).toBe(false);
    expect(res.provider).toBe("openai");
    expect(res.model).toBe(getDefaultModel("openai").id);
  });

  it("uses the preferred provider's default model when logged in with no saved model", async () => {
    const res = await resolveStartOrFallback(auth("anthropic"), ALL, "anthropic", undefined);
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(getDefaultModel("anthropic").id);
  });

  it("keeps a saved model that belongs to the preferred provider", async () => {
    const saved = getDefaultModel("anthropic").id;
    const res = await resolveStartOrFallback(auth("anthropic"), ALL, "anthropic", saved);
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(saved);
  });

  it("ignores a saved model that belongs to a different provider", async () => {
    // Saved model is an OpenAI model but preferred is anthropic → default anthropic.
    const otherProviderModel = getDefaultModel("openai").id;
    const res = await resolveStartOrFallback(
      auth("anthropic"),
      ALL,
      "anthropic",
      otherProviderModel,
    );
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(getDefaultModel("anthropic").id);
  });

  it("falls back to the first logged-in provider when preferred is not connected", async () => {
    // Preferred anthropic is logged out; only openai is connected.
    const res = await resolveStartOrFallback(auth("openai"), ALL, "anthropic", undefined);
    expect(res.loggedIn).toBe(true);
    expect(res.provider).toBe("openai");
    expect(res.model).toBe(getDefaultModel("openai").id);
  });

  it("picks the first connected provider in registry order", async () => {
    // Both gemini and glm connected; ALL lists gemini before glm.
    const res = await resolveStartOrFallback(auth("glm", "gemini"), ALL, "anthropic", undefined);
    expect(res.provider).toBe("gemini");
  });
});
