// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getGitBranches, switchGitBranch, type GitBranches } from "./agent";
import { BranchPicker, lastCommitLabel } from "./BranchPicker";

vi.mock("./agent", () => ({ getGitBranches: vi.fn(), switchGitBranch: vi.fn() }));

const branchesMock = vi.mocked(getGitBranches);
const switchMock = vi.mocked(switchGitBranch);
const now = Math.floor(Date.now() / 1000);

function list(over: Partial<GitBranches> = {}): GitBranches {
  return {
    current: "trunk",
    branches: [
      { name: "trunk", current: true, worktree: null, updatedAt: now },
      { name: "feature/login", current: false, worktree: null, updatedAt: now - 3 * 86_400 },
      { name: "spike", current: false, worktree: "/w/spike", updatedAt: now - 40 * 86_400 },
    ],
    sharedWith: null,
    locked: null,
    setup: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BranchPicker", () => {
  it("lists branches with the current one marked and not pickable", async () => {
    branchesMock.mockResolvedValue(list());
    render(<BranchPicker running={false} />);
    const current = await screen.findByRole("button", { name: /trunk/ });
    expect(current.getAttribute("aria-current")).toBe("true");
    expect((current as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /feature\/login.*3 days ago/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /spike.*Open in another folder/ })).toBeDefined();
  });

  it("switches in place and reloads the list", async () => {
    branchesMock.mockResolvedValue(list());
    switchMock.mockResolvedValue({ kind: "switched", branch: "feature/login" });
    render(<BranchPicker running={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /feature\/login/ }));
    await waitFor(() => expect(branchesMock).toHaveBeenCalledTimes(2));
    expect(switchMock).toHaveBeenCalledWith("feature/login", false, "worktree");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("filters, and offers to create a branch the filter names", async () => {
    branchesMock.mockResolvedValue(list());
    switchMock.mockResolvedValue({ kind: "switched", branch: "fix/crash" });
    render(<BranchPicker running={false} />);
    const input = await screen.findByRole("textbox", { name: /Filter branches/ });
    fireEvent.change(input, { target: { value: "login" } });
    expect(screen.queryByRole("button", { name: /spike/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create branch/ })).not.toBeNull();
    fireEvent.change(input, { target: { value: "fix/crash" } });
    expect(
      screen.getByRole("button", { name: /Create branch “fix\/crash”\s*from trunk/ }),
    ).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(switchMock).toHaveBeenCalledWith("fix/crash", true, "worktree"));
  });

  it("moves this window into the worktree the sidecar picked", async () => {
    branchesMock.mockResolvedValue(list({ sharedWith: "2 other open GG Coder windows" }));
    switchMock.mockResolvedValue({
      kind: "moved",
      branch: "feature/login",
      path: "/w/feature-login",
      sessionPath: "/s/conv.jsonl",
    });
    const move = vi.fn().mockResolvedValue(undefined);
    render(<BranchPicker running={false} onMoveToWorktree={move} />);
    expect(
      await screen.findByText(/2 other open GG Coder windows also use this folder/),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /feature\/login/ }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("/w/feature-login", "/s/conv.jsonl"));
    expect(switchMock).toHaveBeenCalledWith("feature/login", false, "worktree");
  });

  it("lets the user switch a shared folder for everyone instead, and shows the setup", async () => {
    branchesMock.mockResolvedValue(
      list({ sharedWith: "1 other open GG Coder window", setup: "pnpm install --frozen-lockfile" }),
    );
    switchMock.mockResolvedValue({ kind: "switched", branch: "feature/login" });
    render(<BranchPicker running={false} />);
    const ownTree = await screen.findByRole("radio", { name: /own worktree/ });
    expect((ownTree as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("pnpm install --frozen-lockfile")).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: /switching the other windows too/ }));
    expect(screen.queryByText("pnpm install --frozen-lockfile")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /feature\/login/ }));
    await waitFor(() => expect(switchMock).toHaveBeenCalledWith("feature/login", false, "here"));
  });

  it("shows git's reason when a switch fails", async () => {
    branchesMock.mockResolvedValue(list());
    switchMock.mockRejectedValue(new Error("Your local changes would be overwritten by checkout"));
    render(<BranchPicker running={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /feature\/login/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/would be overwritten/);
  });

  it("waits while the agent is working", async () => {
    branchesMock.mockResolvedValue(list());
    render(<BranchPicker running />);
    expect(await screen.findByText(/waits until the agent finishes/)).toBeDefined();
    const row = screen.getByRole("button", { name: /feature\/login/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
  });
});

describe("lastCommitLabel", () => {
  it.each([
    [0, "today"],
    [1, "yesterday"],
    [3, "3 days ago"],
    [45, "a month ago"],
    [200, "6 months ago"],
    [800, "2 years ago"],
  ])("%i days → %s", (days, label) => {
    const at = 1_800_000_000_000;
    expect(lastCommitLabel(at / 1000 - days * 86_400, at)).toBe(label);
  });
});
