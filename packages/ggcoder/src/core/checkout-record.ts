import readline from "node:readline";
import type { SessionEntry } from "./session-manager.js";
import { openSessionReadStream } from "./session-storage.js";

/**
 * The branch a conversation is on, and the checkout it works in: written when
 * the user picks a branch (or the window's branch changes), so a resumed
 * conversation comes back on that branch instead of whatever the project's
 * folder has checked out by then. A `custom` session entry, never on the DAG.
 */
export const CHECKOUT_RECORD_KIND = "workspace_checkout";

export interface CheckoutRecord {
  branch: string;
  /** Root of the checkout (main folder or worktree) the conversation used. */
  cwd: string;
}

export function parseCheckoutRecord(data: unknown): CheckoutRecord | null {
  if (typeof data !== "object" || data === null) return null;
  const { branch, cwd } = data as Record<string, unknown>;
  if (typeof branch !== "string" || !branch || typeof cwd !== "string" || !cwd) return null;
  return { branch, cwd };
}

/** The latest record among loaded session entries, or null. */
export function latestCheckoutRecord(entries: readonly SessionEntry[]): CheckoutRecord | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.kind === CHECKOUT_RECORD_KIND) {
      const record = parseCheckoutRecord(entry.data);
      if (record) return record;
    }
  }
  return null;
}

/**
 * The latest record in a conversation file (plain or archived), read before
 * its session is created so the window can open in the right checkout. Only
 * lines naming the kind are parsed; a missing or unreadable file is null.
 */
export async function readCheckoutRecord(sessionPath: string): Promise<CheckoutRecord | null> {
  let opened: Awaited<ReturnType<typeof openSessionReadStream>>;
  try {
    opened = await openSessionReadStream(sessionPath);
  } catch {
    return null;
  }
  let latest: CheckoutRecord | null = null;
  try {
    const lines = readline.createInterface({ input: opened.stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(CHECKOUT_RECORD_KIND)) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; kind?: unknown; data?: unknown };
        if (entry.type !== "custom" || entry.kind !== CHECKOUT_RECORD_KIND) continue;
        latest = parseCheckoutRecord(entry.data) ?? latest;
      } catch {
        // A torn line: keep the last good record.
      }
    }
  } catch {
    return latest;
  } finally {
    opened.close();
  }
  return latest;
}
