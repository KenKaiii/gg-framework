// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipLayer } from "../TooltipLayer";
import type * as KleioApi from "./kleioApi";
import { KleioApiError, type ShowInfo } from "./kleioApi";
import type * as KleioFiles from "./kleioFiles";
import type { FileOwner } from "./kleioFiles";
import phoneCss from "./kleio-phone.css?raw";
import themeCss from "./kleio-theme.css?raw";
import type { Shown } from "./voiceTools";

const api = vi.hoisted(() => ({ createFileShow: vi.fn(), getShowPart: vi.fn() }));
vi.mock("./kleioApi", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioApi>()),
  createFileShow: api.createFileShow,
  getShowPart: api.getShowPart,
}));
const files = vi.hoisted(() => ({ openFile: vi.fn(), saveFile: vi.fn(), openSite: vi.fn() }));
vi.mock("./kleioFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioFiles>()),
  openFile: files.openFile,
  saveFile: files.saveFile,
  openSite: files.openSite,
}));
// useOpenFile opens a file in its app or a page in the browser from here.
vi.mock("./fileOpen", () => ({ openFile: files.openFile, openSite: files.openSite }));
vi.mock("../agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));

const { FileViewerProvider } = await import("./FileViewerProvider");
const { useOpenFile } = await import("./viewerContext");
const { FileViewer } = await import("./FileViewer");
const { SHOW_KIT } = await import("./ShowViews");

const ID = "sh_0123456789abcdef0123456789abcdef";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const SESSION: FileOwner = { kind: "workspace", cwd: "/Users/me/kleio-projects/app" };
const SPECIALIST: FileOwner = { kind: "blob", blobId: "b_1234abcd" };
const MEMBER: FileOwner = { kind: "group", groupId: "g_00ff00ff", blobId: "b_1234abcd" };

function info(show: Partial<ShowInfo> & Pick<ShowInfo, "kind" | "name">): ShowInfo {
  return { id: ID, state: "ready", ...show };
}

/** A button that opens `path` the way a chat's link or card does. */
function Opener({
  owner,
  path,
  label,
}: {
  owner: FileOwner;
  path: string;
  label?: string;
}): React.ReactElement {
  const open = useOpenFile();
  return (
    <button type="button" onClick={() => void open(owner, path, label)}>
      Open {path}
    </button>
  );
}

/** Opens `path` from a focused button, as a click on a link would, and waits for the viewer. */
async function openViewer(owner: FileOwner, path: string, label?: string): Promise<HTMLElement> {
  render(
    <FileViewerProvider>
      <Opener owner={owner} path={path} label={label} />
    </FileViewerProvider>,
  );
  const opener = screen.getByRole("button", { name: `Open ${path}` });
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole("dialog");
}

/** The header's page counter (a waiting page has the same words, for screen readers). */
const counter = (): string | null | undefined =>
  document.querySelector(".file-viewer .voice-show-at")?.textContent;

const body = (dialog: HTMLElement): HTMLElement => {
  const el = dialog.querySelector<HTMLElement>(".file-viewer-body");
  if (!el) throw new Error("no body");
  return el;
};

beforeEach(() => {
  // jsdom has no blob: URLs.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:kleio/1",
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  files.openFile.mockResolvedValue(undefined);
  files.openSite.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  Reflect.deleteProperty(document, "startViewTransition");
  document.documentElement.classList.remove("platform-ios");
  document.head.querySelectorAll("style[data-test]").forEach((s) => s.remove());
});

describe("FileViewer, a dialog", () => {
  beforeEach(() => {
    api.createFileShow.mockResolvedValue(
      info({ kind: "text", name: "notes.md", format: "markdown" }),
    );
    api.getShowPart.mockResolvedValue(text("# Notes\n\nNothing to click."));
  });

  it("is a modal dialog named by the file, focus in on its body and back to the opener", async () => {
    const dialog = await openViewer(SESSION, "out/notes.md");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: "notes.md" })).toBe(dialog);
    expect(api.createFileShow).toHaveBeenCalledWith({
      source: "workspace",
      cwd: SESSION.cwd,
      path: "out/notes.md",
    });
    // Focus starts in its body, so the keys scroll it straight away.
    expect(document.activeElement).toBe(body(dialog));
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy();
    // Tab and Shift+Tab stay inside.
    fireEvent.keyDown(body(dialog), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open in app" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Open in app" }), {
      key: "Tab",
      shiftKey: true,
    });
    expect(document.activeElement).toBe(body(dialog));
    fireEvent.click(screen.getByRole("button", { name: "Close notes.md" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open out/notes.md" }));
  });

  it("closes on Esc and stops it there, so nothing beneath hears it", async () => {
    const beneath = vi.fn();
    window.addEventListener("keydown", beneath);
    document.addEventListener("keydown", beneath);
    try {
      const dialog = await openViewer(SESSION, "out/notes.md");
      fireEvent.keyDown(body(dialog), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(beneath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", beneath);
      document.removeEventListener("keydown", beneath);
    }
  });

  it("leaves an Esc that dismisses a keyboard tooltip to the tooltip, as every modal does", async () => {
    render(<TooltipLayer />);
    const dialog = await openViewer(SESSION, "out/notes.md");
    const close = screen.getByRole("button", { name: "Close notes.md" });
    fireEvent.keyDown(close, { key: "Tab" });
    act(() => close.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("Close (Esc)");
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("glides out as a modal does, unless motion is reduced", async () => {
    const start = vi.fn((update: () => void) => {
      update();
      const done = Promise.resolve();
      return { ready: done, finished: done, updateCallbackDone: done, skipTransition() {} };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    const motion = (reduce: boolean): void => {
      vi.stubGlobal("matchMedia", (media: string) => ({
        matches: reduce && media.includes("reduce"),
        media,
        addEventListener() {},
        removeEventListener() {},
      }));
    };
    motion(false);
    await openViewer(SESSION, "out/notes.md");
    fireEvent.click(screen.getByRole("button", { name: "Close notes.md" }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    motion(true);
    await openViewer(SESSION, "out/notes.md");
    fireEvent.click(screen.getByRole("button", { name: "Close notes.md" }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fills the window less a margin on the desktop, and the whole screen on the iPhone", async () => {
    const style = document.createElement("style");
    style.dataset.test = "";
    style.textContent = `${themeCss}\n${phoneCss}`;
    document.head.append(style);
    const dialog = await openViewer(SESSION, "out/notes.md");
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("no backdrop");
    expect(getComputedStyle(dialog).borderRadius).toBe("18px");
    expect(getComputedStyle(backdrop).paddingTop).toBe("32px");
    document.documentElement.classList.add("platform-ios");
    expect(getComputedStyle(dialog).borderRadius).toBe("0px");
    expect(getComputedStyle(dialog).width).toBe("100%");
    expect(getComputedStyle(backdrop).paddingTop).toBe("0px");
    // Its actions are 44 pt icons, still named for VoiceOver.
    const save = screen.getByRole("button", { name: "Save a copy" });
    expect(getComputedStyle(save).minHeight).toBe("44px");
    const label = save.querySelector(".file-viewer-action-label");
    expect(label && getComputedStyle(label).position).toBe("absolute");
  });
});

describe("FileViewer, while it opens and when it can't", () => {
  it("says it's opening while the host readies the file", async () => {
    api.createFileShow.mockReturnValue(new Promise(() => {}));
    const dialog = await openViewer(SPECIALIST, "findings.pdf", "The findings");
    expect(screen.getByRole("dialog", { name: "The findings" })).toBe(dialog);
    const waiting = within(dialog).getByText("Opening…");
    expect(waiting.closest("[role='status']")).toBeTruthy();
    expect(api.createFileShow).toHaveBeenCalledWith({
      source: "specialist",
      id: "b_1234abcd",
      path: "findings.pdf",
    });
    // Open in app and Save a copy are there already.
    expect(screen.getByRole("button", { name: "Open in app" })).toBeTruthy();
  });

  it("asks for an update when the host is older than the viewer, and still opens the file in its app", async () => {
    api.createFileShow.mockRejectedValue(new KleioApiError(400, "bad_request"));
    await openViewer(SESSION, "out/notes.md");
    expect(
      await screen.findByText("Update your host to view coding-session files here."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(files.openFile).toHaveBeenCalledWith(SESSION, "out/notes.md", expect.any(Function));
    cleanup();
    // A host from before shows at all.
    api.createFileShow.mockRejectedValue(new KleioApiError(404, "not found"));
    await openViewer(SPECIALIST, "notes.md");
    expect(await screen.findByText("Update your host to view files here.")).toBeTruthy();
  });

  it("says why the host didn't show it: gone, too big, or a kind it can't draw", async () => {
    const cases: [KleioApiError, string][] = [
      [new KleioApiError(404, "not_found"), "Kleio couldn't find that file on your host."],
      [
        new KleioApiError(413, "too_large", "That file is too big to show."),
        "That file is too big to show.",
      ],
      [
        new KleioApiError(415, "unsupported", "Kleio can't show this kind of file yet."),
        "Kleio can't show this kind of file yet.",
      ],
    ];
    for (const [e, said] of cases) {
      api.createFileShow.mockRejectedValue(e);
      await openViewer(SPECIALIST, "notes.md");
      expect(await screen.findByText(said)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Open in app" })).toBeTruthy();
      cleanup();
    }
  });
});

describe("FileViewer, a CSV", () => {
  beforeEach(() => {
    api.createFileShow.mockResolvedValue(info({ kind: "text", name: "team.csv", format: "plain" }));
  });

  it("draws a small CSV as a table with header cells", async () => {
    api.getShowPart.mockResolvedValue(text('name,score\nAda,3\n"Cy, Jr.",5'));
    await openViewer(MEMBER, "out/team.csv");
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["name", "score"]);
    expect(
      within(table)
        .getAllByRole("cell")
        .map((td) => td.textContent),
    ).toEqual(["Ada", "3", "Cy, Jr.", "5"]);
    expect(screen.getByRole("region", { name: "team.csv, as a table" })).toBeTruthy();
    expect(api.createFileShow).toHaveBeenCalledWith({
      source: "group",
      id: "g_00ff00ff",
      member: "b_1234abcd",
      path: "out/team.csv",
    });
  });

  it("shows a CSV too big for a table as its text, and says so", async () => {
    const big = ["n", ...Array.from({ length: 1001 }, (_, i) => String(i))].join("\n");
    api.getShowPart.mockResolvedValue(text(big));
    await openViewer(SESSION, "out/team.csv");
    expect(await screen.findByText("Shown as text: it's too big for a table.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".voice-show-pre")?.textContent).toBe(big);
  });
});

describe("FileViewer, its actions", () => {
  beforeEach(() => {
    api.createFileShow.mockResolvedValue(
      info({ kind: "pdf", name: "findings.pdf", pages: 3, totalPages: 3 }),
    );
    api.getShowPart.mockResolvedValue(PNG);
  });

  it("opens the file in its app and saves a copy, saying how it went", async () => {
    await openViewer(SPECIALIST, "findings.pdf");
    await vi.waitFor(() => expect(counter()).toBe("Page 1 of 3"));
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(files.openFile).toHaveBeenCalledWith(SPECIALIST, "findings.pdf", expect.any(Function));
    files.saveFile.mockResolvedValueOnce(true);
    fireEvent.click(await screen.findByRole("button", { name: "Save a copy" }));
    expect(files.saveFile).toHaveBeenCalledWith(SPECIALIST, "findings.pdf", expect.any(Function));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(screen.getByText("Saved.").getAttribute("role")).toBe("status");
    files.saveFile.mockRejectedValueOnce(new Error("no such file"));
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    expect(await screen.findByText("This file isn't on your host any more.")).toBeTruthy();
  });

  it("says how the download goes when the file isn't here yet", async () => {
    await openViewer(SPECIALIST, "findings.pdf");
    await vi.waitFor(() => expect(counter()).toBe("Page 1 of 3"));
    let done: () => void = () => {};
    files.openFile.mockImplementationOnce(
      (_owner: FileOwner, _path: string, progress: (p: KleioFiles.DownloadProgress) => void) => {
        progress({ received: 3 * 1024 * 1024, total: 9 * 1024 * 1024, secondsLeft: 70 });
        return new Promise<void>((resolve) => {
          done = resolve;
        });
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(
      await screen.findByText("Downloading… 3.0 MB of 9.0 MB, about a minute left"),
    ).toBeTruthy();
    await act(async () => done());
    expect(screen.queryByText(/Downloading…/)).toBeNull();
  });

  it("opens a show from the call as it is, at its page, without asking the host again", async () => {
    const shown: Shown = {
      key: 4,
      title: "slides.pdf",
      whose: "Chef",
      show: info({ kind: "pdf", name: "slides.pdf", pages: 3, totalPages: 9 }),
      url: null,
      problem: null,
      file: null,
    };
    render(
      <FileViewer
        request={{ kind: "shown", shown, page: 2, file: null }}
        kit={SHOW_KIT}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "slides.pdf" })).toBeTruthy();
    expect(screen.getByText("Chef")).toBeTruthy();
    expect(counter()).toBe("Page 2 of 9");
    expect(await screen.findByRole("img", { name: "Page 2 of 9" })).toBeTruthy();
    expect(api.createFileShow).not.toHaveBeenCalled();
    expect(api.getShowPart).toHaveBeenCalledWith(ID, "page-2");
    // Kleio's own file: nothing to open in an app or save from here.
    expect(screen.queryByRole("button", { name: "Open in app" })).toBeNull();
  });

  it("offers a web page in the browser instead", async () => {
    const shown: Shown = {
      key: 5,
      title: "example.com",
      whose: "example.com",
      show: info({ kind: "web", name: "example.com", host: "example.com" }),
      url: "https://example.com/news",
      problem: null,
      file: null,
    };
    render(
      <FileViewer
        request={{ kind: "shown", shown, file: null }}
        kit={SHOW_KIT}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Open in browser" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in app" })).toBeNull();
    // The page's picture, drawn from the show as it is.
    const shot = await screen.findByRole("button", { name: "Open example.com in your browser" });
    expect(shot.querySelector("img")?.getAttribute("src")).toBe("blob:kleio/1");
    expect(api.getShowPart).toHaveBeenCalledWith(ID, "image");
  });
});

describe("useOpenFile", () => {
  it("sends a web page to the browser and a kind the viewer doesn't draw to its app", async () => {
    render(
      <FileViewerProvider>
        <Opener owner={SESSION} path="site/index.html" />
        <Opener owner={SESSION} path="out/report.docx" />
      </FileViewerProvider>,
    );
    // One click at a time: vitest's mocker can hand two dynamic imports of a
    // mocked module, made in the same tick, different copies.
    fireEvent.click(screen.getByRole("button", { name: "Open site/index.html" }));
    await vi.waitFor(() => expect(files.openSite).toHaveBeenCalledWith(SESSION, "site/index.html"));
    fireEvent.click(screen.getByRole("button", { name: "Open out/report.docx" }));
    await vi.waitFor(() => expect(files.openFile).toHaveBeenCalledWith(SESSION, "out/report.docx"));
    expect(files.openSite).toHaveBeenCalledTimes(1);
    expect(files.openFile).toHaveBeenCalledTimes(1);
    expect(api.createFileShow).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens every file in its app outside the viewer's provider, as before", async () => {
    render(<Opener owner={SPECIALIST} path="notes.md" />);
    fireEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
    await vi.waitFor(() => expect(files.openFile).toHaveBeenCalledWith(SPECIALIST, "notes.md"));
    expect(api.createFileShow).not.toHaveBeenCalled();
  });
});
