// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./MarkdownRenderer", () => {
  throw new Error("Chunk unavailable");
});
import { Markdown } from "./Markdown";

it("reports a failed rich-text chunk and preserves safely escaped, expandable message content", async () => {
  const source = [
    "```text",
    '<img src=x onerror="alert(1)">',
    ...Array.from({ length: 1000 }, (_, i) => `line ${i}`),
    "```",
  ].join("\n");
  const { container } = render(<Markdown>{source}</Markdown>);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Showing plain text"),
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(container.textContent).not.toContain("line 999");
  fireEvent.click(screen.getByRole("button", { name: /Show full plain text/ }));
  expect(container.textContent).toContain("line 999");
  expect(container.querySelector("img")).toBeNull();
});
