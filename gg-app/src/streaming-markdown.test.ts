import { describe, expect, it } from "vitest";
import {
  displayStreamingMarkdown,
  holdBackPendingHeading,
  holdBackPendingMarker,
  holdBackPendingTable,
} from "./streaming-markdown";

describe("displayStreamingMarkdown", () => {
  it.each([
    ["an opening bold run", "**He", "**He**"],
    ["inline code mid-word", "reading `mani", "reading `mani`"],
    ["italics", "_blocking pa", "_blocking pa_"],
    ["strikethrough", "~~old", "~~old~~"],
    // A link is a link from its first letter, aimed at an inert placeholder.
    ["a link without its address", "see [the loa", "see [the loa](streamdown:incomplete-link)"],
    [
      "a link with half an address",
      "see [docs](https://exa",
      "see [docs](streamdown:incomplete-link)",
    ],
  ])("closes %s so it renders formatted, not as raw syntax", (_, partial, shown) => {
    expect(displayStreamingMarkdown(partial)).toBe(shown);
  });

  it.each([
    ["finished text", "**Here's the fix.** Run `pnpm test`."],
    ["a code block", "```ts\nconst a = **b"],
    ["multiplication", "3 * 4 = 12"],
    ["prices", "It costs $5 and $6."],
  ])("leaves %s alone", (_, text) => {
    expect(displayStreamingMarkdown(text)).toBe(text);
  });
});

describe("holdBackPendingMarker", () => {
  it.each([
    // A lone `-` under text is a heading underline: "fix it:" flashed up as a
    // big heading for a frame before the list item's words arrived.
    ["a list dash", "Three changes fix it:\n-", "Three changes fix it:"],
    ["a dash and its space", "Three changes fix it:\n- ", "Three changes fix it:"],
    ["a numbered item", "What changed:\n1.", "What changed:"],
    ["a heading's hashes", "Intro\n\n##", "Intro\n"],
  ])("holds back %s until its text arrives", (_, partial, shown) => {
    expect(holdBackPendingMarker(partial)).toBe(shown);
  });

  it.each([
    ["a list item with text", "Fix it:\n- **Cache"],
    ["a dash inside a sentence", "a - b"],
    ["a dash inside a code block", "```sh\nx\n-"],
  ])("shows %s", (_, text) => {
    expect(holdBackPendingMarker(text)).toBe(text);
  });
});

describe("holdBackPendingHeading", () => {
  it("holds a title-like line until the next line shows it is a heading", () => {
    // "Summary" then "---" is a heading; shown first as text, it was rebuilt
    // as a heading the moment the underline arrived and faded in twice.
    expect(holdBackPendingHeading("Done.\n\nSummary")).toBe("Done.\n");
    expect(holdBackPendingHeading("Done.\n\nSummary\n")).toBe("Done.\n");
    const settled = "Done.\n\nSummary\n---\nCold";
    expect(holdBackPendingHeading(settled)).toBe(settled);
  });

  it.each([
    ["a sentence being typed", "Got it — here's what"],
    ["a finished sentence", "Done.\n\nThe loader is fixed."],
    ["a line that ends with a colon", "Done.\n\nWhat changed:"],
    ["the second line of a paragraph", "Line one\nline two"],
    ["a list item", "- item"],
  ])("never holds %s", (_, text) => {
    expect(holdBackPendingHeading(text)).toBe(text);
  });
});

describe("holdBackPendingTable", () => {
  const intro = "Intro";
  const header = "| Path | Before | After |";

  it("holds a table header back until its delimiter row arrives", () => {
    // Without the |---| line it would flash as a paragraph of pipes.
    expect(holdBackPendingTable(`${intro}\n\n${header}`)).toBe(intro);
    expect(holdBackPendingTable(`${intro}\n\n${header}\n`)).toBe(intro);
    expect(holdBackPendingTable(`${intro}\n\n| Pa`)).toBe(intro);
  });

  it("keeps waiting while the delimiter row is still being typed", () => {
    expect(holdBackPendingTable(`${intro}\n\n${header}\n|---|--`)).toBe(intro);
  });

  it("shows the table once the delimiter covers every column, and as rows grow", () => {
    const table = `${intro}\n\n${header}\n|---|---|---|`;
    expect(holdBackPendingTable(table)).toBe(table);
    const growing = `${table}\n| Cold start | 820 ms`;
    expect(holdBackPendingTable(growing)).toBe(growing);
  });

  it("never holds back prose or code that merely contains a pipe", () => {
    for (const text of ["Use a || b to default.", "Pipe a | b here", "```sh\nls | grep x"]) {
      expect(holdBackPendingTable(text)).toBe(text);
    }
  });
});
