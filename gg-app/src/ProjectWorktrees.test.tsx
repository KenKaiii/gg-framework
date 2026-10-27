// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listGitWorktrees, removeGitWorktree, type GitWorktree } from "./agent";
import { ProjectWorktrees, worktreeStatus } from "./ProjectWorktrees";

vi.mock("./agent", () => ({ listGitWorktrees: vi.fn(), removeGitWorktree: vi.fn() }));

const listMock = vi.mocked(listGitWorktrees);
const removeMock = vi.mocked(removeGitWorktree);

const tree = (over: Partial<GitWorktree>): GitWorktree => ({
  path: "/w/feature",
  branch: "feature",
  managed: true,
  missing: false,
  dirty: 0,
  ahead: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectWorktrees", () => {
  it("stays hidden when the project has no worktrees", async () => {
    listMock.mockResolvedValue({ mainPath: "/r", mainBranch: "trunk", worktrees: [] });
    const { container } = render(
      <ProjectWorktrees projectPath="/r" busy={false} onOpen={vi.fn()} />,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("lists worktrees with status and opens one", async () => {
    listMock.mockResolvedValue({
      mainPath: "/r",
      mainBranch: "trunk",
      worktrees: [tree({ ahead: 3 }), tree({ path: "/mine", branch: "spike", managed: false })],
    });
    const onOpen = vi.fn();
    render(<ProjectWorktrees projectPath="/r" busy={false} onOpen={onOpen} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /feature.*3 commits ahead of trunk/ }),
    );
    expect(onOpen).toHaveBeenCalledWith("/w/feature");
    // The user's own worktree is listed but can't be removed from here.
    expect(screen.getByText("Your worktree")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Remove the spike worktree/ })).toBeNull();
  });

  it("removes a clean worktree at once, and asks first when it has changes", async () => {
    listMock.mockResolvedValue({
      mainPath: "/r",
      mainBranch: "trunk",
      worktrees: [tree({}), tree({ path: "/w/dirty", branch: "dirty", dirty: 2 })],
    });
    removeMock.mockResolvedValue(undefined);
    render(<ProjectWorktrees projectPath="/r" busy={false} onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove the feature worktree" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("/r", "/w/feature", false));
    fireEvent.click(screen.getByRole("button", { name: "Remove the dirty worktree" }));
    expect(await screen.findByText(/2 uncommitted changes that will be lost/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("/r", "/w/dirty", true));
  });

  it("shows why a removal was refused", async () => {
    listMock.mockResolvedValue({ mainPath: "/r", mainBranch: "trunk", worktrees: [tree({})] });
    removeMock.mockRejectedValue(new Error("A window is open in this worktree. Close it first."));
    render(<ProjectWorktrees projectPath="/r" busy={false} onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove the feature worktree" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Close it first/);
  });
});

describe("worktreeStatus", () => {
  it.each([
    [{}, "Clean"],
    [{ dirty: 1 }, "1 change"],
    [{ dirty: 2, ahead: 1 }, "2 changes · 1 commit ahead of trunk"],
    [{ missing: true, dirty: 4 }, "Folder deleted"],
  ])("%o → %s", (over, label) => {
    expect(worktreeStatus(tree(over), "trunk")).toBe(label);
  });
});
