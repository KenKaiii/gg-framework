// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { openUrl } from "../agent";
import { setHomeBackgroundEnabled } from "../home-background";
import type { Box } from "./flip";
import type * as KleioApi from "./kleioApi";
import type { CallState } from "./voiceCall";
import type { Shown } from "./voiceTools";

const call = vi.hoisted(() => ({
  state: { phase: "idle", lines: [], muted: false, error: null, shown: null } as CallState,
  partial: [] as { who: "you" | "kleio"; text: string }[],
  endCall: vi.fn(),
  resetCall: vi.fn(),
  setMuted: vi.fn(),
  startCall: vi.fn(),
  closeShown: vi.fn(),
}));
const api = vi.hoisted(() => ({ getShowPart: vi.fn(), createFileShow: vi.fn() }));

vi.mock("./voiceCall", () => ({
  useCall: () => call.state,
  callLevels: () => ({ out: null, in: null }),
  partialLines: () => call.partial,
  endCall: call.endCall,
  resetCall: call.resetCall,
  setMuted: call.setMuted,
  startCall: call.startCall,
  closeShown: call.closeShown,
}));
// The orb and the waves are WebGL: not something jsdom can draw.
vi.mock("./VoiceOrb", () => ({ VoiceOrb: () => <div data-testid="orb" /> }));
vi.mock("../HomeDither", () => ({
  HomeDither: ({ className }: { className?: string }) => (
    <div data-testid="waves" className={className} />
  ),
}));
vi.mock("./kleioApi", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioApi>()),
  getVoiceStatus: vi.fn(),
  getShowPart: api.getShowPart,
  createFileShow: api.createFileShow,
}));
vi.mock("./BriefPanel", () => ({ briefMe: vi.fn() }));
vi.mock("../agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(async () => {}),
  sendPrompt: vi.fn(),
}));

const { VoiceMode, latestCaption, CAPTION_HOLD_MS } = await import("./VoiceMode");
const { FileViewerProvider } = await import("./FileViewerProvider");

function set(state: Partial<CallState>): void {
  call.state = { ...call.state, ...state };
}

/** A report she shows (show), as voiceTools hands it to the screen. */
const REPORT: Shown = {
  key: 1,
  title: "Q3 report.md",
  whose: "Chef",
  show: {
    id: "sh_0123456789abcdef0123456789abcdef",
    kind: "text",
    name: "Q3 report.md",
    state: "ready",
    format: "markdown",
  },
  url: null,
  problem: null,
  file: null,
};

beforeEach(() => {
  call.state = { phase: "idle", lines: [], muted: false, error: null, shown: null };
  call.partial = [];
  setHomeBackgroundEnabled(true);
  // What's shown stays loading unless a test waits for it.
  api.getShowPart.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(Element.prototype, "animate");
  document.documentElement.style.removeProperty("--zoom");
});

describe("VoiceMode", () => {
  it("shows nothing until you talk to Kleio", () => {
    const { container } = render(<VoiceMode />);
    expect(container.innerHTML).toBe("");
  });

  it("fills the window with her orb, who's talking and her words as she says them", async () => {
    set({ phase: "speaking" });
    call.partial = [{ who: "kleio", text: "Morning. Nothing needs you." }];
    render(<VoiceMode />);
    expect(screen.getByRole("dialog", { name: "Talking to Kleio" })).toBeTruthy();
    expect(await screen.findByTestId("orb")).toBeTruthy();
    expect(screen.getByText("Speaking")).toBeTruthy();
    expect(screen.getByText("Morning. Nothing needs you.")).toBeTruthy();
  });

  it("moves the home screen's waves behind her, unless the background is switched off", () => {
    set({ phase: "listening" });
    render(<VoiceMode />);
    expect(screen.getByTestId("waves").className).toBe("voice-dither");
    cleanup();
    setHomeBackgroundEnabled(false);
    render(<VoiceMode />);
    expect(screen.queryByTestId("waves")).toBeNull();
    expect(screen.getByText("Listening")).toBeTruthy();
  });

  it("quotes your words while she thinks, so you know she heard you", () => {
    set({ phase: "thinking", lines: [{ who: "you", text: "What did Chef make?" }] });
    render(<VoiceMode />);
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("“What did Chef make?”")).toBeTruthy();
  });

  it("mutes, unmutes and hangs up", () => {
    set({ phase: "listening" });
    const { rerender } = render(<VoiceMode />);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(call.setMuted).toHaveBeenLastCalledWith(true);
    set({ muted: true });
    rerender(<VoiceMode />);
    expect(screen.getByText("Muted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(call.setMuted).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
    expect(call.endCall).toHaveBeenCalledTimes(1);
  });

  it("leaves with Escape or the close button", () => {
    set({ phase: "listening" });
    render(<VoiceMode />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(call.resetCall).toHaveBeenCalledTimes(2);
  });

  it("shows what she pulls up beside her, and the call keeps going", async () => {
    api.getShowPart.mockResolvedValue(new TextEncoder().encode("# Q3\n\nSales rose by a tenth."));
    set({ phase: "speaking", shown: REPORT });
    render(<VoiceMode />);
    const room = screen.getByRole("dialog", { name: "Talking to Kleio" });
    expect(room.dataset.panel).toBe("open");
    const panel = screen.getByRole("region", { name: "Q3 report.md" });
    expect(panel.textContent).toContain("Chef");
    // The document itself, its Markdown drawn (loaded with the first one shown).
    expect(await screen.findByRole("heading", { name: "Q3" })).toBeTruthy();
    expect(panel.textContent).toContain("Sales rose by a tenth.");
    expect(api.getShowPart).toHaveBeenCalledWith(REPORT.show?.id, "text");
    // Beside the call, not over it: the only dialog is the call, which goes on.
    expect(screen.getAllByRole("dialog")).toEqual([room]);
    expect(screen.getByRole("button", { name: "Hang up" })).toBeTruthy();
    expect(screen.getByText("Kleio is showing Q3 report.md")).toBeTruthy();
  });

  it("closes what she's showing with × or Esc, never the call", () => {
    set({ phase: "listening", shown: REPORT });
    render(<VoiceMode />);
    fireEvent.click(screen.getByRole("button", { name: "Close Q3 report.md" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(call.closeShown).toHaveBeenCalledTimes(2);
    expect(call.endCall).not.toHaveBeenCalled();
    expect(call.resetCall).not.toHaveBeenCalled();
  });

  it("takes it down when she hides it, and the room goes back", () => {
    set({ phase: "speaking", shown: REPORT });
    const { rerender } = render(<VoiceMode />);
    set({ shown: null });
    rerender(<VoiceMode />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Talking to Kleio" }).dataset.panel).toBe("closed");
    expect(screen.getByRole("button", { name: "Hang up" })).toBeTruthy();
  });

  it("never takes focus when she opens it, and gives it back when it closes", () => {
    set({ phase: "listening" });
    const { rerender } = render(<VoiceMode />);
    const mute = screen.getByRole("button", { name: "Mute" });
    mute.focus();
    set({ shown: REPORT });
    rerender(<VoiceMode />);
    expect(document.activeElement).toBe(mute);
    // They go to the panel and close it there.
    const close = screen.getByRole("button", { name: "Close Q3 report.md" });
    close.focus();
    fireEvent.click(close);
    expect(call.closeShown).toHaveBeenCalledTimes(1);
    set({ shown: null });
    rerender(<VoiceMode />);
    expect(document.activeElement).toBe(mute);
  });

  it("explains what Kleio Voice can and can't do, without leaving the call", async () => {
    set({ phase: "listening" });
    render(<VoiceMode />);
    fireEvent.click(screen.getByRole("button", { name: "What Kleio Voice can do" }));
    // The guide loads when first opened.
    const guide = await screen.findByRole("dialog", { name: "What Kleio Voice can do" });
    expect(guide.textContent).toContain("Show you things while you talk");
    expect(guide.textContent).toContain("with Open in browser for the page itself");
    expect(guide.textContent).toContain("Tap what she shows to see it full size.");
    expect(guide.textContent).toContain("Say “close it”, or tap ×, to take it down.");
    expect(guide.textContent).toContain("Web pages and PDFs need a Mac host on macOS 14 or later.");
    expect(guide.textContent).toContain("Run a job on her own");
    expect(guide.textContent).toContain("she asks before opening a web page");
    expect(guide.textContent).toContain("Sign in to websites as you");
    expect(guide.textContent).toContain("shows its sign-in or paywall page");
    expect(guide.textContent).toContain("Runs on OpenAI");
    // She has no mail tools, so the guide never offers mail.
    expect(guide.textContent).not.toMatch(/e-?mail|inbox/i);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "What Kleio Voice can do" })).toBeNull();
    expect(call.resetCall).not.toHaveBeenCalled();
  });

  it("ends the call if the voice screen goes away mid-call", () => {
    set({ phase: "listening" });
    const { unmount } = render(<VoiceMode />);
    expect(call.resetCall).not.toHaveBeenCalled();
    unmount();
    expect(call.resetCall).toHaveBeenCalledTimes(1);
  });

  it("says why a call ended, and offers to talk again", () => {
    set({ phase: "ended", error: "Your host couldn't reach OpenAI." });
    render(<VoiceMode />);
    expect(screen.getByText("Call ended")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Your host couldn't reach OpenAI.");
    fireEvent.click(screen.getByRole("button", { name: "Talk again" }));
    expect(call.startCall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Hang up" })).toBeNull();
  });

  it("clears the words after a quiet spell, so the screen rests", () => {
    vi.useFakeTimers();
    set({ phase: "listening", lines: [{ who: "kleio", text: "Anything else?" }] });
    render(<VoiceMode />);
    expect(screen.getByText("Anything else?")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(CAPTION_HOLD_MS + 500);
    });
    expect(screen.queryByText("Anything else?")).toBeNull();
    expect(screen.getByText("Listening")).toBeTruthy();
  });
});

describe("the glide when what she shows opens and closes", () => {
  /** The room at 1280×800, where the orb is with the panel closed and open (at 100%). */
  const ROOM: Box = { left: 0, top: 0, width: 1280, height: 800 };
  const ORB: Box = { left: 450, top: 120, width: 380, height: 380 };
  const ORB_ASIDE: Box = { left: 106, top: 180, width: 240, height: 240 };
  const PANEL: Box = { left: 484, top: 60, width: 768, height: 704 };

  interface Started {
    readonly el: Element;
    readonly frames: Keyframe[];
    readonly options: KeyframeAnimationOptions;
    finish(): void;
  }

  /** Lays the room out at `zoom` and records every animation started. */
  function fakeLayout(zoom: number): Started[] {
    const started: Started[] = [];
    document.documentElement.style.setProperty("--zoom", String(zoom));
    const at = (b: Box): DOMRect =>
      new DOMRect(b.left * zoom, b.top * zoom, b.width * zoom, b.height * zoom);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const open = this.closest(".voice-mode")?.getAttribute("data-panel") === "open";
      if (this.classList.contains("voice-mode")) return at(ROOM);
      if (this.classList.contains("voice-stage")) return at(open ? ORB_ASIDE : ORB);
      if (this.classList.contains("voice-show")) return at(PANEL);
      return new DOMRect(0, 0, 0, 0);
    });
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      writable: true,
      value: function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
        const done: (() => void)[] = [];
        started.push({ el: this, frames, options, finish: () => done.forEach((f) => f()) });
        return {
          cancel: vi.fn(),
          addEventListener: (type: string, f: () => void) => {
            if (type === "finish") done.push(f);
          },
        };
      },
    });
    return started;
  }

  function reduceMotion(reduce: boolean): void {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: reduce && media.includes("reduce"),
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  }

  /** Opens the panel on a listening call, then closes it; what started each time. */
  function openThenClose(): { opened: Started[]; closed: Started[]; all: Started[] } {
    const all = fakeLayout(1);
    set({ phase: "listening" });
    const { rerender } = render(<VoiceMode />);
    set({ shown: REPORT });
    rerender(<VoiceMode />);
    const opened = [...all];
    set({ shown: null });
    rerender(<VoiceMode />);
    return { opened, closed: all.slice(opened.length), all };
  }

  it("glides the orb aside as the panel opens, and back as it slides away", () => {
    reduceMotion(false);
    const { opened, closed } = openThenClose();
    const stage = document.querySelector(".voice-stage");
    expect(opened.map((a) => [a.el, a.frames[0]?.transform, a.options])).toEqual([
      [
        stage,
        "translate(344px, -60px) scale(1.5833, 1.5833)",
        { duration: 420, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      ],
    ]);
    // Closing: the panel keeps its place while it slides away and fades, and
    // the orb glides back to the middle.
    const panel = screen.getByRole("region", { hidden: true });
    expect(panel.hasAttribute("data-leaving")).toBe(true);
    expect(panel.hasAttribute("inert")).toBe(true);
    expect([panel.style.left, panel.style.top, panel.style.width, panel.style.height]).toEqual([
      "484px",
      "60px",
      "768px",
      "704px",
    ]);
    const [leave, back] = closed;
    expect(leave?.el).toBe(panel);
    expect(leave?.frames[1]).toEqual({ opacity: 0, transform: "translateX(24px)" });
    expect(leave?.options).toMatchObject({ duration: 320, fill: "forwards" });
    expect(back?.el).toBe(stage);
    expect(back?.frames[0]?.transform).toBe("translate(-344px, 60px) scale(0.6316, 0.6316)");
    act(() => leave?.finish());
    expect(screen.queryByRole("region", { hidden: true })).toBeNull();
  });

  it("moves the orb by the page's own pixels when the page is zoomed", () => {
    reduceMotion(false);
    const started = fakeLayout(1.2);
    set({ phase: "listening" });
    const { rerender } = render(<VoiceMode />);
    set({ shown: REPORT });
    rerender(<VoiceMode />);
    // The same move as at 100%: the zoom scales it, so it lands where the orb goes.
    expect(started.map((a) => a.frames[0]?.transform)).toEqual([
      "translate(344px, -60px) scale(1.5833, 1.5833)",
    ]);
  });

  it("doesn't move anything when motion is reduced: the layout just switches", () => {
    reduceMotion(true);
    const { all } = openThenClose();
    expect(all).toEqual([]);
    expect(screen.queryByRole("region", { hidden: true })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Talking to Kleio" }).dataset.panel).toBe("closed");
  });
});

describe("latestCaption", () => {
  const state = (lines: CallState["lines"]): CallState => ({
    phase: "listening",
    lines,
    muted: false,
    error: null,
    shown: null,
  });

  it("prefers her words as she says them, else whoever spoke last", () => {
    const s = state([
      { who: "kleio", text: "Morning." },
      { who: "you", text: "Anything new?" },
    ]);
    expect(latestCaption(s, [])).toEqual({ who: "you", text: "Anything new?" });
    expect(latestCaption(s, [{ who: "kleio", text: "Chef finished." }])).toEqual({
      who: "kleio",
      text: "Chef finished.",
    });
    expect(latestCaption(state([]), [])).toBeNull();
  });

  it("keeps the newest words of a long reply, from a word boundary", () => {
    const long = `${"word ".repeat(120)}the end.`;
    const shown = latestCaption(state([]), [{ who: "kleio", text: long }]);
    expect(shown?.text.endsWith("the end.")).toBe(true);
    expect(shown?.text.startsWith("word")).toBe(true);
    expect(shown?.text.length).toBeLessThanOrEqual(360);
  });
});

describe("what she shows, full size", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const DECK_ID = "sh_fedcba9876543210fedcba9876543210";
  const PAGE = "https://en.wikipedia.org/wiki/Clio";
  /** A specialist's PDF: one the app can also open in its app or save. */
  const DECK: Shown = {
    key: 2,
    title: "deck.pdf",
    whose: "Chef",
    show: { id: DECK_ID, kind: "pdf", name: "deck.pdf", state: "ready", pages: 3, totalPages: 3 },
    url: null,
    problem: null,
    file: { owner: { kind: "blob", blobId: "b1" }, path: "out/deck.pdf" },
  };
  const WIKI: Shown = {
    key: 3,
    title: "en.wikipedia.org",
    whose: "en.wikipedia.org",
    show: {
      id: "sh_00112233445566778899aabbccddeeff",
      kind: "web",
      name: "en.wikipedia.org",
      host: "en.wikipedia.org",
      state: "ready",
      title: "Clio - Wikipedia",
    },
    url: PAGE,
    problem: null,
    file: null,
  };

  beforeEach(() => {
    // jsdom has no blob: URLs.
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:k/1" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  });
  afterEach(() => {
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  /** The voice screen in the app, under the file viewer's provider (main.tsx). */
  const inApp = (): React.ReactElement => (
    <FileViewerProvider>
      <VoiceMode />
    </FileViewerProvider>
  );
  const viewer = (name: string): Promise<HTMLElement> => screen.findByRole("dialog", { name });
  const fullSize = (): HTMLElement => screen.getByRole("button", { name: "Full size" });

  it("opens it over the call as the same show, never made again, and the call goes on", async () => {
    api.getShowPart.mockResolvedValue(new TextEncoder().encode("# Q3\n\nSales rose by a tenth."));
    set({ phase: "speaking", shown: REPORT });
    render(inApp());
    expect(await screen.findByRole("heading", { name: "Q3" })).toBeTruthy();
    fireEvent.click(fullSize());
    const dialog = await viewer("Q3 report.md");
    expect(await within(dialog).findByRole("heading", { name: "Q3" })).toBeTruthy();
    expect(api.getShowPart.mock.calls).toEqual([
      [REPORT.show?.id, "text"],
      [REPORT.show?.id, "text"],
    ]);
    expect(api.createFileShow).not.toHaveBeenCalled();
    // Kleio's own file: nothing to open in an app or save from here.
    expect(within(dialog).queryByRole("button", { name: "Open in app" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Talking to Kleio" })).toBeTruthy();
    expect(call.closeShown).not.toHaveBeenCalled();
    expect(call.endCall).not.toHaveBeenCalled();
  });

  it("opens from a click on her document, but not from a link in it", async () => {
    api.getShowPart.mockResolvedValue(
      new TextEncoder().encode("# Q3\n\nSee [the figures](https://example.com/q3)."),
    );
    set({ phase: "listening", shown: REPORT });
    render(inApp());
    fireEvent.click(await screen.findByRole("link", { name: "the figures" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/q3");
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Q3 report.md" })).toBeNull();
    fireEvent.click(screen.getByRole("heading", { name: "Q3" }));
    expect(await viewer("Q3 report.md")).toBeTruthy();
  });

  it("opens a PDF at the page tapped, scrolled to it, with Open in app for a specialist's", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.page ? (Number(this.dataset.page) - 1) * 1_100 : 0;
    });
    set({ phase: "listening", shown: DECK });
    render(inApp());
    const panel = screen.getByRole("region", { name: "deck.pdf" });
    fireEvent.click(await within(panel).findByRole("img", { name: "Page 2 of 3" }));
    const dialog = await viewer("deck.pdf");
    expect(dialog.querySelector(".voice-show-at")?.textContent).toBe("Page 2 of 3");
    expect(dialog.querySelector(".file-viewer-body")?.scrollTop).toBe(1_100 - 16);
    expect(within(dialog).getByRole("button", { name: "Open in app" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save a copy" })).toBeTruthy();
    expect(api.createFileShow).not.toHaveBeenCalled();
  });

  it("opens a web page's picture, the page itself a click away in the browser", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    set({ phase: "listening", shown: WIKI });
    render(inApp());
    fireEvent.click(await screen.findByRole("img", { name: "The page at en.wikipedia.org" }));
    const dialog = await viewer("Clio - Wikipedia");
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open in browser" }));
    expect(openUrl).toHaveBeenCalledWith(PAGE);
  });

  it("closes on Esc, leaving what she's showing and the call", async () => {
    set({ phase: "listening", shown: REPORT });
    render(inApp());
    const opener = fullSize();
    opener.focus();
    fireEvent.click(opener);
    const dialog = await viewer("Q3 report.md");
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Q3 report.md" })).toBeNull();
    expect(screen.getByRole("region", { name: "Q3 report.md" })).toBeTruthy();
    expect(call.closeShown).not.toHaveBeenCalled();
    expect(call.resetCall).not.toHaveBeenCalled();
    expect(call.endCall).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    // The next Esc closes what she's showing, as ever.
    fireEvent.keyDown(opener, { key: "Escape" });
    expect(call.closeShown).toHaveBeenCalledTimes(1);
  });

  it("closes when she takes it down or shows something else, focus back in the room", async () => {
    set({ phase: "listening", shown: REPORT });
    const { rerender } = render(inApp());
    const hangUp = screen.getByRole("button", { name: "Hang up" });
    fullSize().focus();
    fireEvent.click(fullSize());
    expect(await viewer("Q3 report.md")).toBeTruthy();
    set({ shown: null });
    rerender(inApp());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Q3 report.md" })).toBeNull());
    expect(document.activeElement).toBe(hangUp);

    set({ shown: REPORT });
    rerender(inApp());
    fullSize().focus();
    fireEvent.click(fullSize());
    expect(await viewer("Q3 report.md")).toBeTruthy();
    set({ shown: DECK });
    rerender(inApp());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Q3 report.md" })).toBeNull());
    expect(screen.getByRole("region", { name: "deck.pdf" })).toBeTruthy();
    expect(document.activeElement).toBe(hangUp);
  });

  it("closes when the voice screen does", async () => {
    set({ phase: "listening", shown: REPORT });
    const { rerender } = render(inApp());
    fireEvent.click(fullSize());
    expect(await viewer("Q3 report.md")).toBeTruthy();
    set({ phase: "idle", shown: null });
    rerender(inApp());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
