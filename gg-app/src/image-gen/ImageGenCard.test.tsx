// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageGenCard } from "./ImageGenCard";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

vi.mock("../window-motion", () => ({ useMotionLevel: vi.fn(() => "full") }));
import { useMotionLevel } from "../window-motion";

describe("ImageGenCard", () => {
  it("keeps counting the estimate with motion turned off", () => {
    vi.mocked(useMotionLevel).mockReturnValue("off");
    render(<ImageGenCard prompt="x" gif={false} startedAt={Date.now()} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const shown = Number.parseInt(document.querySelector(".img-gen-progress")!.textContent!, 10);
    expect(shown).toBeGreaterThan(0);
    vi.mocked(useMotionLevel).mockReturnValue("full");
  });

  it("shows what is being made, its prompt and a climbing estimate", () => {
    const startedAt = Date.now();
    render(<ImageGenCard prompt="a looping lantern" gif startedAt={startedAt} />);
    expect(screen.getByText("Creating GIF", { selector: ".img-gen-phrase" })).toBeTruthy();
    expect(screen.getByText("a looping lantern")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Creating GIF");
    expect(document.querySelector(".img-gen-progress")?.textContent).toBe("0%");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const shown = Number.parseInt(document.querySelector(".img-gen-progress")!.textContent!, 10);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(95);
  });

  it("starts Snake from the board and stops it with Escape", () => {
    render(<ImageGenCard prompt="x" gif={false} startedAt={Date.now()} />);
    const play = screen.getByRole("button", {
      name: "Play Snake while your image is generating",
    });
    fireEvent.click(play);
    // Clicking focuses the board so the arrow keys reach it (WebKit won't by itself).
    expect(document.activeElement).toBe(play);
    expect(play.getAttribute("aria-label")).toBe(
      "Snake: steer with the arrow keys, Escape to stop",
    );
    expect(document.querySelector(".img-gen-score")?.textContent).toBe("0");
    fireEvent.keyDown(play, { key: "Escape" });
    expect(play.getAttribute("aria-label")).toBe("Play Snake while your image is generating");
    expect(document.querySelector(".img-gen-score")).toBeNull();
  });
});
