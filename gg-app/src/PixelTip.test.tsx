// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PixelTip } from "./PixelTip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PixelTip", () => {
  it("shows after a short hover, describes the control, and hides on leave or press", () => {
    vi.useFakeTimers();
    render(
      <PixelTip text="Code: open a project and build it with the agent.">
        <button type="button">Code</button>
      </PixelTip>,
    );
    const button = screen.getByRole("button", { name: "Code" });
    fireEvent.pointerEnter(button.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    const tip = screen.getByRole("tooltip");
    // Plain words, the name picked out, no product prefix.
    expect(tip.textContent).toBe("Code: open a project and build it with the agent.");
    expect(tip.querySelector(".pixel-tip-key")?.textContent).toBe("Code");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    // Still named by its own text, not the tip.
    expect(screen.getByRole("button", { name: "Code" })).toBe(button);

    fireEvent.pointerDown(button.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });
});
