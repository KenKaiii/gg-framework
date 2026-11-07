import { GG_CODER_USER_AGENT } from "@kenkaiiii/gg-ai";

/**
 * Kimi Code plan keys come from the Kimi Code Console and work on the host
 * that issued them: `api.kimi.com` (kimi.com accounts) or `api.kimi.ai`
 * (kimi.ai accounts). The other host rejects the key as invalid.
 */
export const KIMI_CODE_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODE_OVERSEAS_BASE_URL = "https://api.kimi.ai/coding/v1";

const KIMI_CODE_BASE_URLS = [KIMI_CODE_DEFAULT_BASE_URL, KIMI_CODE_OVERSEAS_BASE_URL] as const;

type ProbeResult = "authorized" | "unauthorized" | "inconclusive";

async function probeHost(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": GG_CODER_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return "authorized";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

/**
 * The Kimi Code base URL for the host that issued `apiKey`, found by asking
 * both. Undefined when neither gives a clear answer (offline, timeouts);
 * callers then use {@link KIMI_CODE_DEFAULT_BASE_URL} and may ask again later.
 */
export async function detectKimiCodeBaseUrl(
  apiKey: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const results = await Promise.all(
    KIMI_CODE_BASE_URLS.map((url) => probeHost(url, apiKey, fetchImpl, timeoutMs)),
  );
  const index = results.indexOf("authorized");
  return index === -1 ? undefined : KIMI_CODE_BASE_URLS[index];
}

/** True if `baseUrl` is a Kimi Code plan endpoint (either host). */
export function isKimiCodingEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
  return /^https:\/\/api\.kimi\.(com|ai)\/coding(\/|$)/i.test(baseUrl);
}
