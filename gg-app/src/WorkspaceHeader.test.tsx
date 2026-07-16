// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
