import React from "react";
import { Box, Text, render, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { partitionCompleted, pinStreamingTextBeforeToolBoundary } from "./item-helpers.js";
import {
  getChatControlsLayoutDecision,
  shouldTopSpaceAssistantAfterToolBoundary,
  shouldTopSpaceStreamingAssistant,
} from "./layout-decisions.js";
import { AssistantMessage } from "./components/AssistantMessage.js";
import { StreamingArea } from "./components/StreamingArea.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import type { FooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function getLastFrameLines(output: string): string[] {
  const text = stripAnsi(output);
  const lastFooterIndex = text.lastIndexOf("FOOTER");
  if (lastFooterIndex === -1) return [];
  const previousFooterIndex = text.lastIndexOf("FOOTER", lastFooterIndex - 1);
  const start = previousFooterIndex === -1 ? 0 : previousFooterIndex + "FOOTER".length;
  return text
    .slice(start, lastFooterIndex + "FOOTER".length)
    .split("\n")
    .filter(Boolean);
}

function CompactChatHarness({ liveCount }: { liveCount: number }) {
  return (
    <Box flexDirection="column" width={40}>
      <Box flexDirection="column" paddingRight={1}>
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text>CONTROL_STATUS</Text>
        <Text>CHAT_INPUT</Text>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

function PinnedChatHarness({ liveCount }: { liveCount: number }) {
  const rows = 8;
  const controlsRows = 3;
  const liveAreaRows = rows - controlsRows;
  const shouldPin = liveCount > 0;
  return (
    <Box flexDirection="column" width={40} height={shouldPin ? rows : undefined}>
      <Box
        flexDirection="column"
        height={shouldPin ? liveAreaRows : undefined}
        justifyContent={shouldPin ? "flex-end" : undefined}
        overflowY={shouldPin ? "hidden" : undefined}
      >
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column" minHeight={controlsRows}>
        <Text>CONTROL_STATUS</Text>
        <Text>CHAT_INPUT</Text>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

function UnlatchedChatHarness({ liveCount }: { liveCount: number }) {
  return (
    <Box flexDirection="column" width={40}>
      <Box flexDirection="column" height={5} flexShrink={1} overflowY="hidden">
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0} flexGrow={0}>
        <Text>CONTROL_STATUS</Text>
        <Text>CHAT_INPUT</Text>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

function LatchedChatHarness({ liveCount }: { liveCount: number }) {
  return (
    <Box flexDirection="column" width={40} height={8}>
      <Box flexDirection="column" height={5} flexShrink={1} overflowY="hidden">
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0} flexGrow={0}>
        <Text>CONTROL_STATUS</Text>
        <Text>CHAT_INPUT</Text>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

function AppMeasuredMaxHeightHarness({
  liveCount,
  controlsRows,
}: {
  liveCount: number;
  controlsRows: number;
}) {
  return (
    <Box flexDirection="column" width={40} flexShrink={0} flexGrow={0}>
      <Box flexDirection="column" flexGrow={0} flexShrink={1} overflowY="hidden">
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0} flexGrow={0}>
        <Text>FRAME_MARKER_{controlsRows}</Text>
        {Array.from({ length: controlsRows }, (_, index) => (
          <Text key={index}>CONTROL_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
    </Box>
  );
}

const noFooterStatus: FooterStatusLayoutDecision = {
  hasBackgroundTasks: false,
  hasUpdateNotice: false,
  stack: false,
  compactBackgroundTasks: false,
};

describe("streaming assistant ordering", () => {
  it("pins visible streaming assistant text before the first tool row", () => {
    const items = pinStreamingTextBeforeToolBoundary({
      items: [],
      visibleStreamingText: "I’ll inspect the renderer first.",
      thinking: "",
      thinkingMs: 0,
      makeId: () => "assistant-pinned-1",
    });

    expect(items).toEqual([
      {
        kind: "assistant",
        text: "I’ll inspect the renderer first.",
        thinking: undefined,
        thinkingMs: undefined,
        id: "assistant-pinned-1",
      },
    ]);
  });

  it("does not pin reasoning marker text before tool rows", () => {
    expect(
      pinStreamingTextBeforeToolBoundary({
        items: [],
        visibleStreamingText: 'currentItem?.type === "reasoning"',
        thinking: "",
        thinkingMs: 0,
        makeId: () => "assistant-pinned-1",
      }),
    ).toEqual([]);
  });

  it("does not pin duplicate assistant text when a live assistant row already exists", () => {
    const existing = {
      kind: "assistant" as const,
      text: "I’ll inspect the renderer first.",
      id: "assistant-existing-1",
    };

    expect(
      pinStreamingTextBeforeToolBoundary({
        items: [existing],
        visibleStreamingText: "I’ll inspect the renderer first.",
        thinking: "",
        thinkingMs: 0,
        makeId: () => "assistant-pinned-1",
      }),
    ).toEqual([existing]);
  });

  it("keeps pinned assistant text in front of a subsequently appended tool row", () => {
    const pinned = pinStreamingTextBeforeToolBoundary({
      items: [],
      visibleStreamingText: "I’ll inspect the renderer first.",
      thinking: "",
      thinkingMs: 0,
      makeId: () => "assistant-pinned-1",
    });

    const next = [
      ...pinned,
      {
        kind: "tool_start" as const,
        toolCallId: "read-1",
        name: "read",
        args: { file_path: "src/ui/App.tsx" },
        id: "tool-1",
        startedAt: 0,
        animateUntil: 0,
      },
    ];

    expect(next.map((item) => item.kind)).toEqual(["assistant", "tool_start"]);
  });

  it("flushes pinned assistant text with the completed tool row that follows it", () => {
    const assistant = {
      kind: "assistant" as const,
      text: "I’ll inspect these files first.",
      id: "assistant-pinned-1",
    };
    const group = {
      kind: "tool_group" as const,
      id: "tool-group-1",
      tools: [
        {
          toolCallId: "read-1",
          name: "read",
          args: { file_path: "src/a.ts" },
          status: "done" as const,
          result: "ok",
        },
      ],
    };

    const { flushed, remaining } = partitionCompleted([assistant, group]);

    expect(flushed.map((item) => item.kind)).toEqual(["assistant", "tool_group"]);
    expect(remaining).toEqual([]);
  });
});

describe("streaming assistant spacing", () => {
  it("top-spaces streaming text after the last flushed tool row", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Next I’ll inspect the terminal history serialized output.",
        lastHistoryItem: {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [],
        },
      }),
    ).toBe(true);
  });

  it("top-spaces streaming text while the flushed tool row is still pending history commit", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Next I’ll inspect the terminal history serialized output.",
        lastPendingHistoryItem: {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [],
        },
      }),
    ).toBe(true);
  });

  it("top-spaces a completed live assistant row after a flushed tool boundary", () => {
    expect(
      shouldTopSpaceAssistantAfterToolBoundary({
        text: "Next I’ll inspect the terminal history serialized output.",
        lastPendingHistoryItem: {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [],
        },
      }),
    ).toBe(true);
  });

  it("does not top-space streaming text when no prior agent row exists", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "First answer in the conversation.",
      }),
    ).toBe(false);
  });

  it("does not top-space streaming text after the submitted user row", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Answering right after the prompt.",
        lastPendingHistoryItem: {
          kind: "user",
          id: "user-1",
          text: "Please fix this.",
        },
      }),
    ).toBe(false);
  });

  it("top-spaces streaming text after a live queued row", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Continuing the current response.",
        lastLiveItem: {
          kind: "queued",
          id: "queued-1",
          text: "next prompt",
        },
      }),
    ).toBe(true);
  });

  it("top-spaces streaming text after a finalized task row", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Now I’ll work through the task output.",
        lastHistoryItem: {
          kind: "task",
          id: "task-1",
          title: "Restore task pane",
        },
      }),
    ).toBe(true);
  });

  it("top-spaces streaming text after finalized notice rows", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Back to answering after the notice.",
        lastHistoryItem: {
          kind: "update_notice",
          id: "update-notice-1",
          text: "Ken just pushed a fresh update.",
        },
      }),
    ).toBe(true);
  });
});

describe("chat controls layout", () => {
  it("caps finalized assistant rows the same way as streaming assistant rows", () => {
    const text = Array.from({ length: 24 }, (_, index) => `final line ${index + 1}`).join("\n");
    const streaming = stripAnsi(
      renderToString(
        <TerminalSizeProvider>
          <StreamingArea
            isRunning
            streamingText={text}
            streamingThinking=""
            availableTerminalHeight={6}
          />
        </TerminalSizeProvider>,
        { columns: 60 },
      ),
    )
      .split("\n")
      .filter(Boolean);
    const finalized = stripAnsi(
      renderToString(
        <TerminalSizeProvider>
          <AssistantMessage text={text} availableTerminalHeight={6} />
        </TerminalSizeProvider>,
        { columns: 60 },
      ),
    )
      .split("\n")
      .filter(Boolean);

    expect(streaming.length).toBeLessThanOrEqual(6);
    expect(finalized.length).toBeLessThanOrEqual(6);
    expect(finalized.length).toBe(streaming.length);
  });

  it("reserves stable controls rows while the agent is running", () => {
    const layout = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
      liveToolPanelRows: 0,
    });

    expect(layout).toEqual({ controlsRows: 6, liveAreaRows: 18 });
  });

  it("reserves the same controls rows for running and done status", () => {
    const running = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
      liveToolPanelRows: 0,
    });
    const done = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: false,
      activityVisible: false,
      doneStatusVisible: true,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
      liveToolPanelRows: 0,
    });

    expect(done.controlsRows).toBe(running.controlsRows);
  });

  it("reserves the same controls rows for idle and running status", () => {
    const idle = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: false,
      activityVisible: false,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
      liveToolPanelRows: 0,
    });
    const running = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
      liveToolPanelRows: 0,
    });

    expect(idle.controlsRows).toBe(running.controlsRows);
    expect(idle.liveAreaRows).toBe(running.liveAreaRows);
  });

  it("reserves controls rows for the live tool panel so the footer never bounces as tools run", () => {
    const base = {
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
    };
    const noPanel = getChatControlsLayoutDecision({ ...base, liveToolPanelRows: 0 });
    const oneRow = getChatControlsLayoutDecision({ ...base, liveToolPanelRows: 1 });
    const threeRows = getChatControlsLayoutDecision({ ...base, liveToolPanelRows: 3 });

    // Each tool-panel row is added to the controls budget and removed from the
    // live area, so the total stays exactly `rows` and the footer stays pinned.
    expect(oneRow.controlsRows).toBe(noPanel.controlsRows + 1);
    expect(threeRows.controlsRows).toBe(noPanel.controlsRows + 3);
    expect(noPanel.controlsRows + noPanel.liveAreaRows).toBe(24);
    expect(threeRows.controlsRows + threeRows.liveAreaRows).toBe(24);
  });

  it("caps the reserved live tool panel rows at the rolling window height", () => {
    const base = {
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      footerFitsOnOneLine: true,
    };
    const threeRows = getChatControlsLayoutDecision({ ...base, liveToolPanelRows: 3 });
    const tenRows = getChatControlsLayoutDecision({ ...base, liveToolPanelRows: 10 });

    expect(tenRows.controlsRows).toBe(threeRows.controlsRows);
  });

  it("keeps a minimum live area when controls consume most terminal rows", () => {
    const layout = getChatControlsLayoutDecision({
      rows: 10,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: {
        ...noFooterStatus,
        hasBackgroundTasks: true,
        hasUpdateNotice: true,
        stack: true,
      },
      taskBarExpanded: true,
      footerFitsOnOneLine: false,
      liveToolPanelRows: 0,
    });

    expect(layout.liveAreaRows).toBe(3);
  });
});

describe("compact chat layout", () => {
  it("does not reserve blank terminal rows above the controls when live output is empty", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 12,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { unmount } = render(<CompactChatHarness liveCount={0} />, {
      stdout,
      columns: 40,
      rows: 12,
      debug: true,
    });

    expect(getLastFrameLines(output)).toEqual(["CONTROL_STATUS", "CHAT_INPUT", "FOOTER"]);
    unmount();
  });

  it("renders live output directly above the controls without flex filler", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 12,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { unmount } = render(<CompactChatHarness liveCount={2} />, {
      stdout,
      columns: 40,
      rows: 12,
      debug: true,
    });

    expect(getLastFrameLines(output)).toEqual([
      "LIVE_ROW_01",
      "LIVE_ROW_02",
      "CONTROL_STATUS",
      "CHAT_INPUT",
      "FOOTER",
    ]);
    unmount();
  });

  it("removes fullscreen filler after live output shrinks", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 8,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { rerender, unmount } = render(<PinnedChatHarness liveCount={5} />, {
      stdout,
      columns: 40,
      rows: 8,
      debug: true,
    });

    rerender(<PinnedChatHarness liveCount={0} />);

    expect(getLastFrameLines(output)).toEqual(["CONTROL_STATUS", "CHAT_INPUT", "FOOTER"]);
    unmount();
  });

  it("reproduces controls being pushed off the terminal bottom when long live output is not latched", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 8,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { unmount } = render(<UnlatchedChatHarness liveCount={12} />, {
      stdout,
      columns: 40,
      rows: 8,
      debug: true,
    });

    const lines = getLastFrameLines(output);
    expect(lines.at(-3)).toBe("CONTROL_STATUS");
    expect(lines.at(-2)).toBe("CHAT_INPUT");
    expect(lines.at(-1)).toBe("FOOTER");
    expect(lines[0]).not.toBe("LIVE_ROW_01");
    unmount();
  });

  it("keeps controls latched to the terminal bottom when long live output overflows", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 8,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { unmount } = render(<LatchedChatHarness liveCount={12} />, {
      stdout,
      columns: 40,
      rows: 8,
      debug: true,
    });

    const lines = getLastFrameLines(output);
    expect(lines.at(-3)).toBe("CONTROL_STATUS");
    expect(lines.at(-2)).toBe("CHAT_INPUT");
    expect(lines.at(-1)).toBe("FOOTER");
    expect(lines).toHaveLength(8);
    unmount();
  });

  it("keeps the App layout capped by measured controls during long live output", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 10,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { rerender, unmount } = render(
      <AppMeasuredMaxHeightHarness liveCount={14} controlsRows={5} />,
      {
        stdout,
        columns: 40,
        rows: 10,
        debug: true,
      },
    );

    rerender(<AppMeasuredMaxHeightHarness liveCount={14} controlsRows={5} />);

    const text = stripAnsi(output);
    const lastMarker = text.lastIndexOf("FRAME_MARKER_5");
    const previousMarker = text.lastIndexOf("FRAME_MARKER_5", lastMarker - 1);
    const frame = text
      .slice(previousMarker === -1 ? 0 : previousMarker + "FRAME_MARKER_5".length, lastMarker)
      .split("\n")
      .filter(Boolean);
    const finalRows = text.slice(lastMarker).split("\n").filter(Boolean);

    expect(frame).not.toContain("CONTROL_ROW_03LIVE_ROW_03");
    expect(finalRows).toEqual([
      "FRAME_MARKER_5",
      "CONTROL_ROW_01",
      "CONTROL_ROW_02",
      "CONTROL_ROW_03",
      "CONTROL_ROW_04",
      "CONTROL_ROW_05",
    ]);
    unmount();
  });
});
