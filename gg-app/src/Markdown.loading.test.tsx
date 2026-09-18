// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const pending = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
});
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./MarkdownRenderer", async () => {
  await pending.promise;
  return vi.importActual("./MarkdownRenderer");
});
import { Markdown } from "./Markdown";

it("keeps bounded, escaped plain text usable while rich text loads, then renders real highlighting", async () => {
  const source = [
    "```ts",
    ...Array.from({ length: 1000 }, (_, i) => `const v${i} = ${i};`),
    "```",
  ].join("\n");
  const { container } = render(<Markdown>{source}</Markdown>);
  expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  expect(container.textContent).toContain("const v0 = 0;");
  expect(container.textContent).not.toContain("const v999 = 999;");
  fireEvent.click(screen.getByRole("button", { name: /Show full plain text/ }));
  expect(container.textContent).toContain("const v999 = 999;");
  fireEvent.click(screen.getByRole("button", { name: "Show less plain text" }));
  expect(container.textContent).not.toContain("const v999 = 999;");

  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  await waitFor(() => expect(container.querySelector(".code-block")).toBeTruthy());
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.textContent).not.toContain("const v999 = 999;");
  fireEvent.click(screen.getByRole("button", { name: /Show full output/ }));
  expect(container.textContent).toContain("const v999 = 999;");
  expect(container.querySelector(".hljs-keyword")).toBeTruthy();
});
