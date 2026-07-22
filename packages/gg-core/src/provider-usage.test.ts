import { describe, expect, it, vi } from "vitest";
import { fetchSubscriptionUsage } from "./provider-usage.js";
import type { SubscriptionUsageError } from "./provider-usage.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchSubscriptionUsage", () => {
  it("normalizes Anthropic current and weekly windows", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        five_hour: { utilization: 31.5, resets_at: "2030-01-01T05:00:00Z" },
        seven_day: { utilization: 67, resets_at: "2030-01-07T00:00:00Z" },
      }),
    );

    const result = await fetchSubscriptionUsage(
      "anthropic",
      { accessToken: "anthropic-token" },
      { fetchFn, now: () => 1234 },
    );

    expect(result).toEqual({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [
        {
          kind: "current",
          label: "5-hour",
          usedPercent: 31.5,
          resetsAt: Date.parse("2030-01-01T05:00:00Z"),
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 67,
          resetsAt: Date.parse("2030-01-07T00:00:00Z"),
        },
      ],
      fetchedAt: 1234,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer anthropic-token",
          "anthropic-beta": "oauth-2025-04-20",
        }),
      }),
    );
  });

  it("normalizes Codex windows and sends the account id", async () => {
    const now = 2_000_000;
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            used_percent: 22,
            reset_after_seconds: 600,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            used_percent: 48,
            reset_at: 2_000_000_000,
          },
        },
      }),
    );

    const result = await fetchSubscriptionUsage(
      "openai",
      { accessToken: "openai-token", accountId: "acct-123" },
      { fetchFn, now: () => now },
    );

    expect(result).toEqual({
      provider: "openai",
      displayName: "Codex",
      windows: [
        {
          kind: "current",
          label: "5-hour",
          usedPercent: 22,
          resetsAt: now + 600_000,
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 48,
          resetsAt: 2_000_000_000_000,
        },
      ],
      fetchedAt: now,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer openai-token",
          "ChatGPT-Account-Id": "acct-123",
        }),
      }),
    );
  });

  it("treats a weekly-only Codex primary window as weekly", async () => {
    const now = 2_000_000;
    const result = await fetchSubscriptionUsage(
      "openai",
      { accessToken: "openai-token" },
      {
        now: () => now,
        fetchFn: async () =>
          jsonResponse({
            rate_limit: {
              primary_window: {
                limit_window_seconds: 604_800,
                used_percent: 11,
                reset_after_seconds: 593_701,
              },
              secondary_window: null,
            },
          }),
      },
    );

    expect(result.windows).toEqual([
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 11,
        resetsAt: now + 593_701_000,
      },
    ]);
  });

  it("normalizes Kimi weekly quota and the 5-hour rate-limit window", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        usage: {
          limit: "2048",
          used: "214",
          remaining: "1834",
          resetTime: "2030-01-09T15:23:13.716839300Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "200",
              used: "139",
              remaining: "61",
              resetTime: "2030-01-06T13:33:02.717479433Z",
            },
          },
        ],
      }),
    );

    const result = await fetchSubscriptionUsage(
      "moonshot",
      { accessToken: "kimi-token" },
      { fetchFn, now: () => 1234 },
    );

    expect(result).toEqual({
      provider: "moonshot",
      displayName: "Kimi",
      windows: [
        {
          kind: "current",
          label: "5-hour",
          usedPercent: 69.5,
          resetsAt: Date.parse("2030-01-06T13:33:02.717479433Z"),
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: (214 / 2048) * 100,
          resetsAt: Date.parse("2030-01-09T15:23:13.716839300Z"),
        },
      ],
      fetchedAt: 1234,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.kimi.com/coding/v1/usages");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization?.endsWith("kimi-token")).toBe(true);
    expect(headers["X-Msh-Platform"]).toBe("kimi_code_cli");
  });

  it("skips Kimi windows with unknown time units or unusable counters", async () => {
    const result = await fetchSubscriptionUsage(
      "moonshot",
      { accessToken: "kimi-token" },
      {
        now: () => 1234,
        fetchFn: async () =>
          jsonResponse({
            usage: { limit: "0", used: "0", resetTime: "2030-01-09T00:00:00Z" },
            limits: [
              {
                window: { duration: 7, timeUnit: "TIME_UNIT_FORTNIGHT" },
                detail: { limit: "10", used: "1", resetTime: "2030-01-08T00:00:00Z" },
              },
              {
                window: { duration: "1", timeUnit: "TIME_UNIT_DAY" },
                detail: { limit: "50", used: "5", resetTime: "2030-01-02T00:00:00Z" },
              },
            ],
          }),
      },
    );

    expect(result.windows).toEqual([
      {
        kind: "current",
        label: "24-hour",
        usedPercent: 10,
        resetsAt: Date.parse("2030-01-02T00:00:00Z"),
      },
    ]);
  });

  it("rejects provider HTTP errors without exposing the response body", async () => {
    await expect(
      fetchSubscriptionUsage(
        "anthropic",
        { accessToken: "expired" },
        { fetchFn: async () => jsonResponse({ secret: "raw-provider-detail" }, 401) },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubscriptionUsageError>>({
        message: "Subscription usage request failed with HTTP 401",
        status: 401,
      }),
    );
  });

  it("preserves provider Retry-After guidance on rate limits", async () => {
    await expect(
      fetchSubscriptionUsage(
        "anthropic",
        { accessToken: "test-token" },
        {
          fetchFn: async () =>
            new Response(JSON.stringify({ error: "rate limited" }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "120" },
            }),
          now: () => Date.parse("2030-01-01T00:00:00Z"),
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubscriptionUsageError>>({
        status: 429,
        retryAfterMs: 120_000,
      }),
    );
  });
});
