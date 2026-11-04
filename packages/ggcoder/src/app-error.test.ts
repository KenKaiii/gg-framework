import { describe, expect, it } from "vitest";
import { createAppErrorPayload, restoreAppErrorPayload } from "./app-error.js";

describe("app error snapshots", () => {
  it("retains reset seconds, source, scope and occurrence time through history", () => {
    const payload = createAppErrorPayload(
      {
        source: "provider",
        reason: "usage_limit",
        headline: "ChatGPT usage limit reached",
        message: "Allowance exhausted",
        guidance: "Wait for reset",
        provider: "openai",
        statusCode: 429,
        resetsAt: 1_800_000_000,
        requestId: "req-1",
      },
      "ken_error",
      1_799_999_000_000,
      [],
    );
    expect(restoreAppErrorPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    expect(payload.resetsAt).toBe(1_800_000_000);
    expect(payload.occurredAt).toBe(1_799_999_000_000);
  });

  it("redacts before the shared payload can be broadcast, logged or persisted", () => {
    const payload = createAppErrorPayload(
      {
        source: "ggcoder",
        reason: "unknown",
        headline: "Something went wrong",
        message: "request failed with private-account-value",
        guidance: "Open details",
      },
      "error",
      10,
      ["private-account-value"],
    );
    expect(payload.message).toContain("[REDACTED]");
    expect(JSON.stringify(payload)).not.toContain("private-account-value");
  });

  it("restores older markers without inventing metadata", () => {
    expect(restoreAppErrorPayload({ headline: "Earlier error", guidance: "Old guidance" })).toEqual(
      {
        scope: "error",
        headline: "Earlier error",
        guidance: "Old guidance",
      },
    );
  });

  it("drops invalid metadata and rejects malformed rows", () => {
    expect(
      restoreAppErrorPayload({ headline: "Error", resetsAt: "tomorrow", occurredAt: Infinity })
        ?.resetsAt,
    ).toBeUndefined();
    expect(restoreAppErrorPayload({ headline: 123 })).toBeUndefined();
    expect(restoreAppErrorPayload(null)).toBeUndefined();
  });
});
