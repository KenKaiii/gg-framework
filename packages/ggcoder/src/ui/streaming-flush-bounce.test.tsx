// Regression for the per-chunk footer "bounce" during streaming.
//
// The assistant response is flushed to native scrollback paragraph-by-paragraph
// while it streams (see assistant-stream-split). The scrollback print happens in
// an effect AFTER paint, while `flushedChars` only advances in that same effect.
// If the live frame is sliced solely by the already-committed `flushedChars`,
// the just-flushed paragraph renders BOTH in scrollback and still live for one
// frame — a transient height bump that shoves the footer up, then back down on
// every paragraph boundary. App fixes this by slicing the live text with the
// PROSPECTIVE flush computed during render. This test models that flow and
// asserts the footer offset from the bottom stays constant across flushes.
import React, { useEffect, useRef, useState } from "react";
import { render, Text, useStdout } from "ink";
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
import { useTranscriptHistory } from "./hooks/useTranscriptHistory.js";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";
import { splitAssistantStreamingText } from "./utils/assistant-stream-split.js";
import { stripDoneMarkers } from "../utils/plan-steps.js";

const COLUMNS = 80;
const ROWS = 24;
const theme = loadTheme("dark");
const terminalContext: TerminalHistoryContext = {
  theme,
  columns: COLUMNS,
  version: "sim",
  model: "sim-model",
  provider: "anthropic",
  cwd: "/tmp/sim-project",
};
const FOOTER_BOTTOM = "SIM_ACTIVITY_BAR";

let idCounter = 0;
const getId = (): string => `chunk-${idCounter++}`;

function Controls(): React.ReactElement {
  return (
    <ChatControls controlsRef={() => {}}>
      <Text>SIM_STATUS</Text>
      <Text>SIM_INPUT</Text>
      <Text>SIM_FOOTER</Text>
      <Text>{FOOTER_BOTTOM}</Text>
    </ChatControls>
  );
}

// Mirrors App.tsx: prospective flush is computed during render so the live
// frame drops the to-be-flushed prefix immediately; the scrollback print is
// deferred to the effect.
function Driver({ rawText }: { rawText: string }): React.ReactElement {
  const { write: writeStdout } = useStdout();
  const [history, setHistory] = useState<CompletedItem[]>([]);
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  const flushRef = useRef({ flushedChars: 0, text: "" });
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

  const alreadyFlushed = flushRef.current.flushedChars;
  const pendingFlushChars = rawText
    ? splitAssistantStreamingText(rawText.slice(alreadyFlushed)).flushedText.length
    : 0;

  useEffect(() => {
    if (!rawText) {
      flushRef.current = { flushedChars: 0, text: "" };
      return;
    }
    if (rawText === flushRef.current.text) return;
    const split = splitAssistantStreamingText(rawText.slice(flushRef.current.flushedChars));
    if (split.flushedText.length > 0) {
      queueFlush([
        {
          kind: "assistant",
          text: stripDoneMarkers(split.flushedText),
          continuation: flushRef.current.flushedChars > 0,
          id: getId(),
        },
      ]);
      flushRef.current = {
        flushedChars: flushRef.current.flushedChars + split.flushedText.length,
        text: rawText,
      };
      return;
    }
    flushRef.current = { ...flushRef.current, text: rawText };
  }, [rawText, queueFlush]);

  const visibleStreamingText = stripDoneMarkers(rawText.slice(alreadyFlushed + pendingFlushChars));

  const renderItem = (
    item: CompletedItem,
    index: number,
    items: CompletedItem[],
  ): React.ReactNode =>
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
      measuredLiveAreaRows: ROWS,
    });

  return (
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <ChatLayout columns={COLUMNS}>
          <ChatLivePane
            liveItems={liveItems}
            renderItem={renderItem}
            isRunning
            visibleStreamingText={visibleStreamingText}
            streamingThinking=""
            thinkingMs={0}
            reserveStreamingSpacing={false}
            renderMarkdown
            measuredLiveAreaRows={ROWS}
            assistantMarginTop={0}
            streamingContinuation={alreadyFlushed + pendingFlushChars > 0}
          />
          <Controls />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
}

function paragraph(n: number): string {
  return Array.from({ length: 3 }, (_, i) => `P${n}_LINE_${i + 1}`).join("\n");
}

describe("streaming flush footer bounce", () => {
  it("keeps the footer at a constant offset across paragraph flush boundaries", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);

    const footerOffsets: number[] = [];
    const capture = (): void => {
      const lines = recorder.viewportLines().map((line) => stripAnsi(line));
      const footerIdx = lines.findIndex((line) => line.includes(FOOTER_BOTTOM));
      footerOffsets.push(footerIdx === -1 ? -1 : lines.length - footerIdx);
    };

    // Stream a 3-paragraph response: text grows, then crosses a blank-line
    // boundary (flush), then grows again, etc. The boundary frames are where the
    // bounce used to occur.
    const steps = [
      paragraph(1),
      `${paragraph(1)}\n\n`,
      `${paragraph(1)}\n\n${paragraph(2)}`,
      `${paragraph(1)}\n\n${paragraph(2)}\n\n`,
      `${paragraph(1)}\n\n${paragraph(2)}\n\n${paragraph(3)}`,
    ];

    const mounted = render(<Driver rawText={steps[0]!} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
    });
    await tick();
    capture();
    for (let i = 1; i < steps.length; i++) {
      mounted.rerender(<Driver rawText={steps[i]!} />);
      await tick();
      await tick();
      capture();
    }
    mounted.unmount();

    // The footer (controls block) must stay pinned the same distance from the
    // bottom on every frame — no transient grow/shrink as paragraphs flush.
    for (const offset of footerOffsets) {
      expect(offset).toBe(footerOffsets[0]);
    }
  });
});
