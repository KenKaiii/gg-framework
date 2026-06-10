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

    // Trim tool group results
    if (rec.kind === "tool_group" && Array.isArray(rec.tools)) {
      const tools = rec.tools as { result?: string }[];
      let toolsChanged = false;
      const trimmedTools = tools.map((t) => {
        if (typeof t.result === "string" && t.result.length > MAX_RESULT_CHARS_IN_HISTORY) {
          toolsChanged = true;
          return { ...t, result: truncateResult(t.result) };
        }
        return t;
      });
      if (toolsChanged) {
        patches.tools = trimmedTools;
        changed = true;
      }
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
 * Returns the items to flush to history. Callers should keep the live area
 * bounded and avoid re-rendering finalized long text through Ink.
 */
export function flushOnTurnText<T extends FlushableItem>(liveItems: T[]): T[] {
  return liveItems;
}

/**
 * Aggressive overflow flush: when live items exceed a threshold, flush all
 * completed items except the last few to keep the live area bounded.
 * This enables terminal scrollback access during long multi-tool runs.
 *
 * Returns { flushed, remaining }. Call this on every tool_start/tool_end
 * when liveItems.length > threshold.
 */
const OVERFLOW_THRESHOLD = 8;
const KEEP_RECENT = 3;

export function flushOverflow<T extends FlushableItem>(
  liveItems: T[],
): { flushed: T[]; remaining: T[] } {
  if (liveItems.length <= OVERFLOW_THRESHOLD) {
    return { flushed: [], remaining: liveItems };
  }

  // Find the last active item (tool_start, running tool_group, server_tool_start)
  let lastActiveIdx = -1;
  for (let i = liveItems.length - 1; i >= 0; i--) {
    const item = liveItems[i];
    if (
      item.kind === "tool_start" ||
      item.kind === "server_tool_start" ||
      (item.kind === "tool_group" &&
        ((item as unknown as { tools: { status: string }[] }).tools ?? []).some(
          (t) => t.status === "running",
        ))
    ) {
      lastActiveIdx = i;
      break;
    }
  }

  // Keep at least KEEP_RECENT items + everything from the last active item onward
  const keepFrom =
    lastActiveIdx >= 0
      ? Math.min(lastActiveIdx, liveItems.length - KEEP_RECENT)
      : liveItems.length - KEEP_RECENT;
  const splitAt = Math.max(0, keepFrom);

  if (splitAt === 0) {
    return { flushed: [], remaining: liveItems };
  }

  const candidates = liveItems.slice(0, splitAt);
  return { flushed: candidates, remaining: liveItems.slice(splitAt) };
}

/**
 * When a turn finalizes, decide how many leading items must be flushed to
 * scrollback immediately because the pinned frame is too tall for the live
 * area. Finalized items lose the streaming-time table/code-block clamp, so a
 * too-tall pinned frame exceeds the terminal and Ink can only paint its
 * bottom rows — the top of the response (e.g. a table's header) is never
 * painted anywhere until the next turn's flush finally writes it to
 * scrollback.
 *
 * The budget is CUMULATIVE: a turn segmented on [DONE:N] markers pins several
 * assistant items whose individual heights fit while their sum overflows.
 * Walking from the end, keep the largest suffix that fits within
 * `liveAreaRows` and flush the leading complement — a contiguous prefix, so
 * transcript order is preserved. An item taller than the whole budget flushes
 * itself and everything before it. Returns 0 when everything fits or the
 * live area hasn't been measured yet.
 */
export function countOversizedFlushItems(
  items: readonly { kind: string; text?: string }[],
  estimateRows: (text: string) => number,
  liveAreaRows: number,
): number {
  if (liveAreaRows <= 0) return 0;
  let rows = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    // Non-assistant rows (step_done, etc.) are single-line; assistant items
    // are estimated from their text. +1 approximates the transcript margin
    // between items — over-counting just flushes marginally earlier.
    const itemRows =
      item.kind === "assistant" && typeof item.text === "string" ? estimateRows(item.text) : 1;
    rows += itemRows + (i < items.length - 1 ? 1 : 0);
    if (rows > liveAreaRows) return i + 1;
  }
  return 0;
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

  const hasPendingToolStart = liveItems.some(
    (item) =>
      item.kind === "tool_start" ||
      item.kind === "server_tool_start" ||
      (item.kind === "tool_group" &&
        ((item as unknown as { tools: { status: string }[] }).tools ?? []).some(
          (t) => t.status === "running",
        )),
  );

  if (hasPendingToolStart || liveItems.length === 0) {
    return { flushed: [], remaining: liveItems };
  }

  return {
    flushed: liveItems,
    remaining: [],
  };
}
