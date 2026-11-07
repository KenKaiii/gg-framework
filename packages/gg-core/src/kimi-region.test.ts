import { describe, expect, it, vi } from "vitest";
import {
  KIMI_CODE_DEFAULT_BASE_URL,
  KIMI_CODE_OVERSEAS_BASE_URL,
  detectKimiCodeBaseUrl,
  isKimiCodingEndpoint,
} from "./kimi-region.js";

type Reply = number | "network-error";

function fakeFetch(replies: { com: Reply; ai: Reply }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = String(url).startsWith("https://api.kimi.ai") ? replies.ai : replies.com;
    expect((init?.headers as Record<string, string>)["User-Agent"]).not.toMatch(/kimi-code-cli/);
    if (reply === "network-error") throw new TypeError("fetch failed");
    return new Response("{}", { status: reply });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("detectKimiCodeBaseUrl", () => {
  it("picks the host that accepts the key", async () => {
    expect(await detectKimiCodeBaseUrl("k", { fetch: fakeFetch({ com: 401, ai: 200 }) })).toBe(
      KIMI_CODE_OVERSEAS_BASE_URL,
    );
    expect(await detectKimiCodeBaseUrl("k", { fetch: fakeFetch({ com: 200, ai: 401 }) })).toBe(
      KIMI_CODE_DEFAULT_BASE_URL,
    );
  });

  it("is undefined when neither host answers clearly", async () => {
    const fetch = fakeFetch({ com: "network-error", ai: 500 });
    expect(await detectKimiCodeBaseUrl("k", { fetch })).toBeUndefined();
  });

  it("asks each host's models endpoint", async () => {
    const fetch = fakeFetch({ com: 401, ai: 401 });
    await detectKimiCodeBaseUrl("k", { fetch });
    expect(fetch.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      "https://api.kimi.ai/coding/v1/models",
      "https://api.kimi.com/coding/v1/models",
    ]);
  });
});

describe("isKimiCodingEndpoint", () => {
  it("matches both plan hosts and nothing else", () => {
    expect(isKimiCodingEndpoint(KIMI_CODE_DEFAULT_BASE_URL)).toBe(true);
    expect(isKimiCodingEndpoint(KIMI_CODE_OVERSEAS_BASE_URL)).toBe(true);
    expect(isKimiCodingEndpoint("https://api.moonshot.ai/v1")).toBe(false);
    expect(isKimiCodingEndpoint(undefined)).toBe(false);
  });
});
