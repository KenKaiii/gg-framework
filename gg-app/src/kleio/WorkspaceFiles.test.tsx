// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { openProjectPath } from "../agent";
import { toast } from "../toast";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  // The real one needs the Tauri bridge. This keeps its handler, for a test to call.
  Channel: class {
    onmessage: (message: unknown) => void;
    constructor(onmessage: (message: unknown) => void = () => {}) {
      this.onmessage = onmessage;
    }
  },
}));
vi.mock("../agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));
vi.mock("../toast", () => ({ toast: vi.fn() }));

const { Markdown } = await import("../Markdown");
const { FileViewerProvider } = await import("./FileViewerProvider");
const { WorkspaceFileCards, WorkspaceFilesProvider, useOpenFromHost } =
  await import("./WorkspaceFiles");

const CWD = "/Users/k/kleio-projects/demo";
const OWNER = { kind: "workspace", cwd: CWD } as const;
const REPLY = [
  "Done. Here's the [Quarterly report](report.pdf) and the [Demo site](site/index.html).",
  `I also changed [App.tsx](${CWD}/src/App.tsx).`,
].join("\n\n");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The transcript's shape: the provider around a reply and its cards. */
async function renderReply(cwd: string | null, text = REPLY): Promise<void> {
  await act(async () => {
    render(
      <WorkspaceFilesProvider cwd={cwd}>
        <Markdown>{text}</Markdown>
        <WorkspaceFileCards text={text} />
      </WorkspaceFilesProvider>,
    );
  });
}

describe("Chat/Code outputs when paired to a Mac mini", () => {
  it("shows a card for each output, but none for source files", async () => {
    vi.mocked(invoke).mockResolvedValue({
      name: "report.pdf",
      size: 2048,
      mime: "application/pdf",
      thumbnail: null,
    });
    await renderReply(CWD);
    // The cards load on first use (WorkspaceOutputCards), so wait for them.
    expect(await screen.findByRole("button", { name: "Open report.pdf" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open site index.html" })).toBeTruthy();
    expect(document.querySelectorAll(".kleio-file")).toHaveLength(2);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("kleio_file_fetch", {
        owner: OWNER,
        path: "report.pdf",
        onProgress: expect.anything(),
        auto: true,
      }),
    );
  });

  it("opens a linked output from the mini, and a site through its preview", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await renderReply(CWD, "[Quarterly report](report.pdf) · [Demo site](site/index.html)");
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("link", { name: "Quarterly report" }));
    fireEvent.click(screen.getByRole("link", { name: "Demo site" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenCalledWith("kleio_file_open", { owner: OWNER, path: "report.pdf" });
    expect(invoke).toHaveBeenCalledWith("kleio_site_open", {
      owner: OWNER,
      path: "site/index.html",
    });
    expect(openProjectPath).not.toHaveBeenCalled();
  });

  it("leaves source-file links to the project opener", async () => {
    await renderReply(CWD);
    fireEvent.click(screen.getByRole("link", { name: "App.tsx" }));
    expect(openProjectPath).toHaveBeenCalledWith(`${CWD}/src/App.tsx`);
    expect(invoke).not.toHaveBeenCalledWith("kleio_file_open", expect.anything());
  });

  it("says why a linked output didn't open", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no such workspace"));
    await renderReply(CWD, "[Demo site](site/index.html)");
    fireEvent.click(screen.getByRole("link", { name: "Demo site" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Kleio only opens files from its project folders.",
        "error",
      ),
    );
  });

  // Regression: the London jobs report a Chat session made got no card. The
  // reply (on the Mac mini, 9 Oct 2026) lists it by name under its folder.
  it("shows and opens a report a Chat reply lists under its folder", async () => {
    const cwd = "/Users/willmckie/kleio-projects";
    const reply = [
      "I can't push a file attachment into the iPhone chat from here — the image I viewed only lands in my own context, not on your screen. So I've put everything somewhere you can open it:",
      "",
      "**`~/kleio-projects/job-research/report-2026-10-09/`**",
      "- `london-ai-jobs-2026-10-09.pdf` — the full 6-page report",
      "- `report-p1.png` … `report-p6.png` — each page as an image (p1 = the eight top picks + notes; p2–p6 = the full 175-role table)",
      "",
      "Trying an inline render in case the Kleio client supports it:",
      "",
      "![Page 1 – top picks](/Users/willmckie/kleio-projects/job-research/report-2026-10-09/report-p1.png)",
      "",
      "![Page 2 – all roles](/Users/willmckie/kleio-projects/job-research/report-2026-10-09/report-p2.png)",
      "",
      "If those show as broken links, the quickest route on the phone is Files → Mac mini (over Tailscale) → that folder, or ask the Job hunter agent to resend this morning's PDF the way it normally delivers it. My comparison write-up is alongside it: `~/kleio-projects/job-research/2026-10-09-london-roles-vs-report-picks.md`.",
    ].join("\n");
    const owner = { kind: "workspace", cwd } as const;
    const folder = "job-research/report-2026-10-09";
    vi.mocked(invoke).mockResolvedValue({
      name: "london-ai-jobs-2026-10-09.pdf",
      size: 456453,
      mime: "application/pdf",
      thumbnail: null,
    });
    await renderReply(cwd, reply);

    const open = await screen.findByRole("button", { name: "Open london-ai-jobs-2026-10-09.pdf" });
    const fetched = (): unknown[] =>
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "kleio_file_fetch")
        .map(([, args]) => args);
    await waitFor(() =>
      // Each card's own fetch.
      expect(fetched()).toEqual(
        ["london-ai-jobs-2026-10-09.pdf", "report-p1.png", "report-p6.png"].map((name) => ({
          owner,
          path: `${folder}/${name}`,
          onProgress: expect.anything(),
          auto: true,
        })),
      ),
    );
    vi.mocked(invoke).mockClear();
    fireEvent.click(open);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("kleio_file_open", {
        owner,
        path: `${folder}/london-ai-jobs-2026-10-09.pdf`,
      }),
    );
  });

  it("changes nothing when not paired", async () => {
    await renderReply(null);
    expect(document.querySelector(".kleio-file")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Quarterly report" }));
    expect(openProjectPath).toHaveBeenCalledWith("report.pdf");
    expect(invoke).not.toHaveBeenCalled();
  });
});

/** A picture card wired as the transcript's (App.tsx): from the host when
 *  paired to one, else on this device. */
function ImageCard({ path }: { path: string }): React.ReactElement {
  const openFromHost = useOpenFromHost();
  return (
    <button
      type="button"
      onClick={() => {
        if (!openFromHost(path)) void openProjectPath(path);
      }}
    >
      Open image
    </button>
  );
}

async function clickImage(cwd: string | null, path: string): Promise<void> {
  await act(async () => {
    render(
      <WorkspaceFilesProvider cwd={cwd}>
        <ImageCard path={path} />
      </WorkspaceFilesProvider>,
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Open image" }));
}

describe("a picture a tool made, opened from the transcript", () => {
  // Regression: on 14 Oct 2026 a recipe photo generate_image made on the Mac
  // mini didn't open from a Mac paired to it ("file not found", six clicks):
  // the click looked for the mini's path on the Mac.
  it("opens from the mini, by its path inside the session's folder", async () => {
    const cwd = "/Users/willmckie/kleio-projects/cookbook";
    const photo = "finn-cookbook/photos/lemon-garlic-chicken-with-white-beans-spinach.jpg";
    vi.mocked(invoke).mockResolvedValue(undefined);
    await clickImage(cwd, `${cwd}/${photo}`);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("kleio_file_open", {
        owner: { kind: "workspace", cwd },
        path: photo,
      }),
    );
    expect(openProjectPath).not.toHaveBeenCalled();
  });

  // Of the hidden folders, the host serves only pictures saved straight into
  // .gg/generated or .gg/screenshots (see the viewer's tests below).
  it.each([
    ".gg/plans/diagram.png",
    ".gg/generated/old/2026-10-15T14-00-00-000Z.png",
    ".git/x.png",
  ])(
    "says why one in a hidden folder (%s) can't open, and never looks on this device",
    async (inside) => {
      await clickImage(CWD, `${CWD}/${inside}`);
      expect(toast).toHaveBeenCalledWith(
        "Kleio can't open this image here: it's in a hidden folder on your host. Ask for images to be saved in the project folder instead.",
        "error",
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(openProjectPath).not.toHaveBeenCalled();
    },
  );

  it("says why one outside the session's folder can't open", async () => {
    await clickImage(CWD, "/Users/k/Desktop/logo.png");
    expect(toast).toHaveBeenCalledWith(
      "Kleio can't open this image here: it isn't in this session's folder on your host.",
      "error",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(openProjectPath).not.toHaveBeenCalled();
  });

  it("opens on this device when not paired", async () => {
    await clickImage(null, `${CWD}/out/logo.png`);
    expect(openProjectPath).toHaveBeenCalledWith(`${CWD}/out/logo.png`);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a session's files in the app, beside its file viewer", () => {
  /** The host is still readying a show, so the viewer stays open saying so. */
  function hostShowing(): void {
    vi.mocked(invoke).mockImplementation((cmd) =>
      cmd === "kleio_api" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
  }

  /** The app's shape (main.tsx, App.tsx): the viewer around a reply and its cards. */
  async function renderInApp(content: React.ReactElement): Promise<void> {
    await act(async () => {
      render(
        <FileViewerProvider>
          <WorkspaceFilesProvider cwd={CWD}>{content}</WorkspaceFilesProvider>
        </FileViewerProvider>,
      );
    });
  }

  async function expectViewed(path: string): Promise<void> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    expect(await screen.findByRole("dialog", { name })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("kleio_api", {
      method: "POST",
      path: "/kleio/voice/show",
      body: { source: "workspace", cwd: CWD, path },
      session: null,
    });
    expect(invoke).not.toHaveBeenCalledWith("kleio_file_open", expect.anything());
    expect(openProjectPath).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  }

  // Notes didn't open at all before: they weren't outputs, so they went to
  // the project opener, which looked for the mini's path on this device.
  it.each([
    ["notes", "notes/review.md"],
    ["a log", `${CWD}/out/run.txt`],
    ["a report", "report.pdf"],
    ["a spreadsheet", "~/kleio-projects/demo/data/sales.csv"],
    ["a picture a tool made", ".gg/screenshots/home.png"],
  ])("opens a link to %s in the viewer, from the session's folder", async (_, href) => {
    hostShowing();
    await renderInApp(<Markdown>{`See [the file](${href}).`}</Markdown>);
    fireEvent.click(screen.getByRole("link", { name: "the file" }));
    const path = href.replace(`${CWD}/`, "").replace("~/kleio-projects/demo/", "");
    await expectViewed(path);
  });

  it("opens a kind the viewer doesn't draw in its app, and leaves source files alone", async () => {
    hostShowing();
    await renderInApp(
      <Markdown>{`The [plan](Q3%20plan.docx) and [App.tsx](${CWD}/src/App.tsx).`}</Markdown>,
    );
    fireEvent.click(screen.getByRole("link", { name: "plan" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("kleio_file_open", {
        owner: OWNER,
        path: "Q3 plan.docx",
      }),
    );
    fireEvent.click(screen.getByRole("link", { name: "App.tsx" }));
    expect(openProjectPath).toHaveBeenCalledWith(`${CWD}/src/App.tsx`);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a card's report in the viewer", async () => {
    vi.mocked(invoke).mockImplementation((cmd) =>
      cmd === "kleio_file_fetch"
        ? Promise.resolve({
            name: "report.pdf",
            size: 2048,
            mime: "application/pdf",
            thumbnail: null,
          })
        : cmd === "kleio_api"
          ? new Promise(() => {})
          : Promise.resolve(undefined),
    );
    await renderInApp(<WorkspaceFileCards text="The [Quarterly report](report.pdf)." />);
    fireEvent.click(await screen.findByRole("button", { name: "Open report.pdf" }));
    expect(await screen.findByRole("dialog", { name: "Quarterly report" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("kleio_api", {
      method: "POST",
      path: "/kleio/voice/show",
      body: { source: "workspace", cwd: CWD, path: "report.pdf" },
      session: null,
    });
  });

  // Before, these showed the "hidden folder" toast: the host served no hidden folder.
  it.each([".gg/generated/2026-10-15T14-00-00-000Z.png", ".gg/screenshots/home.jpeg"])(
    "opens a picture a tool saved at %s in the viewer",
    async (inside) => {
      hostShowing();
      await renderInApp(<ImageCard path={`${CWD}/${inside}`} />);
      fireEvent.click(screen.getByRole("button", { name: "Open image" }));
      await expectViewed(inside);
    },
  );

  it("opens a picture the session saved in its folder in the viewer", async () => {
    hostShowing();
    await renderInApp(<ImageCard path={`${CWD}/out/logo.png`} />);
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    await expectViewed("out/logo.png");
  });

  it("still says why a picture outside the session's folder can't open", async () => {
    await renderInApp(<ImageCard path="/Users/k/Desktop/logo.png" />);
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(toast).toHaveBeenCalledWith(
      "Kleio can't open this image here: it isn't in this session's folder on your host.",
      "error",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
