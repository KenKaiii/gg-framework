import { describe, expect, it } from "vitest";
import { buildTranscriptLines, windowTranscriptLines } from "./transcript-lines.js";
import type { CompletedItem } from "../app-items.js";
import { loadTheme } from "../theme/theme.js";
import { createTerminalHistoryPrinter } from "../terminal-history.js";

const context = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "0.0.0-test",
  model: "test-model",
  provider: "openai" as const,
  cwd: "/tmp/project",
};

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}

describe("buildTranscriptLines", () => {
  it("flattens items to a line buffer matching the scrollback printer output", () => {
    const items: CompletedItem[] = [
      { kind: "user", text: "hello there", id: "u1" },
      { kind: "assistant", text: "hi back", id: "a1" },
    ];

    // Reference: what the scrollback printer would write.
    let printed = "";
    const printer = createTerminalHistoryPrinter();
    printer.print(items, context, { write: (data) => (printed += data) });
    const printedLines = printed.split("\n");
    // The printer's first item has a leading newline suppressed by formatHistoryWrite
    // for the first row; normalize trailing empties for comparison.
    while (printedLines.length > 0 && printedLines[printedLines.length - 1] === "") {
      printedLines.pop();
    }

    const lines = buildTranscriptLines(items, context);
    expect(lines.map(stripAnsi)).toEqual(printedLines.map(stripAnsi));
  });

  it("returns an empty buffer for no items", () => {
    expect(buildTranscriptLines([], context)).toEqual([]);
  });

  it("serializes streaming-equivalent assistant text", () => {
    const lines = buildTranscriptLines(
      [{ kind: "assistant", text: "streaming answer", id: "s1" }],
      context,
    );
    expect(lines.map(stripAnsi).join("\n")).toContain("streaming answer");
  });
});

describe("windowTranscriptLines", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);

  it("bottom-sticks when offset is 0", () => {
    const w = windowTranscriptLines(lines, 3, 0);
    expect(w.lines).toEqual(["line-7", "line-8", "line-9"]);
    expect(w.topPadding).toBe(0);
    expect(w.offset).toBe(0);
    expect(w.total).toBe(10);
  });

  it("scrolls up by the offset", () => {
    const w = windowTranscriptLines(lines, 3, 2);
    expect(w.lines).toEqual(["line-5", "line-6", "line-7"]);
    expect(w.offset).toBe(2);
  });

  it("clamps offset to the maximum", () => {
    const w = windowTranscriptLines(lines, 3, 999);
    expect(w.lines).toEqual(["line-0", "line-1", "line-2"]);
    expect(w.offset).toBe(7);
  });

  it("pads the top when content is shorter than the viewport", () => {
    const short = ["a", "b"];
    const w = windowTranscriptLines(short, 5, 0);
    expect(w.lines).toEqual(["a", "b"]);
    expect(w.topPadding).toBe(3);
    expect(w.total).toBe(2);
  });

  it("handles an exact fit with no padding", () => {
    const w = windowTranscriptLines(lines, 10, 0);
    expect(w.lines).toEqual(lines);
    expect(w.topPadding).toBe(0);
  });
});
