import fsp from "node:fs/promises";
import path from "node:path";
import { claudeCodeHome, type ClaudeCodeRuntimeOptions } from "./runtime.js";
import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from "../provider-usage.js";

/** The parts of the SDK's `rate_limit_event.rate_limit_info` the usage meter reads. */
export interface ClaudeCodeRateLimitInfo {
  rateLimitType?: string;
  /** Fraction of the window used, 0–1. */
  utilization?: number;
  /** Unix epoch seconds. */
  resetsAt?: number;
  /** Not in the SDK types yet; carries every window the response reported. */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

const USAGE_FILE = "usage.json";
const WINDOWS: Record<string, Pick<SubscriptionUsageWindow, "kind" | "label">> = {
  five_hour: { kind: "current", label: "5-hour" },
  seven_day: { kind: "weekly", label: "Weekly" },
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toWindow(
  key: string,
  raw: { utilization?: number; resetsAt?: number } | undefined,
): SubscriptionUsageWindow | null {
  const shape = WINDOWS[key];
  const fraction = finite(raw?.utilization);
  if (!shape || fraction === undefined) return null;
  const resetsAt = finite(raw?.resetsAt);
  return {
    ...shape,
    usedPercent: Math.min(100, Math.max(0, fraction * 100)),
    ...(resetsAt !== undefined ? { resetsAt: resetsAt * 1000 } : {}),
  };
}

/**
 * Fold one SDK rate-limit report into the last snapshot. A report can carry a
 * single window, so windows it doesn't mention keep their previous values.
 */
export function mergeClaudeCodeRateLimit(
  info: ClaudeCodeRateLimitInfo,
  previous: SubscriptionUsageSnapshot | null,
  now = Date.now(),
): SubscriptionUsageSnapshot {
  const reported = info.unifiedWindows
    ? Object.entries(info.unifiedWindows).map(([key, raw]) => toWindow(key, raw))
    : info.rateLimitType
      ? [toWindow(info.rateLimitType, info)]
      : [];
  const byKind = new Map(previous?.windows.map((w) => [w.kind, w]) ?? []);
  for (const window of reported) if (window) byKind.set(window.kind, window);
  const windows = [...byKind.values()].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "current" ? -1 : 1,
  );
  return { provider: "anthropic", displayName: "Anthropic", windows, fetchedAt: now };
}

function usagePath(opts: ClaudeCodeRuntimeOptions): string {
  return path.join(claudeCodeHome(opts), USAGE_FILE);
}

/**
 * The latest Claude subscription usage Claude Code reported, from any GG
 * process on this machine. Windows whose reset time has passed are dropped:
 * their old percentage no longer holds and the new one isn't known yet.
 */
export async function readClaudeCodeUsage(
  opts: ClaudeCodeRuntimeOptions & { now?: number } = {},
): Promise<SubscriptionUsageSnapshot | null> {
  let parsed: SubscriptionUsageSnapshot;
  try {
    parsed = JSON.parse(await fsp.readFile(usagePath(opts), "utf8")) as SubscriptionUsageSnapshot;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.windows) || typeof parsed.fetchedAt !== "number") return null;
  const now = opts.now ?? Date.now();
  const windows = parsed.windows.filter(
    (w) =>
      (w.kind === "current" || w.kind === "weekly") &&
      typeof w.usedPercent === "number" &&
      (w.resetsAt === undefined || w.resetsAt > now),
  );
  return { provider: "anthropic", displayName: "Anthropic", windows, fetchedAt: parsed.fetchedAt };
}

let writeQueue: Promise<void> = Promise.resolve();

/** Save an SDK rate-limit report so the usage meter (app or CLI) can show it. */
export function recordClaudeCodeRateLimit(
  info: ClaudeCodeRateLimitInfo,
  opts: ClaudeCodeRuntimeOptions & { now?: number } = {},
): Promise<void> {
  const write = async (): Promise<void> => {
    const now = opts.now ?? Date.now();
    const next = mergeClaudeCodeRateLimit(info, await readClaudeCodeUsage({ ...opts, now }), now);
    if (next.windows.length === 0) return;
    const file = usagePath(opts);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(next), "utf8");
  };
  writeQueue = writeQueue.then(write).catch(() => {});
  return writeQueue;
}

/** Forget saved usage, e.g. on sign-out, so another account never inherits it. */
export async function clearClaudeCodeUsage(opts: ClaudeCodeRuntimeOptions = {}): Promise<void> {
  await writeQueue;
  await fsp.rm(usagePath(opts), { force: true }).catch(() => {});
}
