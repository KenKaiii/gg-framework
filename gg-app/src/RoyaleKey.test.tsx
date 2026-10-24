// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({
  royaleStatus: vi.fn(),
  openRoyale: vi.fn(),
  unlinkRoyale: vi.fn(async () => {}),
  openUrl: vi.fn(),
  royaleSummary: vi.fn(async (): Promise<RoyaleSummary | null> => null),
}));
vi.mock("./agent", () => agent);
import type { RoyaleSummary } from "./agent";
const toast = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ toast }));

import { ROYALE_CONSENT_LINES, ROYALE_CONSENT_VERSION, RoyaleKey } from "./RoyaleKey";
import { RoyaleScreen } from "./RoyaleScreen";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
const FIRST_LINE = ROYALE_CONSENT_LINES[0];

describe("RoyaleKey", () => {
  it("asks before linking, and only lets them in once they confirm they're 18+", async () => {
    agent.royaleStatus.mockResolvedValue({ linked: false, serverUrl: "x" });
    const onOpen = vi.fn();
    render(<RoyaleKey onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "GG Royale" }));
    await screen.findByText(FIRST_LINE);
    // Says what it is, that there's no real money, and what's shared.
    expect(screen.getByText(/no real money/)).toBeTruthy();
    expect(screen.getByText(/kind of bug it fixed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy notice" })).toBeTruthy();
    // Not ticked yet: Let's play doesn't go in.
    fireEvent.click(screen.getByRole("button", { name: "Let's play" }));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I'm 18 or older" }));
    fireEvent.click(screen.getByRole("button", { name: "Let's play" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(FIRST_LINE)).toBeNull();
    expect(localStorage.getItem("gg-royale-consent")).toBe(String(ROYALE_CONSENT_VERSION));
  });

  it("asks again when the wording changed since they last agreed, even if linked", async () => {
    agent.royaleStatus.mockResolvedValue({ linked: true, serverUrl: "x" });
    localStorage.setItem("gg-royale-consent", String(ROYALE_CONSENT_VERSION - 1));
    const onOpen = vi.fn();
    render(<RoyaleKey onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "GG Royale" }));
    await screen.findByText(FIRST_LINE);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("goes straight in when linked and agreed, and toasts a failed check", async () => {
    agent.royaleStatus.mockResolvedValue({ linked: true, serverUrl: "x" });
    localStorage.setItem("gg-royale-consent", String(ROYALE_CONSENT_VERSION));
    const onOpen = vi.fn();
    render(<RoyaleKey onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "GG Royale" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(FIRST_LINE)).toBeNull();

    agent.royaleStatus.mockRejectedValue(new Error("daemon not ready"));
    fireEvent.click(screen.getByRole("button", { name: "GG Royale" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("daemon not ready"), "error"),
    );
  });
});

describe("RoyaleKey badge", () => {
  it("shows rewards waiting, else people playing, else nothing", async () => {
    agent.royaleStatus.mockResolvedValue({ linked: true, serverUrl: "x" });
    agent.royaleSummary.mockResolvedValueOnce({ claimable: 2, streak: 1, playing: 3 });
    render(<RoyaleKey onOpen={vi.fn()} />);
    expect((await screen.findByLabelText("2 rewards waiting")).textContent).toBe("2");
    cleanup();

    agent.royaleSummary.mockResolvedValueOnce({ claimable: 0, streak: 0, playing: 3 });
    render(<RoyaleKey onOpen={vi.fn()} />);
    expect(await screen.findByText("3 playing")).toBeTruthy();
    cleanup();

    agent.royaleSummary.mockResolvedValueOnce(null);
    render(<RoyaleKey onOpen={vi.fn()} />);
    await waitFor(() => expect(agent.royaleSummary).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("makes no summary call when unlinked", async () => {
    agent.royaleStatus.mockResolvedValue({ linked: false, serverUrl: "x" });
    render(<RoyaleKey onOpen={vi.fn()} />);
    await waitFor(() => expect(agent.royaleStatus).toHaveBeenCalled());
    expect(agent.royaleSummary).not.toHaveBeenCalled();
  });
});

/**
 * The game frame, once the screen is listening to it. The frame appears when
 * the sign-in URL arrives (outside act), and the message listener is a passive
 * effect that can land a tick later on a slow runner; flush it before sending
 * the game's signals, or they'd go to nobody.
 */
async function findFrame(): Promise<HTMLIFrameElement> {
  const frame = (await screen.findByLabelText("GG Royale")) as HTMLIFrameElement;
  await act(async () => {});
  return frame;
}

describe("RoyaleScreen", () => {
  it("embeds the game full-window in a sandboxed frame, with Back", async () => {
    agent.openRoyale.mockResolvedValue("https://royale.test/#code=abc");
    const onClose = vi.fn();
    render(<RoyaleScreen onClose={onClose} />);
    const frame = await screen.findByLabelText("GG Royale");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("https://royale.test/#code=abc");
    // Scripts and its own storage only: no top navigation, popups or forms.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // Straight home, like every other screen: no curtain, no fade out.
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the game on its closed curtain, and Back goes straight home without asking the game", async () => {
    agent.openRoyale.mockResolvedValue("https://royale.test/#code=abc");
    const onClose = vi.fn();
    render(<RoyaleScreen onClose={onClose} />);
    const frame = await findFrame();
    const win = frame.contentWindow!;
    const say = (
      t: string,
      from: { origin: string; source: Window | null } = {
        origin: "https://royale.test",
        source: win,
      },
    ) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { gg: "royale", t }, ...from }));
      });
    // Hidden until the game says its curtain is painted shut.
    expect(frame.className).not.toContain("is-shown");
    // Signals from anywhere else are ignored.
    say("painted", { origin: "https://evil.test", source: win });
    say("painted", { origin: "https://royale.test", source: window });
    expect(frame.className).not.toContain("is-shown");
    say("painted");
    expect(frame.className).toContain("is-shown");

    const post = vi.spyOn(win, "postMessage");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(post).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("signs the game straight back in when it lost its sign-in, at most once per half minute", async () => {
    agent.openRoyale.mockResolvedValue("https://royale.test/#code=abc");
    render(<RoyaleScreen onClose={vi.fn()} />);
    const frame = await findFrame();
    expect(agent.openRoyale).toHaveBeenCalledTimes(1);
    const say = (t: string) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { gg: "royale", t },
            origin: "https://royale.test",
            source: frame.contentWindow,
          }),
        );
      });
    agent.openRoyale.mockResolvedValue("https://royale.test/#code=fresh");
    say("signed-out");
    await waitFor(() => expect(agent.openRoyale).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((screen.getByLabelText("GG Royale") as HTMLIFrameElement).src).toContain("code=fresh"),
    );
    // A second loss straight away doesn't loop.
    say("signed-out");
    await new Promise((r) => setTimeout(r, 30));
    expect(agent.openRoyale).toHaveBeenCalledTimes(2);
  });

  it("forgets the link and the agreement and goes home when the game deleted the player's data", async () => {
    agent.openRoyale.mockResolvedValue("https://royale.test/#code=abc");
    localStorage.setItem("gg-royale-consent", "2");
    const onClose = vi.fn();
    render(<RoyaleScreen onClose={onClose} />);
    const frame = await findFrame();
    const say = (t: string, source: Window | null) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { gg: "royale", t },
            origin: "https://royale.test",
            source,
          }),
        );
      });
    // Only the game's own frame can say it.
    say("deleted", window);
    expect(agent.unlinkRoyale).not.toHaveBeenCalled();
    say("deleted", frame.contentWindow);
    // Generous under a loaded full run: unlink + toast + close are three async hops.
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(agent.unlinkRoyale).toHaveBeenCalledOnce();
    expect(localStorage.getItem("gg-royale-consent")).toBeNull();
  });

  it("shows the error and retries", async () => {
    agent.openRoyale
      .mockRejectedValueOnce(new Error("Couldn't reach the GG Royale server."))
      .mockResolvedValueOnce("https://royale.test/#code=b");
    render(<RoyaleScreen onClose={vi.fn()} />);
    await screen.findByText(/Couldn't reach/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("GG Royale")).toBeTruthy();
    expect(agent.openRoyale).toHaveBeenCalledTimes(2);
  });
});
