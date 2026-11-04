/**
 * Xiaomi MiMo Token Plan runs separate clusters, and a `tp-` key only works on
 * the cluster that issued it (shown on the user's Token Plan page). Any other
 * cluster answers 401 "Invalid API Key". Pay-as-you-go (API Credits) keys use
 * the single global host and are unaffected.
 */
export const XIAOMI_TOKEN_PLAN_BASE_URLS = [
  "https://token-plan-sgp.xiaomimimo.com/v1",
  "https://token-plan-ams.xiaomimimo.com/v1",
  "https://token-plan-cn.xiaomimimo.com/v1",
] as const;

/**
 * The Token Plan base URL whose cluster accepts `apiKey`, found by listing
 * models (free, auth-only) on every cluster. Undefined when none accepts it.
 */
export async function detectXiaomiTokenPlanBaseUrl(
  apiKey: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const accepted = await Promise.all(
    XIAOMI_TOKEN_PLAN_BASE_URLS.map(async (baseUrl) => {
      try {
        const res = await fetchImpl(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } catch {
        return false;
      }
    }),
  );
  const index = accepted.indexOf(true);
  return index === -1 ? undefined : XIAOMI_TOKEN_PLAN_BASE_URLS[index];
}
