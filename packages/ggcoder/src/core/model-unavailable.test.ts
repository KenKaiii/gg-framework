import { describe, expect, it } from "vitest";
import { ProviderError } from "@kleio/ai";
import { isModelUnavailableError, isModelUnavailableFailure } from "./model-unavailable.js";

describe("isModelUnavailableError", () => {
  it("recognizes unavailable-model failures", () => {
    expect(
      isModelUnavailableError(
        "OpenAI does not recognize the requested model (not). It may not exist or your account may not have access.",
      ),
    ).toBe(true);
    expect(isModelUnavailableError("The requested model is not available for this account.")).toBe(
      true,
    );
    expect(isModelUnavailableError("Model gpt-example does not exist.")).toBe(true);
  });

  it("does not retry unrelated provider or process failures", () => {
    expect(isModelUnavailableError("usage limit reached")).toBe(false);
    expect(isModelUnavailableError("401 invalid authentication credentials")).toBe(false);
    expect(isModelUnavailableError("spawn node ENOENT")).toBe(false);
  });
});

describe("isModelUnavailableFailure", () => {
  it.each([
    [
      "a terse provider 404",
      new ProviderError("anthropic", "model: claude-sonnet-9", { statusCode: 404 }),
    ],
    ["an OpenAI model_not_found code", new ProviderError("openai", "code: model_not_found")],
    ["a plain not-found message", new Error("Model gpt-example does not exist.")],
  ])("treats %s as an unavailable model", (_label, err) => {
    expect(isModelUnavailableFailure(err)).toBe(true);
  });

  it.each([
    ["a usage limit", new ProviderError("openai", "usage limit reached", { statusCode: 429 })],
    ["bad credentials", new ProviderError("anthropic", "invalid x-api-key", { statusCode: 401 })],
    ["an overloaded provider", new ProviderError("anthropic", "Overloaded", { statusCode: 529 })],
    ["a non-error value", "socket hang up"],
  ])("does not treat %s as an unavailable model", (_label, err) => {
    expect(isModelUnavailableFailure(err)).toBe(false);
  });
});
