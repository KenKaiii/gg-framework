import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import { getChatControlsLayoutDecision, MIN_LIVE_AREA_ROWS } from "./layout-decisions.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { useTheme } from "./theme/theme.js";
import type { CompletedItem } from "./app-items.js";
import type { FooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

const noFooterStatus: FooterStatusLayoutDecision = {
  hasBackgroundTasks: false,
  hasUpdateNotice: false,
  stack: false,
  compactBackgroundTasks: false,
};

const ROWS = 24;
const COLUMNS = 60;

// Worst case for the live-frame jump: the agent has just gone idle, so the
// activity/status row disappears and the controls shrink — which grows the live
// area to nearly fill the screen right as the finalized assistant row renders.
const idleControlsRows = getChatControlsLayoutDecision({
  rows: ROWS,
  columns: COLUMNS,
  agentRunning: false,
  activityVisible: false,
  doneStatusVisible: false,
  stallStatusVisible: false,
  exitPending: false,
  footerStatusLayout: noFooterStatus,
  taskBarExpanded: false,
  footerFitsOnOneLine: true,
  liveToolPanelRows: 0,
}).controlsRows;

// Mirror useChatLayoutMeasurements: rows - controlsRows - 2 (the widened cushion).
const measuredLiveAreaRows = Math.max(MIN_LIVE_AREA_ROWS, ROWS - idleControlsRows - 2);

// A previous tool boundary forces the assistant transcript item's top margin.
const previousToolGroup: CompletedItem = {
  kind: "tool_group",
  id: "tool-group-1",
  tools: [],
};

function ThemedTranscriptItem({ item }: { item: CompletedItem }) {
  const theme = useTheme();
  const items = [previousToolGroup, item];
  return (
    <>
      {renderTranscriptItem({
        item,
        index: 1,
        items,
        version: "0.0.0-test",
        currentModel: "test-model",
        currentProvider: "anthropic",
        displayedCwd: "/tmp",
        columns: COLUMNS,
        theme,
        renderMarkdown: true,
        measuredLiveAreaRows,
      })}
    </>
  );
}

function renderFrameLineCount(item: CompletedItem): number {
  const output = renderToString(
    <TerminalSizeProvider>
      <ThemedTranscriptItem item={item} />
    </TerminalSizeProvider>,
    { columns: COLUMNS },
  );
  return stripAnsi(output).split("\n").filter(Boolean).length;
}

describe("live frame height", () => {
  it("keeps a tall finalized assistant frame (with thinking) below terminal height", () => {
    const text = Array.from({ length: ROWS * 3 }, (_, index) => `final line ${index + 1}`).join(
      "\n",
    );
    const item: CompletedItem = {
      kind: "assistant",
      id: "assistant-tall-thinking",
      text,
      thinking: "internal reasoning that collapses to a header",
      thinkingMs: 1200,
    };

    const lines = renderFrameLineCount(item);

    // Adding back the controls must never reach the terminal height, or Ink
    // enters its fullscreen clearTerminal path and snaps the controls to the top.
    expect(lines + idleControlsRows).toBeLessThanOrEqual(ROWS - 1);
  });

  it("keeps a tall finalized assistant frame (no thinking) below terminal height", () => {
    const text = Array.from({ length: ROWS * 3 }, (_, index) => `final line ${index + 1}`).join(
      "\n",
    );
    const item: CompletedItem = {
      kind: "assistant",
      id: "assistant-tall-plain",
      text,
    };

    const lines = renderFrameLineCount(item);

    expect(lines + idleControlsRows).toBeLessThanOrEqual(ROWS - 1);
  });

  it("reserves identical controls and live-area rows idle vs running (constant footer)", () => {
    const baseInputs = {
      rows: ROWS,
      columns: COLUMNS,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
      liveToolPanelRows: 0,
    };
    const idle = getChatControlsLayoutDecision({
      ...baseInputs,
      agentRunning: false,
      activityVisible: false,
    });
    const running = getChatControlsLayoutDecision({
      ...baseInputs,
      agentRunning: true,
      activityVisible: true,
    });

    expect(idle.controlsRows).toBe(running.controlsRows);
    expect(idle.liveAreaRows).toBe(running.liveAreaRows);
  });
});
