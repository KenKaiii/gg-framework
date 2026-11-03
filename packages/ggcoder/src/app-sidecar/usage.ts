import {
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageProvider,
  oauthStorageKey,
  fetchSubscriptionUsage,
  SubscriptionUsageError,
} from "@kleio/core";
import { log } from "../core/logger.js";
import type { AuthStorage } from "../core/auth-storage.js";

export type UsageResult =
  | (SubscriptionUsageSnapshot & { connected: true; error?: never; stale?: boolean })
  | {
      provider: SubscriptionUsageProvider;
      displayName: string;
      connected: boolean;
      windows: [];
      fetchedAt: number;
      error?: string;
      stale?: boolean;
    };

export function createUsageService(auth: AuthStorage): {
  subscriptionUsage: (provider: SubscriptionUsageProvider) => Promise<
    | (SubscriptionUsageSnapshot & { connected: true; error?: never; stale?: boolean })
    | {
        provider: SubscriptionUsageProvider;
        displayName: string;
        connected: boolean;
        windows: [];
        fetchedAt: number;
        error?: string;
        stale?: boolean;
      }
  >;
} {
  const usageCache = new Map<
    SubscriptionUsageProvider,
    { expiresAt: number; result: UsageResult }
  >();

  const usageRequests = new Map<SubscriptionUsageProvider, Promise<UsageResult>>();

  // Last snapshot that actually carried windows, per provider. Replayed while a
  // fetch is failing so the title meter never blinks out of existence. Bounded
  // by USAGE_LAST_GOOD_MAX_AGE_MS — a provider that never recovers must stop
  // reporting rather than freeze a percentage (and a long-past reset time) on
  // screen forever. The 429 backoff alone runs to 24h, far past any usefulness.
  const usageLastGood = new Map<SubscriptionUsageProvider, UsageResult>();

  const USAGE_LAST_GOOD_MAX_AGE_MS = 30 * 60_000;

  // 429 backoff: quota endpoints are auxiliary UI data. Honor Retry-After when
  // provided; otherwise retain the unavailable snapshot for 30 minutes. Clamp
  // the provider value so a malformed header can neither hammer the endpoint
  // nor suppress usage data forever.
  const usageRateLimitedUntil = new Map<SubscriptionUsageProvider, number>();

  // Providers currently in a logged rate-limit episode (cleared on success).
  const usageRateLimitLogged = new Set<SubscriptionUsageProvider>();

  const USAGE_RATE_LIMIT_FALLBACK_BACKOFF_MS = 30 * 60_000;

  const USAGE_RATE_LIMIT_MIN_BACKOFF_MS = 60_000;

  const USAGE_RATE_LIMIT_MAX_BACKOFF_MS = 24 * 60 * 60_000;

  function clearUsageRateLimit(provider: SubscriptionUsageProvider): void {
    usageRateLimitedUntil.delete(provider);
    if (usageRateLimitLogged.delete(provider)) {
      log("INFO", "app-sidecar", "subscription usage recovered", { provider });
    }
  }

  async function fetchUsageProvider(provider: SubscriptionUsageProvider): Promise<UsageResult> {
    const displayName =
      provider === "anthropic" ? "Anthropic" : provider === "openai" ? "Codex" : "Kimi";
    // Kimi plan usage is tracked on the OAuth credential specifically — the
    // Moonshot platform API key is metered per-token, not per plan window.
    const authKey = oauthStorageKey(provider) ?? provider;
    if (!(await auth.hasProviderAuth(authKey))) {
      // Logged out: drop the replay cache so a later login on a DIFFERENT
      // account can never inherit the previous one's numbers.
      usageLastGood.delete(provider);
      return { provider, displayName, connected: false, windows: [], fetchedAt: Date.now() };
    }
    try {
      let credentials = await auth.resolveCredentials(authKey);
      try {
        const snapshot = {
          ...(await fetchSubscriptionUsage(provider, credentials)),
          connected: true as const,
        };
        clearUsageRateLimit(provider);
        return snapshot;
      } catch (error) {
        // A provider can revoke an access token before its stored expiry. Refresh
        // once on 401, matching inference auth recovery, then retry the usage call.
        if (error instanceof SubscriptionUsageError && error.status === 401) {
          // Name the rejected token. This poller runs on a timer alongside live
          // agent runs, so an unconditional refresh here would invalidate the
          // token those runs are holding and fail them mid-turn — a background
          // status check must never be able to log out the foreground.
          credentials = await auth.resolveCredentials(authKey, {
            forceRefresh: true,
            rejectedToken: credentials.accessToken,
          });
          const snapshot = {
            ...(await fetchSubscriptionUsage(provider, credentials)),
            connected: true as const,
          };
          clearUsageRateLimit(provider);
          return snapshot;
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SubscriptionUsageError && error.status === 429) {
        const backoffMs = Math.min(
          USAGE_RATE_LIMIT_MAX_BACKOFF_MS,
          Math.max(
            USAGE_RATE_LIMIT_MIN_BACKOFF_MS,
            error.retryAfterMs ?? USAGE_RATE_LIMIT_FALLBACK_BACKOFF_MS,
          ),
        );
        usageRateLimitedUntil.set(provider, Date.now() + backoffMs);
        // Rate limits on this auxiliary endpoint are expected (every GG process
        // on the machine polls it) and already handled by the backoff plus the
        // last-good replay. Log the transition, not every retry.
        if (!usageRateLimitLogged.has(provider)) {
          usageRateLimitLogged.add(provider);
          log("INFO", "app-sidecar", "subscription usage rate-limited; backing off", {
            provider,
            backoffMs: String(backoffMs),
          });
        }
      } else {
        log("WARN", "app-sidecar", "subscription usage fetch failed", { provider, message });
      }

      const connected = await auth.hasProviderAuth(authKey);
      // Transient failures (notably the 429s these auxiliary quota endpoints
      // hand out) must not blank the meter. Keep serving the last good
      // snapshot, flagged `stale`, so the bar stays put instead of flickering
      // out for the whole backoff window and back in on the next success.
      // Past the max age it's dropped — no data beats confidently wrong data.
      const lastGood = usageLastGood.get(provider);
      if (lastGood && Date.now() - lastGood.fetchedAt >= USAGE_LAST_GOOD_MAX_AGE_MS) {
        usageLastGood.delete(provider);
      } else if (connected && lastGood) {
        return { ...lastGood, stale: true };
      }
      return {
        provider,
        displayName,
        connected,
        windows: [],
        fetchedAt: Date.now(),
        error: connected ? "Usage is temporarily unavailable." : undefined,
      };
    }
  }

  async function subscriptionUsage(provider: SubscriptionUsageProvider): Promise<UsageResult> {
    const cached = usageCache.get(provider);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const inFlight = usageRequests.get(provider);
    if (inFlight) return inFlight;
    const request = fetchUsageProvider(provider);
    usageRequests.set(provider, request);
    try {
      const result = await request;
      // Never re-store a replay — it would keep its original `fetchedAt`, but
      // writing it back muddies the "last GOOD" contract for no gain.
      if (result.connected && !result.error && !result.stale && result.windows.length > 0) {
        usageLastGood.set(provider, result);
      }
      // Anthropic can return utilization before it assigns reset timestamps
      // (notably before the account's first active request). Retry that partial
      // snapshot quickly; complete snapshots keep the normal one-minute cache.
      const missingReset =
        result.connected &&
        result.windows.length > 0 &&
        result.windows.some((window) => window.resetsAt === undefined);
      const rateLimitedUntil = usageRateLimitedUntil.get(provider) ?? 0;
      usageCache.set(provider, {
        result,
        expiresAt:
          rateLimitedUntil > Date.now()
            ? rateLimitedUntil
            : Date.now() + (missingReset ? 10_000 : 60_000),
      });
      return result;
    } finally {
      if (usageRequests.get(provider) === request) usageRequests.delete(provider);
    }
  }

  return {
    subscriptionUsage,
  };
}
