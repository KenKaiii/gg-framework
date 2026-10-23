// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CHANGELOG } from "./changelog";
import { WHATSNEW_MODES } from "./whatsnew-content";
import { releaseText } from "./WhatsNewParts";
import { WhatsNewWindow } from "./WhatsNewWindow";

const closeWindow = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ close: closeWindow }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn().mockResolvedValue(undefined) }));

const latest = CHANGELOG[0];
if (!latest) throw new Error("changelog is empty");

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  closeWindow.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("releaseText", () => {
  it("renders explicit and known specifics as themed inline highlights", () => {
    const html = renderToStaticMarkup(
      <>{releaseText("Turn on `Autopilot` for GPT-5.6 and save 90 MB.")}</>,
    );

    expect(html).not.toContain("`");
    expect(html.match(/class="whatsnew-highlight"/g)).toHaveLength(3);
    expect(html).toContain(">Autopilot</strong>");
    expect(html).toContain(">GPT-5.6</strong>");
    expect(html).toContain(">90 MB</strong>");
  });
});

describe("WhatsNewWindow", () => {
  // Both moods must put the newest release's words on screen: animation is
  // decoration, never the only way to read the notes.
  it.each(WHATSNEW_MODES)("%s shows every new feature and the history", (mode) => {
    const html = renderToStaticMarkup(<WhatsNewWindow mode={mode} />);

    expect(html).toContain(`data-mode="${mode}"`);
    expect(html).toContain(`What&#x27;s new in GG Coder v${latest.version}`);
    expect(html.match(/class="wn-headline"/g)?.length ?? 0).toBeGreaterThanOrEqual(
      latest.items.length,
    );
    expect(html).toContain("wn-history");
  });

  // GG Royale's look: the clearing canvas, the notes as rows on a board,
  // and the one action as the game's plate button. Opening doesn't focus it
  // (no ring until the keyboard reaches it); Enter closes the window.
  it("puts the notes on a lounge board with a plate button to leave", async () => {
    const { container, getByRole } = render(<WhatsNewWindow mode="hype" />);

    expect(container.querySelector("canvas.wn-backdrop")).not.toBeNull();
    expect(container.querySelectorAll(".wn-board .wn-row")).toHaveLength(latest.items.length);
    const done = getByRole("button", { name: "Let's go" });
    expect(done.classList).toContain("plate-button");
    expect(document.activeElement).not.toBe(done);
    await waitFor(() => expect(container.querySelector('[data-phase="open"]')).not.toBeNull());
    vi.useFakeTimers();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(container.querySelector('[data-phase="closing"]')).not.toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("starts hidden, then asks Rust to show it and fades in", async () => {
    const { container } = render(<WhatsNewWindow />);
    const card = container.querySelector(".whatsnew-window");

    expect(invoke).toHaveBeenCalledWith("reveal_whatsnew_window");
    await waitFor(() => expect(card?.getAttribute("data-phase")).toBe("open"));
  });

  it("fades out before closing the window, and only closes once", async () => {
    const { container, getByRole } = render(<WhatsNewWindow />);
    const card = container.querySelector(".whatsnew-window");
    await waitFor(() => expect(card?.getAttribute("data-phase")).toBe("open"));
    vi.useFakeTimers();

    fireEvent.click(getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(card?.getAttribute("data-phase")).toBe("closing");
    expect(closeWindow).not.toHaveBeenCalled();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });
});
