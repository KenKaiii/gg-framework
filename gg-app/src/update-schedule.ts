/** localStorage key: the machine-wide update-check lease + last result. */
export const UPDATE_CHECK_KEY = "gg-update-check";

/**
 * Every window (and both update hooks inside a window) used to hit the GitHub
 * updater endpoint on mount and hourly. They share localStorage, so the first
 * hook to run claims an hour-long lease and checks; the rest reuse its result
 * and only call the updater themselves when it found an update (each window
 * needs its own `Update` handle to install).
 */
export const UPDATE_CHECK_LEASE_MS = 55 * 60 * 1000;

interface CheckRecord {
  at: number;
  version: string | null;
}

type KV = Pick<Storage, "getItem" | "setItem">;

function read(storage: KV): CheckRecord | null {
  try {
    const raw = storage.getItem(UPDATE_CHECK_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { at, version } = parsed as Record<string, unknown>;
    if (typeof at !== "number") return null;
    return { at, version: typeof version === "string" ? version : null };
  } catch {
    return null;
  }
}

export type UpdateCheckDecision =
  /** This hook owns the lease: run the real check, then `recordUpdateCheck`. */
  | { kind: "check" }
  /** Another hook checked recently and found nothing. */
  | { kind: "skip" }
  /** Another hook found `version`; fetch this window's own handle for it. */
  | { kind: "fetch"; version: string };

/** Decide (and, for "check", claim the lease) at time `now`. */
export function claimUpdateCheck(storage: KV | null, now: number): UpdateCheckDecision {
  if (!storage) return { kind: "check" };
  const prev = read(storage);
  if (prev && now - prev.at >= 0 && now - prev.at < UPDATE_CHECK_LEASE_MS) {
    return prev.version ? { kind: "fetch", version: prev.version } : { kind: "skip" };
  }
  try {
    storage.setItem(UPDATE_CHECK_KEY, JSON.stringify({ at: now, version: prev?.version ?? null }));
  } catch {
    // Storage unavailable: check without the shared lease.
  }
  return { kind: "check" };
}

/** Publish the lease holder's result so other windows reuse it. */
export function recordUpdateCheck(storage: KV | null, now: number, version: string | null): void {
  try {
    storage?.setItem(UPDATE_CHECK_KEY, JSON.stringify({ at: now, version }));
  } catch {
    // Best-effort.
  }
}

/** Version a storage event announces, when another window found an update. */
export function versionFromStorageEvent(
  key: string | null,
  newValue: string | null,
): string | null {
  if (key !== UPDATE_CHECK_KEY || !newValue) return null;
  try {
    const parsed: unknown = JSON.parse(newValue);
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
