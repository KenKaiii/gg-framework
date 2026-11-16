// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LivePreviewPanel } from "./LivePreviewPanel";
import { livePreviewAvailable } from "./livePreviewAvailable";
import type { LivePreview } from "./useLivePreview";

afterEach(cleanup);

const preview = (over: Partial<LivePreview> = {}): LivePreview => ({
  status: { running: false, url: null, target: null },
  busy: false,
  error: null,
  needsUrl: false,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  open: vi.fn(),
  ...over,
});

describe("LivePreviewPanel", () => {
  it("shows the link with Open and Stop while it runs", () => {
    const p = preview({
      status: { running: true, url: "http://localhost:4100/", target: "http://localhost:5173/" },
    });
    render(<LivePreviewPanel preview={p} />);
    expect(screen.getByText("localhost:4100")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Shows localhost:5173.");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(p.open).toHaveBeenCalledOnce();
    expect(p.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("offers to start the dev server when none runs, with typing an address as the fallback", () => {
    const p = preview({ needsUrl: true, error: "No dev server is running for this project." });
    const startDevServer = vi.fn();
    render(<LivePreviewPanel preview={p} onStartDevServer={startDevServer} />);
    expect(screen.getByText("No web app running")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start dev server" }));
    expect(startDevServer).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Other address" }));
    const field = screen.getByRole("textbox", { name: "Dev server address" });
    const open = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.change(field, { target: { value: " localhost:3000 " } });
    fireEvent.click(open);
    expect(p.start).toHaveBeenCalledWith("localhost:3000");
  });

  it("finds the dev server again from Open, holds while looking, and shows errors", () => {
    const p = preview();
    const { rerender } = render(<LivePreviewPanel preview={p} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(p.start).toHaveBeenCalledWith();
    rerender(<LivePreviewPanel preview={{ ...p, busy: true }} />);
    expect(screen.getByRole("status").textContent).toContain("Looking for");
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<LivePreviewPanel preview={{ ...p, error: "Runs on https" }} />);
    expect(screen.getByRole("alert").textContent).toBe("Runs on https");
  });
});

describe("livePreviewAvailable", () => {
  it("is on for a code window with a project, and off in goal, chat and project-less windows", () => {
    expect(livePreviewAvailable("code", false, {})).toBe(true);
    expect(livePreviewAvailable("code", false, { goal: { id: "g" } })).toBe(false);
    expect(livePreviewAvailable("chat", false, {})).toBe(false);
    expect(livePreviewAvailable("code", true, {})).toBe(false);
    expect(livePreviewAvailable("code", false, null)).toBe(false);
  });
});
