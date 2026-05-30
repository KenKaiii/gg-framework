import React from "react";
import { Text, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { CompletedItem } from "./app-items.js";
import { ChatControls, ChatLayout } from "./components/ChatLayout.js";
import { ChatLivePane } from "./components/ChatLivePane.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";

const COLUMNS = 80;
const ROWS = 24;
const CONTROLS_ROWS = 6;
const LIVE_ROWS = ROWS - CONTROLS_ROWS - 1;
const theme = loadTheme("dark");

function rawLines(value: string): string[] {
  return stripAnsi(value).replace(/\r/g, "\n").split("\n");
}

function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  const next = [...lines];
  while (next.at(-1) === "") next.pop();
  return next;
}

function visibleLines(value: string): string[] {
  return trimTrailingEmptyLines(rawLines(value));
}

function countLineContaining(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length;
}

function SimulatedControls({ done }: { done?: boolean }) {
  return (
    <ChatControls controlsRef={() => {}}>
      <Text>{done ? "SIM_DONE_STATUS" : "SIM_ACTIVITY_STATUS"}</Text>
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
  done,
}: {
  liveItems: CompletedItem[];
  streamingText?: string;
  done?: boolean;
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
            isRunning={!done}
            visibleStreamingText={streamingText}
            streamingThinking=""
            thinkingMs={0}
            reserveStreamingSpacing={false}
            renderMarkdown
            measuredLiveAreaRows={LIVE_ROWS}
            assistantMarginTop={0}
            streamingContinuation={false}
          />
          <SimulatedControls done={done} />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

function renderSimulationFrame(props: React.ComponentProps<typeof SimulatedTui>): string[] {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = COLUMNS;
  process.stdout.rows = ROWS;
  try {
    return visibleLines(renderToString(<SimulatedTui {...props} />, { columns: COLUMNS }));
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
}

const longPrompt = Array.from({ length: 28 }, (_, index) => {
  return `SIM_LONG_PROMPT_LINE_${String(index + 1).padStart(2, "0")}`;
}).join("\n");

const longAssistant = Array.from({ length: 40 }, (_, index) => {
  return `SIM_ASSISTANT_LINE_${String(index + 1).padStart(2, "0")}`;
}).join("\n");

describe("TUI simulation", () => {
  it("keeps compact transcript order and only clamps overflowing active output", () => {
    const running = renderSimulationFrame({
      liveItems: [{ kind: "assistant", id: "assistant-running", text: longAssistant }],
      streamingText: "",
    });
    const done = renderSimulationFrame({ liveItems: [], done: true });

    expect(running).toHaveLength(ROWS - 1);
    expect(done).toHaveLength(CONTROLS_ROWS);
    expect(countLineContaining(running, "SIM_ASSISTANT_LINE_")).toBeGreaterThan(0);
    expect(done.some((line) => line.includes("GG Coder"))).toBe(false);
    expect(running.slice(-6)).toEqual([
      "SIM_ACTIVITY_STATUS",
      "SIM_INPUT_TOP",
      "SIM_INPUT_BODY",
      "SIM_INPUT_BOTTOM",
      "SIM_FOOTER",
      "SIM_ACTIVITY_BAR",
    ]);
    expect(done.slice(-6)).toEqual([
      "SIM_DONE_STATUS",
      "SIM_INPUT_TOP",
      "SIM_INPUT_BODY",
      "SIM_INPUT_BOTTOM",
      "SIM_FOOTER",
      "SIM_ACTIVITY_BAR",
    ]);
  });

  it("bottom-clips large prompt/output blocks without duplicating visible chat rows", () => {
    const frame = renderSimulationFrame({
      liveItems: [
        { kind: "user", id: "long-user", text: longPrompt },
        { kind: "assistant", id: "long-assistant", text: longAssistant },
      ],
      streamingText: "SIM_STREAMING_TAIL",
    });

    expect(frame).toHaveLength(ROWS - 1);
    expect(countLineContaining(frame, "SIM_LONG_PROMPT_LINE_01")).toBeLessThanOrEqual(1);
    expect(countLineContaining(frame, "SIM_ASSISTANT_LINE_40")).toBeLessThanOrEqual(1);
    expect(countLineContaining(frame, "SIM_STREAMING_TAIL")).toBeLessThanOrEqual(1);
    expect(frame.slice(-2)).toEqual(["SIM_FOOTER", "SIM_ACTIVITY_BAR"]);
  });

  it("keeps message/tool spacing stable in the simulated live frame", () => {
    const frame = renderSimulationFrame({
      liveItems: [
        { kind: "assistant", id: "assistant-intro", text: "I’ll inspect the renderer first." },
        {
          kind: "tool_group",
          id: "tool-group",
          tools: [
            {
              toolCallId: "read-1",
              name: "read",
              args: { file_path: "src/ui/App.tsx" },
              status: "done",
              result: "ok",
            },
          ],
        },
        { kind: "assistant", id: "assistant-next", text: "Now I’ll patch the layout." },
      ],
    });
    const compact = frame.filter((line) => line.length > 0);

    expect(compact).toContain(" ⏺ I’ll inspect the renderer first.");
    expect(compact.some((line) => line.includes("Read") && line.includes("App.tsx"))).toBe(true);
    expect(compact).toContain(" ⏺ Now I’ll patch the layout.");
    expect(countLineContaining(frame, "Now I’ll patch the layout.")).toBe(1);
  });
});
