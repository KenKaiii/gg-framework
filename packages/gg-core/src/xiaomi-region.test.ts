import { describe, expect, it, vi } from "vitest";
import { detectXiaomiTokenPlanBaseUrl } from "./xiaomi-region.js";

function clusterFetch(acceptingHost: string | undefined) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("token-plan-cn")) throw new TypeError("fetch failed");
    const ok = acceptingHost !== undefined && String(url).includes(acceptingHost);
    return new Response(ok ? '{"data":[]}' : '{"error":{"code":"401"}}', {
      status: ok ? 200 : 401,
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("detectXiaomiTokenPlanBaseUrl", () => {
  it("finds the Europe cluster for a key only Amsterdam accepts", async () => {
    const fetch = clusterFetch("token-plan-ams");
    expect(await detectXiaomiTokenPlanBaseUrl("tp-eu", { fetch })).toBe(
      "https://token-plan-ams.xiaomimimo.com/v1",
    );
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://token-plan-sgp.xiaomimimo.com/v1/models",
      "https://token-plan-ams.xiaomimimo.com/v1/models",
      "https://token-plan-cn.xiaomimimo.com/v1/models",
    ]);
  });

  it("is undefined when no cluster accepts the key, even if one is unreachable", async () => {
    expect(
      await detectXiaomiTokenPlanBaseUrl("tp-bad", { fetch: clusterFetch(undefined) }),
    ).toBeUndefined();
  });
});
