/**
 * Pure functions for flushing completed live items to Static history.
 *
 * During an agent run, items (text blocks, tool calls, etc.) accumulate in
 * the live area. Ink re-renders ALL live items on every state change, so if
 * they grow unbounded the live area becomes very tall, making Ink's cursor
 * math expensive and causing visible jank.
 *
 * These functions determine which items can be safely moved to Static history
 * (where Ink writes them once and never re-renders them).
 */

/** Minimal item shape needed for flush logic. */
export interface FlushableItem {
  kind: string;
  id: string;
}

/**
 * Max history items kept in React state. Ink's <Static> renders items once
 * to stdout, so pruned items remain visible in terminal scrollback — we just
 * release the JS object references to avoid unbounded memory growth.
 */
export const MAX_HISTORY_ITEMS = 200;

/**
 * Max characters to keep in a tool result string after the item has been
 * flushed to Static history. Ink already rendered the full result, so we
 * only need enough for potential re-renders (which shouldn't happen for
 * Static items, but keep a small buffer for safety).
 */
const MAX_RESULT_CHARS_IN_HISTORY = 2_000;

/**
 * Prune history to keep at most MAX_HISTORY_ITEMS. Oldest items are dropped
 * first; they remain visible in terminal scrollback.
 */
export function pruneHistory<T>(items: T[]): T[] {
  if (items.length <= MAX_HISTORY_ITEMS) return items;
  return items.slice(items.length - MAX_HISTORY_ITEMS);
}

/** Truncate a string if it exceeds the history limit. */
function truncateResult(s: string): string {
  if (s.length <= MAX_RESULT_CHARS_IN_HISTORY) return s;
  return s.slice(0, MAX_RESULT_CHARS_IN_HISTORY) + "\n… (truncated)";
}

/**
 * Trim large payload data from items that have been flushed to Static history.
 * Ink already rendered them to the terminal — we only keep a truncated version
 * to prevent multi-GB memory retention from tool results, server tool data, and
 * sub-agent results.
 *
 * Works with any item shape via duck-typing: truncates `result` strings,
 * clears `input`/`data` fields, and trims sub-agent result strings.
 */
export function trimFlushedItems<T extends FlushableItem>(items: T[]): T[] {
  return items.map((item) => {
    const rec = item as Record<string, unknown>;
    const patches: Record<string, unknown> = {};
    let changed = false;

    // Truncate tool result strings (ToolDoneItem, SubAgentInfo, etc.)
    if (typeof rec.result === "string" && rec.result.length > MAX_RESULT_CHARS_IN_HISTORY) {
      patches.result = truncateResult(rec.result);
      changed = true;
    }

    // Clear server tool input/data — potentially large JSON payloads
    if (rec.input !== undefined && rec.kind === "server_tool_done") {
      patches.input = undefined;
      changed = true;
    }
    if (rec.data !== undefined && rec.kind === "server_tool_done") {
      patches.data = undefined;
      changed = true;
    }

    // Trim sub-agent group results
    if (rec.kind === "subagent_group" && Array.isArray(rec.agents)) {
      const agents = rec.agents as { result?: string }[];
      let agentsChanged = false;
      const trimmedAgents = agents.map((a) => {
        if (typeof a.result === "string" && a.result.length > MAX_RESULT_CHARS_IN_HISTORY) {
          agentsChanged = true;
          return { ...a, result: truncateResult(a.result) };
        }
        return a;
      });
      if (agentsChanged) {
        patches.agents = trimmedAgents;
        changed = true;
      }
    }

    return changed ? { ...item, ...patches } : item;
  });
}

/**
 * Called when `onTurnText` fires (end of each LLM turn that produced text).
 * All previous items are guaranteed complete — tool calls from this turn
 * finished before `turn_end` fired, and `onTurnText` fires inside `turn_end`.
 *
 * Returns the items to flush to history. The caller should then set liveItems
 * to contain only the new text item.
 */
export function flushOnTurnText<T extends FlushableItem>(liveItems: T[]): T[] {
  return liveItems;
}

/**
 * Called when `onTurnEnd` fires with a tool_use stop reason (LLM responded
 * with only tool calls, no text). Flushes all items IF none are still pending
 * (no `tool_start` without a corresponding `tool_done`).
 *
 * Returns { flushed, remaining } — flushed items go to history, remaining
 * items stay in liveItems.
 */
export function flushOnTurnEnd<T extends FlushableItem>(
  liveItems: T[],
  stopReason: string,
): { flushed: T[]; remaining: T[] } {
  if (stopReason !== "tool_use") {
    return { flushed: [], remaining: liveItems };
  }

  const hasPendingToolStart = liveItems.some((item) => item.kind === "tool_start");

  if (hasPendingToolStart || liveItems.length === 0) {
    return { flushed: [], remaining: liveItems };
  }

  return { flushed: liveItems, remaining: [] };
}
