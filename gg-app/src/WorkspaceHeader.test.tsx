// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// WorkspaceHeader imports agent.ts (openUrl), which reads the current webview
// window at module load — stub it for jsdom.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { formatWorkspaceTitle, WorkspaceHeader } from "./WorkspaceHeader";

afterEach(cleanup);

function ChatHeaderHarness(): React.ReactElement {
  const [navHidden, setNavHidden] = useState(false);

  return (
    <WorkspaceHeader
      workspaceMode="chat"
      navHidden={navHidden}
      onToggleNav={() => setNavHidden((hidden) => !hidden)}
    >
      <button>New chat</button>
    </WorkspaceHeader>
  );
}

describe("WorkspaceHeader", () => {
  it("renders the chevron in chat mode and toggles the navbar", () => {
    render(<ChatHeaderHarness />);

    expect(screen.getByText("GG Chat")).toBeDefined();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDefined();

    const hideToggle = screen.getByRole("button", { name: "Hide nav buttons" });
    expect(hideToggle.getAttribute("aria-expanded")).toBe("true");
    expect(hideToggle.querySelector("polyline")?.getAttribute("points")).toBe("6 15 12 9 18 15");
    fireEvent.click(hideToggle);

    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    const showToggle = screen.getByRole("button", { name: "Show nav buttons" });
    expect(showToggle.getAttribute("aria-expanded")).toBe("false");
    expect(showToggle.querySelector("polyline")?.getAttribute("points")).toBe("6 9 12 15 18 9");
    fireEvent.click(showToggle);

    expect(screen.getByRole("button", { name: "New chat" })).toBeDefined();
  });

  it("formats clean, dirty, and pre-commit project context", () => {
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder")).toBe("app │ ⎇ main");
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder", 3)).toBe(
      "app │ ⎇ main │ 3 uncommitted",
    );
    expect(formatWorkspaceTitle("/work/app", null, "GG Coder", 1)).toBe("app │ 1 uncommitted");
  });

  it("shows GitHub issue/PR counts and appends them to the window title", () => {
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder", 0, 4, 1)).toBe(
      "app │ ⎇ main │ 4 issues │ 1 PR",
    );

    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd="/work/gg-coder"
        gitBranch="main"
        gitHubIssues={4}
        gitHubPRs={1}
        gitHubRepoUrl="https://github.com/kenkaiiii/gg-coder"
        navHidden
        onToggleNav={() => {}}
      >
        <button>New session</button>
      </WorkspaceHeader>,
    );

    expect(screen.getByRole("button", { name: "4 issues" })).toBeDefined();
    expect(screen.getByRole("button", { name: "1 PR" })).toBeDefined();
  });

  it("hides the GitHub chips when the counts are unknown", () => {
    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd="/work/gg-coder"
        gitBranch="main"
        navHidden
        onToggleNav={() => {}}
      >
        <button>New session</button>
      </WorkspaceHeader>,
    );

    expect(screen.queryByText(/issues?$/)).toBeNull();
    expect(screen.queryByText(/PRs?$/)).toBeNull();
  });

  it("hides a zero-count chip but keeps a non-zero one", () => {
    // 3 open issues, 0 open PRs → issues chip shows, PR chip is hidden.
    expect(formatWorkspaceTitle("/work/app", "main", "GG Coder", 0, 3, 0)).toBe(
      "app │ ⎇ main │ 3 issues",
    );

    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd="/work/gg-coder"
        gitBranch="main"
        gitHubIssues={3}
        gitHubPRs={0}
        gitHubRepoUrl="https://github.com/kenkaiiii/gg-coder"
        navHidden
        onToggleNav={() => {}}
      >
        <button>New session</button>
      </WorkspaceHeader>,
    );

    expect(screen.getByRole("button", { name: "3 issues" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /PRs?$/ })).toBeNull();
  });

  it("makes the folder a click-to-open-location button and the branch a repo link", () => {
    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd="/work/gg-coder"
        gitBranch="main"
        gitHubRepoUrl="https://github.com/kenkaiiii/gg-coder"
        navHidden
        onToggleNav={() => {}}
      >
        <button>New session</button>
      </WorkspaceHeader>,
    );

    const folder = screen.getByRole("button", { name: "gg-coder" });
    expect(folder.getAttribute("title")).toBe("/work/gg-coder — open folder");

    const branch = screen.getByRole("button", { name: "⎇ main" });
    expect(branch.getAttribute("title")).toContain("github.com/kenkaiiii/gg-coder");
  });

  it("leaves the branch as static text when there is no GitHub repo URL", () => {
    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd="/work/gg-coder"
        gitBranch="main"
        navHidden
        onToggleNav={() => {}}
      >
        <button>New session</button>
      </WorkspaceHeader>,
    );

    expect(screen.queryByRole("button", { name: "⎇ main" })).toBeNull();
    expect(screen.getByText("⎇ main")).toBeDefined();
  });

  it("shows the current directory, branch, and dirty count instead of a session title", () => {
    render(
      <WorkspaceHeader
        workspaceMode="code"
        cwd="C:\\work\\gg-coder"
        gitBranch="feature/titlebar"
        gitDirtyFileCount={3}
        navHidden
        onToggleNav={() => {}}
      >
        <button>New session</button>
      </WorkspaceHeader>,
    );

    expect(screen.getByText("gg-coder")).toBeDefined();
    expect(screen.getByText("⎇ feature/titlebar")).toBeDefined();
    expect(screen.getByText("3 uncommitted")).toBeDefined();
    expect(screen.getByTitle("gg-coder │ ⎇ feature/titlebar │ 3 uncommitted")).toBeDefined();
    expect(screen.queryByText("GG Coder")).toBeNull();
  });
});
