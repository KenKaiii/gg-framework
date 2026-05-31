import { describe, expect, it } from "vitest";
import type { CompletedItem } from "./app-items.js";
import { routePromptCommandInput } from "./prompt-routing.js";
import { getNextGeneratedItemId, removeItemsWithIds, uniqueItemsById } from "./item-helpers.js";
import {
  getDoneFlushDecision,
  shouldHideHistoryForOverlayView,
  shouldHideStaticItemsForOverlayView,
  shouldStabilizeOverlayPaneRerender,
} from "./layout-decisions.js";

describe("App TUI state persistence helpers", () => {
  it("hides Static history for overlay panes so they open as standalone views", () => {
    expect(shouldHideHistoryForOverlayView(true, false)).toBe(true);
    expect(shouldHideHistoryForOverlayView(true, true)).toBe(true);
    expect(shouldHideHistoryForOverlayView(false, false)).toBe(false);
  });

  it("keeps standalone overlay state hidden even while rerendering", () => {
    const hideHistory = shouldHideHistoryForOverlayView(true, true);
    const stabilizeStatic = shouldStabilizeOverlayPaneRerender({
      overlayPane: "skills",
      isAgentRunning: true,
    });

    expect(hideHistory).toBe(true);
    expect(
      shouldHideStaticItemsForOverlayView({
        shouldHideHistoryForOverlay: hideHistory,
        stabilizeOverlayPaneRerender: stabilizeStatic,
      }),
    ).toBe(true);
  });

  it("persists the visible completion footer across idle pane remounts", () => {
    const doneStatus = { durationMs: 3200, toolsUsed: [], verb: "Mulled it over for" };
    const sessionStore = { doneStatus: null as typeof doneStatus | null };

    sessionStore.doneStatus = doneStatus;

    expect(sessionStore.doneStatus).toEqual(doneStatus);
  });

  it("shows the done footer unless a plan review pane is about to open", () => {
    expect(getDoneFlushDecision({ planOverlayPending: false })).toEqual({
      showDoneStatus: true,
      flushLiveItems: true,
    });
    expect(getDoneFlushDecision({ planOverlayPending: true })).toEqual({
      showDoneStatus: false,
      flushLiveItems: true,
    });
  });

  it("seeds generated item IDs after restored ui-prefixed history and live rows", () => {
    expect(
      getNextGeneratedItemId([{ id: "banner" }, { id: "ui-0" }, { id: "ui-1" }, { id: "ui-7" }]),
    ).toBe(8);
  });

  it("keeps fresh-session generated IDs in the same ui-prefixed namespace", () => {
    const firstFreshItem = `ui-${getNextGeneratedItemId([{ id: "banner" }])}`;

    expect(firstFreshItem).toBe("ui-0");
  });

  it("dedupes restored live rows by id before rendering", () => {
    const restoredLiveItems: CompletedItem[] = [
      { kind: "info", text: "first", id: "ui-0" },
      { kind: "info", text: "duplicate", id: "ui-0" },
      { kind: "info", text: "second", id: "ui-1" },
    ];

    expect(uniqueItemsById(restoredLiveItems).map((item) => item.id)).toEqual(["ui-0", "ui-1"]);
  });

  it("drops restored live rows that were already finalized into history", () => {
    const restoredLiveItems: CompletedItem[] = [
      { kind: "info", text: "already printed", id: "ui-0" },
      { kind: "info", text: "still live", id: "ui-1" },
    ];
    const historyIds = new Set(["banner", "ui-0"]);

    expect(removeItemsWithIds(restoredLiveItems, historyIds).map((item) => item.id)).toEqual([
      "ui-1",
    ]);
  });

  it("routes slash prompt commands with pasted multi-line args into the command path", () => {
    const pastedArgs = "prove this snippet renders:\nconst a = 1;\nconsole.log(a);";
    const route = routePromptCommandInput(`/expand ${pastedArgs}`);

    expect(route).toMatchObject({ cmdName: "expand", cmdArgs: pastedArgs });
    expect(route?.fullPrompt).toContain(`## User Instructions\n\n${pastedArgs}`);
  });
});
