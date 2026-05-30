import React from "react";
import { render, renderToString, Text } from "ink";
import { beforeEach, describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { CompletedItem } from "./app-items.js";
import { ChatControls, ChatLayout } from "./components/ChatLayout.js";
import { TranscriptViewport } from "./components/TranscriptViewport.js";
import { buildTranscriptLines } from "./transcript/transcript-lines.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";
import type { TerminalHistoryContext } from "./terminal-history.js";
import {
  resetTranscriptScroll,
  scrollTranscriptByLines,
  setTranscriptScrollBounds,
} from "./stores/transcript-scroll-store.js";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const COLUMNS = 80;
const ROWS = 24;
const CONTROLS_ROWS = 6;
const VIEWPORT_ROWS = ROWS - CONTROLS_ROWS;
const theme = loadTheme("dark");
const context: TerminalHistoryContext = {
  theme,
  columns: COLUMNS,
  version: "sim",
  model: "sim-model",
  provider: "anthropic",
  cwd: "/tmp/sim-project",
};

function FullscreenHarness({
  history,
  liveItems,
  streamingText = "",
}: {
  history: CompletedItem[];
  liveItems: CompletedItem[];
  streamingText?: string;
}) {
  const items: CompletedItem[] = [...history, ...liveItems];
  if (streamingText.length > 0) {
    items.push({ kind: "assistant", text: streamingText, id: "__streaming__" });
  }
  const lines = buildTranscriptLines(items, context);
  return (
    <ThemeContext.Provider value={theme}>
      <ChatLayout columns={COLUMNS} rows={ROWS}>
        <TranscriptViewport lines={lines} columns={COLUMNS} viewportRows={VIEWPORT_ROWS} />
        <ChatControls controlsRef={() => {}}>
          <Text>SIM_STATUS</Text>
          <Text>SIM_INPUT_TOP</Text>
          <Text>SIM_INPUT_BODY</Text>
          <Text>SIM_INPUT_BOTTOM</Text>
          <Text>SIM_FOOTER</Text>
          <Text>SIM_ACTIVITY_BAR</Text>
        </ChatControls>
      </ChatLayout>
    </ThemeContext.Provider>
  );
}

/**
 * Variant whose controls region can grow (simulating the slash-command menu /
 * task picker opening below the input). The viewport must yield so the extra
 * rows stay visible within the fixed-height frame instead of overflowing off
 * the bottom of the (bottom-pinned) screen.
 */
function FullscreenHarnessWithMenu({ menuRows }: { menuRows: number }) {
  const lines = buildTranscriptLines(
    [{ kind: "assistant", id: "a", text: longAssistant }],
    context,
  );
  return (
    <ThemeContext.Provider value={theme}>
      <ChatLayout columns={COLUMNS} rows={ROWS}>
        <TranscriptViewport lines={lines} columns={COLUMNS} viewportRows={VIEWPORT_ROWS} />
        <ChatControls controlsRef={() => {}}>
          <Text>SIM_INPUT_TOP</Text>
          <Text>SIM_INPUT_BODY</Text>
          <Text>SIM_INPUT_BOTTOM</Text>
          {Array.from({ length: menuRows }, (_, i) => (
            <Text key={`menu-${i}`}>{`SIM_MENU_ROW_${i + 1}`}</Text>
          ))}
          <Text>SIM_FOOTER</Text>
        </ChatControls>
      </ChatLayout>
    </ThemeContext.Provider>
  );
}

function makeStdout(sink: { last: string }): NodeJS.WriteStream {
  return {
    columns: COLUMNS,
    rows: ROWS,
    isTTY: true,
    writable: true,
    write(chunk: string, callback?: (error?: Error | null) => void) {
      sink.last += chunk;
      callback?.(null);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

const longAssistant = Array.from({ length: 40 }, (_, i) => `SIM_ASSISTANT_LINE_${i + 1}`).join(
  "\n",
);

describe("fullscreen transcript viewport pinning", () => {
  beforeEach(() => {
    setTranscriptScrollBounds(0);
    resetTranscriptScroll();
  });

  it("keeps the footer at the same row across stream → finalize → next submit", async () => {
    // Apply writes cumulatively to a virtual terminal and read the resulting
    // on-screen state. After the Ink 6.8 fullscreen patch (see render.ts /
    // patches/ink@6.8.0.patch), steady fullscreen frames flow through the
    // incremental line-diff renderer, so a single rerender no longer rewrites
    // the whole frame — the footer line is only emitted when it actually moves.
    // Inspecting the cumulative screen (what the user sees) is therefore the
    // correct invariant, not the bytes of the last individual write.
    const term = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(term);

    // Frame 1: active stream, response in flight (in liveItems / streaming).
    const mounted = render(
      <FullscreenHarness
        history={[{ kind: "banner", id: "banner" }]}
        liveItems={[]}
        streamingText={longAssistant}
      />,
      { stdout, patchConsole: false, maxFps: 1000 },
    );
    await settle();
    const streamFooter = term.footerRow("SIM_FOOTER");

    // Frame 2: response finalized into history, liveItems cleared.
    mounted.rerender(
      <FullscreenHarness
        history={[
          { kind: "banner", id: "banner" },
          { kind: "assistant", id: "a1", text: longAssistant },
        ]}
        liveItems={[]}
      />,
    );
    await settle();
    const doneFooter = term.footerRow("SIM_FOOTER");

    // Frame 3: next prompt submitted — new user row appended to history.
    mounted.rerender(
      <FullscreenHarness
        history={[
          { kind: "banner", id: "banner" },
          { kind: "assistant", id: "a1", text: longAssistant },
          { kind: "user", id: "u2", text: "follow up question" },
        ]}
        liveItems={[]}
      />,
    );
    await settle();
    const submitFooter = term.footerRow("SIM_FOOTER");

    mounted.unmount();

    // The footer sits near the bottom of the full-height frame (FOOTER is the
    // 5th of 6 controls rows, so row ROWS-2 with a 0-based index).
    expect(streamFooter).toBe(ROWS - 2);
    // The success criterion: the footer occupies the same row on every frame.
    expect(doneFooter).toBe(streamFooter);
    expect(submitFooter).toBe(streamFooter);
  });

  it("emits a constant viewport row count regardless of content length or scroll", () => {
    // A stable total line count is what lets Ink's incremental renderer diff
    // pure content and skip the controls region, eliminating scroll flicker.
    const shortLines = buildTranscriptLines([{ kind: "assistant", id: "a", text: "hi" }], context);
    const longLines = buildTranscriptLines(
      [{ kind: "assistant", id: "a", text: longAssistant }],
      context,
    );

    const countRows = (frame: string): number =>
      stripAnsi(frame).replace(/\n+$/, "").split("\n").length;

    resetTranscriptScroll();
    setTranscriptScrollBounds(0);
    const shortFrame = renderToString(
      <TranscriptViewport lines={shortLines} columns={COLUMNS} viewportRows={VIEWPORT_ROWS} />,
    );
    const longFrame = renderToString(
      <TranscriptViewport lines={longLines} columns={COLUMNS} viewportRows={VIEWPORT_ROWS} />,
    );
    // Scroll up 5 lines via the store, then render the same long content.
    setTranscriptScrollBounds(longLines.length - VIEWPORT_ROWS);
    scrollTranscriptByLines(5);
    const scrolledFrame = renderToString(
      <TranscriptViewport lines={longLines} columns={COLUMNS} viewportRows={VIEWPORT_ROWS} />,
    );
    resetTranscriptScroll();

    expect(countRows(shortFrame)).toBe(VIEWPORT_ROWS);
    expect(countRows(longFrame)).toBe(VIEWPORT_ROWS);
    expect(countRows(scrolledFrame)).toBe(VIEWPORT_ROWS);
  });

  it("yields viewport height so an opened menu stays inside the frame and the footer stays visible", async () => {
    const sink = { last: "" };
    const stdout = makeStdout(sink);

    // Tall menu: 12 extra rows below the input would overflow a rigid viewport.
    const mounted = render(<FullscreenHarnessWithMenu menuRows={12} />, {
      stdout,
      patchConsole: false,
      maxFps: 1000,
    });
    await settle();
    const frame = sink.last;
    mounted.unmount();

    const visible = stripAnsi(frame)
      .split("\n")
      .map((line) => line.trimEnd());
    const footerIdx = visible.findIndex((line) => line.includes("SIM_FOOTER"));
    const lastMenuIdx = visible.findIndex((line) => line.includes("SIM_MENU_ROW_12"));

    // Both the last menu row and the footer rendered, and the footer is below
    // the menu — nothing got pushed off the bottom of the fixed-height frame.
    expect(lastMenuIdx).toBeGreaterThanOrEqual(0);
    expect(footerIdx).toBeGreaterThan(lastMenuIdx);
    // The whole frame fits within the terminal height.
    expect(footerIdx).toBeLessThanOrEqual(ROWS - 1);
  });
});
