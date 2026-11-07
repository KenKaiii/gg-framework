// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanReviewModal } from "./PlanReviewModal";

vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
// The critter crew is a canvas-free DOM engine with timers and rAF; it is
// decorative and covered by its own tests, so keep it out of these.
vi.mock("./PlanCritters", () => ({ PlanCritters: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Handlers {
  onAccept: ReturnType<typeof vi.fn<() => void>>;
  onFeedback: ReturnType<typeof vi.fn<(feedback: string) => void>>;
  onReject: ReturnType<typeof vi.fn<() => void>>;
}

function renderPlan(props: { kenReviewing?: boolean } = {}): Handlers {
  const handlers: Handlers = {
    onAccept: vi.fn<() => void>(),
    onFeedback: vi.fn<(feedback: string) => void>(),
    onReject: vi.fn<() => void>(),
  };
  render(
    <PlanReviewModal
      content={"# Plan\n\n## Steps\n\n1. Do the thing\n2. Then the other\n"}
      random={() => 0.25}
      {...props}
      {...handlers}
    />,
  );
  return handlers;
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const feedbackBox = (): HTMLElement =>
  screen.getByRole("textbox", { name: "Feedback on the plan" });

describe("PlanReviewModal", () => {
  it("is a named modal dialog that starts focus in the feedback composer, not on Accept", () => {
    renderPlan();
    const dialog = screen.getByRole("dialog", { name: "Review plan" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(feedbackBox());
  });

  it("an Enter carried over from the chat composer does nothing on an empty draft", () => {
    const handlers = renderPlan();
    fireEvent.keyDown(feedbackBox(), { key: "Enter" });
    expect(handlers.onAccept).not.toHaveBeenCalled();
    expect(handlers.onFeedback).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send feedback" })).toHaveProperty("disabled", true);
  });

  it("shows the step count in the header", () => {
    renderPlan();
    expect(screen.getByText("2 steps")).toBeTruthy();
  });

  it("keeps Tab inside and never resolves the plan on Escape", () => {
    const handlers = renderPlan();
    fireEvent.change(feedbackBox(), { target: { value: "tweak" } });
    const send = screen.getByRole("button", { name: "Send feedback" });
    send.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Plan" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onAccept).not.toHaveBeenCalled();
    expect(handlers.onReject).not.toHaveBeenCalled();
    expect(handlers.onFeedback).not.toHaveBeenCalled();
  });

  it("dissolves out before accepting, and accepts exactly once", () => {
    stubReducedMotion(false);
    vi.useFakeTimers();
    const handlers = renderPlan();
    const accept = screen.getByRole("button", { name: "Accept plan" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(screen.getByRole("dialog").className).toContain("leaving");
    expect(handlers.onAccept).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(handlers.onAccept).toHaveBeenCalledTimes(1);
    expect(handlers.onReject).not.toHaveBeenCalled();
  });

  it("sends trimmed feedback on Enter, and Shift+Enter stays a new line", () => {
    stubReducedMotion(true);
    const handlers = renderPlan();
    fireEvent.change(feedbackBox(), { target: { value: "  cover the websocket too  " } });
    fireEvent.keyDown(feedbackBox(), { key: "Enter", shiftKey: true });
    expect(handlers.onFeedback).not.toHaveBeenCalled();
    fireEvent.keyDown(feedbackBox(), { key: "Enter" });
    expect(handlers.onFeedback).toHaveBeenCalledWith("cover the websocket too");
  });

  it("rejects immediately under reduced motion", () => {
    stubReducedMotion(true);
    const handlers = renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(handlers.onReject).toHaveBeenCalledTimes(1);
  });

  it("keeps the decision keys beside send, with one primary action at a time", () => {
    renderPlan();
    const accept = screen.getByRole("button", { name: "Accept plan" });
    const send = screen.getByRole("button", { name: "Send feedback" });
    expect(accept.closest(".inputactions-trailing")).toBe(send.closest(".inputactions-trailing"));
    expect(screen.getByRole("button", { name: "Reject" }).closest(".inputactions-trailing")).toBe(
      send.closest(".inputactions-trailing"),
    );
    expect(accept.className).toContain("primary");
    fireEvent.change(feedbackBox(), { target: { value: "split step 2" } });
    expect(accept.className).not.toContain("primary");
  });

  it("says when Ken is reviewing, without locking the decision", () => {
    renderPlan({ kenReviewing: true });
    expect(screen.getByRole("status").textContent).toContain("Ken is reviewing it");
    expect(screen.getByRole("button", { name: "Accept plan" })).toHaveProperty("disabled", false);
  });
});
