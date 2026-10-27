// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  getSettings,
  importTranscript,
  listProjects,
  listSessions,
  selectProject,
  setProjectHidden,
  waitForReady,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { ProjectPicker } from "./ProjectPicker";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn(),
  focusWindowByOffset: vi.fn(),
  getSettings: vi.fn(),
  importTranscript: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  selectProject: vi.fn(),
  setProjectHidden: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));
vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectWorktrees", () => ({ ProjectWorktrees: () => null }));

const getSettingsMock = vi.mocked(getSettings);
const importTranscriptMock = vi.mocked(importTranscript);
const listProjectsMock = vi.mocked(listProjects);
const listSessionsMock = vi.mocked(listSessions);
const selectProjectMock = vi.mocked(selectProject);
const setProjectHiddenMock = vi.mocked(setProjectHidden);
const waitForReadyMock = vi.mocked(waitForReady);

const PROJECT: DiscoveredProject = {
  name: "ui-test",
  path: "/Users/dev/ui-test",
  lastActiveDisplay: "1w ago",
  sources: ["claude-code"],
};

const NATIVE_SESSION: RecentSession = {
  id: "gg-1",
  path: "/sessions/gg-1.jsonl",
  preview: "Native GG Coder session",
  lastActiveDisplay: "2m ago",
  messageCount: 4,
};

const FOREIGN_SESSION: RecentSession = {
  id: "cc-1",
  path: "/Users/dev/.claude/projects/-Users-dev-ui-test/cc-1.jsonl",
  preview: "Build a UI dashboard in HTML",
  lastActiveDisplay: "1w ago",
  messageCount: 44,
  source: "claude-code",
};

/** Render the picker already opened on the project's session list. */
async function renderSessionList(sessions: RecentSession[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue([PROJECT]);
  listSessionsMock.mockResolvedValue(sessions);
  selectProjectMock.mockResolvedValue();

  render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);
  await screen.findByText(sessions[0]!.preview);
}

// Pickers keep their last list per window (useCachedList); each test starts
// from a first visit.
beforeEach(() => sessionStorage.clear());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OTHER_PROJECT: DiscoveredProject = {
  name: "scratch",
  path: "/private/tmp",
  lastActiveDisplay: "1d ago",
  sources: ["ggcoder"],
};

/** Render the picker on the project list (no deep link). */
async function renderProjectList(projects: DiscoveredProject[]): Promise<void> {
  getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
  waitForReadyMock.mockResolvedValue();
  listProjectsMock.mockResolvedValue(projects);

  render(<ProjectPicker onChosen={vi.fn()} />);
  await screen.findByText(projects[0]!.name);
}

describe("ProjectPicker hide", () => {
  it("removes the row and persists the decision", async () => {
    setProjectHiddenMock.mockResolvedValue();
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide scratch"));

    await waitFor(() => expect(screen.queryByText("scratch")).toBeNull());
    expect(setProjectHiddenMock).toHaveBeenCalledWith("/private/tmp", true);
    // The untouched project stays put.
    expect(screen.getByText("ui-test")).toBeTruthy();
  });

  it("restores the row in place when persisting fails", async () => {
    setProjectHiddenMock.mockRejectedValue(new Error("disk full"));
    await renderProjectList([PROJECT, OTHER_PROJECT]);

    fireEvent.click(screen.getByLabelText("Hide ui-test"));

    // Comes back rather than lying about what the next launch will show, and
    // returns to its original position rather than the end of the list.
    await waitFor(() => expect(screen.getByText("ui-test")).toBeTruthy());
    const names = screen.getAllByText(/^(ui-test|scratch)$/).map((n) => n.textContent);
    expect(names).toEqual(["ui-test", "scratch"]);
  });
});

describe("ProjectPicker load failures", () => {
  it("says the project list failed to load and retries, not 'No projects yet'", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockRejectedValueOnce(new Error("daemon down")).mockResolvedValue([PROJECT]);

    render(<ProjectPicker onChosen={vi.fn()} />);

    expect(await screen.findByText("Couldn't load your projects.")).toBeTruthy();
    expect(screen.queryByText("No projects yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(PROJECT.name)).toBeTruthy();
    expect(screen.queryByText("Couldn't load your projects.")).toBeNull();
  });

  it("says a project's sessions failed to load instead of an endless skeleton", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([PROJECT]);
    listSessionsMock.mockRejectedValueOnce(new Error("daemon down"));

    render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);

    expect(await screen.findByText("Couldn't load this project's sessions.")).toBeTruthy();
    expect(screen.queryByText("No previous sessions yet.")).toBeNull();
    expect(document.querySelector(".list-skeleton")).toBeNull();

    listSessionsMock.mockResolvedValue([NATIVE_SESSION]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(NATIVE_SESSION.preview)).toBeTruthy();
  });
});

describe("ProjectPicker session list", () => {
  it("badges a Claude Code session with its source", async () => {
    await renderSessionList([NATIVE_SESSION, FOREIGN_SESSION]);

    // The foreign row is labelled; the native one carries no source tag.
    const badge = screen.getByText("Claude Code");
    expect(badge.className).toContain("picker-source-tag");

    const foreignRow = screen.getByText(FOREIGN_SESSION.preview).closest("button");
    expect(foreignRow?.textContent).toContain("Claude Code");
    expect(foreignRow?.getAttribute("title")).toContain("opens as a GG Coder session");

    const nativeRow = screen.getByText(NATIVE_SESSION.preview).closest("button");
    expect(nativeRow?.textContent).not.toContain("Claude Code");
    expect(nativeRow?.getAttribute("title")).toBeNull();
  });

  it("imports then opens when a foreign session is clicked", async () => {
    importTranscriptMock.mockResolvedValue({
      ok: true,
      sessionId: "imported-1",
      sessionPath: "/sessions/imported-1.jsonl",
      cwd: PROJECT.path,
      format: "claude",
      messageCount: 44,
      dropped: "nothing",
    });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    await waitFor(() => {
      // Imported from the foreign transcript...
      expect(importTranscriptMock).toHaveBeenCalledWith(FOREIGN_SESSION.path, PROJECT.path);
      // ...then opened by the NEW session path, not the transcript path.
      expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, "/sessions/imported-1.jsonl");
    });
  });

  it("opens a native session directly, with no import", async () => {
    await renderSessionList([NATIVE_SESSION]);

    fireEvent.click(screen.getByText(NATIVE_SESSION.preview));

    await waitFor(() => {
      expect(selectProjectMock).toHaveBeenCalledWith(PROJECT.path, NATIVE_SESSION.path);
    });
    expect(importTranscriptMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed import instead of opening a broken session", async () => {
    importTranscriptMock.mockResolvedValue({ ok: false, error: "Could not read transcript" });
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Could not read transcript");
    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("stays usable after a failed import", async () => {
    importTranscriptMock.mockRejectedValue(new Error("daemon not ready"));
    await renderSessionList([FOREIGN_SESSION]);

    fireEvent.click(screen.getByText(FOREIGN_SESSION.preview));
    await screen.findByRole("alert");

    // `busy` must be released, or every later click is silently ignored.
    const row = screen.getByText(FOREIGN_SESSION.preview).closest("button");
    expect(row?.hasAttribute("disabled")).toBe(false);
  });
});

describe("ProjectPicker returning from a session", () => {
  it("opens straight on the project's sessions, never flashing the project list", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    // Discovery hasn't answered yet: the first paint is all there is.
    waitForReadyMock.mockReturnValue(new Promise(() => {}));
    render(<ProjectPicker onChosen={vi.fn()} initialProjectPath={PROJECT.path} />);
    expect(screen.getByText("ui-test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New session" })).toBeTruthy();
    expect(screen.queryByText("Choose a project")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open existing" })).toBeNull();
  });

  it("falls back to the project list when the path isn't a known project", async () => {
    getSettingsMock.mockResolvedValue({ projectsRoot: "/Users/dev", configured: true });
    waitForReadyMock.mockResolvedValue();
    listProjectsMock.mockResolvedValue([OTHER_PROJECT]);
    render(<ProjectPicker onChosen={vi.fn()} initialProjectPath="/Users/dev/gone" />);
    expect(await screen.findByText("Choose a project")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open existing" })).toBeTruthy();
  });
});
