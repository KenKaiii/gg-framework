import React from "react";
import { Box, render, renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { AssistantMessage } from "./AssistantMessage.js";
import { StreamingArea } from "./StreamingArea.js";
import { ToolExecution } from "./ToolExecution.js";
import { ToolGroupExecution } from "./ToolGroupExecution.js";
import { ServerToolExecution } from "./ServerToolExecution.js";
import { TerminalSizeProvider } from "../hooks/useTerminalSize.js";
import type * as figures from "../constants/figures.js";

// BLACK_CIRCLE is platform-dependent (⏺ on macOS, ● elsewhere); pin it so
// the hardcoded frame expectations pass on Linux/Windows CI too.
vi.mock("../constants/figures.js", async (importOriginal) => ({
  ...(await importOriginal<typeof figures>()),
  BLACK_CIRCLE: "\u23FA",
}));
import {
  createTerminalHistoryPrinter,
  serializeCompletedItemToTerminalHistory,
} from "../terminal-history.js";
import { loadTheme } from "../theme/theme.js";
import {
  pinStreamingTextBeforeToolBoundary,
  shouldTopSpaceAssistantAfterToolBoundary,
  shouldTopSpaceStreamingAssistant,
} from "../App.js";

const TERMINAL_COLUMNS = 68;

async function flushInkRender(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const LONG_STREAMING_TEXT =
  "Here’s some longer random chat text: a tiny story, carefully comparing cloud-flavored notes whether terminal UIs should shimmer, putting a few safe read-only tool calls: listed components, listed functions, listed packages/tests, and checked content width.";
const LONG_TOOL_QUERY =
  "explain how terminal tool execution rows wrap when the query contains lots of descriptive words and keeps going past one physical line";
const LONG_BASH_OUTPUT =
  "Exit code: 0\n" +
  [
    "first output row with enough content to require wrapping and truncation inside the response gutter",
    "second output row with similarly verbose content for validating bounded width behavior",
    "third output row that is intentionally wordy and should still remain readable",
    "fourth output row to hit the maximum preview count",
    "fifth output row should be hidden behind the overflow summary",
  ].join("\n");
const LONG_TABLE_TEXT =
  "| Area | Details | Status |\n" +
  "| --- | --- | --- |\n" +
  "| Dashboard | Provides a centralized Next.js dashboard with live account statuses, automation activity, error logs, and engagement metrics. | Ready |\n" +
  "| Recovery | Captures long verifier failure summaries without letting table borders overflow terminal width. | Needs review |";
const MIXED_MARKDOWN_TEXT =
  "# Heading **one**\n\n" +
  "Regular *italic* and `code` with https://example.com/docs.\n" +
  "- First **item**\n" +
  "  1. Nested-ish item\n\n" +
  LONG_TABLE_TEXT +
  "\n\n```ts\nconst answer = 42;\nconsole.log(answer);\n```";

function rawLinesOf(text: string): string[] {
  return stripAnsi(text).split("\n");
}

function linesOf(text: string): string[] {
  return rawLinesOf(text).filter((line) => line.length > 0);
}

function renderWithTerminal(element: React.ReactElement): string[] {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = TERMINAL_COLUMNS;
  process.stdout.rows = 20;
  try {
    return linesOf(
      renderToString(<TerminalSizeProvider>{element}</TerminalSizeProvider>, {
        columns: TERMINAL_COLUMNS,
      }),
    );
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
}

function renderAssistantFrame(streaming: boolean, text = LONG_STREAMING_TEXT): string[] {
  return renderWithTerminal(<AssistantMessage text={text} streaming={streaming} />);
}

/** Like renderWithTerminal but keeps blank rows — needed for alignment checks. */
function renderWithTerminalRaw(element: React.ReactElement): string[] {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = TERMINAL_COLUMNS;
  process.stdout.rows = 20;
  try {
    return rawLinesOf(
      renderToString(<TerminalSizeProvider>{element}</TerminalSizeProvider>, {
        columns: TERMINAL_COLUMNS,
      }),
    );
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
}

function renderTerminalHistoryAssistantText(text = LONG_STREAMING_TEXT): string {
  return serializeCompletedItemToTerminalHistory(
    { kind: "assistant", text, id: "assistant-1" },
    {
      theme: loadTheme("dark"),
      columns: TERMINAL_COLUMNS,
      version: "test",
      model: "test-model",
      provider: "anthropic",
      cwd: "/tmp/test",
    },
  );
}

function renderTerminalHistoryAssistantFrame(text = LONG_STREAMING_TEXT): string[] {
  return linesOf(renderTerminalHistoryAssistantText(text));
}

async function renderInteractiveStreamingFrame(): Promise<string[]> {
  const chunks: string[] = [];
  const stdout = {
    columns: TERMINAL_COLUMNS,
    rows: 20,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
  const instance = render(
    <TerminalSizeProvider>
      <StreamingArea
        isRunning
        streamingText={LONG_STREAMING_TEXT}
        streamingThinking=""
        availableTerminalHeight={12}
      />
    </TerminalSizeProvider>,
    {
      stdout,
      patchConsole: false,
    },
  );
  await flushInkRender();
  instance.unmount();
  await instance.waitUntilExit();
  return linesOf(chunks.join(""));
}

async function renderInteractiveElementFrame(element: React.ReactElement): Promise<string> {
  const chunks: string[] = [];
  const stdout = {
    columns: TERMINAL_COLUMNS,
    rows: 20,
    isTTY: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
  const instance = render(<TerminalSizeProvider>{element}</TerminalSizeProvider>, {
    stdout,
    patchConsole: false,
  });
  await flushInkRender();
  instance.unmount();
  await instance.waitUntilExit();
  return stripAnsi(chunks.join("")).replace(/\r/g, "\n");
}

async function renderPrintedHistoryThenLiveFrame(liveElement: React.ReactElement): Promise<string> {
  const chunks: string[] = [];
  const stdout = {
    columns: TERMINAL_COLUMNS,
    rows: 20,
    isTTY: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
  createTerminalHistoryPrinter({ stream: stdout }).print(
    [
      {
        kind: "assistant",
        id: "assistant-history-1",
        text: "I’ll inspect the relevant UI renderer.",
      },
    ],
    {
      theme: loadTheme("dark"),
      columns: TERMINAL_COLUMNS,
      version: "test",
      model: "test-model",
      provider: "anthropic",
      cwd: "/tmp/test",
    },
  );
  const instance = render(<TerminalSizeProvider>{liveElement}</TerminalSizeProvider>, {
    stdout,
    patchConsole: false,
  });
  await flushInkRender();
  instance.unmount();
  await instance.waitUntilExit();
  return stripAnsi(chunks.join("")).replace(/\r/g, "\n");
}

async function renderFlushedToolThenAssistantFrame({
  historyState = "committed",
  mode = "streaming",
}: {
  historyState?: "committed" | "pending";
  mode?: "streaming" | "completed";
} = {}): Promise<string> {
  const chunks: string[] = [];
  const stdout = {
    columns: TERMINAL_COLUMNS,
    rows: 20,
    isTTY: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
  const historyItem = {
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
  const streamingText = "Next I’ll inspect the terminal history serialized output.";

  createTerminalHistoryPrinter({ stream: stdout }).print([historyItem], {
    theme: loadTheme("dark"),
    columns: TERMINAL_COLUMNS,
    version: "test",
    model: "test-model",
    provider: "anthropic",
    cwd: "/tmp/test",
  });

  const marginTop =
    mode === "streaming"
      ? shouldTopSpaceStreamingAssistant({
          visibleStreamingText: streamingText,
          lastPendingHistoryItem: historyState === "pending" ? historyItem : undefined,
          lastHistoryItem: historyState === "committed" ? historyItem : undefined,
        })
      : shouldTopSpaceAssistantAfterToolBoundary({
          text: streamingText,
          lastPendingHistoryItem: historyState === "pending" ? historyItem : undefined,
          lastHistoryItem: historyState === "committed" ? historyItem : undefined,
        });

  const instance = render(
    <TerminalSizeProvider>
      {mode === "streaming" ? (
        <StreamingArea
          isRunning
          streamingText={streamingText}
          streamingThinking=""
          availableTerminalHeight={12}
          assistantMarginTop={marginTop ? 1 : 0}
        />
      ) : (
        <AssistantMessage text={streamingText} marginTop={marginTop ? 1 : 0} />
      )}
    </TerminalSizeProvider>,
    {
      stdout,
      patchConsole: false,
    },
  );
  await flushInkRender();
  instance.unmount();
  await instance.waitUntilExit();
  return stripAnsi(chunks.join("")).replace(/\r/g, "\n");
}

describe("AssistantMessage live layout", () => {
  it("renders continuation assistant rows without a response dot", () => {
    const lines = renderWithTerminal(
      <AssistantMessage text="continued line" streaming continuation />,
    );

    expect(lines[0]).toBe("   continued line");
  });

  it("caps rendered assistant rows to the available terminal height", () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = renderWithTerminal(
      <AssistantMessage text={text} streaming availableTerminalHeight={5} />,
    );

    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("REGRESSION: dot stays inline when the height clamp slices at a blank line", () => {
    // 3 paragraphs render as [p1, "", p2, "", p3]. availableTerminalHeight=4
    // tail-slices to ["", p2, "", p3] — the ⏺ prefix sits in a sibling box
    // aligned to the first row, so a leading blank row left the dot floating
    // one row above the text (alignment varied with the slice boundary).
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    const lines = renderWithTerminalRaw(
      <AssistantMessage text={text} availableTerminalHeight={4} />,
    );

    expect(lines[0]).toBe(" \u23FA Second paragraph here.");
  });

  it("renders the streaming frame with the same line structure as finalized history", () => {
    const streamingLines = renderAssistantFrame(true);
    const finalLines = renderAssistantFrame(false);
    const historyLines = renderTerminalHistoryAssistantFrame();

    expect(streamingLines).toEqual(finalLines);
    expect(streamingLines).toEqual(historyLines);
    expect(streamingLines[0]?.startsWith(" ⏺ ")).toBe(true);
    for (const continuationLine of streamingLines.slice(1)) {
      expect(continuationLine.startsWith("   ")).toBe(true);
    }
  });

  it("keeps streaming, completed, and terminal-history markdown rendering aligned", () => {
    const cases = [
      LONG_STREAMING_TEXT,
      LONG_TABLE_TEXT,
      MIXED_MARKDOWN_TEXT,
      "Inline **bold**, *italic*, ~~strike~~, <u>under</u>, [docs](https://example.com), and `code`.",
      "## List check\n- alpha **one**\n- beta `two`\n1. first\n2. second",
      "Dr. Jones reviewed it.\n--\nThe next paragraph renders below a divider.",
      "```ts\nconst answer = 42;\nconsole.log(answer);\n```",
    ];

    for (const text of cases) {
      const streamingLines = renderAssistantFrame(true, text);
      const completedLines = renderAssistantFrame(false, text);
      const historyLines = renderTerminalHistoryAssistantFrame(text);

      expect(streamingLines, text).toEqual(completedLines);
      expect(completedLines, text).toEqual(historyLines);
      for (const line of streamingLines) {
        expect(stringWidth(line), `${text}\n${line}`).toBeLessThanOrEqual(TERMINAL_COLUMNS);
      }
    }
  });

  it("keeps title abbreviations with the following name", () => {
    const streamingLines = renderAssistantFrame(true, "Dr. Jones reviewed it.");
    const historyLines = renderTerminalHistoryAssistantFrame("Dr. Jones reviewed it.");

    expect(streamingLines).toContain(" ⏺ Dr. Jones reviewed it.");
    expect(historyLines).toEqual(streamingLines);
  });

  it("preserves assistant paragraph breaks exactly in terminal history", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const historyLines = rawLinesOf(renderTerminalHistoryAssistantText(text));

    expect(historyLines).toEqual([
      " ⏺ First paragraph.",
      "",
      "   Second paragraph.",
      "",
      "   Third paragraph.",
    ]);
  });

  it("renders double-hyphen markdown dividers across live and history output", () => {
    const streamingLines = renderAssistantFrame(true, "before\n--\nafter");
    const historyLines = renderTerminalHistoryAssistantFrame("before\n--\nafter");
    const dividerLine = streamingLines.find((line) => line.includes("─"));

    expect(dividerLine).toBeDefined();
    expect(dividerLine).not.toContain("--");
    expect(historyLines).toEqual(streamingLines);
  });

  it("keeps every streaming physical line within the terminal width", () => {
    const lines = renderAssistantFrame(true);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
    }
  });

  it("keeps rendered markdown tables inside the terminal width", () => {
    const lines = renderWithTerminal(<AssistantMessage text={LONG_TABLE_TEXT} streaming={false} />);
    const tableLines = lines.filter((line) => /[┌┬┐│├┼┤└┴┘]/.test(line));

    expect(tableLines.length).toBeGreaterThan(4);
    for (const line of tableLines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
    }
  });

  it("keeps the interactive streaming frame inside the terminal width", async () => {
    const lines = await renderInteractiveStreamingFrame();

    expect(lines).toEqual(renderAssistantFrame(true));
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
    }
  });

  it("keeps assistant text above the tool row when a tool starts after text streamed", async () => {
    const assistantText = "I’ll inspect the renderer first.";
    const pinnedItems = pinStreamingTextBeforeToolBoundary({
      items: [],
      visibleStreamingText: assistantText,
      thinking: "",
      thinkingMs: 0,
      makeId: () => "assistant-pinned-1",
    });
    const frame = await renderInteractiveElementFrame(
      <>
        {pinnedItems.map((item) =>
          item.kind === "assistant" ? <AssistantMessage key={item.id} text={item.text} /> : null,
        )}
        <ToolExecution
          status="running"
          name="read"
          args={{ file_path: "src/ui/App.tsx" }}
          animateUntil={0}
        />
      </>,
    );
    const assistantIndex = frame.indexOf(" ⏺ I’ll inspect the renderer first.");
    const toolIndex = frame.indexOf(" · Reading…");

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeLessThan(toolIndex);
  });

  it("omits the flushed tool row from scrollback and renders the streaming text", async () => {
    const frame = await renderFlushedToolThenAssistantFrame({ historyState: "committed" });
    const physicalLines = frame.split("\n");

    expect(physicalLines).not.toContain(" ⏺ Read 1 file: a.ts");
    expect(physicalLines).toContain(" ⏺ Next I’ll inspect the terminal history serialized output.");
  });

  it("omits the tool row from scrollback while pending history state commit", async () => {
    const frame = await renderFlushedToolThenAssistantFrame({ historyState: "pending" });
    const physicalLines = frame.split("\n");

    expect(physicalLines).not.toContain(" ⏺ Read 1 file: a.ts");
    expect(physicalLines).toContain(" ⏺ Next I’ll inspect the terminal history serialized output.");
  });

  it("omits the tool row for a completed live assistant row pending history commit", async () => {
    const frame = await renderFlushedToolThenAssistantFrame({
      historyState: "pending",
      mode: "completed",
    });
    const physicalLines = frame.split("\n");

    expect(physicalLines).not.toContain(" ⏺ Read 1 file: a.ts");
    expect(physicalLines).toContain(" ⏺ Next I’ll inspect the terminal history serialized output.");
  });

  it("keeps a blank visual row between printed history and compact active tool rows", async () => {
    const frame = await renderPrintedHistoryThenLiveFrame(
      <Box marginTop={1} flexDirection="column">
        <ToolExecution
          status="running"
          name="read"
          args={{ file_path: "src/a.ts" }}
          animateUntil={0}
          marginTop={0}
        />
      </Box>,
    );

    expect(frame).toContain(" ⏺ I’ll inspect the relevant UI renderer.\n\n · Reading…");
  });

  it("keeps a blank visual row between printed history and active tool groups", async () => {
    const frame = await renderPrintedHistoryThenLiveFrame(
      <Box marginTop={1} flexDirection="column">
        <ToolGroupExecution
          marginTop={0}
          tools={[
            {
              toolCallId: "read-1",
              name: "read",
              args: { file_path: "src/a.ts" },
              status: "done",
              result: "ok",
            },
          ]}
        />
      </Box>,
    );

    expect(frame).toContain(" ⏺ I’ll inspect the relevant UI renderer.\n\n ⏺ Read 1 file: a.ts");
  });

  it("keeps a blank visual row between printed history and bash progress rows", async () => {
    const frame = await renderPrintedHistoryThenLiveFrame(
      <Box marginTop={1} flexDirection="column">
        <ToolExecution
          status="running"
          name="bash"
          args={{ command: "echo hi" }}
          progressOutput="hello\nworld"
          animateUntil={0}
          marginTop={0}
        />
      </Box>,
    );

    expect(frame).toContain(" ⏺ I’ll inspect the relevant UI renderer.\n\n · Bash(echo hi)");
  });

  it("does not add hidden self-spacing when transcript spacing is not requested", async () => {
    const frame = await renderPrintedHistoryThenLiveFrame(
      <ToolExecution
        status="running"
        name="bash"
        args={{ command: "echo hi" }}
        animateUntil={0}
        marginTop={0}
      />,
    );

    expect(frame).toContain(" ⏺ I’ll inspect the relevant UI renderer.\n · Bash(echo hi)");
    expect(frame).not.toContain("renderer.\n\n · Bash(echo hi)");
  });

  it("wraps long web_search tool headers and summaries inside the terminal width", () => {
    const lines = renderWithTerminal(
      <ToolExecution
        status="done"
        name="web_search"
        args={{ query: LONG_TOOL_QUERY }}
        result={"1. First result\n2. Second result\n3. Third result"}
        isError={false}
      />,
    );

    expect(lines.some((line) => line.includes("Web Search"))).toBe(true);
    expect(lines.some((line) => line.includes("3 results"))).toBe(true);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
    }
  });

  it("keeps verbose bash tool output previews inside the terminal width", () => {
    const lines = renderWithTerminal(
      <ToolExecution
        status="done"
        name="bash"
        args={{ command: "printf lots-of-output" }}
        result={LONG_BASH_OUTPUT}
        isError={false}
      />,
    );

    expect(lines.some((line) => line.includes("Bash"))).toBe(true);
    expect(lines.some((line) => line.includes("1 lines hidden"))).toBe(true);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
    }
  });

  it("wraps long server-tool execution rows inside the terminal width", () => {
    const lines = renderWithTerminal(
      <ServerToolExecution
        status="done"
        name="web_search"
        input={{ query: LONG_TOOL_QUERY }}
        resultType="search_result"
        durationMs={2400}
      />,
    );

    expect(lines.some((line) => line.includes("Web Search"))).toBe(true);
    expect(lines.some((line) => line.includes("Did 1 search in 2s"))).toBe(true);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(TERMINAL_COLUMNS);
    }
  });
});
