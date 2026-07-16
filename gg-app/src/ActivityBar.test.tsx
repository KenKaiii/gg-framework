// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./ActivityBar";

const baseProps = {
  running: true,
  tokens: 0,
  doneStatus: null,
  isThinking: false,
  thinkingStartTs: null,
  thinkingAccumMs: 0,
  onCancel: vi.fn(),
};

describe("ActivityBar plan progress", () => {
  it("shows approved-plan progress only while a run is active", () => {
    const { rerender } = render(<ActivityBar {...baseProps} planTotal={3} planDone={2} />);
    expect(screen.getByText("Plan Steps")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();

    rerender(<ActivityBar {...baseProps} planTotal={3} planDone={3} />);
    expect(screen.queryByText("Plan Steps")).toBeNull();
    expect(screen.queryByText("3/3")).toBeNull();

    rerender(<ActivityBar {...baseProps} running={false} planTotal={3} planDone={2} />);
    expect(screen.queryByText("Plan Steps")).toBeNull();
  });
});

describe("ActivityBar cancellation state", () => {
  it("shows an enabled cancel action during a normal run", () => {
    render(<ActivityBar {...baseProps} />);
    expect(
      (screen.getByRole("button", { name: "Cancel agent run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole("status").querySelector(".spinner")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("announces and disables cancellation while awaiting settlement", () => {
    render(<ActivityBar {...baseProps} cancelling />);
    const button = screen.getByRole("button", { name: "Cancellation in progress" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Cancelling...");
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
