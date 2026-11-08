// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getPoll, votePoll, type PollState } from "./agent";
import { toast } from "./toast";
import { HomePoll } from "./HomePoll";

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./agent", () => ({ getPoll: vi.fn(), votePoll: vi.fn() }));

const POLL = {
  id: "p1",
  question: "What should GG Coder add next?",
  options: ["Voice input in Chat", "A Git panel in Code", "Plugin marketplace"],
  closesAt: Date.now() + 3 * 86_400_000,
};
const state = (over: Partial<PollState> = {}): PollState => ({
  status: 200,
  poll: POLL,
  counts: [0, 0, 0],
  total: 0,
  myChoice: null,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomePoll", () => {
  it("shows the question and answers, no results, and the privacy line before a vote", async () => {
    vi.mocked(getPoll).mockResolvedValue(state({ counts: [3, 1, 0], total: 4 }));
    render(<HomePoll />);
    expect(await screen.findByRole("heading", { name: "Weekly poll" })).toBeTruthy();
    expect(screen.getByText(POLL.question)).toBeTruthy();
    expect(screen.getByText("closes in 3d")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voice input in Chat" })).toBeTruthy();
    expect(screen.queryByText("75%")).toBeNull();
    expect(screen.getByText("Your vote is anonymous.")).toBeTruthy();
  });

  it("votes, shows each answer's share and marks the pick, then moves the vote", async () => {
    vi.mocked(getPoll).mockResolvedValue(state());
    vi.mocked(votePoll)
      .mockResolvedValueOnce(state({ counts: [3, 1, 0], total: 4, myChoice: 0 }))
      .mockResolvedValueOnce(state({ counts: [2, 2, 0], total: 4, myChoice: 1 }));
    render(<HomePoll />);
    fireEvent.click(await screen.findByRole("button", { name: "Voice input in Chat" }));
    const mine = await screen.findByRole("button", { name: "Voice input in Chat, 75%, your pick" });
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/4 votes ·/).textContent).toBe("4 votes · closes in 3d");
    expect(screen.getByText("Vote saved: Voice input in Chat, 75% of 4 votes.")).toBeTruthy();
    expect(votePoll).toHaveBeenCalledWith("p1", 0);

    fireEvent.click(screen.getByRole("button", { name: "A Git panel in Code, 25%" }));
    expect(
      await screen.findByRole("button", { name: "A Git panel in Code, 50%, your pick" }),
    ).toBeTruthy();
    expect(votePoll).toHaveBeenLastCalledWith("p1", 1);
  });

  it("says so when a vote can't be saved and keeps the board as it was", async () => {
    vi.mocked(getPoll).mockResolvedValue(state());
    vi.mocked(votePoll).mockResolvedValue({
      ...state(),
      status: 0,
      poll: null,
      error: "unreachable",
    });
    render(<HomePoll />);
    fireEvent.click(await screen.findByRole("button", { name: "Plugin marketplace" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Couldn't reach the poll. Try again in a moment.",
        "warning",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Plugin marketplace" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("stays hidden with no open poll or no server", async () => {
    vi.mocked(getPoll).mockResolvedValue({ ...state(), status: 0, poll: null });
    const { container } = render(<HomePoll />);
    await waitFor(() => expect(getPoll).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
