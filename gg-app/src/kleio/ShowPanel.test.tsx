// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { openProjectPath, openUrl } from "../agent";
import type * as KleioApi from "./kleioApi";
import { KleioApiError, type ShowInfo } from "./kleioApi";
import type { Shown } from "./voiceTools";

const api = vi.hoisted(() => ({ getShowPart: vi.fn() }));
vi.mock("./kleioApi", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioApi>()),
  getShowPart: api.getShowPart,
}));
vi.mock("../agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(async () => {}),
  sendPrompt: vi.fn(),
}));

const { ShowPanel, pictureType, showHeadline } = await import("./ShowPanel");

const ID = "sh_0123456789abcdef0123456789abcdef";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
const PAGE = "https://en.wikipedia.org/wiki/Clio";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A file she shows. */
function file(show: Partial<ShowInfo> & Pick<ShowInfo, "kind">, title = "plan.md"): Shown {
  return {
    key: 1,
    title,
    whose: "Chef",
    show: { id: ID, name: title, state: "ready", ...show },
    url: null,
    problem: null,
    file: null,
  };
}

/** A web page (or an online PDF) she shows. */
function page(show: Partial<ShowInfo>): Shown {
  return {
    key: 2,
    title: "en.wikipedia.org",
    whose: "en.wikipedia.org",
    show: {
      id: ID,
      kind: "web",
      name: "en.wikipedia.org",
      host: "en.wikipedia.org",
      state: "ready",
      ...show,
    },
    url: PAGE,
    problem: null,
    file: null,
  };
}

/** One that never came: why, as voiceTools says it. */
function trouble(problem: NonNullable<Shown["problem"]>, url: string | null): Shown {
  return {
    key: 3,
    title: url ? "en.wikipedia.org" : "slides.pdf",
    whose: "Kleio",
    show: null,
    url,
    problem,
    file: null,
  };
}

/** The blob: URLs made and let go, reset for each test. */
const urls = { made: [] as Blob[], let: [] as string[] };

beforeEach(() => {
  urls.made = [];
  urls.let = [];
  // jsdom has no blob: URLs.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (b: Blob) => {
      urls.made.push(b);
      return `blob:kleio/${urls.made.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (u: string) => urls.let.push(u),
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

function panel(shown: Shown, onClose = vi.fn()): ReturnType<typeof render> {
  return render(<ShowPanel shown={shown} onClose={onClose} />);
}

const openButtons = (): HTMLElement[] => screen.queryAllByRole("button", { name: /^Open/ });

describe("ShowPanel, a document", () => {
  it("draws Markdown, its links opening only as web pages in the browser", async () => {
    api.getShowPart.mockResolvedValue(
      text(
        "# The plan\n\nSee [the site](https://example.com/a), [the notes](notes/x.md), [mail](mailto:a@b.c) and [top](#top).",
      ),
    );
    panel(file({ kind: "text", format: "markdown" }));
    // Drawn as soon as its text arrives, with no module left to load (a lazy
    // Markdown kept a cold test runner on "Loading…" past findBy's wait).
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "The plan" })).toBeTruthy();
    expect(api.getShowPart).toHaveBeenCalledWith(ID, "text");
    fireEvent.click(screen.getByRole("link", { name: "the site" }));
    expect(vi.mocked(openUrl).mock.calls).toEqual([["https://example.com/a"]]);
    // Never a project path, another app, or this window's own address.
    for (const name of ["the notes", "mail", "top"]) {
      const link = screen.getByRole("link", { name });
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented, name).toBe(true);
    }
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openProjectPath).not.toHaveBeenCalled();
  });

  it("draws plain text as it is, and says when only its start is shown", async () => {
    api.getShowPart.mockResolvedValue(text("name,total\nChef,12\n"));
    const { container } = panel(file({ kind: "text", format: "plain", cut: true }, "totals.csv"));
    expect(await screen.findByText("Only the start of this file is shown.")).toBeTruthy();
    expect(container.querySelector("pre")?.textContent).toBe("name,total\nChef,12\n");
  });

  it("says when a file is empty", async () => {
    api.getShowPart.mockResolvedValue(text("  \n"));
    panel(file({ kind: "text", format: "plain" }, "empty.txt"));
    expect(await screen.findByText("This file is empty.")).toBeTruthy();
  });
});

describe("ShowPanel, a picture", () => {
  it("draws it from its bytes, and lets them go when it closes", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    const { unmount } = panel(file({ kind: "image" }, "logo.png"));
    const img = await screen.findByRole("img", { name: "logo.png" });
    expect(img.getAttribute("src")).toBe("blob:kleio/1");
    expect(api.getShowPart).toHaveBeenCalledWith(ID, "image");
    expect(urls.made.map((b) => b.type)).toEqual(["image/png"]);
    unmount();
    expect(urls.let).toEqual(["blob:kleio/1"]);
  });

  it("never draws bytes that aren't a picture it knows, whatever the file says", async () => {
    api.getShowPart.mockResolvedValue(SVG);
    panel(file({ kind: "image" }, "logo.png"));
    expect(await screen.findByText("That isn't a picture Kleio can show.")).toBeTruthy();
    expect(urls.made).toEqual([]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("knows a picture by how it starts", () => {
    const of = (...b: number[]): Uint8Array => new Uint8Array(b);
    const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
    expect(pictureType(PNG)).toBe("image/png");
    expect(pictureType(of(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(pictureType(of(...ascii("GIF89a"), 1, 0))).toBe("image/gif");
    expect(pictureType(of(...ascii("GIF87a")))).toBe("image/gif");
    expect(pictureType(of(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")))).toBe("image/webp");
    expect(pictureType(of(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")))).toBeNull();
    expect(pictureType(SVG)).toBeNull();
    expect(pictureType(text("%PDF-1.7"))).toBeNull();
    expect(pictureType(of(0x89, 0x50, 0x4e))).toBeNull();
    expect(pictureType(of())).toBeNull();
  });
});

describe("ShowPanel, a PDF", () => {
  it("draws its pages, saying which one is being read and how many it has", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    const { container } = panel(file({ kind: "pdf", pages: 3, totalPages: 120 }, "deck.pdf"));
    expect(await screen.findByRole("img", { name: "Page 3 of 120" })).toBeTruthy();
    expect(api.getShowPart.mock.calls).toEqual([
      [ID, "page-1"],
      [ID, "page-2"],
      [ID, "page-3"],
    ]);
    expect(screen.getByText("Page 1 of 120")).toBeTruthy();
    expect(screen.getByText("Only the first 3 of its 120 pages are shown.")).toBeTruthy();
    // Scrolled so the second page's top is a third of the way down.
    const body = container.querySelector<HTMLElement>(".voice-show-body");
    if (!body) throw new Error("no body");
    for (const slot of container.querySelectorAll<HTMLElement>("[data-page]")) {
      const top = (Number(slot.dataset.page) - 1) * 1_100;
      Object.defineProperty(slot, "offsetTop", { configurable: true, value: top });
    }
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 800 });
    body.scrollTop = 900;
    fireEvent.scroll(body);
    expect(screen.getByText("Page 2 of 120")).toBeTruthy();
  });

  it("fetches a page only as it comes near", () => {
    const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    const watched: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          seen.push(cb);
        }
        observe(el: Element): void {
          watched.push(el);
        }
        disconnect(): void {}
      },
    );
    api.getShowPart.mockReturnValue(new Promise(() => {}));
    panel(file({ kind: "pdf", pages: 12, totalPages: 12 }, "deck.pdf"));
    expect(watched).toHaveLength(12);
    expect(api.getShowPart).not.toHaveBeenCalled();
    act(() => seen[1]?.([{ isIntersecting: true }]));
    expect(api.getShowPart.mock.calls).toEqual([[ID, "page-2"]]);
  });
});

describe("ShowPanel, a web page", () => {
  it("says it's loading while the host draws it", () => {
    panel(page({ state: "capturing" }));
    expect(screen.getByRole("status").textContent).toBe("Loading en.wikipedia.org…");
    expect(api.getShowPart).not.toHaveBeenCalled();
  });

  it("shows a picture of the page that opens the page itself when tapped", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    panel(page({ title: "Clio - Wikipedia" }));
    const shot = await screen.findByRole("button", {
      name: "Open en.wikipedia.org in your browser",
    });
    expect(screen.getByRole("region", { name: "Clio - Wikipedia" }).textContent).toContain(
      "en.wikipedia.org",
    );
    fireEvent.click(shot);
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(vi.mocked(openUrl).mock.calls).toEqual([[PAGE], [PAGE]]);
    expect(screen.queryByText(/sign in or subscribe/)).toBeNull();
  });

  it("says when a page asks you to sign in, and when it goes on below", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    panel(page({ signIn: true, cut: true }));
    expect(
      await screen.findByText(
        "This page asks you to sign in or subscribe, so this is what a visitor sees. Open it in your browser to see yours.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("The page goes on. Open it in your browser to see the rest."),
    ).toBeTruthy();
  });

  it("says why it failed, offering the link, but never for a private address", () => {
    const { unmount } = panel(
      page({ state: "failed", reason: "timeout", detail: "en.wikipedia.org took too long." }),
    );
    expect(screen.getByText("en.wikipedia.org took too long.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(openUrl).toHaveBeenCalledWith(PAGE);
    unmount();
    panel(page({ state: "failed", reason: "refused", detail: "That's a private address." }));
    expect(screen.getByText("That's a private address.")).toBeTruthy();
    expect(openButtons()).toEqual([]);
    cleanup();
    panel(trouble({ kind: "refused", text: "That's a private address." }, "http://10.0.0.1/"));
    expect(screen.getByText("That's a private address.")).toBeTruthy();
    expect(openButtons()).toEqual([]);
  });

  it("offers only a web address it can open", () => {
    panel({ ...page({ state: "failed", detail: "Nope." }), url: "javascript:alert(1)" });
    expect(openButtons()).toEqual([]);
  });
});

describe("ShowPanel, when it can't be shown", () => {
  it("says the host can't draw pages or PDFs, offering the link", () => {
    panel(trouble({ kind: "unavailable" }, PAGE));
    expect(screen.getByText("Kleio can't show web pages or PDFs on this host.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(openUrl).toHaveBeenCalledWith(PAGE);
    cleanup();
    panel(trouble({ kind: "unavailable" }, null));
    expect(screen.getByText("Kleio can't show web pages or PDFs on this host.")).toBeTruthy();
    expect(openButtons()).toEqual([]);
  });

  it("says the host needs updating", () => {
    panel(trouble({ kind: "outdated" }, PAGE));
    expect(screen.getByText("Update your host to show web pages and PDFs.")).toBeTruthy();
    expect(openButtons()).toHaveLength(1);
    cleanup();
    panel(trouble({ kind: "outdated" }, null));
    expect(screen.getByText("Update your host to show files here.")).toBeTruthy();
  });

  it("says what the host said for anything else", () => {
    panel(trouble({ kind: "failed", text: "Kleio can't show this kind of file yet." }, null));
    expect(screen.getByText("Kleio can't show this kind of file yet.")).toBeTruthy();
  });

  it("says when what was shown has expired or changed, or the host can't be reached", async () => {
    const cases: [KleioApiError, string][] = [
      [new KleioApiError(410, "expired"), "That has expired. Ask Kleio to show it again."],
      [
        new KleioApiError(409, "changed", "That file has changed since Kleio showed it."),
        "That file has changed since Kleio showed it.",
      ],
      [
        new KleioApiError(0, "unreachable", "error sending request: tcp connect error"),
        "Couldn't reach your host just now.",
      ],
    ];
    for (const [e, words] of cases) {
      api.getShowPart.mockRejectedValueOnce(e);
      panel(file({ kind: "text", format: "markdown" }));
      expect(await screen.findByText(words)).toBeTruthy();
      cleanup();
    }
  });
});

describe("ShowPanel, its header", () => {
  it("names it and whose it is, and × closes it", () => {
    api.getShowPart.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    panel(file({ kind: "text", format: "markdown" }, "Q3 report.md"), onClose);
    const region = screen.getByRole("region", { name: "Q3 report.md" });
    expect(region.textContent).toContain("Chef");
    fireEvent.click(screen.getByRole("button", { name: "Close Q3 report.md" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes by a page's own title under its site, and a file's name", () => {
    expect(showHeadline(page({ title: "Clio - Wikipedia" }))).toEqual({
      title: "Clio - Wikipedia",
      whose: "en.wikipedia.org",
    });
    expect(showHeadline(page({ state: "capturing" }))).toEqual({
      title: "en.wikipedia.org",
      whose: null,
    });
    expect(showHeadline(file({ kind: "pdf", pages: 2, title: "Untitled" }, "deck.pdf"))).toEqual({
      title: "deck.pdf",
      whose: "Chef",
    });
  });

  it("can't be used while it leaves", () => {
    api.getShowPart.mockReturnValue(new Promise(() => {}));
    render(<ShowPanel shown={file({ kind: "image" })} leaving onClose={vi.fn()} />);
    const region = screen.getByRole("region", { hidden: true });
    expect(region.hasAttribute("inert")).toBe(true);
    expect(region.hasAttribute("data-leaving")).toBe(true);
  });
});

describe("ShowPanel, full size", () => {
  /** The panel on a call, where it opens full size in the viewer. */
  function onCall(shown: Shown): ReturnType<typeof vi.fn> {
    const onEnlarge = vi.fn();
    render(<ShowPanel shown={shown} onClose={vi.fn()} onEnlarge={onEnlarge} />);
    return onEnlarge;
  }
  const fullSize = (): HTMLElement | null => screen.queryByRole("button", { name: "Full size" });
  function one(selector: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`no ${selector}`);
    return el;
  }

  it("opens a picture from Full size or a tap on it", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    const onEnlarge = onCall(file({ kind: "image" }, "logo.png"));
    fireEvent.click(await screen.findByRole("img", { name: "logo.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Full size" }));
    expect(onEnlarge.mock.calls).toEqual([[], []]);
  });

  it("opens a PDF at the page tapped, and from Full size at the page being read", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    const onEnlarge = onCall(file({ kind: "pdf", pages: 3, totalPages: 3 }, "deck.pdf"));
    fireEvent.click(await screen.findByRole("img", { name: "Page 3 of 3" }));
    // Between the pages is no page.
    fireEvent.click(one(".voice-show-pages"));
    const body = one(".voice-show-body");
    for (const slot of document.querySelectorAll<HTMLElement>("[data-page]")) {
      const top = (Number(slot.dataset.page) - 1) * 1_100;
      Object.defineProperty(slot, "offsetTop", { configurable: true, value: top });
    }
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 800 });
    body.scrollTop = 900;
    fireEvent.scroll(body);
    fireEvent.click(screen.getByRole("button", { name: "Full size" }));
    expect(onEnlarge.mock.calls).toEqual([[3], [2]]);
  });

  it("opens a web page's picture, the page itself still in the browser from the header", async () => {
    api.getShowPart.mockResolvedValue(PNG);
    const onEnlarge = onCall(page({ title: "Clio - Wikipedia" }));
    fireEvent.click(await screen.findByRole("img", { name: "The page at en.wikipedia.org" }));
    expect(onEnlarge.mock.calls).toEqual([[]]);
    expect(openUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /in your browser/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(vi.mocked(openUrl).mock.calls).toEqual([[PAGE]]);
  });

  it("opens a document from a click on it, not on a link or a button in it, nor on selecting", async () => {
    api.getShowPart.mockResolvedValue(
      text("# The plan\n\nSee [the site](https://example.com/a).\n\n```sh\nmake\n```"),
    );
    const onEnlarge = onCall(file({ kind: "text", format: "markdown" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("link", { name: "the site" }));
    expect(vi.mocked(openUrl).mock.calls).toEqual([["https://example.com/a"]]);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      });
      expect(writeText).toHaveBeenCalledWith("make");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    const heading = screen.getByRole("heading", { name: "The plan" });
    window.getSelection()?.selectAllChildren(heading);
    fireEvent.click(heading);
    expect(onEnlarge).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    fireEvent.click(heading);
    expect(onEnlarge.mock.calls).toEqual([[]]);
  });

  it("isn't offered until it's drawn, when it can't be shown, or off a call", async () => {
    onCall(page({ state: "capturing" }));
    expect(fullSize()).toBeNull();
    cleanup();
    onCall(trouble({ kind: "unavailable" }, PAGE));
    expect(fullSize()).toBeNull();
    cleanup();
    api.getShowPart.mockResolvedValue(PNG);
    panel(file({ kind: "image" }, "logo.png"));
    const img = await screen.findByRole("img", { name: "logo.png" });
    expect(fullSize()).toBeNull();
    expect(img.hasAttribute("data-enlarge")).toBe(false);
  });
});
