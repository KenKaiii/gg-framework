// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.2.0") }));
vi.mock("./goal-ken-portrait", () => ({ drawKenPortrait: vi.fn() }));
vi.mock("./agent", () => ({ openUrl: vi.fn(), openWhatsNewWindow: vi.fn(async () => {}) }));
vi.mock("./changelog", () => ({
  CHANGELOG: [
    { version: "0.3.0", date: "2026-06-17", items: ["Ken got a `Workers` view. It is good."] },
    { version: "0.2.0", date: "2026-06-16", items: ["Faster lists for everyone. Truly."] },
    { version: "0.1.0", date: "2026-06-15", items: ["The first release ever shipped. Yes."] },
  ],
}));

import { openUrl, openWhatsNewWindow } from "./agent";
import { AboutKen, AboutPage } from "./AboutPage";
import { SKOOL_URL, SOURCE_URL, YOUTUBE_URL } from "./about-content";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderPage(): Promise<void> {
  render(<AboutPage />);
  await act(async () => {
    await Promise.resolve();
  });
}

function dayButton(label: RegExp): HTMLElement {
  return screen.getByRole("button", { name: label });
}

describe("AboutPage", () => {
  it("credits Ken and opens his Skool and YouTube in the browser", async () => {
    await renderPage();

    expect(screen.getByRole("heading", { name: "Ken Kai" })).not.toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Learn with Ken on Skool/ }));
    expect(openUrl).toHaveBeenCalledWith(SKOOL_URL);
    fireEvent.click(screen.getByRole("link", { name: /Watch on YouTube/ }));
    expect(openUrl).toHaveBeenCalledWith(YOUTUBE_URL);
  });

  it("states the AGPL license and opens the source code in the browser", async () => {
    await renderPage();

    expect(
      screen.getByText(/free software under the GNU AGPL-3\.0, with no warranty/),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Source code" }));
    expect(openUrl).toHaveBeenCalledWith(SOURCE_URL);
  });

  it("dates GG Coder from the CLI and the calendar from the desktop app", async () => {
    await renderPage();

    expect(screen.getByText("CLI since 4 Mar 2026. App since 15 Jun 2026.")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Desktop app releases" })).not.toBeNull();
    expect(screen.getByText("3 releases. You're on v0.2.0.")).not.toBeNull();
  });

  it("opens on the day your version shipped and reads out what landed", async () => {
    await renderPage();

    const yours = dayButton(/Tue 16 Jun: 1 release, your version/);
    expect(yours.getAttribute("aria-current")).toBe("true");
    expect(yours.tabIndex).toBe(0);
    expect(screen.getByText("Faster lists for everyone.")).not.toBeNull();
    expect(document.querySelector(".about-readout .badge")?.textContent).toBe("Your version");
  });

  it("shows the day under the pointer, and walks days and weeks with the arrows", async () => {
    await renderPage();

    fireEvent.mouseEnter(dayButton(/Wed 17 Jun/));
    expect(screen.getByText("Workers")).not.toBeNull();

    const wed = dayButton(/Wed 17 Jun/);
    fireEvent.keyDown(wed, { key: "ArrowUp" });
    expect(document.activeElement).toBe(dayButton(/Tue 16 Jun/));
    fireEvent.keyDown(dayButton(/Tue 16 Jun/), { key: "Home" });
    expect(document.activeElement).toBe(dayButton(/Mon 15 Jun/));
    expect(screen.getByText("The first release ever shipped.")).not.toBeNull();
    // There's no week before the first day, so ArrowLeft stays put.
    fireEvent.keyDown(dayButton(/Mon 15 Jun/), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(dayButton(/Mon 15 Jun/));
  });

  it("opens the full release history", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Read every release" }));
    expect(openWhatsNewWindow).toHaveBeenCalledWith("calm");
  });
});

describe("AboutKen", () => {
  const LINES = [
    { face: "happy", text: "Hi there." },
    { face: "wink", text: "Bye now." },
  ] as const;

  function box(): HTMLElement {
    return screen.getByRole("button", { name: /^Ken, / });
  }

  it("rises, types his line, then moves through his lines on click", () => {
    vi.useFakeTimers();
    render(<AboutKen lines={LINES} start />);
    const dialogue = document.querySelector(".about-ken");

    // Up on the next frame, then talking once the entrance has played.
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(dialogue?.getAttribute("data-phase")).toBe("entering");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(dialogue?.getAttribute("data-phase")).toBe("talking");
    // Clicking mid-line shows the rest at once.
    fireEvent.click(box());
    expect(document.querySelector(".ken-dialogue-text")?.textContent).toBe("Hi there.");
    expect(box().getAttribute("aria-label")).toBe("Ken, 1 of 2: Hi there. Next");

    fireEvent.click(box());
    // One character every 30ms, each scheduled after the last one lands.
    for (let i = 0; i < "Bye now.".length; i++) {
      act(() => {
        vi.advanceTimersByTime(30);
      });
    }
    expect(document.querySelector(".ken-dialogue-text")?.textContent).toBe("Bye now.");
    expect(box().getAttribute("aria-label")).toBe("Ken, 2 of 2: Bye now. Start over");

    fireEvent.click(box());
    expect(box().getAttribute("aria-label")).toContain("1 of 2: Hi there.");
  });

  it("waits to come up until the page shows", () => {
    vi.useFakeTimers();
    render(<AboutKen lines={LINES} start={false} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(document.querySelector(".about-ken")?.getAttribute("data-phase")).toBe("hidden");
  });
});
