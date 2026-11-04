// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as Platform from "../platform";
import { isPhone } from "../platform";
import { FileViewerProvider } from "./FileViewerProvider";
import { GroupsPage } from "./GroupsPage";
import {
  createFileShow,
  createGroup,
  deleteGroup,
  listBlobs,
  listGroupMessages,
  listGroups,
  newGroupSession,
  answerGroupAsk,
  type Blob,
  type Group,
  stopGroup,
} from "./kleioApi";
import type * as KleioApi from "./kleioApi";

// Replies render through Markdown, which reaches the Tauri bridge on import.
vi.mock("../agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));
vi.mock("../RadioButton", () => ({ RadioButton: () => <button type="button">Radio</button> }));
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof Platform>()),
  isPhone: vi.fn(() => false),
}));
vi.mock("../WindowLayoutButton", () => ({
  WindowLayoutButton: () => <button type="button">Windows</button>,
}));
vi.mock("./kleioApi", async (importOriginal) => {
  const real = await importOriginal<typeof KleioApi>();
  return {
    ...real,
    listBlobs: vi.fn(),
    listGroups: vi.fn(),
    listGroupMessages: vi.fn(),
    sendGroupMessage: vi.fn(),
    stopGroup: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    newGroupSession: vi.fn(),
    answerGroupAsk: vi.fn(),
    createFileShow: vi.fn(),
  };
});

function agent(id: string, name: string): Blob {
  return {
    id,
    name,
    emoji: "🫧",
    color: "sky",
    job: `${name}'s job`,
    model: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    schedules: [],
    running: false,
  };
}

const AGENTS = Array.from({ length: 9 }, (_, i) => agent(`b${i + 1}`, `Agent ${i + 1}`));

const DESK: Group = {
  id: "g1",
  name: "Morning Desk",
  emoji: "☕️",
  color: "lemon",
  members: ["b1", "b2"],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  typing: [],
  lastMessage: {
    seq: 2,
    id: "m2",
    author: "b2",
    authorName: "Agent 2",
    emoji: "🫧",
    text: "Two emails need replies.",
    at: "2026-09-01T09:00:00Z",
  },
};

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<GroupsPage onClose={() => undefined} />);
  });
}

beforeEach(() => {
  vi.mocked(listBlobs).mockResolvedValue(AGENTS);
  vi.mocked(listGroups).mockResolvedValue([DESK]);
  vi.mocked(listGroupMessages).mockResolvedValue({
    messages: [
      {
        seq: 1,
        id: "m1",
        author: "b1",
        authorName: "Agent 1",
        emoji: "🫧",
        text: "VanMoof closed a **€40M** round.",
        at: "2026-09-01T08:00:00Z",
      },
    ],
    typing: [],
    lastSeq: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(isPhone).mockReturnValue(false);
});

/** The composer's beam reads matchMedia once a member is replying. */
function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/**
 * Stop the clock, Date only (timers, waitFor and React keep real time), and
 * return the time it stopped at. A live call's time is the poll's Date.now()
 * minus its start, so a test that expects "live · 4s" would otherwise read
 * "5s" on a machine slower than a second between its setup and the poll.
 */
function pinClock(): number {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
  return Date.now();
}

describe("GroupsPage", () => {
  it("lists each group with its latest message", async () => {
    await renderPage();
    const desk = screen.getByRole("button", { name: /^Morning Desk\./ });
    expect(within(desk).getByText("Agent 2: Two emails need replies.")).toBeTruthy();
  });

  it("opens a group into its chat, with replies formatted and members alongside", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const log = await screen.findByRole("log", { name: "Morning Desk conversation" });
    await waitFor(() => expect(within(log).getByText("€40M").tagName).toBe("STRONG"));
    const side = screen.getByRole("complementary", { name: "Morning Desk details" });
    expect(within(side).getByText("Agent 1")).toBeTruthy();
    expect(within(side).getByText("Agent 2")).toBeTruthy();
  });

  it("on the iPhone, puts the group's member count under its name", async () => {
    vi.mocked(isPhone).mockReturnValue(true);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));

    const heading = await screen.findByRole("heading", { name: "Morning Desk", level: 1 });
    const titles = heading.parentElement as HTMLElement;
    expect(titles.className).toBe("kleio-head-titles");
    expect(within(titles).getByText("2 members")).toBeTruthy();
  });

  it("shows each member's tool calls and how its last turn ended, outside the transcript", async () => {
    // A member replying turns on the composer's beam, which reads matchMedia.
    stubMatchMedia();
    const now = pinClock();
    const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [],
      typing: ["b1"],
      lastSeq: 0,
      activity: {
        b1: [
          {
            id: "t1",
            name: "bash",
            summary: "pnpm test",
            status: "failed",
            startedAt: at(9000),
            endedAt: at(6000),
          },
          { id: "t2", name: "read", summary: "notes.md", status: "running", startedAt: at(4000) },
        ],
      },
      outcomes: { b2: { kind: "timed_out", reason: "took over 2 min" } },
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const side = await screen.findByRole("complementary", { name: "Morning Desk details" });

    // The member replying opens on its own; the newest call is last and live.
    const live = await within(side).findByRole("button", { name: /^Activity of Agent 1/ });
    await waitFor(() => expect(live.getAttribute("aria-expanded")).toBe("true"));
    const calls = within(side).getByRole("list", { name: "Agent 1's tool calls, oldest first" });
    const rows = within(calls).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "⏺Ran pnpm testfailed · 3s",
      "⏺Reading notes.md…live · 4s",
    ]);

    // Another member's stop stays folded until asked for; its toggle says why.
    const stopped = within(side).getByRole("button", { name: /^Activity of Agent 2/ });
    expect(stopped.getAttribute("aria-expanded")).toBe("false");
    expect(stopped.textContent).toContain("Stopped");
    const body = document.getElementById(stopped.getAttribute("aria-controls") ?? "");
    expect(body?.hidden).toBe(true);
    fireEvent.click(stopped);
    expect(stopped.getAttribute("aria-expanded")).toBe("true");
    expect(body?.hidden).toBe(false);
    expect(within(side).getByText("Stopped: took over 2 min")).toBeTruthy();

    // The transcript stays clean.
    const log = screen.getByRole("log", { name: "Morning Desk conversation" });
    expect(log.textContent).not.toMatch(/Stopped|pnpm test/);

    // The replying member's calls also show live above the composer.
    const feed = screen.getByRole("list", { name: "What the members are doing" });
    expect(
      within(feed)
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual(["⏺Ran pnpm testfailed · 3s", "⏺Reading notes.md…live · 4s"]);
  });

  it("names each member in the live feed when several reply at once, newest last", async () => {
    stubMatchMedia();
    const now = Date.now();
    const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [],
      typing: ["b1", "b2"],
      lastSeq: 0,
      activity: {
        b1: [{ id: "t1", name: "grep", summary: "TODO", status: "running", startedAt: at(2000) }],
        b2: [{ id: "t1", name: "bash", summary: "ls", status: "running", startedAt: at(5000) }],
      },
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const feed = await screen.findByRole("list", { name: "What the members are doing" });
    const rows = within(feed).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^⏺Running ls…Agent 2live · \d+s$/),
      expect.stringMatching(/^⏺Searching TODO…Agent 1live · \d+s$/),
    ]);
  });

  it("shows no activity for an older host that doesn't report it", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const side = await screen.findByRole("complementary", { name: "Morning Desk details" });
    await waitFor(() => expect(within(side).getByText("Agent 1")).toBeTruthy());
    expect(within(side).queryByRole("button", { name: /^Activity of/ })).toBeNull();
  });

  it("builds a new group from ticked agents, up to eight", async () => {
    vi.mocked(createGroup).mockResolvedValue({ ...DESK, id: "g2", name: "Crew", members: [] });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "+ New group" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Crew" } });
    const picks = screen.getByRole("list", { name: "Members" });
    const rows = within(picks).getAllByRole("button");
    for (const row of rows.slice(0, 8)) fireEvent.click(row);
    expect(screen.getByText("8 of 8 — the group is full")).toBeTruthy();
    expect((rows[8] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Crew", members: AGENTS.slice(0, 8).map((a) => a.id) }),
      ),
    );
  });

  it("asks before deleting a group", async () => {
    vi.mocked(deleteGroup).mockResolvedValue(undefined);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete Morning Desk" }));
    expect(deleteGroup).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: "Delete Morning Desk?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith("g1"));
  });

  it("starts a new conversation from the pen button, after asking, and clears the old one", async () => {
    vi.mocked(newGroupSession).mockResolvedValue({ ...DESK, clearedThrough: 1 });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const log = await screen.findByRole("log", { name: "Morning Desk conversation" });
    await waitFor(() => expect(within(log).getByText("€40M")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(newGroupSession).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: "Start a new conversation?" });
    // A later poll still returns the old message: it stays cleared.
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [],
      typing: [],
      lastSeq: 1,
      clearedThrough: 1,
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(newGroupSession).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(within(log).queryByText("€40M")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Start a new conversation?" })).toBeNull();
  });

  it("shows a member's question with its buttons, says who asks, and sends your pick", async () => {
    stubMatchMedia();
    vi.mocked(answerGroupAsk).mockResolvedValue(undefined);
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [],
      typing: ["b2"],
      lastSeq: 0,
      asks: {
        b2: {
          id: "ask-7",
          questions: [
            {
              id: "q1",
              question: "Which market?",
              kind: "choice",
              options: [{ label: "Lagos" }, { label: "Nairobi" }],
            },
          ],
        },
      },
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const log = await screen.findByRole("log", { name: "Morning Desk conversation" });
    await within(log).findByText("Which market?");
    expect(within(log).getByText("Agent 2 asks")).toBeTruthy();
    // While it waits on you, the question replaces "is replying".
    expect(within(log).queryByText(/is replying/)).toBeNull();

    fireEvent.click(within(log).getByRole("button", { name: /Nairobi/ }));
    await waitFor(() =>
      expect(answerGroupAsk).toHaveBeenCalledWith("g1", "ask-7", "answer", { q1: "Nairobi" }),
    );
  });

  it("drops messages another device's new session cleared", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const log = await screen.findByRole("log", { name: "Morning Desk conversation" });
    await waitFor(() => expect(within(log).getByText("€40M")).toBeTruthy());

    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [
        {
          seq: 2,
          id: "m2",
          author: "you",
          authorName: "You",
          emoji: "🙂",
          text: "Fresh start",
          at: "",
        },
      ],
      typing: [],
      lastSeq: 2,
      clearedThrough: 1,
    });
    await waitFor(() => expect(within(log).getByText("Fresh start")).toBeTruthy(), {
      timeout: 3000,
    });
    expect(within(log).queryByText("€40M")).toBeNull();
  });

  it("shows an empty Assets panel before anything is shared", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const side = await screen.findByRole("complementary", { name: "Morning Desk details" });
    expect(within(side).getByRole("heading", { name: "Assets" })).toBeTruthy();
    expect(within(side).getByText("Files your specialists share will appear here.")).toBeTruthy();
  });

  it("stops the group from the composer while a member is replying", async () => {
    stubMatchMedia();
    vi.mocked(stopGroup).mockResolvedValue(undefined);
    vi.mocked(listGroupMessages).mockResolvedValue({ messages: [], typing: ["b1"], lastSeq: 0 });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(stopGroup).toHaveBeenCalledWith("g1");
  });

  it("shows Send, not Stop, when nobody is replying", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    await screen.findByRole("button", { name: "Send" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("lists the files members shared under Assets, newest first, one row per file", async () => {
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [
        {
          seq: 1,
          id: "m1",
          author: "b1",
          authorName: "Agent 1",
          emoji: "🫧",
          text: "Draft: [the report](outputs/report.pdf)",
          at: "",
        },
        {
          seq: 2,
          id: "m2",
          author: "b2",
          authorName: "Agent 2",
          emoji: "🫧",
          text: "Numbers in [sales](outputs/sales.csv); see also [the report](outputs/report.pdf).",
          at: "",
        },
        {
          seq: 3,
          id: "m3",
          author: "you",
          authorName: "You",
          emoji: "🙂",
          text: "Mine: [notes](outputs/notes.md)",
          at: "",
        },
        {
          seq: 4,
          id: "m4",
          author: "b1",
          authorName: "Agent 1",
          emoji: "🫧",
          text: "I've created [festivals.md](/Users/w/Kleio/groups/g1/b1/festivals.md), not [theirs](/Users/w/Kleio/groups/g1/b2/a.md) or [this](/etc/passwd.txt).",
          at: "",
        },
      ],
      typing: [],
      lastSeq: 4,
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const side = await screen.findByRole("complementary", { name: "Morning Desk details" });
    const list = await within(side).findByRole("list", {
      name: "Files shared in this conversation, newest first",
    });
    // Agent 2's report is a different file from Agent 1's (each has a folder).
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Open festivals.md, shared by Agent 1",
      "Open sales, shared by Agent 2",
      "Open the report, shared by Agent 2",
      "Open the report, shared by Agent 1",
    ]);
  });

  it("iPhone: the same verbose tool calls as the Mac, live and per member", async () => {
    vi.mocked(isPhone).mockReturnValue(true);
    stubMatchMedia();
    const now = pinClock();
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [],
      typing: ["b1"],
      lastSeq: 0,
      activity: {
        b1: [
          {
            id: "t1",
            name: "bash",
            summary: "pnpm test",
            status: "done",
            startedAt: new Date(now - 9000).toISOString(),
            endedAt: new Date(now - 6000).toISOString(),
          },
          {
            id: "t2",
            name: "read",
            summary: "docs/notes.md",
            status: "running",
            startedAt: new Date(now - 4000).toISOString(),
          },
        ],
      },
      outcomes: { b2: { kind: "timed_out", reason: "took over 30 min" } },
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    const feed = await screen.findByRole("list", { name: "What the members are doing" });
    expect(
      within(feed)
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual(["⏺Ran pnpm test3s", "⏺Reading docs/notes.md…live · 4s"]);
    const side = screen.getByRole("complementary", { name: "Morning Desk details" });
    const live = within(side).getByRole("button", { name: /^Activity of Agent 1/ });
    await waitFor(() => expect(live.getAttribute("aria-expanded")).toBe("true"));
    expect(
      within(side).getByRole("list", { name: "Agent 1's tool calls, oldest first" }),
    ).toBeTruthy();
    fireEvent.click(within(side).getByRole("button", { name: /^Activity of Agent 2/ }));
    expect(within(side).getByText("Stopped: took over 30 min")).toBeTruthy();
  });

  it("points you to specialists first when there are none", async () => {
    vi.mocked(listBlobs).mockResolvedValue([]);
    vi.mocked(listGroups).mockResolvedValue([]);
    await renderPage();
    expect(screen.getByRole("heading", { name: "No groups yet" })).toBeTruthy();
    expect(screen.getByText(/Create a specialist first/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "+ New group" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("a member's file link in a group", () => {
  it("opens the file in the viewer, asked of the host as that member's in the group", async () => {
    vi.mocked(listGroupMessages).mockResolvedValue({
      messages: [
        {
          seq: 1,
          id: "m1",
          author: "b1",
          authorName: "Agent 1",
          emoji: "🫧",
          text: "Drafted [the plan](out/plan.md).",
          at: "2026-09-01T08:00:00Z",
        },
      ],
      typing: [],
      lastSeq: 1,
    });
    vi.mocked(createFileShow).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(
        <FileViewerProvider>
          <GroupsPage onClose={() => undefined} />
        </FileViewerProvider>,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /^Morning Desk\./ }));
    fireEvent.click(await screen.findByRole("link", { name: "the plan" }));
    expect(await screen.findByRole("dialog", { name: "plan.md" })).toBeTruthy();
    expect(createFileShow).toHaveBeenCalledWith({
      source: "group",
      id: "g1",
      member: "b1",
      path: "out/plan.md",
    });
  });
});
