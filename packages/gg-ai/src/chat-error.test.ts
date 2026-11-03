import { describe, expect, it } from "vitest";
import { formatChatError } from "./chat-error.js";
import {
  GGAIError,
  ProviderError,
  ResponseStalledError,
  VideoUnsupportedError,
  formatError,
} from "./errors.js";

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

  it("sends a rejected local key to the local endpoint settings, not account sign-in", () => {
    const error = formatChatError(new ProviderError("local", "Unauthorized", { statusCode: 401 }));
    expect(error.reason).toBe("auth");
    expect(error.headline).toBe("The local server rejected its key");
    expect(error.guidance).toMatch(/Local models in AI Providers/);
  });

  it.each([
    {
      message: "Fast mode unavailable (out_of_credits): Your Claude usage credits have run out.",
      reason: "billing",
      headline: "Your Claude usage credits have run out",
      guidance: /Add funds or turn on auto-reload/,
    },
    {
      message:
        "Fast mode unavailable (overage_not_provisioned): Claude usage credits are turned off.",
      reason: "model_access",
      headline: "Claude usage credits are turned off",
      guidance: /Turn usage credits on at claude\.ai\/settings\/usage/,
    },
    {
      message: "rate_limit_error: Usage credits are required for fast mode.",
      reason: "billing",
      headline: "Fast mode needs Claude usage credits",
      guidance: /Check usage credits/,
    },
  ])("tells a fast-mode refusal its cause, not to wait: $headline", (row) => {
    const error = formatChatError(new ProviderError("anthropic", row.message, { statusCode: 429 }));
    expect(error.reason).toBe(row.reason);
    expect(error.headline).toBe(row.headline);
    expect(error.guidance).toMatch(row.guidance);
    expect(error.guidance).toMatch(/Claude Opus 5\.5 \(standard speed\)/);
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

  it("removes blame and static entitlement promises", () => {
    expect(
      formatChatError(new GGAIError("fetch failed", { source: "network" })).guidance,
    ).not.toContain("not a GG Coder issue");
    const video = formatChatError(new VideoUnsupportedError());
    expect(video.reason).toBe("capability");
    expect(video.guidance).toBe("Choose a model that supports video.");
  });

  // The provider was reachable — every attempt connected — so the network
  // headline sent users to debug a connection that worked.
  it("names a stalled response instead of an unreachable provider", () => {
    const stalled = formatChatError(
      new ResponseStalledError("stopped mid-response", { inToolCall: true }),
    );
    expect(stalled).toMatchObject({
      reason: "network",
      headline: "The response kept stalling",
      guidance: "Ask for the change in smaller pieces, then try again.",
    });
    expect(
      formatChatError(new ResponseStalledError("stopped", { inToolCall: false })).guidance,
    ).toBe("Try again, or choose another model if it keeps happening.");
    expect(formatChatError(new GGAIError("fetch failed", { source: "network" })).headline).toBe(
      "Couldn’t reach the provider",
    );
    // The CLI/TUI formats with formatError and must not blame the network either.
    expect(
      formatError(new ResponseStalledError("stopped", { inToolCall: false })).headline,
    ).not.toMatch(/reach/i);
  });
});
