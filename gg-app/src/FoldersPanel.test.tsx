// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FoldersPanel } from "./FoldersPanel";

afterEach(cleanup);

describe("FoldersPanel", () => {
  it("lists each added folder with its own Remove key", () => {
    const onRemove = vi.fn();
    render(<FoldersPanel roots={["/w/sdk", "/w/docs"]} busy={null} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove docs" }));
    expect(onRemove).toHaveBeenCalledWith("/w/docs");
    expect(screen.getByTitle("/w/sdk")).toBeDefined();
  });

  it("holds every key while one folder is being removed", () => {
    render(<FoldersPanel roots={["/w/sdk", "/w/docs"]} busy="/w/sdk" onRemove={vi.fn()} />);
    for (const key of screen.getAllByRole("button")) expect(key).toHaveProperty("disabled", true);
  });

  it("says so when nothing is added", () => {
    render(<FoldersPanel roots={[]} busy={null} onRemove={vi.fn()} />);
    expect(screen.getByText("No folders added.")).toBeDefined();
  });
});
