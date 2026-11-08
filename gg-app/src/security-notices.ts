// Installed packages now known to be infected, shown once as a warning toast.
// Never a prompt: the agent is told to replace the package on its own.
import type { SecurityNotice } from "./agent";
import type { KeyValueStore } from "./blocked-skills";

const STORAGE_KEY = "gg-security-notices-shown";
/** Keeps the remembered list small; the oldest entries fall off first. */
const MAX_REMEMBERED = 200;

function readShown(store: KeyValueStore): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Messages for notices not shown before (across windows and app restarts),
 * recording them as shown. A fixed-then-reflagged package is a new key.
 */
export function takeNewSecurityNotices(
  notices: readonly SecurityNotice[] | undefined,
  store: KeyValueStore,
): string[] {
  if (!notices || notices.length === 0) return [];
  const shown = readShown(store);
  const seen = new Set(shown);
  const messages: string[] = [];
  for (const notice of notices) {
    if (!notice.key || !notice.message || seen.has(notice.key)) continue;
    seen.add(notice.key);
    shown.push(notice.key);
    messages.push(notice.message);
  }
  if (messages.length > 0) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(shown.slice(-MAX_REMEMBERED)));
    } catch {
      // Storage full/unavailable: worst case the notice shows again.
    }
  }
  return messages;
}

interface SecurityRowLike {
  kind: string;
  rule?: string;
  target?: string;
  count?: number;
}

/**
 * Add a security row, folding it into the previous row when that's the same
 * block (shown as "×N"), so retries never fill the chat. Returns `prev` with
 * the row added or the last row's count bumped.
 */
export function withSecurityRow<T extends SecurityRowLike>(prev: readonly T[], row: T): T[] {
  const last = prev[prev.length - 1];
  if (
    last &&
    last.kind === "security" &&
    row.kind === "security" &&
    last.rule === row.rule &&
    last.target === row.target
  ) {
    return [...prev.slice(0, -1), { ...last, count: (last.count ?? 1) + (row.count ?? 1) }];
  }
  return [...prev, row];
}

/** Restored history: consecutive identical security rows folded into one (O(n)). */
export function collapseSecurityRows<T extends SecurityRowLike>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (
      last &&
      item.kind === "security" &&
      last.kind === "security" &&
      last.rule === item.rule &&
      last.target === item.target
    ) {
      out[out.length - 1] = { ...last, count: (last.count ?? 1) + (item.count ?? 1) };
    } else {
      out.push(item);
    }
  }
  return out;
}
