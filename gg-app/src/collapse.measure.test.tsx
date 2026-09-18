// @vitest-environment jsdom
/**
 * Measures the folding win in DOM nodes, the mechanism behind the webview
 * memory: every mounted node carries layout, style, and syntax-highlight
 * markup, and a single window rendering a day's session passed `1.5 GB`.
 * Node count is deterministic and runs anywhere, unlike RSS.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ROW_COLLAPSE_CHARS, visibleBlockCount } from "./collapse";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

const { Markdown } = await import("./Markdown");

/**
 * A tool dump of the shape that actually blew the window up: a long fenced
 * block of command output, sized from the largest record observed in the live
 * session that measured 1554 MB (43 KB).
 */
const heavyRow = [
  "Here is the output:",
  "",
  "```ts",
  ...Array.from({ length: 1200 }, (_, i) => `const module${i} = require("./mod-${i}"); // ok`),
  "```",
  "",
  "That completes the run.",
].join("\n");

describe("folding measured on a realistic heavy row", () => {
  it("mounts an order of magnitude fewer DOM nodes for a big tool dump", async () => {
    const { container, unmount } = render(<Markdown>{heavyRow}</Markdown>);
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
      expect(container.querySelector("p")?.textContent).toBe("Here is the output:");
    });
    const folded = container.querySelectorAll("*").length;
    const foldedChars = (container.textContent ?? "").length;

    // Two fold layers can stack: the row holds back blocks, and the fenced
    // block inside folds too. Expand until nothing is left folded.
    expect(container.querySelector("button.code-expand")).toBeTruthy();
    for (let guard = 0; guard < 10; guard++) {
      const next = container.querySelector("button.code-expand") as HTMLButtonElement | null;
      if (!next || next.textContent?.includes("Show less")) break;
      fireEvent.click(next);
    }
    const expanded = container.querySelectorAll("*").length;
    const expandedChars = (container.textContent ?? "").length;
    unmount();

    // The whole point: folded must be dramatically cheaper than expanded, in
    // both mounted elements (highlight spans) and mounted text.
    expect(folded).toBeLessThan(expanded / 5);
    expect(foldedChars).toBeLessThan(expandedChars / 5);
    console.log(
      `heavy row — folded: ${folded} nodes / ${foldedChars} chars, ` +
        `expanded: ${expanded} nodes / ${expandedChars} chars ` +
        `(${(expanded / folded).toFixed(0)}x fewer nodes)`,
    );
  });

  it("keeps a normal reply at full fidelity", async () => {
    const normal = "I fixed the bug.\n\n```ts\nconst x = 1;\n```\n\nAll tests pass.";
    const { container } = render(<Markdown>{normal}</Markdown>);
    await waitFor(() => expect(container.querySelector(".code-block")).toBeTruthy());
    expect(container.querySelector("button.code-expand")).toBeNull();
    expect(container.textContent).toContain("All tests pass.");
  });

  it("holds back blocks once a row exceeds the character budget", () => {
    const blocks = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${"detail ".repeat(12)}`);
    const visible = visibleBlockCount(blocks);
    expect(visible).toBeLessThan(blocks.length);
    const mountedChars = blocks.slice(0, visible).reduce((sum, block) => sum + block.length, 0);
    // Mounted content stays within one budget's worth (plus the block that
    // crossed it), regardless of how much the row actually contains.
    expect(mountedChars).toBeLessThanOrEqual(ROW_COLLAPSE_CHARS * 2);
  });
});
