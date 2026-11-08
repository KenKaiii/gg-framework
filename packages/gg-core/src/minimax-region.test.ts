import { describe, expect, it, vi } from "vitest";
import {
  MINIMAX_CN_BASE_URL,
  MINIMAX_GLOBAL_BASE_URL,
  detectMiniMaxBaseUrl,
} from "./minimax-region.js";

type Reply = { status: number; code?: number } | "network-error";

function fakeFetch(replies: { global: Reply; cn: Reply }) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    const reply = href.startsWith("https://api.minimax.cn") ? replies.cn : replies.global;
    if (reply === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ base_resp: { status_code: reply.code ?? 0 } }), {
      status: reply.status,
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("detectMiniMaxBaseUrl", () => {
  it("picks Mainland China for a key only the China platform accepts", async () => {
    const fetch = fakeFetch({ global: { status: 401 }, cn: { status: 200, code: 0 } });
    expect(await detectMiniMaxBaseUrl("sk-cp-key", { fetch })).toBe(MINIMAX_CN_BASE_URL);
  });

  it("picks Global when MiniMax answers 200 with an invalid-key code on China", async () => {
    const fetch = fakeFetch({ global: { status: 200, code: 0 }, cn: { status: 200, code: 2049 } });
    expect(await detectMiniMaxBaseUrl("sk-cp-key", { fetch })).toBe(MINIMAX_GLOBAL_BASE_URL);
  });

  it("treats 'no active plan' (2062) as the key's home region", async () => {
    const fetch = fakeFetch({ global: { status: 200, code: 2062 }, cn: { status: 401 } });
    expect(await detectMiniMaxBaseUrl("sk-cp-key", { fetch })).toBe(MINIMAX_GLOBAL_BASE_URL);
  });

  it("is undefined when neither region answers clearly", async () => {
    const fetch = fakeFetch({ global: "network-error", cn: { status: 500 } });
    expect(await detectMiniMaxBaseUrl("sk-cp-key", { fetch })).toBeUndefined();
  });

  it("checks pay-as-you-go keys against the balance endpoint, plan keys against the quota", async () => {
    const fetch = fakeFetch({ global: { status: 200 }, cn: { status: 401 } });
    await detectMiniMaxBaseUrl("sk-api-key", { fetch });
    await detectMiniMaxBaseUrl("sk-cp-key", { fetch });
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("https://api.minimax.io/account/query_balance");
    expect(urls).toContain("https://api.minimax.io/v1/token_plan/remains");
  });
});
