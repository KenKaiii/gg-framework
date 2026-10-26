// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldScreen } from "./WorldScreen";

vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  worldSaveGet: vi.fn(async () => ({ status: 0, body: null })),
  worldSavePut: vi.fn(async () => ({ status: 0, body: null })),
  worldSaveDelete: vi.fn(async () => ({ status: 0, body: null })),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ready = (source: MessageEventSource | null, origin = window.location.origin): void => {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { gg: "world", t: "ready" }, source, origin }),
    );
  });
};

describe("WorldScreen", () => {
  it("shows on ready and posts the player's progress to the game", () => {
    const onShown = vi.fn();
    const view = render(
      <WorldScreen
        onClose={vi.fn()}
        onShown={onShown}
        player={{ level: 7, percent: 42, xp: 1234 }}
      />,
    );
    const frame = screen.getByLabelText<HTMLIFrameElement>("World");
    const win = frame.contentWindow;
    expect(win).not.toBeNull();
    if (!win) return;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});

    // A message from anywhere else is ignored.
    ready(window);
    ready(win, "https://evil.test");
    expect(post).not.toHaveBeenCalled();
    expect(onShown).not.toHaveBeenCalled();

    ready(win);
    expect(onShown).toHaveBeenCalledOnce();
    expect(document.querySelector(".world-screen.is-visible")).not.toBeNull();
    expect(post).toHaveBeenLastCalledWith(
      { gg: "world", t: "player", level: 7, percent: 42, xp: 1234 },
      window.location.origin,
    );

    // Progress changes are passed on.
    view.rerender(
      <WorldScreen
        onClose={vi.fn()}
        onShown={onShown}
        player={{ level: 8, percent: 3, xp: 1300 }}
      />,
    );
    expect(post).toHaveBeenCalledWith(
      { gg: "world", t: "player", level: 8, percent: 3, xp: 1300 },
      window.location.origin,
    );
  });

  it("Back closes it", () => {
    const onClose = vi.fn();
    render(<WorldScreen onClose={onClose} player={{ level: 1, percent: 0, xp: 0 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says it couldn't load after 10 s, with Try again", () => {
    vi.useFakeTimers();
    try {
      render(<WorldScreen onClose={vi.fn()} player={{ level: 1, percent: 0, xp: 0 }} />);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByRole("alert").textContent).toContain("couldn't load");
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByLabelText("World")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorldScreen keys", () => {
  it("passes Escape to the game when focus is on the app (closes what's open in World)", () => {
    // consent already answered (the consent box keeps Escape for itself while it is open)
    localStorage.setItem("gg-world-save-consent", JSON.stringify({ v: 1, on: false }));
    render(<WorldScreen onClose={vi.fn()} player={{ level: 1, percent: 0, xp: 0 }} />);
    const frame = screen.getByLabelText<HTMLIFrameElement>("World");
    const win = frame.contentWindow;
    if (!win) throw new Error("no frame window");
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    ready(win);
    screen.getByRole("button", { name: "Back" }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(post).toHaveBeenCalledWith(
      { gg: "world", t: "key", key: "Escape" },
      window.location.origin,
    );
  });
});
