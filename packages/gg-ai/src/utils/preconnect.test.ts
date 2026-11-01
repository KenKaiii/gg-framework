import { describe, expect, it, vi } from "vitest";
import { PRECONNECT_INTERVAL_MS, preconnectOrigin, preconnectProvider } from "./preconnect.js";

function fakeFetch(): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 404 }));
}

describe("preconnectOrigin", () => {
  it("resolves the origin each route's real requests go to", () => {
    expect(preconnectOrigin({ provider: "openai" })).toBe("https://api.openai.com");
    expect(preconnectOrigin({ provider: "openai", accountId: "acct" })).toBe("https://chatgpt.com");
    expect(preconnectOrigin({ provider: "deepseek" })).toBe("https://api.deepseek.com");
    expect(preconnectOrigin({ provider: "xai", baseUrl: "https://proxy.example.com/v1" })).toBe(
      "https://proxy.example.com",
    );
  });

  it("skips local servers, plain http and unparseable URLs", () => {
    expect(preconnectOrigin({ provider: "local", baseUrl: "https://gpu.example.com/v1" })).toBe(
      undefined,
    );
    for (const baseUrl of [
      "https://localhost:8080/v1",
      "https://127.0.0.1/v1",
      "https://192.168.1.4/v1",
      "https://10.0.0.2/v1",
      "https://172.20.0.1/v1",
      "https://[::1]/v1",
      "https://[fd00::1]/v1",
      "https://box.local/v1",
      "http://api.example.com/v1",
      "not a url",
    ]) {
      expect(preconnectOrigin({ provider: "openai", baseUrl })).toBe(undefined);
    }
  });
});

describe("preconnectProvider", () => {
  it("sends one unauthenticated HEAD to the route's base URL", () => {
    const fetch = fakeFetch();
    const opened = preconnectProvider({ provider: "openai", warmedAt: new Map(), fetch, now: 0 });
    expect(opened).toBe("https://api.openai.com");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1");
    expect(init?.method).toBe("HEAD");
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it("opens each origin at most once per interval", () => {
    const fetch = fakeFetch();
    const warmedAt = new Map<string, number>();
    const base = { provider: "openai" as const, warmedAt, fetch };
    preconnectProvider({ ...base, now: 1_000 });
    expect(preconnectProvider({ ...base, now: 1_000 + PRECONNECT_INTERVAL_MS - 1 })).toBe(
      undefined,
    );
    preconnectProvider({ ...base, accountId: "acct", now: 1_000 });
    preconnectProvider({ ...base, now: 1_000 + PRECONNECT_INTERVAL_MS });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1",
      "https://chatgpt.com/backend-api",
      "https://api.openai.com/v1",
    ]);
  });

  it("never throws or rejects when the network is down", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(preconnectProvider({ provider: "gemini", warmedAt: new Map(), fetch })).toBe(
      "https://cloudcode-pa.googleapis.com",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("sends nothing for a local provider", () => {
    const fetch = fakeFetch();
    const baseUrl = "http://127.0.0.1:11434/v1";
    expect(preconnectProvider({ provider: "local", baseUrl, warmedAt: new Map(), fetch })).toBe(
      undefined,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
