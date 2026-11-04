import type { CacheRetention } from "@kleio/ai";

/**
 * Cold-prompt-cache detection (mirrors langchain-ai/deepagents#6477's
 * `cold_cache.py`): providers keep the conversation prefix cached only for a
 * TTL, so after a break the next message re-reads the whole context uncached.
 *
 * Every TTL below is derived from what gg-ai actually puts on the wire — never
 * from a provider's marketing maximum we did not request. A provider/route we
 * cannot pin to a request-side TTL returns `null` (no warning) rather than a
 * guess.
 */

export interface CacheTtlPolicy {
  ttlMs: number;
  /**
   * `expired`: the TTL is a documented/requested *maximum* — past it the entry
   * is gone. `may_be_cold`: the TTL is a guaranteed *minimum* (GPT-5.6+ `30m`),
   * so past it the prefix may still be warm.
   */
  confidence: "expired" | "may_be_cold";
  /** Where the number comes from, for logs/diagnostics. */
  source: string;
}

export interface CacheTtlInput {
  provider: string;
  model: string;
  cacheRetention: CacheRetention;
  baseUrl?: string;
  /** OpenAI OAuth (ChatGPT/Codex) routes carry an account id. */
  accountId?: string;
}

const MINUTE = 60_000;

/** Resolve the cache TTL our provider code requests for this route. */
export function resolveCacheTtl(input: CacheTtlInput): CacheTtlPolicy | null {
  if (input.cacheRetention === "none") return null;

  if (input.provider === "anthropic") {
    // gg-ai/src/providers/transform.ts `toAnthropicCacheControl`: "long" sends
    // `ttl: "1h"` only on the first-party endpoint; everything else sends a bare
    // `{type: "ephemeral"}`, which is Anthropic's 5-minute default.
    const firstParty = !input.baseUrl || input.baseUrl.includes("api.anthropic.com");
    if (input.cacheRetention === "long" && firstParty) {
      return {
        ttlMs: 60 * MINUTE,
        confidence: "expired",
        source: "anthropic cache_control ttl=1h (transform.ts toAnthropicCacheControl)",
      };
    }
    return {
      ttlMs: 5 * MINUTE,
      confidence: "expired",
      source: "anthropic cache_control ephemeral default 5m (transform.ts toAnthropicCacheControl)",
    };
  }

  if (input.provider === "openai") {
    if (input.accountId) {
      // gg-ai/src/providers/openai-codex.ts: the Codex backend rejects
      // prompt_cache_retention; "Cache TTL on Codex is controlled server-side
      // (~5-10 min in-memory)". Use the upper bound so we only warn once the
      // entry is surely gone.
      return {
        ttlMs: 10 * MINUTE,
        confidence: "expired",
        source: "codex server-side in-memory cache ~5-10m (openai-codex.ts)",
      };
    }
    if (input.model.startsWith("gpt-5.6") || input.model.startsWith("gpt-6")) {
      // gg-ai/src/providers/openai.ts sends prompt_cache_options.ttl = "30m";
      // OpenAI documents 30 minutes as a guaranteed minimum.
      return {
        ttlMs: 30 * MINUTE,
        confidence: "may_be_cold",
        source: "openai prompt_cache_options ttl=30m (openai.ts)",
      };
    }
    if (input.cacheRetention === "long") {
      // gg-ai/src/providers/openai.ts sends prompt_cache_retention = "24h".
      return {
        ttlMs: 24 * 60 * MINUTE,
        confidence: "expired",
        source: "openai prompt_cache_retention=24h (openai.ts)",
      };
    }
    // No retention param sent → OpenAI's default in-memory retention, which
    // its prompt-caching guide documents as up to one hour (a maximum).
    return {
      ttlMs: 60 * MINUTE,
      confidence: "expired",
      source: "openai default in_memory retention, max 1h (no param sent by openai.ts)",
    };
  }

  // Other providers (Gemini, GLM, Moonshot, OpenRouter, local, …): we request
  // no TTL and have no documented window to anchor a warning on.
  return null;
}

/**
 * Prefix size below which the notice is not worth an interruption. At 40k
 * tokens a cold Anthropic re-read (1.25x write vs 0.1x cached read) costs ~12x
 * the warm request, roughly a dime on Sonnet-class pricing; below that the delta
 * is pennies — and compacting first itself re-reads the whole context once, so
 * on small chats "Compact first" saves nothing.
 */
export const CACHE_EXPIRY_NOTICE_MIN_TOKENS = 40_000;

export interface CacheTouch {
  at: number;
  provider: string;
  model: string;
  policy: CacheTtlPolicy;
}

export interface CacheExpiryStatus {
  /** Owning session, so clients can key "dismissed once per expiry per chat". */
  sessionId?: string;
  provider: string;
  ttlMs: number;
  confidence: CacheTtlPolicy["confidence"];
  ttlSource: string;
  /** Last successful cache-using request (real turn or prewarm), epoch ms. */
  lastRequestAt: number | null;
  /** When the cached prefix lapses/lapsed, epoch ms; null when age is unknown. */
  expiresAt: number | null;
  expired: boolean;
  /**
   * `idle`: TTL passed. `age_unknown`: resumed/reset session with no request in
   * this process. `identity_changed`: provider/model switched since the last
   * request, so the old prefix cannot be reused.
   */
  reason: "idle" | "age_unknown" | "identity_changed" | null;
  /** Tokens the next request would re-read (the current context). */
  prefixTokens: number;
  minTokens: number;
  /** expired AND prefixTokens >= minTokens: worth showing the notice. */
  notable: boolean;
  /** No authoritative pricing exists in Kleio (turn metric cost is "unavailable"). */
  estimatedExtraCostUsd: null;
}

export interface AssessCacheExpiryInput {
  /** Policy for the route the NEXT request will take. */
  current: { provider: string; model: string; policy: CacheTtlPolicy | null };
  lastTouch: CacheTouch | null;
  now: number;
  prefixTokens: number;
  /** False for an empty chat — nothing to re-read. */
  hasHistory: boolean;
  minTokens?: number;
}

export function assessCacheExpiry(input: AssessCacheExpiryInput): CacheExpiryStatus | null {
  const { current, lastTouch, now } = input;
  if (!input.hasHistory || !current.policy) return null;
  const minTokens = input.minTokens ?? CACHE_EXPIRY_NOTICE_MIN_TOKENS;
  const prefixTokens = Math.max(0, Math.round(input.prefixTokens));

  let reason: CacheExpiryStatus["reason"] = null;
  let expiresAt: number | null = null;
  // The entry lives by the TTL it was WRITTEN with, not the current setting.
  let policy = current.policy;
  if (!lastTouch) {
    reason = "age_unknown";
  } else if (lastTouch.provider !== current.provider || lastTouch.model !== current.model) {
    reason = "identity_changed";
  } else {
    policy = lastTouch.policy;
    expiresAt = lastTouch.at + policy.ttlMs;
    if (now >= expiresAt) reason = "idle";
  }
  const expired = reason !== null;
  return {
    provider: current.provider,
    ttlMs: policy.ttlMs,
    confidence: policy.confidence,
    ttlSource: policy.source,
    lastRequestAt: lastTouch?.at ?? null,
    expiresAt,
    expired,
    reason,
    prefixTokens,
    minTokens,
    notable: expired && prefixTokens >= minTokens,
    estimatedExtraCostUsd: null,
  };
}
