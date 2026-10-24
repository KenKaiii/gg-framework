import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grokCliBaseUrl,
  grokCliHeaders,
  isGrokCliEndpoint,
  loginXai,
  refreshXaiToken,
} from "./xai.js";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("refreshXaiToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns credentials pinned to the Grok CLI proxy", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3_600,
      }),
    ) as unknown as typeof fetch;

    const creds = await refreshXaiToken("old-refresh");
    expect(creds.accessToken).toBe("new-access");
    expect(creds.refreshToken).toBe("rotated-refresh");
    // The endpoint travels with the credential — that is how the runtime knows to
    // route a subscription token to the proxy instead of the API-key host.
    expect(creds.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
  });

  it("preserves the existing refresh token when the server omits it", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "new-access", expires_in: 3_600 }),
    ) as unknown as typeof fetch;

    const creds = await refreshXaiToken("old-refresh");
    // No rotation → keep the caller's token so the credential is never stranded
    // (which would silently demote the user to their metered API key).
    expect(creds.refreshToken).toBe("old-refresh");
  });

  it("survives a token response with no expires_in by reading the JWT exp", async () => {
    // RFC 6749 §5.1 marks expires_in RECOMMENDED, not REQUIRED. Failing the login
    // over its absence would strand a user whose OAuth actually succeeded.
    const exp = Math.floor(Date.now() / 1000) + 1_800;
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: `header.${payload}.sig`, refresh_token: "r" }),
    ) as unknown as typeof fetch;

    const creds = await refreshXaiToken("old-refresh");
    // ~30 min derived from the JWT, not a blanket default.
    expect(creds.expiresIn).toBeGreaterThan(1_700);
    expect(creds.expiresIn).toBeLessThanOrEqual(1_800);
  });

  it("falls back to a default lifetime when the token carries no expiry at all", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "opaque-token", refresh_token: "r" }),
    ) as unknown as typeof fetch;

    const creds = await refreshXaiToken("old-refresh");
    expect(creds.expiresIn).toBe(3600);
    // AuthStorage refreshes proactively off expiresIn, so this stays recoverable.
    expect(creds.expiresAt).toBeGreaterThan(Date.now());
  });

  it("surfaces a 401 in a shape AuthStorage recognizes as a dead refresh token", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "invalid_grant" }, 401),
    ) as unknown as typeof fetch;

    await expect(refreshXaiToken("dead-refresh")).rejects.toThrow(/\(401\)/);
  });
});

describe("loginXai (device code flow)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function callbacks() {
    return {
      onOpenUrl: vi.fn(),
      onStatus: vi.fn(),
      onPromptCode: vi.fn(async () => ""),
    };
  }

  it("shows the user code, opens the browser, and polls until authorized", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://x.ai/device",
          verification_uri_complete: "https://x.ai/device?code=ABCD-1234",
          interval: 1,
        }),
      )
      // RFC 8628: the first polls come back pending while the user authorizes.
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "tok", refresh_token: "ref", expires_in: 3_600 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cb = callbacks();
    const creds = await loginXai(cb);

    expect(creds.accessToken).toBe("tok");
    expect(creds.baseUrl).toBe(grokCliBaseUrl());
    // The code must be visible in the status text: on a headless/SSH box the
    // browser never opens, and the code is the only way in.
    expect(cb.onStatus.mock.calls.map(([m]) => m).join(" ")).toContain("ABCD-1234");
    expect(cb.onOpenUrl).toHaveBeenCalledWith("https://x.ai/device?code=ABCD-1234");

    const deviceBody = String((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(deviceBody).toContain("grok-cli%3Aaccess");
    // Without offline_access xAI issues no refresh token and the login dies in
    // minutes, so assert the scope is requested.
    expect(deviceBody).toContain("offline_access");
  });

  it("uses the server's expires_in as the poll deadline", async () => {
    // RFC 8628 §3.2: the server owns the device code's lifetime. Polling past it
    // only burns requests against a code that can never succeed.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://x.ai/device",
          verification_uri_complete: "https://x.ai/device?code=ABCD-1234",
          interval: 1,
          expires_in: 1,
        }),
      )
      .mockResolvedValue(jsonResponse({ error: "authorization_pending" }, 400));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(loginXai(callbacks())).rejects.toThrow(/timed out/i);
    // A 1s server budget → the device request plus at most a couple of polls,
    // nowhere near what the 10-minute fallback window would have issued.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("fails loudly when the user denies authorization", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://x.ai/device",
          verification_uri_complete: "https://x.ai/device?code=ABCD-1234",
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: "access_denied" }, 400),
      ) as unknown as typeof fetch;

    await expect(loginXai(callbacks())).rejects.toThrow(/denied/i);
  });
});

describe("Grok CLI endpoint helpers", () => {
  it("recognizes the proxy and rejects the API-key host", () => {
    // The identity headers must NEVER be sent to api.x.ai (an API key is not a
    // Grok CLI client), so this predicate is the guard for that.
    expect(isGrokCliEndpoint("https://cli-chat-proxy.grok.com/v1")).toBe(true);
    expect(isGrokCliEndpoint("https://cli-chat-proxy.grok.com/v1/")).toBe(true);
    expect(isGrokCliEndpoint("https://api.x.ai/v1")).toBe(false);
    expect(isGrokCliEndpoint(undefined)).toBe(false);
    expect(isGrokCliEndpoint("")).toBe(false);
  });

  it("sends the client identity the proxy requires, with the model override", () => {
    const headers = grokCliHeaders("grok-4.5");
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(headers["x-grok-model-override"]).toBe("grok-4.5");
    expect(headers["x-grok-client-version"]).toMatch(/^\d+\.\d+/);
    // Omitting the model omits the override rather than sending an empty one.
    expect(grokCliHeaders()["x-grok-model-override"]).toBeUndefined();
  });

  it("reports a client version at or above the proxy's 1.0.13 floor", () => {
    // Below the floor the proxy answers HTTP 426 on every request (the old
    // 0.2.101 pin broke all Grok subscription chats around 2026-10-01).
    const saved = process.env.GROK_CLI_VERSION;
    delete process.env.GROK_CLI_VERSION;
    try {
      const version = grokCliHeaders()["x-grok-client-version"] ?? "";
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
      expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_000_013);
    } finally {
      if (saved !== undefined) process.env.GROK_CLI_VERSION = saved;
    }
  });
});
