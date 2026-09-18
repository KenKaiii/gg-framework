// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CODE_COLLAPSE_LINE_THRESHOLD } from "./collapse";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

const { Markdown } = await import("./Markdown");

async function renderMarkdown(element: ReactElement): Promise<ReturnType<typeof render>> {
  const result = render(element);
  await waitFor(() => {
    expect(result.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  return result;
}

const fence = (lineCount: number): string =>
  ["```ts", ...Array.from({ length: lineCount }, (_, i) => `const v${i} = ${i};`), "```"].join(
    "\n",
  );

describe("oversized output folding", () => {
  it("renders a short block in full, with no expand control", async () => {
    await renderMarkdown(<Markdown>{fence(CODE_COLLAPSE_LINE_THRESHOLD)}</Markdown>);
    // Syntax highlighting splits each line across spans, so assert on the
    // block's combined text rather than any single element.
    const last = CODE_COLLAPSE_LINE_THRESHOLD - 1;
    expect(document.body.textContent).toContain("const v0 = 0;");
    expect(document.body.textContent).toContain(`const v${last} = ${last};`);
    expect(screen.queryByRole("button", { name: /Show full output/ })).toBeNull();
  });

  it("folds a long block and withholds the hidden lines from the DOM", async () => {
    await renderMarkdown(<Markdown>{fence(1000)}</Markdown>);
    const text = document.body.textContent ?? "";
    // Preview is present…
    expect(text).toContain("const v0 = 0;");
    // …and the rest is genuinely absent, not merely hidden with CSS. That is
    // the memory win: 993 lines of highlighted markup never get mounted.
    expect(text).not.toContain("const v999 = 999;");
    expect(text).not.toContain(`const v${CODE_COLLAPSE_LINE_THRESHOLD} =`);
    expect(screen.getByRole("button", { name: /Show full output/ })).toBeTruthy();
  });

  it("names how much is hidden so the fold is not a mystery", async () => {
    await renderMarkdown(<Markdown>{fence(1000)}</Markdown>);
    const button = screen.getByRole("button", { name: /Show full output/ });
    expect(button.textContent).toContain(String(1000 - CODE_COLLAPSE_LINE_THRESHOLD));
  });

  it("reveals the full block on demand and can fold it back", async () => {
    await renderMarkdown(<Markdown>{fence(1000)}</Markdown>);
    fireEvent.click(screen.getByRole("button", { name: /Show full output/ }));
    expect(document.body.textContent).toContain("const v999 = 999;");

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(document.body.textContent).not.toContain("const v999 = 999;");
  });

  it("folds a row made of many ordinary blocks, not just one huge block", async () => {
    const paragraphs = Array.from(
      { length: 400 },
      (_, i) => `Paragraph ${i} ${"word ".repeat(20)}`,
    );
    await renderMarkdown(<Markdown>{paragraphs.join("\n\n")}</Markdown>);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Paragraph 0");
    expect(text).not.toContain("Paragraph 399");
    expect(screen.getByRole("button", { name: /Show full output/ })).toBeTruthy();
  });

  it("leaves an ordinary reply completely untouched", async () => {
    await renderMarkdown(<Markdown>{"Here is the fix.\n\nIt works now."}</Markdown>);
    expect(document.body.textContent).toContain("It works now.");
    expect(screen.queryByRole("button", { name: /Show full output/ })).toBeNull();
  });
});
