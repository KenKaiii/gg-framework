// Regression for the footer "jump" on the native-scrollback default.
//
// Ink's patched render writes a full-screen repaint (eraseScreen + cursorTo
// top) whenever the PREVIOUS frame filled the terminal height. When a tall
// streaming frame is finalized — the response flushes to scrollback and the
// live region collapses to just the controls — the now-shorter frame used to
// trigger that repaint, stranding the footer mid-screen with blank rows below.
// The fix gates the repaint on the CURRENT frame still being fullscreen; this
// test asserts the streaming→done transition performs zero full-screen
// repaints and keeps the footer pinned to the bottom row.
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

// Last footer line — the bottom-most thing on screen when pinned.
const FOOTER_BOTTOM = "SIM_ACTIVITY_BAR";

function SimulatedControls({ label }: { label: string }) {
  return (
    <ChatControls controlsRef={() => {}}>
      <Text>{label}</Text>
      <Text>SIM_INPUT_TOP</Text>
      <Text>SIM_INPUT_BODY</Text>
      <Text>SIM_INPUT_BOTTOM</Text>
      <Text>SIM_FOOTER</Text>
      <Text>{FOOTER_BOTTOM}</Text>
    </ChatControls>
  );
}

function SimTui({
  liveItems,
  streamingText,
  controlsLabel,
}: {
  liveItems: CompletedItem[];
  streamingText: string;
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
      measuredLiveAreaRows: ROWS,
    });
  return (
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <ChatLayout columns={COLUMNS}>
          <ChatLivePane
            liveItems={liveItems}
            renderItem={renderItem}
            isRunning={controlsLabel !== "SIM_DONE"}
            visibleStreamingText={streamingText}
            streamingThinking=""
            thinkingMs={0}
            reserveStreamingSpacing={false}
            renderMarkdown
            measuredLiveAreaRows={ROWS}
            assistantMarginTop={0}
            streamingContinuation={false}
          />
          <SimulatedControls label={controlsLabel} />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

type Phase = "idle" | "stream-short" | "stream-fill" | "done";

function Driver({ phase }: { phase: Phase }) {
  const { write: writeStdout } = useStdout();
  const [history, setHistory] = useState<CompletedItem[]>([]);
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  const committedRef = useRef(false);
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

  // On "done", finalize the turn exactly as App does: flush the finished
  // response to terminal history (scrollback) and clear it from the live frame,
  // so the live region collapses from "fills the screen" down to just controls.
  useEffect(() => {
    if (phase !== "done" || committedRef.current) return;
    committedRef.current = true;
    queueFlush([{ kind: "assistant", id: "final", text: longResponse }]);
    setLiveItems([]);
  }, [phase, queueFlush]);

  let streamingText = "";
  if (phase === "stream-short") streamingText = shortStreaming;
  if (phase === "stream-fill") streamingText = longResponse;

  const controlsLabel = phase === "done" || phase === "idle" ? "SIM_DONE" : "SIM_STREAMING";
  return (
    <SimTui liveItems={liveItems} streamingText={streamingText} controlsLabel={controlsLabel} />
  );
}

const shortStreaming = Array.from({ length: 3 }, (_, i) => `SIM_LINE_${i + 1}`).join("\n");
// A response that, together with the controls, fills the whole terminal during
// streaming so Ink enters its tall-frame (fullscreen) write path — then becomes
// the committed (shorter, after done status) frame, which is the shrink that
// triggers the residual jump.
const longResponse = Array.from(
  { length: ROWS - 4 },
  (_, i) => `SIM_LINE_${String(i + 1).padStart(2, "0")}`,
).join("\n");

function viewport(recorder: ScreenRecorder): string[] {
  return recorder.viewportLines().map((line) => stripAnsi(line));
}

// Ink's patched tall-frame branch repaints the whole screen from the top with
// eraseScreen (\x1b[2J) + cursorTo(0,0). That full repaint is exactly what makes
// the footer visibly "jump". Count how many times it fires per phase.
const ERASE_SCREEN = "\u001B[2J";
function countFullRepaints(raw: string): number {
  return raw.split(ERASE_SCREEN).length - 1;
}

function makeSpyStdout(recorder: ScreenRecorder, sink: { raw: string }): NodeJS.WriteStream {
  const base = makeRecordingStdout(recorder);
  const write = base.write.bind(base);
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "write") {
        return (chunk: string, cb?: (error?: Error | null) => void) => {
          sink.raw += chunk;
          return write(chunk, cb);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
}

describe("footer jump reproduction", () => {
  it("keeps the footer pinned to the bottom row with no whitespace below it", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const sink = { raw: "" };
    const stdout = makeSpyStdout(recorder, sink);
    const frames: { label: string; lines: string[]; repaints: number }[] = [];
    let lastRawLen = 0;
    const capture = (label: string) => {
      const slice = sink.raw.slice(lastRawLen);
      lastRawLen = sink.raw.length;
      frames.push({ label, lines: viewport(recorder), repaints: countFullRepaints(slice) });
    };

    const mounted = render(<Driver phase="idle" />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
    });
    await tick();
    capture("Z: idle (before first turn)");

    mounted.rerender(<Driver phase="stream-short" />);
    await tick();
    capture("A: short streaming");

    mounted.rerender(<Driver phase="stream-fill" />);
    await tick();
    capture("B: streaming fills the screen");

    mounted.rerender(<Driver phase="done" />);
    await tick();
    await tick();
    capture("C: done + committed final response");

    mounted.unmount();

    // The footer bottom line must be the LAST non-blank row in every frame
    // (nothing rendered below it, no reserved whitespace under the footer).
    for (const f of frames) {
      const footerIdx = f.lines.findIndex((line) => line.includes(FOOTER_BOTTOM));
      const lastNonBlank = f.lines.reduce((acc, line, i) => (line.trim().length > 0 ? i : acc), -1);
      expect(footerIdx, `${f.label}: footer present`).toBeGreaterThanOrEqual(0);
      expect(lastNonBlank, `${f.label}: nothing below footer`).toBe(footerIdx);
    }

    // THE JUMP: the streaming→done transition must not trigger Ink's full-screen
    // repaint (eraseScreen + cursorTo top), which is what visibly shoves the
    // footer. Some repaints are unavoidable during clamp engagement while
    // streaming, but committing the finalized response must not repaint.
    const doneFrame = frames.find((f) => f.label.startsWith("C:"));
    expect(doneFrame?.repaints, "done transition full-screen repaints").toBe(0);

    // THE START JUMP: with the status slot reserved unconditionally and the
    // controls height held constant, starting the first turn (idle → first
    // stream) must not trigger a full-screen repaint either — the footer stays
    // put as native scrollback grows beneath it.
    const firstStreamFrame = frames.find((f) => f.label.startsWith("A:"));
    expect(firstStreamFrame?.repaints, "idle→first-stream full-screen repaints").toBe(0);
  });
});
