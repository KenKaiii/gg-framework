import { GG_CODER_USER_AGENT } from "@kenkaiiii/gg-ai";
import { KIMI_CODE_DEFAULT_BASE_URL } from "./kimi-region.js";
import type { OAuthCredentials } from "./oauth/types.js";

// ChatGPT has no meter here: plan usage is reviewed at chatgpt.com/settings/usage.
export type SubscriptionUsageProvider = "anthropic" | "moonshot";
/** Providers whose usage endpoint we call with a token. Claude reports its own (claude-code/usage.ts). */
export type FetchedSubscriptionUsageProvider = Exclude<SubscriptionUsageProvider, "anthropic">;

export interface SubscriptionUsageWindow {
  kind: "current" | "weekly";
  label: string;
  usedPercent: number;
  /** Unix epoch milliseconds. */
  resetsAt?: number;
}

export interface SubscriptionUsageSnapshot {
  provider: SubscriptionUsageProvider;
  displayName: string;
  windows: SubscriptionUsageWindow[];
  fetchedAt: number;
}

export class SubscriptionUsageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SubscriptionUsageError";
  }
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface FetchSubscriptionUsageOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  now?: () => number;
}

interface KimiUsageDetail {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
}

interface KimiLimit {
  window?: { duration?: unknown; timeUnit?: unknown } | null;
  detail?: KimiUsageDetail | null;
}

interface KimiUsageResponse {
  usage?: KimiUsageDetail | null;
  limits?: KimiLimit[] | null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : undefined;
}

async function readUsageResponse(response: Response, now: number): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new SubscriptionUsageError(
      `Subscription usage request failed with HTTP ${response.status}`,
      response.status,
      retryAfterMs(response, now),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SubscriptionUsageError("Subscription usage response was not valid JSON");
  }
}

/**
 * Kimi Code (`/coding/v1/usages`) reports plan quota as string-valued
 * counters, so accept numbers too rather than trusting one wire shape.
 */
function kimiNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return finiteNumber(value);
}

function kimiUsagePercent(detail: KimiUsageDetail | null | undefined): number | undefined {
  const used = kimiNumber(detail?.used);
  const limit = kimiNumber(detail?.limit);
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function kimiWindowMinutes(window: KimiLimit["window"]): number | undefined {
  const duration = kimiNumber(window?.duration);
  if (duration === undefined || duration <= 0) return undefined;
  switch (window?.timeUnit) {
    case "TIME_UNIT_SECOND":
      return duration / 60;
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 24 * 60;
    default:
      // Unknown unit — skip the window rather than mislabel its duration.
      return undefined;
  }
}

async function fetchKimiUsage(
  credentials: Pick<OAuthCredentials, "accessToken" | "baseUrl">,
  fetchFn: FetchFn,
  signal: AbortSignal,
  now: () => number,
): Promise<SubscriptionUsageSnapshot> {
  const baseUrl = (credentials.baseUrl ?? KIMI_CODE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const response = await fetchFn(`${baseUrl}/usages`, {
    method: "GET",
    signal,
    headers: {
      Authorization: "Bearer " + credentials.accessToken,
      Accept: "application/json",
      "User-Agent": GG_CODER_USER_AGENT,
    },
  });
  const data = (await readUsageResponse(response, now())) as KimiUsageResponse;
  const windows: SubscriptionUsageWindow[] = [];
  // Top-level `usage` is the weekly request quota of the membership tier.
  const weeklyPercent = kimiUsagePercent(data.usage);
  if (weeklyPercent !== undefined) {
    windows.push({
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyPercent,
      resetsAt: isoTimestamp(data.usage?.resetTime),
    });
  }
  for (const limit of data.limits ?? []) {
    const minutes = kimiWindowMinutes(limit?.window);
    const percent = kimiUsagePercent(limit?.detail);
    if (minutes === undefined || percent === undefined) continue;
    if (minutes >= 6 * 24 * 60) {
      // A weekly sub-limit duplicates the top-level quota — keep whichever
      // arrived first.
      if (!windows.some((window) => window.kind === "weekly")) {
        windows.push({
          kind: "weekly",
          label: "Weekly",
          usedPercent: percent,
          resetsAt: isoTimestamp(limit?.detail?.resetTime),
        });
      }
      continue;
    }
    windows.push({
      kind: "current",
      label: `${Math.max(1, Math.round(minutes / 60))}-hour`,
      usedPercent: percent,
      resetsAt: isoTimestamp(limit?.detail?.resetTime),
    });
  }
  windows.sort((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === "current" ? -1 : 1;
  });
  return {
    provider: "moonshot",
    displayName: "Kimi",
    windows,
    fetchedAt: now(),
  };
}

/**
 * Fetch plan quota windows with an already-resolved plan credential.
 * Tokens stay server-side: callers expose only the normalized percentages and
 * reset timestamps to their UI.
 */
export async function fetchSubscriptionUsage(
  provider: FetchedSubscriptionUsageProvider,
  credentials: Pick<OAuthCredentials, "accessToken" | "baseUrl">,
  options: FetchSubscriptionUsageOptions = {},
): Promise<SubscriptionUsageSnapshot> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 8_000);
  try {
    return await fetchKimiUsage(credentials, fetchFn, signal, now);
  } catch (error) {
    if (error instanceof SubscriptionUsageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SubscriptionUsageError(message);
  }
}
