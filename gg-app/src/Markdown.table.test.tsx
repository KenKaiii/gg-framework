// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

import { Markdown } from "./Markdown";

afterEach(cleanup);

const TABLE = [
  "| File | Risk | Notes |",
  "|---|:---:|---|",
  "| `src/a.ts` | Low | A stuck refresh no longer holds the auth lock |",
].join("\n");

describe("markdown tables", () => {
  it("wraps each table in a keyboard-scrollable frame and keeps real table markup", () => {
    render(<Markdown>{TABLE}</Markdown>);
    const frame = screen.getByRole("region", { name: "Table" });
    expect(frame.className).toBe("md-table-scroll");
    expect(frame.tabIndex).toBe(0);
    expect(frame.querySelector(":scope > table > tbody > tr > td")).not.toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("gives sentence cells a readable width and leaves short labels natural", () => {
    render(<Markdown>{TABLE}</Markdown>);
    const notes = screen.getByRole("cell", { name: /stuck refresh/ });
    const risk = screen.getByRole("cell", { name: "Low" });
    expect(notes.className).toBe("md-cell-prose");
    expect(risk.className).toBe("");
  });

  it("keeps GFM column alignment", () => {
    render(<Markdown>{TABLE}</Markdown>);
    expect(screen.getByRole("cell", { name: "Low" }).style.textAlign).toBe("center");
  });
});
