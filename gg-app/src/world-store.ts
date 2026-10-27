/**
 * World's saves, kept by the app. World runs in a sealed frame (no same-origin, see WorldScreen.tsx) and so has no
 * storage of its own: on start it asks for its saved data, and sends every change back. Only keys with World's own
 * prefixes are ever read or written here, so World can't see or touch anything else the app keeps in localStorage
 * (project notes, settings...). The keys are the same ones World used when it shared the app's storage, so existing
 * saves carry over as they are.
 */

/** Every key World saves under starts with one of these (packages/gg-world: grep localStorage). */
export const WORLD_KEY_PREFIXES = [
  "night-rooms-",
  "nightrooms.",
  "nr.",
  "nr-",
  "limbo-",
  "tavern-",
  "fc-",
  "cyb-",
  "gg-pool-wins",
  "gg-plat-best",
] as const;

const MAX_KEY = 120;
const MAX_VALUE = 256 * 1024;
const MAX_KEYS = 400;

export function isWorldKey(k: unknown): k is string {
  return (
    typeof k === "string" &&
    k.length > 0 &&
    k.length <= MAX_KEY &&
    WORLD_KEY_PREFIXES.some((p) => k.startsWith(p))
  );
}

/** World's saved keys, for the game's start. */
export function readWorldStore(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!isWorldKey(k)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
  } catch {
    // storage off: World starts fresh
  }
  return out;
}

/** Apply a batch of changes from the game ({ key: value | null }). Anything that isn't World's is ignored. */
export function writeWorldStore(set: unknown): void {
  if (!set || typeof set !== "object" || Array.isArray(set)) return;
  let n = 0;
  for (const [k, v] of Object.entries(set as Record<string, unknown>)) {
    if (++n > MAX_KEYS) break;
    if (!isWorldKey(k)) continue;
    try {
      if (v === null) localStorage.removeItem(k);
      else if (typeof v === "string" && v.length <= MAX_VALUE) localStorage.setItem(k, v);
    } catch {
      // full or off: the change only lasts this visit
    }
  }
}
