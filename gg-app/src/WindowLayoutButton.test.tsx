// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { arrangeAllWindows, setupWindows } from "./agent";
import { WindowLayoutButton } from "./WindowLayoutButton";

vi.mock("./agent", () => ({
  arrangeAllWindows: vi.fn().mockResolvedValue(undefined),
  setupWindows: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

beforeEach(() => {
  document.documentElement.className = "platform-windows";
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

describe("WindowLayoutButton (Windows/Linux fallback)", () => {
  it("commits a window count from the in-webview menu", async () => {
    const onArrange = vi.fn();
    render(<WindowLayoutButton onArrange={onArrange} />);

    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "4 windows" }));

    await waitFor(() => expect(setupWindows).toHaveBeenCalledWith(4));
    expect(onArrange).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs auto-arrange from the fallback menu", async () => {
    render(<WindowLayoutButton />);

    fireEvent.click(screen.getByRole("button", { name: "Arrange into multiple project windows" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Auto-arrange all" }));

    await waitFor(() => expect(arrangeAllWindows).toHaveBeenCalledOnce());
    expect(setupWindows).not.toHaveBeenCalled();
  });
});
