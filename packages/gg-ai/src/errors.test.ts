import { describe, expect, it } from "vitest";
import {
  GGAIError,
  ProviderError,
  VideoUnsupportedError,
  emptyProviderErrorMessage,
  formatError,
  formatErrorForDisplay,
  isRawJsonErrorEcho,
  isRawHtmlErrorEcho,
  providerHtmlErrorMessage,
  isUsageLimitError,
  readHeader,
} from "./errors.js";

describe("isUsageLimitError", () => {
  it("matches the canonical usage-limit message", () => {
    expect(isUsageLimitError(new ProviderError("anthropic", "Claude usage limit reached"))).toBe(
      true,
    );
  });

  it("does not match a transient rate-limit error", () => {
    expect(
      isUsageLimitError(
        new ProviderError("anthropic", "rate_limit_error: Rate limited.", { statusCode: 429 }),
      ),
    ).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isUsageLimitError("Claude usage limit reached")).toBe(false);
  });
});

describe("formatError usage limit", () => {
  it("produces a clear usage-finished message with reset time", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const formatted = formatError(
      new ProviderError("anthropic", "Claude usage limit reached", {
        statusCode: 429,
        resetsAt,
      }),
    );
    expect(formatted.headline).toBe("Anthropic usage limit reached.");
    expect(formatted.message).toContain("Your Anthropic usage is finished.");
    expect(formatted.message).toContain("It resets at");
    expect(formatted.guidance).toContain("Try again once it's back.");
    expect(formatted.resetsAt).toBe(resetsAt);
  });

  it("omits the reset clause when no reset time is known", () => {
    const formatted = formatError(
      new ProviderError("anthropic", "Claude usage limit reached", { statusCode: 429 }),
    );
    expect(formatted.headline).toBe("Anthropic usage limit reached.");
    expect(formatted.message).toBe("Your Anthropic usage is finished.");
    expect(formatted.resetsAt).toBeUndefined();
  });

  it("uses the xAI display name for Grok errors", () => {
    const formatted = formatError(
      new ProviderError("xai", "usage limit reached: You have exceeded your current quota", {
        statusCode: 429,
      }),
    );
    expect(formatted.headline).toBe("xAI (Grok) usage limit reached.");
  });
});

describe("formatError Mythos access", () => {
  it("explains invite-only access for a Mythos not_found_error", () => {
    const formatted = formatError(
      new ProviderError("anthropic", "not_found_error: model: claude-mythos-5", {
        statusCode: 404,
      }),
    );
    expect(formatted.headline).toBe("Claude Mythos 5 is invitation-only.");
    expect(formatted.message).toContain("Project Glasswing");
    expect(formatted.guidance).toContain(
      "platform.claude.com/docs/en/about-claude/models/overview",
    );
    expect(formatted.guidance).toContain("Claude Fable 5");
  });

  it("does not hijack not_found errors for other models", () => {
    const formatted = formatError(
      new ProviderError("anthropic", "not_found_error: model: claude-opus-9", {
        statusCode: 404,
      }),
    );
    expect(formatted.headline).toBe("Anthropic returned an error.");
  });
});

describe("formatError request too large", () => {
  it("routes an Anthropic 413 request_too_large to compact, not a blind retry", () => {
    const f = formatError(
      new ProviderError("anthropic", "request_too_large: Request exceeds the maximum size", {
        statusCode: 413,
      }),
    );
    expect(f.guidance).toContain("too large");
    expect(f.guidance).toContain("Compact");
    expect(f.guidance).not.toContain("status.anthropic.com");
  });

  it("explains the recovery after OpenAI's request retry buffer overflows", () => {
    const f = formatError(
      new ProviderError("openai", "exceeded request buffer limit while retrying upstream", {
        statusCode: 507,
      }),
    );
    expect(f.guidance).toContain("already retried automatically");
    expect(f.guidance).toContain("compact the conversation");
    expect(f.guidance).not.toContain("status.openai.com");
  });
});

describe("VideoUnsupportedError", () => {
  it("formats as a clean capability error naming video-capable models", () => {
    const f = formatError(new VideoUnsupportedError());
    expect(f.source).toBe("capability");
    expect(f.headline).toBe("This model can't analyze video.");
    expect(f.guidance).toContain("Kimi");
    expect(f.guidance).toContain("Gemini");
    expect(f.guidance).toContain("MiniMax");
    expect(f.guidance).toContain("MiMo");
    expect(f.guidance).toContain("model selector");
  });

  it("renders headline + guidance only (no bug-report framing)", () => {
    const out = formatErrorForDisplay(new VideoUnsupportedError());
    expect(out).toContain("This model can't analyze video.");
    expect(out).not.toContain("GG Coder bug");
  });
});

describe("formatErrorForDisplay", () => {
  it("renders an Anthropic 529 overloaded error as headline + message + guidance", () => {
    const out = formatErrorForDisplay(
      new ProviderError("anthropic", "overloaded_error: Overloaded", { statusCode: 529 }),
    );
    expect(out).toBe(
      [
        "Anthropic returned an error.",
        "  overloaded_error: Overloaded",
        "  → Anthropic's servers are overloaded right now. Retry in a moment — not a GG Coder issue.",
      ].join("\n"),
    );
  });

  it("renders an OpenAI 500 server_error pointing at the status page", () => {
    const out = formatErrorForDisplay(
      new ProviderError("openai", "server_error: something broke", { statusCode: 500 }),
    );
    expect(out).toBe(
      [
        "OpenAI returned an error.",
        "  server_error: something broke",
        "  \u2192 This is an error from OpenAI, not GG Coder. Retry \u2014 if it keeps happening, check status.openai.com.",
      ].join("\n"),
    );
  });

  it("prefers an explicit provider hint over the inferred guidance", () => {
    const out = formatErrorForDisplay(
      new ProviderError("openai", "This model is not available.", {
        statusCode: 404,
        hint: "Switch to a listed model via the model selector.",
      }),
    );
    expect(out).toBe(
      [
        "OpenAI returned an error.",
        "  This model is not available.",
        "  \u2192 Switch to a listed model via the model selector.",
      ].join("\n"),
    );
  });

  it("strips a legacy [provider] prefix from the message body", () => {
    const out = formatErrorForDisplay(
      new ProviderError("gemini", "[gemini] quota exceeded", { statusCode: 429 }),
    );
    expect(out).toBe(
      [
        "Gemini returned an error.",
        "  quota exceeded",
        "  \u2192 Your Gemini account has a billing or quota issue \u2014 check your balance. Not a GG Coder issue.",
      ].join("\n"),
    );
  });

  it("classifies a network GGAIError without a GG Coder bug headline", () => {
    const out = formatErrorForDisplay(new GGAIError("fetch failed", { source: "network" }));
    expect(out).toBe(
      [
        "Network error \u2014 couldn't reach the provider.",
        "  fetch failed",
        "  → Check your internet connection. Not a GG Coder issue — retry shortly.",
      ].join("\n"),
    );
  });

  it("falls back to the GG Coder-bug headline for unknown errors", () => {
    const out = formatErrorForDisplay(new Error("Cannot read property 'foo' of undefined"));
    expect(out).toBe(
      [
        "GG Coder hit an unexpected error.",
        "  Cannot read property 'foo' of undefined",
        "  → This looks like a GG Coder bug — please report it to the developer (see /help).",
      ].join("\n"),
    );
  });
});

describe("isRawJsonErrorEcho", () => {
  it("detects the OpenAI/Anthropic SDK's raw JSON echo for an empty error body", () => {
    // Exact shape a Xiaomi MiMo 400 with an empty body produces.
    expect(isRawJsonErrorEcho('400 {"code":"400","message":"","param":"","type":""}')).toBe(true);
  });

  it("detects a bare JSON echo with no leading status code", () => {
    expect(isRawJsonErrorEcho('{"error":"weird"}')).toBe(true);
  });

  it("does not flag a normal human-readable provider message", () => {
    expect(isRawJsonErrorEcho("Rate limit exceeded, please try again later.")).toBe(false);
  });

  it("does not flag a message with a non-numeric prefix before a brace", () => {
    expect(isRawJsonErrorEcho("See docs at https://example.com/{id}")).toBe(false);
  });
});

describe("raw HTML provider errors", () => {
  it("detects bare, status-prefixed, and doctype HTML responses", () => {
    expect(
      isRawHtmlErrorEcho("<html><head><title>Internal Server Error</title></head></html>"),
    ).toBe(true);
    expect(isRawHtmlErrorEcho("502 <!DOCTYPE html><html><body>Bad Gateway</body></html>")).toBe(
      true,
    );
  });

  it("does not flag human-readable messages that merely mention HTML", () => {
    expect(isRawHtmlErrorEcho("The response included an <html> tag.")).toBe(false);
  });

  it("replaces transport markup at the final formatting boundary", () => {
    const formatted = formatError(
      new ProviderError("openai", "500 <html><body>upstream failed</body></html>", {
        statusCode: 500,
      }),
    );

    expect(formatted.message).toBe(
      "The provider returned an HTML error page (HTTP 500) instead of an API response.",
    );
    expect(formatted.message).not.toContain("<html>");
    expect(formatted.guidance).toContain("status.openai.com");
  });

  it("omits the HTTP clause when the status is unknown", () => {
    expect(providerHtmlErrorMessage(undefined)).not.toContain("HTTP");
  });
});

describe("emptyProviderErrorMessage", () => {
  it("includes the HTTP status code when known", () => {
    expect(emptyProviderErrorMessage(400)).toContain("HTTP 400");
  });

  it("omits the status clause when unknown", () => {
    expect(emptyProviderErrorMessage(undefined)).not.toContain("HTTP");
  });
});

describe("readHeader", () => {
  it("reads from a web Headers object", () => {
    const headers = new Headers({ "x-request-id": "req_123" });
    expect(readHeader(headers, "x-request-id")).toBe("req_123");
  });

  it("falls back to the lowercased name on a plain record", () => {
    // Preserves the original anthropic getter contract: tries the exact name,
    // then the lowercased name — so a capitalized lookup finds a lowercase key.
    expect(readHeader({ "x-request-id": "req_456" }, "X-Request-Id")).toBe("req_456");
  });

  it("returns the first present header among several candidates", () => {
    const headers = new Headers({ "openai-request-id": "oai_789" });
    expect(readHeader(headers, "x-request-id", "openai-request-id", "x-oai-request-id")).toBe(
      "oai_789",
    );
  });

  it("returns undefined when no candidate is present", () => {
    expect(readHeader(new Headers(), "x-request-id")).toBeUndefined();
  });

  it("returns undefined for nullish or non-object headers", () => {
    expect(readHeader(undefined, "x-request-id")).toBeUndefined();
    expect(readHeader(null, "x-request-id")).toBeUndefined();
  });
});
