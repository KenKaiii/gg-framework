import type { Provider } from "../types.js";
import { providerFetch } from "./provider-fetch.js";

/**
 * How long a pre-opened origin counts as warm. Matches the pool's idle
 * keep-alive (PROVIDER_KEEP_ALIVE_TIMEOUT_MS): inside this window the socket a
 * previous request or pre-open left is still pooled, so another one is waste.
 */
export const PRECONNECT_INTERVAL_MS = 30_000;

/** Default origin each provider's first request goes to, when no baseUrl is set. */
function defaultBaseUrl(provider: Provider): string | undefined {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      // The ChatGPT plan and API keys both go to the public API.
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "glm":
      return "https://api.z.ai/api/paas/v4";
    case "moonshot":
      return "https://api.moonshot.ai/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "xiaomi":
      return "https://token-plan-sgp.xiaomimimo.com/v1";
    case "minimax":
      return "https://api.minimax.io/anthropic";
    case "xai":
      return "https://api.x.ai/v1";
    case "huggingface":
      return "https://router.huggingface.co/v1";
    case "sakana":
      return "https://api.sakana.ai/v1";
    case "local":
    case "palsu":
      return undefined;
  }
}

/** Loopback, private-range and mDNS hosts: a local server has no handshake worth saving. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(":")) return /^(f[cd]|fe[89ab])/.test(host);
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false;
  const [a = 0, b = 0] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * The URL to pre-open for this route: the route's base URL itself, not the
 * origin root. Measured: `HEAD https://api.openai.com/` answers 421 with
 * `connection: close`, so the socket it opened was discarded; `HEAD` on the
 * base URL (404/401/403, no close) leaves it pooled for the real request.
 */
export function preconnectTarget(options: {
  provider: Provider;
  baseUrl?: string;
  accountId?: string;
}): URL | undefined {
  const raw = options.baseUrl ?? defaultBaseUrl(options.provider);
  if (!raw || options.provider === "local" || options.provider === "palsu") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || isLocalHost(url.hostname)) return undefined;
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}

/** The https origin a route's connections pool under, or undefined when none is worth opening. */
export function preconnectOrigin(options: {
  provider: Provider;
  baseUrl?: string;
  accountId?: string;
}): string | undefined {
  return preconnectTarget(options)?.origin;
}

export interface PreconnectOptions {
  provider: Provider;
  baseUrl?: string;
  accountId?: string;
  /** Last pre-open per origin (ms). Callers own it, so state is never module-global. */
  warmedAt: Map<string, number>;
  now?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Open the DNS+TCP+TLS connection to the provider's origin ahead of the first
 * real request, through the same keep-alive pool those requests use. Sends a
 * bodiless, unauthenticated `HEAD <baseUrl>` — no credentials, no tokens, no side
 * effects — and drops whatever comes back. Fire-and-forget: never throws.
 * Returns the origin it opened, or undefined when it skipped.
 */
export function preconnectProvider(options: PreconnectOptions): string | undefined {
  const target = preconnectTarget(options);
  if (!target) return undefined;
  const origin = target.origin;
  const now = options.now ?? Date.now();
  const last = options.warmedAt.get(origin);
  if (last !== undefined && now - last < PRECONNECT_INTERVAL_MS) return undefined;
  options.warmedAt.set(origin, now);
  const fetchImpl = options.fetch ?? providerFetch;
  void fetchImpl(target.href, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  })
    .then((response) => response.body?.cancel())
    .catch(() => {});
  return origin;
}
