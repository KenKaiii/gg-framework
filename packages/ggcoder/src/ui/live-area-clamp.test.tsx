import React from "react";
import { Text, render } from "ink";
import { describe, expect, it } from "vitest";
import { ChatLivePane } from "./components/ChatLivePane.js";
import { ChatLayout, ChatControls } from "./components/ChatLayout.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { useTheme } from "./theme/theme.js";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import type { CompletedItem } from "./app-items.js";

const ROWS = 24;
const COLUMNS = 80;
const CONTROLS_ROWS = 4;
// Mirror useChatLayoutMeasurements: rows - controlsRows - 2 (widened cushion).
const measuredLiveAreaRows = Math.max(3, ROWS - CONTROLS_ROWS - 2);

function stripAnsi(v: string): string {
  return v.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function Harness({
  liveItems,
  streamingText,
  streamingThinking = "",
}: {
  liveItems: CompletedItem[];
  streamingText: string;
  streamingThinking?: string;
}) {
  const theme = useTheme();
  const renderItem = (item: CompletedItem, index: number, items: CompletedItem[]) =>
    renderTranscriptItem({
      item,
      index,
      items,
      version: "0",
      currentModel: "m",
      currentProvider: "anthropic",
      displayedCwd: "/tmp",
      columns: COLUMNS,
      theme,
      renderMarkdown: true,
      measuredLiveAreaRows,
    });
  return (
    <ChatLayout columns={COLUMNS}>
      <ChatLivePane
        liveItems={liveItems}
        renderItem={renderItem}
        isRunning
        visibleStreamingText={streamingText}
        streamingThinking={streamingThinking}
        thinkingMs={streamingThinking ? 800 : 0}
        reserveStreamingSpacing={false}
        renderMarkdown
        measuredLiveAreaRows={measuredLiveAreaRows}
        assistantMarginTop={0}
        streamingContinuation={false}
      />
      <ChatControls controlsRef={() => {}}>
        {Array.from({ length: CONTROLS_ROWS }, (_, i) => (
          <Text key={i}>CONTROL_{i}</Text>
        ))}
      </ChatControls>
    </ChatLayout>
  );
}

function frameHeight(node: React.ReactElement): number {
  let output = "";
  const stdout = {
    columns: COLUMNS,
    rows: ROWS,
    write(chunk: string) {
      output += chunk;
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
  const { unmount } = render(<TerminalSizeProvider>{node}</TerminalSizeProvider>, {
    stdout,
    columns: COLUMNS,
    rows: ROWS,
    debug: true,
  });
  const height = stripAnsi(output).split("\n").length;
  unmount();
  return height;
}

const longText = Array.from({ length: 60 }, (_, i) => `response line ${i + 1}`).join("\n");

describe("live area clamp", () => {
  it("keeps multiple accumulated assistant blocks below the terminal height", () => {
    // The "jump on final response": Ink redraws from the top once a frame's
    // height reaches the terminal rows. Stacked finalized assistant turns must
    // stay strictly below rows so that never triggers.
    const height = frameHeight(
      <Harness
        liveItems={[
          { kind: "assistant", id: "a1", text: longText },
          { kind: "assistant", id: "a2", text: longText },
        ]}
        streamingText=""
      />,
    );
    expect(height).toBeLessThan(ROWS);
  });

  it("keeps a finalized block plus in-flight streaming below the terminal height", () => {
    const height = frameHeight(
      <Harness
        liveItems={[{ kind: "assistant", id: "a1", text: longText }]}
        streamingText={longText}
      />,
    );
    expect(height).toBeLessThan(ROWS);
  });

  it("keeps a finalized block plus streaming text and active thinking below the terminal height", () => {
    // Worst live-frame case on the native-scrollback default: a finalized turn
    // is still in the live area while the next turn streams BOTH a thinking
    // block and visible text. This is the tallest the live frame ever gets, so
    // it must still stay strictly below rows or Ink's clearTerminal redraw
    // snaps the footer to the top.
    const height = frameHeight(
      <Harness
        liveItems={[{ kind: "assistant", id: "a1", text: longText }]}
        streamingText={longText}
        streamingThinking={Array.from({ length: 20 }, (_, i) => `thinking line ${i + 1}`).join(
          "\n",
        )}
      />,
    );
    expect(height).toBeLessThan(ROWS);
  });

  it("stays compact (no reserved blank rows) when live content is short", () => {
    const height = frameHeight(
      <Harness
        liveItems={[{ kind: "assistant", id: "a1", text: "short reply" }]}
        streamingText=""
      />,
    );
    // 1 assistant row + 4 control rows, no padding up to the budget.
    expect(height).toBeLessThanOrEqual(CONTROLS_ROWS + 2);
  });
});
