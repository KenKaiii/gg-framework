// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KenActivityBar } from "./KenActivityBar";
import { theme } from "./theme";

const baseProps = {
  runStartTs: null,
  tokens: 1234,
};

describe("KenActivityBar", () => {
  it("uses the listening orb and shimmer with Ken's existing color", () => {
    const { container } = render(<KenActivityBar {...baseProps} />);
    const orb = container.querySelector("canvas");
    expect(orb?.getAttribute("aria-label")).toBe("Listening…");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.style.width).toBe("20px");
    const filter = container.querySelector("filter");
    expect(orb?.style.filter).toBe(`url("#${filter?.id}")`);
    const flood = container.querySelector<SVGElement>("feFlood");
    expect(flood?.style.getPropertyValue("flood-color")).toBe(theme.ken);
    const label = screen.getByText("Ken is thinking…");
    expect(label.classList.contains("shimmer-text")).toBe(true);
    expect(label.style.getPropertyValue("--shimmer-base")).toBe(theme.ken);
  });

  it("matches the main bar's running row, with Stop left to the composer's send key", () => {
    const { container } = render(<KenActivityBar {...baseProps} />);
    expect(container.querySelector(".task-activity > .statusrow.running")).toBeTruthy();
    expect(screen.getByTitle("Output tokens").textContent).toBe(" · 1.2k tok");
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /tool panel/ })).toBeNull();
  });

  it("shows the tool panel chevron, like the main bar", () => {
    const onToggleTools = vi.fn();
    render(<KenActivityBar {...baseProps} toolsHidden onToggleTools={onToggleTools} />);
    const chevron = screen.getByRole("button", { name: "Show tool panel" });
    fireEvent.click(chevron);
    expect(onToggleTools).toHaveBeenCalledOnce();
  });
});
