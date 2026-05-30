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

type CsiCommand = {
  params: string;
  final: string;
};

class TerminalViewportRecorder {
  readonly columns: number;
  readonly rows: number;
  private lines: string[][] = [[]];
  private cursorRow = 0;
  private cursorCol = 0;

  constructor({ columns, rows }: { columns: number; rows: number }) {
    this.columns = columns;
    this.rows = rows;
  }

  write(data: string): void {
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === "\u001B") {
        const parsed = this.parseEscape(data, index);
        if (parsed === null) {
          index += 1;
          continue;
        }
        this.applyCsi(parsed.command);
        index = parsed.nextIndex;
        continue;
      }
      if (char === "\r") {
        this.cursorCol = 0;
        index += 1;
        continue;
      }
      if (char === "\n") {
        this.newLine();
        index += 1;
        continue;
      }
      this.putChar(char ?? " ");
      index += 1;
    }
  }

  viewportLines(): string[] {
    const rendered = this.lines.map((line) => line.join("").trimEnd());
    const start = Math.max(0, rendered.length - this.rows);
    return rendered.slice(start);
  }

  fullText(): string {
    return this.lines.map((line) => line.join("").trimEnd()).join("\n");
  }

  private parseEscape(
    data: string,
    start: number,
  ): { command: CsiCommand; nextIndex: number } | null {
    if (data[start + 1] !== "[") return null;
    let index = start + 2;
    let params = "";
    while (index < data.length) {
      const char = data[index];
      if (char && /[A-Za-z~]/u.test(char)) {
        return { command: { params, final: char }, nextIndex: index + 1 };
      }
      params += char;
      index += 1;
    }
    return null;
  }

  private applyCsi({ params, final }: CsiCommand): void {
    if (params.startsWith("?") || params.startsWith(">")) return;
    if (final === "m") return;
    const values = params
      .split(";")
      .filter((part) => part.length > 0)
      .map((part) => Number(part));
    const first = Number.isFinite(values[0]) ? values[0]! : 0;

    if (final === "A") {
      this.cursorRow = Math.max(0, this.cursorRow - (first || 1));
      return;
    }
    if (final === "B") {
      this.cursorRow += first || 1;
      this.ensureLine(this.cursorRow);
      return;
    }
    if (final === "C") {
      this.cursorCol = Math.min(this.columns - 1, this.cursorCol + (first || 1));
      return;
    }
    if (final === "D") {
      this.cursorCol = Math.max(0, this.cursorCol - (first || 1));
      return;
    }
    if (final === "E") {
      this.cursorRow += first || 1;
      this.cursorCol = 0;
      this.ensureLine(this.cursorRow);
      return;
    }
    if (final === "F") {
      this.cursorRow = Math.max(0, this.cursorRow - (first || 1));
      this.cursorCol = 0;
      return;
    }
    if (final === "G") {
      this.cursorCol = Math.max(0, Math.min(this.columns - 1, (first || 1) - 1));
      return;
    }
    if (final === "H" || final === "f") {
      const row = Number.isFinite(values[0]) && values[0]! > 0 ? values[0]! - 1 : 0;
      const col = Number.isFinite(values[1]) && values[1]! > 0 ? values[1]! - 1 : 0;
      this.cursorRow = row;
      this.cursorCol = Math.max(0, Math.min(this.columns - 1, col));
      this.ensureLine(this.cursorRow);
      return;
    }
    if (final === "J") {
      if (first === 2 || first === 3) {
        this.lines = [[]];
        this.cursorRow = 0;
        this.cursorCol = 0;
      }
      return;
    }
    if (final === "K") {
      this.ensureLine(this.cursorRow);
      if (first === 2) {
        this.lines[this.cursorRow] = [];
        this.cursorCol = 0;
      } else {
        this.lines[this.cursorRow] = this.lines[this.cursorRow]!.slice(0, this.cursorCol);
      }
    }
  }

  private putChar(char: string): void {
    if (this.cursorCol >= this.columns) this.newLine();
    this.ensureLine(this.cursorRow);
    const line = this.lines[this.cursorRow]!;
    while (line.length < this.cursorCol) line.push(" ");
    line[this.cursorCol] = char;
    this.cursorCol += 1;
  }

  private newLine(): void {
    this.cursorRow += 1;
    this.cursorCol = 0;
    this.ensureLine(this.cursorRow);
  }

  private ensureLine(row: number): void {
    while (this.lines.length <= row) this.lines.push([]);
  }
}

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

function makeStdout(recorder: TerminalViewportRecorder): NodeJS.WriteStream {
  return {
    columns: COLUMNS,
    rows: ROWS,
    isTTY: true,
    writable: true,
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    write(chunk: string, callback?: (error?: Error | null) => void) {
      recorder.write(chunk);
      callback?.(null);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
}
function normalizedViewport(recorder: TerminalViewportRecorder): string[] {
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
    const recorder = new TerminalViewportRecorder({ columns: COLUMNS, rows: ROWS });
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
