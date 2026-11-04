import { describe, expect, it } from "vitest";
import { formatChatError } from "./chat-error.js";
import { GGAIError, ProviderError, VideoUnsupportedError } from "./errors.js";

describe("formatChatError", () => {
  it.each([
    ["usage limit reached: insufficient credits", 429, "billing"],
    ["usage limit reached: You have exceeded your current quota", 429, "quota"],
    ["ChatGPT usage limit reached", 429, "usage_limit"],
    ["Rate limit exceeded", 429, "rate_limit"],
    [
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
      400,
      "model_access",
    ],
    ["Unsupported value: 'none' is not supported with this model", 400, "provider"],
    ["context_length_exceeded", 400, "context"],
    ["request_too_large", 413, "context"],
    ["expired token", 401, "auth"],
    ["server error", 500, "provider"],
  ])("separates %s into %s", (message, statusCode, reason) => {
    expect(formatChatError(new ProviderError("openai", message, { statusCode })).reason).toBe(
      reason,
    );
  });

  it("does not tell an empty balance to wait for a subscription reset", () => {
    const error = formatChatError(
      new ProviderError("openai", "usage limit reached: insufficient credits", { statusCode: 429 }),
    );
    expect(error.guidance).toContain("billing");
    expect(error.guidance).not.toMatch(/reset|wait/i);
  });

  it("preserves reset seconds and identifiers without inventing a current recovery", () => {
    const error = formatChatError(
      new ProviderError("openai", "ChatGPT usage limit reached", {
        statusCode: 429,
        resetsAt: 1_800_000_000,
        requestId: "request-1",
      }),
    );
    expect(error.headline).toBe("ChatGPT usage limit reached");
    expect(error.resetsAt).toBe(1_800_000_000);
    expect(error.requestId).toBe("request-1");
    expect(error.message).toBeTruthy();
  });

  it("keeps a bare 429 transient even if it has a reset timestamp", () => {
    expect(
      formatChatError(
        new ProviderError("openai", "Too many requests", {
          statusCode: 429,
          resetsAt: 1_800_000_000,
        }),
      ).reason,
    ).toBe("rate_limit");
  });

  it("uses structured account-access evidence before a generic hard-stop phrase", () => {
    const error = formatChatError(
      new ProviderError("openai", "ChatGPT usage limit reached", {
        cause: { code: "usage_not_included" },
      }),
    );
    expect(error.reason).toBe("model_access");
    expect(error.guidance).not.toMatch(/reset|usage/);
  });

  it("keeps a structured transient limit distinct from the adapter's hard-stop phrase", () => {
    const error = formatChatError(
      new ProviderError("openai", "ChatGPT usage limit reached", {
        statusCode: 429,
        resetsAt: 1_800_000_000,
        cause: { code: "rate_limit_exceeded" },
      }),
    );
    expect(error.reason).toBe("rate_limit");
    expect(error.guidance).not.toContain("reset");
  });

  it("keeps the original billing diagnostic instead of the legacy plan-limit summary", () => {
    const message = "usage limit reached: insufficient credits";
    expect(formatChatError(new ProviderError("openai", message)).message).toBe(message);
  });

  it.each([
    "OpenAI Codex cannot require a tool call when no tools are configured.",
    "OpenAI Codex does not support selecting the named tool `read`; use auto, none, or required.",
  ])("does not present tool-configuration failures as video errors: %s", (message) => {
    expect(formatChatError(new GGAIError(message, { source: "capability" }))).toMatchObject({
      reason: "unknown",
      headline: "This request isn’t supported",
      guidance: "Open details to check the request requirements.",
      message,
    });
  });

  it("names the application in update copy only when the caller supplies it", () => {
    const outdated = new GGAIError("This model requires a newer version of Codex.");
    expect(formatChatError(outdated).headline).toBe("The application needs an update");
    expect(
      formatChatError(outdated, { productName: "Kleio Coder", loginCommand: "kleio-coder login" })
        .headline,
    ).toBe("Kleio Coder needs an update");
  });

  it("removes blame and static entitlement promises", () => {
    expect(
      formatChatError(new GGAIError("fetch failed", { source: "network" })).guidance,
    ).not.toContain("not a Kleio Coder issue");
    const video = formatChatError(new VideoUnsupportedError());
    expect(video.reason).toBe("capability");
    expect(video.guidance).toBe("Choose a model that supports video.");
  });
});
