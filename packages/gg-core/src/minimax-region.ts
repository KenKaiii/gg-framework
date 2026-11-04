/**
 * MiniMax runs two separate platforms, and a key only works on the one that
 * issued it: Global (platform.minimax.io) or Mainland China
 * (platform.minimaxi.com). The user's location doesn't matter. Sending a key to
 * the other region's API is rejected as an invalid key.
 */
export const MINIMAX_GLOBAL_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_CN_BASE_URL = "https://api.minimax.cn/anthropic";

const REGION_HOSTS = [
  { host: "https://api.minimax.io", baseUrl: MINIMAX_GLOBAL_BASE_URL },
  { host: "https://api.minimax.cn", baseUrl: MINIMAX_CN_BASE_URL },
] as const;

type ProbeResult = "authorized" | "unauthorized" | "inconclusive";

// 2062 on the quota endpoint means "no active plan" — the key itself is known.
const KEY_KNOWN_CODES = new Set([0, 2062]);
const KEY_REJECTED_CODES = new Set([1004, 2049]);

async function probeRegion(
  host: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  // Same auth-only endpoints MiniMax's own CLI (mmx-cli) uses to detect a key's
  // region: pay-as-you-go keys (`sk-api-`) have a balance, plan keys a quota.
  const url = apiKey.startsWith("sk-api-")
    ? `${host}/account/query_balance`
    : `${host}/v1/token_plan/remains`;
  let sawRejection = false;
  const authHeaders: Record<string, string>[] = [
    { Authorization: `Bearer ${apiKey}` },
    { "x-api-key": apiKey },
  ];
  for (const auth of authHeaders) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { ...auth, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return "inconclusive";
    }
    if (res.status === 401 || res.status === 403) {
      sawRejection = true;
      continue;
    }
    if (!res.ok) return "inconclusive";
    let code: unknown;
    try {
      code = ((await res.json()) as { base_resp?: { status_code?: unknown } }).base_resp
        ?.status_code;
    } catch {
      return "inconclusive";
    }
    if (typeof code === "number" && KEY_KNOWN_CODES.has(code)) return "authorized";
    if (typeof code === "number" && KEY_REJECTED_CODES.has(code)) {
      sawRejection = true;
      continue;
    }
    return "inconclusive";
  }
  return sawRejection ? "unauthorized" : "inconclusive";
}

/**
 * The Anthropic-compatible base URL for the region that issued `apiKey`, found
 * by asking both regions about the key. Undefined when neither region gives a
 * clear answer (offline, timeouts) — callers then keep the Global default and
 * may ask again later.
 */
export async function detectMiniMaxBaseUrl(
  apiKey: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const results = await Promise.all(
    REGION_HOSTS.map((r) => probeRegion(r.host, apiKey, fetchImpl, timeoutMs)),
  );
  const index = results.indexOf("authorized");
  return index === -1 ? undefined : REGION_HOSTS[index]!.baseUrl;
}
