// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as KleioApi from "./kleioApi";
import {
  createFileShow,
  threadAnswerAsk,
  threadHistory,
  threadPrompt,
  threadState,
} from "./kleioApi";
import { FileViewerProvider } from "./FileViewerProvider";
import { ThreadChat } from "./ThreadChat";

vi.mock("./kleioApi", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioApi>()),
  threadState: vi.fn(),
  threadHistory: vi.fn(),
  threadPrompt: vi.fn(),
  threadCancel: vi.fn(),
  threadAnswerAsk: vi.fn(),
  createFileShow: vi.fn(),
}));
vi.mock("./liveActivity", () => ({ startLiveActivity: vi.fn(async () => {}) }));
vi.mock("../agent", () => ({ openProjectPath: vi.fn(), sendPrompt: vi.fn() }));
vi.mock("../useDictation", () => ({
  useDictation: () => ({ state: "idle", start: vi.fn(), stop: vi.fn() }),
}));

const ASK = {
  id: "ask-1",
  questions: [
    {
      id: "q1",
      question: "Fish or veg?",
      kind: "choice",
      options: [{ label: "Fish" }, { label: "Veg" }],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderChat(): void {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  render(
    <ThreadChat
      label="Chef"
      resolve={async () => ({ sessionId: "s1", sessionPath: null, created: false })}
    />,
  );
}

describe("a specialist's question in its chat", () => {
  it("shows the options as buttons and sends the one you pick", async () => {
    vi.mocked(threadHistory).mockResolvedValue([{ role: "user", text: "Plan dinner" }]);
    vi.mocked(threadState).mockResolvedValue({ running: true, pendingAsks: [ASK] });
    vi.mocked(threadAnswerAsk).mockResolvedValue(undefined);
    renderChat();

    const log = await screen.findByRole("log", { name: "Conversation with Chef" });
    await within(log).findByText("Fish or veg?");
    // While it waits on you, the band replaces the "is replying" dots.
    expect(within(log).queryByLabelText("Chef is replying")).toBeNull();

    fireEvent.click(within(log).getByRole("button", { name: /Veg/ }));
    await waitFor(() =>
      expect(threadAnswerAsk).toHaveBeenCalledWith("s1", "ask-1", "answer", { q1: "Veg" }),
    );
  });

  it("a message typed while it waits is the answer, not a new message", async () => {
    vi.mocked(threadHistory).mockResolvedValue([]);
    vi.mocked(threadState).mockResolvedValue({ running: true, pendingAsks: [ASK] });
    vi.mocked(threadAnswerAsk).mockResolvedValue(undefined);
    renderChat();

    const log = await screen.findByRole("log", { name: "Conversation with Chef" });
    await within(log).findByText("Fish or veg?");
    expect(within(log).getByText("Or type your own answer below.")).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message Chef" });
    fireEvent.change(box, { target: { value: "Pasta" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(threadAnswerAsk).toHaveBeenCalledWith("s1", "ask-1", "answer", { q1: "Pasta" }),
    );
    expect(threadPrompt).not.toHaveBeenCalled();
  });

  it("says so when the answer doesn't arrive, and lets you pick again", async () => {
    vi.mocked(threadHistory).mockResolvedValue([]);
    vi.mocked(threadState).mockResolvedValue({ running: true, pendingAsks: [ASK] });
    vi.mocked(threadAnswerAsk).mockRejectedValue(new Error("offline"));
    renderChat();

    const log = await screen.findByRole("log", { name: "Conversation with Chef" });
    await within(log).findByText("Fish or veg?");
    fireEvent.click(within(log).getByRole("button", { name: /Fish/ }));
    expect(await within(log).findByRole("alert")).toBeTruthy();
    expect(within(log).getByRole("button", { name: /Veg/ })).toBeTruthy();
  });
});

describe("a specialist's tool calls in its chat", () => {
  it("shows the run's calls live above the composer, as a Code chat does", async () => {
    vi.mocked(threadHistory).mockResolvedValue([{ role: "user", text: "Check the tests" }]);
    vi.mocked(threadState).mockResolvedValue({ running: true });
    const now = Date.now();
    const activity = vi.fn(async () => [
      {
        id: "t1",
        name: "bash",
        summary: "pnpm test",
        status: "done" as const,
        startedAt: new Date(now - 9000).toISOString(),
        endedAt: new Date(now - 7000).toISOString(),
      },
      {
        id: "t2",
        name: "read",
        summary: "notes.md",
        status: "running" as const,
        startedAt: new Date(now - 3000).toISOString(),
      },
    ]);
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(
      <ThreadChat
        label="Chef"
        resolve={async () => ({ sessionId: "s1", sessionPath: null, created: false })}
        activity={activity}
      />,
    );

    const feed = await screen.findByRole("list", { name: "What Chef is doing" });
    expect(
      within(feed)
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual(["⏺Ran pnpm test2s", expect.stringMatching(/^⏺Reading notes\.md…live · \d+s$/)]);
  });

  it("shows no calls between runs", async () => {
    vi.mocked(threadHistory).mockResolvedValue([]);
    vi.mocked(threadState).mockResolvedValue({ running: false });
    const activity = vi.fn(async () => []);
    render(
      <ThreadChat
        label="Chef"
        resolve={async () => ({ sessionId: "s1", sessionPath: null, created: false })}
        activity={activity}
      />,
    );
    await screen.findByRole("log", { name: "Conversation with Chef" });
    expect(screen.queryByRole("list", { name: "What Chef is doing" })).toBeNull();
    expect(activity).not.toHaveBeenCalled();
  });
});

describe("a specialist's file link in its chat", () => {
  it("opens the file in the viewer, asked of the host as the specialist's", async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.mocked(threadHistory).mockResolvedValue([
      { role: "user", text: "Write it up" },
      { role: "assistant", text: "Here's [the findings](out/findings.pdf)." },
    ]);
    vi.mocked(threadState).mockResolvedValue({ running: false, pendingAsks: [] });
    // The host is still readying it: the viewer says it's opening.
    vi.mocked(createFileShow).mockReturnValue(new Promise(() => {}));
    render(
      <FileViewerProvider>
        <ThreadChat
          label="Chef"
          owner={{ kind: "blob", blobId: "b_1234abcd" }}
          resolve={async () => ({ sessionId: "s1", sessionPath: null, created: false })}
        />
      </FileViewerProvider>,
    );
    fireEvent.click(await screen.findByRole("link", { name: "the findings" }));
    const viewer = await screen.findByRole("dialog", { name: "findings.pdf" });
    expect(within(viewer).getByText("Opening…")).toBeTruthy();
    expect(createFileShow).toHaveBeenCalledWith({
      source: "specialist",
      id: "b_1234abcd",
      path: "out/findings.pdf",
    });
  });
});
