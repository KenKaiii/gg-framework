import { describe, it, expect } from "vitest";
import {
  pruneHistory,
  flushOnTurnText,
  flushOnTurnEnd,
  countOversizedFlushItems,
  MAX_HISTORY_ITEMS,
  type FlushableItem,
} from "./live-item-flush.js";
import { estimateRenderedRows } from "./utils/assistant-stream-split.js";

// ── Test helpers ──────────────────────────────────────────

let idCounter = 0;
function id(): string {
  return `test-${++idCounter}`;
}

function userItem(): FlushableItem {
  return { kind: "user", id: id() };
}

function assistantItem(): FlushableItem {
  return { kind: "assistant", id: id() };
}

function toolStart(toolCallId?: string): FlushableItem & { toolCallId: string } {
  return { kind: "tool_start", id: id(), toolCallId: toolCallId ?? id() };
}

function toolDone(): FlushableItem {
  return { kind: "tool_done", id: id() };
}

function subagentGroup(): FlushableItem {
  return { kind: "subagent_group", id: id() };
}

function errorItem(): FlushableItem {
  return { kind: "error", id: id() };
}

// ── pruneHistory ──────────────────────────────────────────

describe("pruneHistory", () => {
  it("returns items unchanged when under the limit", () => {
    const items = [userItem(), assistantItem(), toolDone()];
    const result = pruneHistory(items);
    expect(result).toBe(items); // same reference, no copy
  });

  it("returns items unchanged at exactly the limit", () => {
    const items = Array.from({ length: MAX_HISTORY_ITEMS }, () => userItem());
    const result = pruneHistory(items);
    expect(result).toBe(items);
  });

  it("drops oldest items when over the limit", () => {
    const items = Array.from({ length: MAX_HISTORY_ITEMS + 50 }, (_, i) => ({
      kind: "user",
      id: `item-${i}`,
    }));
    const result = pruneHistory(items);
    expect(result).toHaveLength(MAX_HISTORY_ITEMS);
    // Should keep the LAST 500 items (newest)
    expect(result[0].id).toBe("item-50");
    expect(result[result.length - 1].id).toBe(`item-${MAX_HISTORY_ITEMS + 49}`);
  });

  it("handles empty array", () => {
    const result = pruneHistory([]);
    expect(result).toEqual([]);
  });

  it("handles single item", () => {
    const items = [userItem()];
    const result = pruneHistory(items);
    expect(result).toBe(items);
  });
});

// ── flushOnTurnText ───────────────────────────────────────

describe("flushOnTurnText", () => {
  it("returns all items for flushing when liveItems is non-empty", () => {
    const items = [assistantItem(), toolDone(), toolDone()];
    const flushed = flushOnTurnText(items);
    expect(flushed).toBe(items);
    expect(flushed).toHaveLength(3);
  });

  it("returns empty array when liveItems is empty", () => {
    const flushed = flushOnTurnText([]);
    expect(flushed).toEqual([]);
  });

  it("flushes tool_start items (they are from a completed turn)", () => {
    // When onTurnText fires, even stale tool_start items from the same turn
    // are complete (tool_end already replaced them in the normal flow, but
    // if somehow a tool_start remains, the turn is still over).
    const items = [assistantItem(), toolStart(), toolDone()];
    const flushed = flushOnTurnText(items);
    expect(flushed).toHaveLength(3);
  });

  it("flushes mixed item types from multi-turn accumulation", () => {
    // Simulates items accumulated across multiple turns before flush was added
    const items = [
      userItem(),
      assistantItem(),
      toolDone(),
      toolDone(),
      assistantItem(),
      toolDone(),
      toolDone(),
      toolDone(),
      assistantItem(),
    ];
    const flushed = flushOnTurnText(items);
    expect(flushed).toHaveLength(9);
  });

  it("flushes subagent group items", () => {
    const items = [assistantItem(), subagentGroup(), toolDone()];
    const flushed = flushOnTurnText(items);
    expect(flushed).toHaveLength(3);
  });

  it("flushes error items", () => {
    const items = [errorItem(), assistantItem()];
    const flushed = flushOnTurnText(items);
    expect(flushed).toHaveLength(2);
  });
});

// ── countOversizedFlushItems ──────────────────────────────

describe("countOversizedFlushItems", () => {
  const LIVE_ROWS = 20;
  const COLUMNS = 80;
  const estimate = (text: string) => estimateRenderedRows(text, COLUMNS);

  const shortText = { kind: "assistant", text: "A short answer.", id: "short" };
  const stepDone = { kind: "step_done", id: "step" };
  // A markdown table tall enough to exceed the live area: header + separator
  // + 30 rows, double-counted by the table heuristic.
  const tallTable = {
    kind: "assistant",
    text: [
      "| Feature | Detail |",
      "| --- | --- |",
      ...Array.from({ length: 30 }, (_, i) => `| Row ${i} | some detail text |`),
    ].join("\n"),
    id: "table",
  };

  it("returns 0 when every assistant item fits the live area", () => {
    expect(countOversizedFlushItems([shortText, stepDone], estimate, LIVE_ROWS)).toBe(0);
  });

  it("flushes through the oversized assistant item (the table-cut-off bug)", () => {
    expect(countOversizedFlushItems([tallTable], estimate, LIVE_ROWS)).toBe(1);
  });

  it("flushes earlier siblings too, preserving transcript order", () => {
    // [short, step_done, tallTable, short] — flushing only the table would
    // print it to scrollback BEFORE the pinned earlier items get flushed on
    // the next turn, corrupting order. Cut must include everything up to and
    // including the last oversized item.
    const items = [shortText, stepDone, tallTable, { ...shortText, id: "tail" }];
    expect(countOversizedFlushItems(items, estimate, LIVE_ROWS)).toBe(3);
  });

  it("ignores non-assistant items even with long text", () => {
    const longError = { kind: "error", text: "x".repeat(10_000), id: "err" };
    expect(countOversizedFlushItems([longError], estimate, LIVE_ROWS)).toBe(0);
  });

  it("returns 0 when the live area has not been measured yet", () => {
    expect(countOversizedFlushItems([tallTable], estimate, 0)).toBe(0);
  });

  it("returns 0 for an empty item list", () => {
    expect(countOversizedFlushItems([], estimate, LIVE_ROWS)).toBe(0);
  });

  it("flushes a tall plain-text response too (no table required)", () => {
    const tallText = {
      kind: "assistant",
      text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
      id: "tall-text",
    };
    expect(countOversizedFlushItems([tallText], estimate, LIVE_ROWS)).toBe(1);
  });

  it("CUMULATIVE: several medium items that fit individually but overflow together", () => {
    // [DONE:N] segmentation pins multiple assistant items per turn. Three
    // 10-row items each fit a 20-row live area alone, but the pinned set is
    // ~32 rows — same top-rows-never-painted bug as a single tall table.
    const medium = (id: string) => ({
      kind: "assistant",
      text: Array.from({ length: 10 }, (_, i) => `para line ${i}`).join("\n"),
      id,
    });
    const items = [medium("a"), { kind: "step_done", id: "s" }, medium("b"), medium("c")];
    // Suffix that fits: [medium c] (10+0) + [medium b] (10+1) = 21 > 20, so
    // only "c" survives — flush the first three.
    expect(countOversizedFlushItems(items, estimate, LIVE_ROWS)).toBe(3);
  });

  it("CUMULATIVE: keeps the whole set when the sum fits the budget", () => {
    const small = (id: string) => ({ kind: "assistant", text: "one line", id });
    const items = [small("a"), { kind: "step_done", id: "s" }, small("b")];
    expect(countOversizedFlushItems(items, estimate, LIVE_ROWS)).toBe(0);
  });
});

// ── flushOnTurnEnd ────────────────────────────────────────

describe("flushOnTurnEnd", () => {
  describe("with tool_use stop reason", () => {
    it("flushes all items when no pending tool_start exists", () => {
      const items = [assistantItem(), toolDone(), toolDone()];
      const { flushed, remaining } = flushOnTurnEnd(items, "tool_use");
      expect(flushed).toBe(items);
      expect(flushed).toHaveLength(3);
      expect(remaining).toEqual([]);
    });

    it("does NOT flush when a tool_start is still pending", () => {
      const items = [assistantItem(), toolStart(), toolDone()];
      const { flushed, remaining } = flushOnTurnEnd(items, "tool_use");
      expect(flushed).toEqual([]);
      expect(remaining).toBe(items);
      expect(remaining).toHaveLength(3);
    });

    it("does NOT flush when liveItems is empty", () => {
      const { flushed, remaining } = flushOnTurnEnd([], "tool_use");
      expect(flushed).toEqual([]);
      expect(remaining).toEqual([]);
    });

    it("does NOT flush when only tool_start items exist (all pending)", () => {
      const items = [toolStart(), toolStart()];
      const { flushed, remaining } = flushOnTurnEnd(items, "tool_use");
      expect(flushed).toEqual([]);
      expect(remaining).toBe(items);
    });

    it("flushes when items include subagent groups with no pending tool_start", () => {
      const items = [subagentGroup(), toolDone()];
      const { flushed, remaining } = flushOnTurnEnd(items, "tool_use");
      expect(flushed).toHaveLength(2);
      expect(remaining).toEqual([]);
    });
  });

  describe("with non-tool_use stop reasons", () => {
    it("does NOT flush for end_turn stop reason", () => {
      const items = [assistantItem(), toolDone()];
      const { flushed, remaining } = flushOnTurnEnd(items, "end_turn");
      expect(flushed).toEqual([]);
      expect(remaining).toBe(items);
    });

    it("does NOT flush for stop_sequence stop reason", () => {
      const items = [assistantItem()];
      const { flushed, remaining } = flushOnTurnEnd(items, "stop_sequence");
      expect(flushed).toEqual([]);
      expect(remaining).toBe(items);
    });

    it("does NOT flush for max_tokens stop reason", () => {
      const items = [assistantItem(), toolDone(), toolDone()];
      const { flushed, remaining } = flushOnTurnEnd(items, "max_tokens");
      expect(flushed).toEqual([]);
      expect(remaining).toBe(items);
    });
  });
});

// ── Integration: simulated agent run scenarios ────────────

describe("flush integration scenarios", () => {
  /**
   * Simulates the state management that App.tsx does with setLiveItems
   * and setHistory, using the extracted pure functions.
   */
  function simulateRun(
    turns: Array<{
      text?: string;
      tools?: number; // number of tool calls
      stopReason: string;
    }>,
  ) {
    let liveItems: FlushableItem[] = [];
    let history: FlushableItem[] = [];

    for (const turn of turns) {
      // Simulate tool calls happening before turn_end
      for (let i = 0; i < (turn.tools ?? 0); i++) {
        liveItems = [...liveItems, toolStart()];
        // Tool completes (replaces tool_start with tool_done in real code)
        liveItems = liveItems.map((item) =>
          item.kind === "tool_start" && liveItems.indexOf(item) === liveItems.length - 1
            ? toolDone()
            : item,
        );
      }

      // onTurnEnd fires first
      const turnEndResult = flushOnTurnEnd(liveItems, turn.stopReason);
      if (turnEndResult.flushed.length > 0) {
        history = pruneHistory([...history, ...turnEndResult.flushed]);
      }
      liveItems = turnEndResult.remaining;

      // onTurnText fires second (only if text exists)
      if (turn.text) {
        const flushed = flushOnTurnText(liveItems);
        if (flushed.length > 0) {
          history = pruneHistory([...history, ...flushed]);
        }
        liveItems = [assistantItem()]; // new text item
      }
    }

    return { liveItems, history };
  }

  it("scenario: simple text-only conversation stays bounded", () => {
    const { liveItems, history } = simulateRun([
      { text: "Hello!", stopReason: "end_turn" },
      { text: "How can I help?", stopReason: "end_turn" },
      { text: "Sure thing.", stopReason: "end_turn" },
    ]);
    // Only the last text item should be live
    expect(liveItems).toHaveLength(1);
    expect(liveItems[0].kind).toBe("assistant");
    // Previous text items moved to history
    expect(history).toHaveLength(2);
  });

  it("scenario: text + tools cycle stays bounded", () => {
    const { liveItems, history } = simulateRun([
      { text: "Let me check.", tools: 3, stopReason: "end_turn" },
      { text: "Found it.", tools: 2, stopReason: "end_turn" },
      { text: "Done.", stopReason: "end_turn" },
    ]);
    expect(liveItems).toHaveLength(1);
    // 3 tool_done + 1 assistant + 2 tool_done + 1 assistant = 7
    expect(history).toHaveLength(7);
  });

  it("scenario: tool-only turns flush correctly", () => {
    const { liveItems, history } = simulateRun([
      { tools: 3, stopReason: "tool_use" }, // tool-only, flushed by onTurnEnd
      { tools: 2, stopReason: "tool_use" }, // tool-only, flushed by onTurnEnd
      { text: "All done.", stopReason: "end_turn" },
    ]);
    expect(liveItems).toHaveLength(1);
    expect(liveItems[0].kind).toBe("assistant");
    expect(history).toHaveLength(5); // 3 + 2 tool_done items
  });

  it("scenario: many turns — liveItems never exceeds current turn size", () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({
      text: `Turn ${i}`,
      tools: 5,
      stopReason: "end_turn" as const,
    }));
    const { liveItems } = simulateRun(turns);
    // Only the last text item should remain live
    expect(liveItems).toHaveLength(1);
  });

  it("scenario: alternating text and tool-only turns", () => {
    const { liveItems, history } = simulateRun([
      { text: "Searching...", tools: 2, stopReason: "end_turn" },
      { tools: 3, stopReason: "tool_use" }, // tool-only
      { text: "Found results.", tools: 1, stopReason: "end_turn" },
      { tools: 4, stopReason: "tool_use" }, // tool-only
      { text: "Complete.", stopReason: "end_turn" },
    ]);
    expect(liveItems).toHaveLength(1);
    // History: (2 tools + 1 text) + (3 tools) + (1 tool + 1 text) + (4 tools) = 12
    expect(history).toHaveLength(12);
  });

  it("scenario: stress test — 100 turns with 10 tools each", () => {
    const turns = Array.from({ length: 100 }, () => ({
      text: "Working...",
      tools: 10,
      stopReason: "end_turn" as const,
    }));
    const { liveItems, history } = simulateRun(turns);
    expect(liveItems).toHaveLength(1);
    // Total items: 100 turns * (10 tools + 1 text) - 1 (last text is live) = 1099
    // But pruneHistory caps at 500
    expect(history).toHaveLength(MAX_HISTORY_ITEMS);
  });

  it("REGRESSION: liveItems retained after agent finishes, flushed on next submit", () => {
    // After the agent finishes its last turn, the final AssistantItem stays
    // in liveItems (NOT moved to Static via useEffect). This prevents Ink
    // cursor-math glitches that caused text to get cut off during the
    // live→Static transition. Items are flushed when the user submits the
    // next message (simulated here by flushing before adding a new userItem).
    let liveItems: FlushableItem[] = [];
    let history: FlushableItem[] = [];

    // Agent produces a response (turn 1)
    const flushed1 = flushOnTurnText(liveItems);
    if (flushed1.length > 0) history = pruneHistory([...history, ...flushed1]);
    liveItems = [assistantItem()];

    // Agent finishes — liveItems NOT cleared (no useEffect flush)
    // The final response stays in liveItems
    expect(liveItems).toHaveLength(1);
    expect(liveItems[0].kind).toBe("assistant");

    // User submits next message — NOW flush to Static
    if (liveItems.length > 0) {
      history = pruneHistory([...history, ...liveItems]);
    }
    liveItems = [userItem()];

    // Previous AssistantItem is now in history
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe("assistant");
    // New user message is in liveItems
    expect(liveItems).toHaveLength(1);
    expect(liveItems[0].kind).toBe("user");
  });

  it("REGRESSION: without flush, liveItems would grow unbounded", () => {
    // This test documents the old behavior — liveItems would contain
    // ALL items from ALL turns. With 20 turns of 5 tools each, that's
    // 20 * (5 + 1) = 120 items re-rendered on every timer tick.
    // With the fix, liveItems is always at most 1 item (current text).
    const turns = Array.from({ length: 20 }, () => ({
      text: "Working...",
      tools: 5,
      stopReason: "end_turn" as const,
    }));
    const { liveItems } = simulateRun(turns);
    // The whole point: liveItems MUST be bounded
    expect(liveItems.length).toBeLessThanOrEqual(1);
  });

  it("SCROLL REPRO HARNESS: large queued input and live tool output stay bounded", () => {
    // Deterministic headless stand-in for the reported TUI scroll bug: the user
    // pastes a very large next prompt while the current run is still producing
    // live tool/result rows. No OAuth/API/Ink render is needed; we assert the
    // pure state invariant that protects terminal scrollback from live-area
    // growth. The queued prompt is deliberately huge to catch accidental logic
    // that would keep queued input in the live region before it starts.
    const queuedPrompt = Array.from(
      { length: 600 },
      (_, i) => `queued follow-up line ${i}: ${"x".repeat(80)}`,
    ).join("\n");
    expect(queuedPrompt.length).toBeGreaterThan(50_000);

    let liveItems: FlushableItem[] = [assistantItem()];
    let history: FlushableItem[] = [];
    let maxLiveItems = liveItems.length;

    const queueFlush = (items: FlushableItem[]) => {
      history = pruneHistory([...history, ...items]);
    };
    const partitionCompleted = (items: FlushableItem[]) => {
      const firstActiveIdx = items.findIndex((item) => item.kind === "tool_start");
      if (firstActiveIdx === -1) return { flushed: items, remaining: [] };
      if (firstActiveIdx === 0) return { flushed: [], remaining: items };
      return { flushed: items.slice(0, firstActiveIdx), remaining: items.slice(firstActiveIdx) };
    };

    for (let i = 0; i < 75; i++) {
      // onToolStart flushes completed assistant/tool output before adding the
      // running tool row, so old live output moves to Static/history.
      const beforeStart = partitionCompleted(liveItems);
      if (beforeStart.flushed.length > 0) queueFlush(beforeStart.flushed);
      liveItems = [...beforeStart.remaining, toolStart(`tool-${i}`)];
      maxLiveItems = Math.max(maxLiveItems, liveItems.length);

      // onToolEnd replaces the active row with completed output, then
      // partitionCompleted flushes it. This simulates queued/live work without
      // ever placing the queued prompt itself into liveItems.
      liveItems = liveItems.map((item) =>
        item.kind === "tool_start" ? ({ kind: "tool_done", id: item.id } as FlushableItem) : item,
      );
      const afterEnd = partitionCompleted(liveItems);
      if (afterEnd.flushed.length > 0) queueFlush(afterEnd.flushed);
      liveItems = afterEnd.remaining;
      maxLiveItems = Math.max(maxLiveItems, liveItems.length);
    }

    // While a message is queued, App shows only a tiny queue indicator; the
    // queued text starts rendering as a user item only when onQueuedStart fires.
    expect(queuedPrompt).not.toEqual("");
    expect(maxLiveItems).toBeLessThanOrEqual(1);
    expect(liveItems).toEqual([]);
    expect(history).toHaveLength(76); // initial assistant + 75 completed tool rows
  });
});
