import { kimiCodeBaseUrl, kimiCodingHeaders } from "./oauth/kimi.js";
import type { OAuthCredentials } from "./oauth/types.js";

export type SubscriptionUsageProvider = "anthropic" | "openai" | "moonshot";

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

interface AnthropicWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicWindow | null;
  seven_day?: AnthropicWindow | null;
}

interface CodexWindow {
  limit_window_seconds?: unknown;
  used_percent?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
  } | null;
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

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function unixTimestamp(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function codexResetAt(window: CodexWindow, now: number): number | undefined {
  const absolute = unixTimestamp(window.reset_at);
  if (absolute !== undefined) return absolute;
  const afterSeconds = finiteNumber(window.reset_after_seconds);
  return afterSeconds === undefined ? undefined : now + afterSeconds * 1000;
}

function currentWindowLabel(seconds: unknown, fallbackHours: number): string {
  const duration = finiteNumber(seconds);
  const hours = Math.max(1, Math.round((duration ?? fallbackHours * 3600) / 3600));
  return `${hours}-hour`;
}

function codexWindowKind(
  window: CodexWindow,
  fallback: "current" | "weekly",
): "current" | "weekly" {
  const duration = finiteNumber(window.limit_window_seconds);
  if (duration === undefined) return fallback;
  // The API can put its seven-day limit in either primary or secondary.
  // Classify by duration without mislabeling a future 24-hour window as weekly.
  return duration >= 6 * 24 * 60 * 60 ? "weekly" : "current";
}

function normalizedCodexWindow(
  window: CodexWindow | null | undefined,
  fallbackKind: "current" | "weekly",
  now: number,
): SubscriptionUsageWindow | null {
  if (!window) return null;
  const usedPercent = clampPercent(window.used_percent);
  if (usedPercent === undefined) return null;
  const kind = codexWindowKind(window, fallbackKind);
  return {
    kind,
    label: kind === "weekly" ? "Weekly" : currentWindowLabel(window.limit_window_seconds, 5),
    usedPercent,
    resetsAt: codexResetAt(window, now),
  };
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

async function fetchAnthropicUsage(
  credentials: Pick<OAuthCredentials, "accessToken">,
  fetchFn: FetchFn,
  signal: AbortSignal,
  now: () => number,
): Promise<SubscriptionUsageSnapshot> {
  const response = await fetchFn(ANTHROPIC_USAGE_URL, {
    method: "GET",
    signal,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "ggcoder",
    },
  });
  const data = (await readUsageResponse(response, now())) as AnthropicUsageResponse;
  const windows: SubscriptionUsageWindow[] = [];
  const currentPercent = clampPercent(data.five_hour?.utilization);
  if (currentPercent !== undefined) {
    windows.push({
      kind: "current",
      label: "5-hour",
      usedPercent: currentPercent,
      resetsAt: isoTimestamp(data.five_hour?.resets_at),
    });
  }
  const weeklyPercent = clampPercent(data.seven_day?.utilization);
  if (weeklyPercent !== undefined) {
    windows.push({
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyPercent,
      resetsAt: isoTimestamp(data.seven_day?.resets_at),
    });
  }
  return {
    provider: "anthropic",
    displayName: "Anthropic",
    windows,
    fetchedAt: now(),
  };
}

async function fetchCodexUsage(
  credentials: Pick<OAuthCredentials, "accessToken" | "accountId">,
  fetchFn: FetchFn,
  signal: AbortSignal,
  now: () => number,
): Promise<SubscriptionUsageSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: "application/json",
    originator: "ggcoder",
    "User-Agent": "ggcoder",
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  const response = await fetchFn(CODEX_USAGE_URL, { method: "GET", signal, headers });
  const data = (await readUsageResponse(response, now())) as CodexUsageResponse;
  const windows = [
    normalizedCodexWindow(data.rate_limit?.primary_window, "current", now()),
    normalizedCodexWindow(data.rate_limit?.secondary_window, "weekly", now()),
  ].filter((window): window is SubscriptionUsageWindow => window !== null);
  windows.sort((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === "current" ? -1 : 1;
  });
  return {
    provider: "openai",
    displayName: "Codex",
    windows,
    fetchedAt: now(),
  };
}

/**
 * Kimi For Coding (`/coding/v1/usages`) reports plan quota as string-valued
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
  credentials: Pick<OAuthCredentials, "accessToken" | "accountId">,
  fetchFn: FetchFn,
  signal: AbortSignal,
  now: () => number,
): Promise<SubscriptionUsageSnapshot> {
  const response = await fetchFn(`${kimiCodeBaseUrl()}/usages`, {
    method: "GET",
    signal,
    headers: {
      Authorization: "Bearer " + credentials.accessToken,
      Accept: "application/json",
      // The managed coding endpoint gates on the kimi-code-cli client identity,
      // same as model requests.
      ...kimiCodingHeaders(),
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
 * Fetch subscription quota windows with an already-resolved OAuth credential.
 * Tokens stay server-side: callers expose only the normalized percentages and
 * reset timestamps to their UI.
 */
export async function fetchSubscriptionUsage(
  provider: SubscriptionUsageProvider,
  credentials: Pick<OAuthCredentials, "accessToken" | "accountId">,
  options: FetchSubscriptionUsageOptions = {},
): Promise<SubscriptionUsageSnapshot> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 8_000);
  try {
    return provider === "anthropic"
      ? await fetchAnthropicUsage(credentials, fetchFn, signal, now)
      : provider === "openai"
        ? await fetchCodexUsage(credentials, fetchFn, signal, now)
        : await fetchKimiUsage(credentials, fetchFn, signal, now);
  } catch (error) {
    if (error instanceof SubscriptionUsageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SubscriptionUsageError(message);
  }
}
