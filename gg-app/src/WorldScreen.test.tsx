// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const ready = (source: MessageEventSource | null, origin = "null"): void => {
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

    // A message from anywhere else is ignored (the sealed frame's origin is opaque: "null").
    ready(window);
    ready(win, "https://evil.test");
    ready(win, window.location.origin);
    expect(post).not.toHaveBeenCalled();
    expect(onShown).not.toHaveBeenCalled();

    ready(win);
    expect(onShown).toHaveBeenCalledOnce();
    expect(document.querySelector(".world-screen.is-visible")).not.toBeNull();
    expect(post).toHaveBeenLastCalledWith(
      { gg: "world", t: "player", level: 7, percent: 42, xp: 1234 },
      "*",
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
      "*",
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
    expect(post).toHaveBeenCalledWith({ gg: "world", t: "key", key: "Escape" }, "*");
  });
});

describe("WorldScreen seal", () => {
  const send = (source: MessageEventSource | null, data: unknown, origin = "null"): void => {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
    });
  };

  it("runs the game sealed: scripts only, no same-origin (no reach into the app or its commands)", () => {
    render(<WorldScreen onClose={vi.fn()} player={{ level: 1, percent: 0, xp: 0 }} />);
    const frame = screen.getByLabelText<HTMLIFrameElement>("World");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("gives the game only World's own saved keys, and keeps only World's keys it sends back", () => {
    localStorage.setItem("night-rooms-wallet", '{"coins":5}');
    localStorage.setItem("gg-notes:/Users/me/project", "private");
    render(<WorldScreen onClose={vi.fn()} player={{ level: 1, percent: 0, xp: 0 }} />);
    const win = screen.getByLabelText<HTMLIFrameElement>("World").contentWindow;
    if (!win) throw new Error("no frame window");
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    send(win, { gg: "world", t: "boot" });
    expect(post).toHaveBeenCalledWith(
      { gg: "world", t: "storage", data: { "night-rooms-wallet": '{"coins":5}' } },
      "*",
    );
    send(win, {
      gg: "world",
      t: "store",
      set: { "night-rooms-wallet": '{"coins":9}', "gg-notes:/Users/me/project": "pwned" },
    });
    expect(localStorage.getItem("night-rooms-wallet")).toBe('{"coins":9}');
    expect(localStorage.getItem("gg-notes:/Users/me/project")).toBe("private");
    // not from the frame: ignored
    send(window, { gg: "world", t: "store", set: { "night-rooms-wallet": "x" } });
    expect(localStorage.getItem("night-rooms-wallet")).toBe('{"coins":9}');
    localStorage.clear();
  });

  it("lays the TV player over the glass the game reports, and removes it on close", () => {
    render(<WorldScreen onClose={vi.fn()} player={{ level: 1, percent: 0, xp: 0 }} />);
    const win = screen.getByLabelText<HTMLIFrameElement>("World").contentWindow;
    if (!win) throw new Error("no frame window");
    send(win, {
      gg: "world",
      t: "tv",
      open: true,
      n: 1,
      rect: { x: 100, y: 80, w: 640, h: 360, radius: 12 },
    });
    const tv = screen.getByLabelText<HTMLIFrameElement>("TV");
    expect(tv.getAttribute("src")).toContain("https://gg-world.buzzbeamaustralia.workers.dev/tv");
    // a hijacked TV page still can't navigate the app window or open pop-ups
    expect(tv.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation");
    expect(tv.style.width).toBe("640px");
    send(win, { gg: "world", t: "tv", open: false });
    expect(screen.queryByLabelText("TV")).toBeNull();
  });
});

describe("WorldScreen loading screen", () => {
  it("shows a loading screen from the start, follows World's progress, and goes once World is drawn", async () => {
    render(<WorldScreen onClose={vi.fn()} player={{ level: 1, percent: 0, xp: 0 }} />);
    const bar = screen.getByRole("progressbar", { name: "Loading World" });
    expect(document.querySelector(".world-screen.is-open")).not.toBeNull();
    expect(screen.getByText("Opening World…")).toBeTruthy();
    const win = screen.getByLabelText<HTMLIFrameElement>("World").contentWindow;
    if (!win) throw new Error("no frame window");
    const send = (data: Record<string, unknown>): void => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { gg: "world", ...data },
            source: win,
            origin: "null",
          }),
        );
      });
    };
    send({ t: "progress", p: 0.42, label: "Building the Den" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("Building the Den…")).toBeTruthy();
    // never goes backwards, and labels are cleaned
    send({ t: "progress", p: 0.1, label: "<b>x</b>" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    send({ t: "ready" });
    await waitFor(() => expect(document.querySelector(".world-loading")).toBeNull(), {
      timeout: 2000,
    });
  });
});
