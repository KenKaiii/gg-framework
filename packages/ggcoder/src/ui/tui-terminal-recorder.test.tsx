import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { CompletedItem } from "./app-items.js";
import { ChatControls, ChatLayout } from "./components/ChatLayout.js";
import { ChatLivePane } from "./components/ChatLivePane.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
import type { TerminalHistoryContext } from "./terminal-history.js";
import { Text, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { useTranscriptHistory } from "./hooks/useTranscriptHistory.js";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const COLUMNS = 80;
const ROWS = 24;
const CONTROLS_ROWS = 6;
const LIVE_ROWS = ROWS - CONTROLS_ROWS - 2;
const theme = loadTheme("dark");
const terminalContext: TerminalHistoryContext = {
  theme,
  columns: COLUMNS,
  version: "sim",
  model: "sim-model",
  provider: "anthropic",
  cwd: "/tmp/sim-project",
};

function SimulatedControls({ label }: { label: string }) {
  return (
    <ChatControls controlsRef={() => {}}>
      <Text>{label}</Text>
      <Text>SIM_INPUT_TOP</Text>
      <Text>SIM_INPUT_BODY</Text>
      <Text>SIM_INPUT_BOTTOM</Text>
      <Text>SIM_FOOTER</Text>
      <Text>SIM_ACTIVITY_BAR</Text>
    </ChatControls>
  );
}

function SimulatedTui({
  liveItems,
  streamingText = "",
  controlsLabel,
}: {
  liveItems: CompletedItem[];
  streamingText?: string;
  controlsLabel: string;
}) {
  const renderItem = (item: CompletedItem, index: number, items: CompletedItem[]) =>
    renderTranscriptItem({
      item,
      index,
      items,
      version: "sim",
      currentModel: "sim-model",
      currentProvider: "anthropic",
      displayedCwd: "/tmp/sim-project",
      columns: COLUMNS,
      theme,
      renderMarkdown: true,
      measuredLiveAreaRows: LIVE_ROWS,
    });

  return (
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <ChatLayout columns={COLUMNS}>
          <ChatLivePane
            liveItems={liveItems}
            renderItem={renderItem}
            isRunning={controlsLabel !== "SIM_DONE_STATUS"}
            visibleStreamingText={streamingText}
            streamingThinking=""
            thinkingMs={0}
            reserveStreamingSpacing={false}
            renderMarkdown
            measuredLiveAreaRows={LIVE_ROWS}
            assistantMarginTop={0}
            streamingContinuation={false}
          />
          <SimulatedControls label={controlsLabel} />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

function StatefulSimulatedTui({
  initialLiveItems,
  streamingText = "",
  controlsLabel,
  flushItems,
}: {
  initialLiveItems: CompletedItem[];
  streamingText?: string;
  controlsLabel: string;
  flushItems?: CompletedItem[];
}) {
  const { write: writeStdout } = useStdout();
  const [history, setHistory] = useState<CompletedItem[]>([]);
  const [liveItems, setLiveItems] = useState<CompletedItem[]>(initialLiveItems);
  const flushedRef = useRef(false);
  const { queueFlush } = useTranscriptHistory({
    terminalHistoryPrinter: createTerminalHistoryPrinter(),
    terminalHistoryContext: terminalContext,
    writeStdout,
    sessionPathRef: { current: undefined },
    sessionManagerRef: { current: null },
    history,
    setHistory,
    setLiveItems,
  });

  useEffect(() => {
    if (!flushItems || flushedRef.current) return;
    flushedRef.current = true;
    queueFlush(flushItems);
  }, [flushItems, queueFlush]);

  return (
    <SimulatedTui
      liveItems={liveItems}
      streamingText={streamingText}
      controlsLabel={controlsLabel}
    />
  );
}

function makeStdout(recorder: ScreenRecorder): NodeJS.WriteStream {
  return makeRecordingStdout(recorder);
}
function normalizedViewport(recorder: ScreenRecorder): string[] {
  return recorder.viewportLines().map((line) => stripAnsi(line));
}

function formatFrame(label: string, lines: readonly string[]): string {
  const body = lines
    .map((line, index) => `${String(index + 1).padStart(2, "0")}│${line}`)
    .join("\n");
  return `\n=== ${label} ===\n${body}\n`;
}

function maybeWriteFrames(frames: readonly { label: string; lines: string[] }[]): void {
  if (process.env.GG_TUI_RECORD !== "1") return;
  const outPath = path.join(process.cwd(), ".gg", "tui-terminal-recorder.txt");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    frames.map((frame) => formatFrame(frame.label, frame.lines)).join("\n"),
  );
}

const longAssistant = Array.from({ length: 40 }, (_, index) => {
  return `SIM_ASSISTANT_LINE_${String(index + 1).padStart(2, "0")}`;
}).join("\n");

async function nextRender(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
}

describe("TUI terminal recorder", () => {
  it("keeps the final assistant response live on normal done instead of flush-scrolling under controls", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeStdout(recorder);
    const frames: { label: string; lines: string[] }[] = [];
    const capture = (label: string) => frames.push({ label, lines: normalizedViewport(recorder) });

    const mounted = render(
      <StatefulSimulatedTui
        initialLiveItems={[{ kind: "assistant", id: "assistant-live", text: longAssistant }]}
        controlsLabel="SIM_ACTIVITY_STATUS"
      />,
      { stdout, columns: COLUMNS, rows: ROWS, patchConsole: false, maxFps: 1000 },
    );
    await nextRender();
    capture("hook active assistant before flush");

    mounted.rerender(
      <StatefulSimulatedTui
        initialLiveItems={[{ kind: "assistant", id: "assistant-live", text: longAssistant }]}
        controlsLabel="SIM_DONE_STATUS"
      />,
    );
    await nextRender();
    await nextRender();
    capture("hook done after flush");

    const viewport = normalizedViewport(recorder);
    mounted.unmount();
    maybeWriteFrames(frames);

    const activeFrame =
      frames.find((frame) => frame.label === "hook active assistant before flush")?.lines ?? [];
    const doneFrame = frames.find((frame) => frame.label === "hook done after flush")?.lines ?? [];
    const activeStatusSlot = activeFrame.findIndex((line) => line.includes("SIM_ACTIVITY_STATUS"));
    const doneStatusSlot = doneFrame.findIndex((line) => line.includes("SIM_DONE_STATUS"));
    expect(doneStatusSlot).toBe(activeStatusSlot);
    expect(doneFrame.some((line) => line.includes("SIM_ASSISTANT_LINE_40"))).toBe(true);

    const doneIndex = viewport.findIndex((line) => line.includes("SIM_DONE_STATUS"));
    const footerIndex = viewport.findIndex((line) => line.includes("SIM_FOOTER"));
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThan(doneIndex);
    expect(viewport.slice(doneIndex, footerIndex + 2)).toEqual([
      "SIM_DONE_STATUS",
      "SIM_INPUT_TOP",
      "SIM_INPUT_BODY",
      "SIM_INPUT_BOTTOM",
      "SIM_FOOTER",
      "SIM_ACTIVITY_BAR",
    ]);
  });
});
