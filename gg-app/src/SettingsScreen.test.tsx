// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Each page is exercised by its own tests; here they are stand-ins, so this
// file covers only the screen: the header, the tabs, and Back.
vi.mock("./SettingsModal", () => ({ SettingsModal: () => <p>general page</p> }));
vi.mock("./McpModal", () => ({ McpModal: () => <p>mcp page</p> }));
vi.mock("./SteroidsModal", () => ({ SteroidsModal: () => <p>steroids page</p> }));
vi.mock("./AboutPage", () => ({ AboutPage: () => <p>about page</p> }));
vi.mock("./TelegramSettingsModal", () => ({ TelegramSettingsModal: () => <p>telegram setup</p> }));
vi.mock("./LoginScreen", async () => {
  const { SettingsHeaderStatus } = await import("./settings-header");
  return {
    LoginScreen: () => (
      <>
        <SettingsHeaderStatus>
          <span>3 connected</span>
        </SettingsHeaderStatus>
        <p>providers page</p>
      </>
    ),
  };
});
vi.mock("./agent", () => ({
  waitForReady: () => Promise.resolve(),
  hasModelSource: () => Promise.resolve(false),
  getServeStatus: vi.fn(() => Promise.resolve({ running: false, configured: false })),
  startServe: vi.fn(),
  stopServe: vi.fn(),
  setRemoteActive: vi.fn(),
  getSteroidsStatus: () => Promise.resolve({ installed: true, connected: true }),
  onSteroidsChange: () => () => {},
}));

import { getServeStatus } from "./agent";
import { SETTINGS_PAGE_WAIT_MS } from "./settings-ready";
import { SettingsScreen } from "./SettingsScreen";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function waiting(): boolean {
  return document.querySelector(".settings-screen")?.classList.contains("is-waiting") ?? false;
}

async function renderScreen(props: Partial<Parameters<typeof SettingsScreen>[0]> = {}) {
  const onClose = vi.fn();
  render(<SettingsScreen onClose={onClose} {...props} />);
  // Let the status loads settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { onClose };
}

function heading(): string | null {
  return screen.getByRole("heading", { level: 1 }).textContent;
}

describe("SettingsScreen", () => {
  it("titles the header after the open tab and follows the tab bar", async () => {
    await renderScreen();

    expect(heading()).toBe("General");
    expect(screen.getByText("general page")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));

    expect(heading()).toBe("MCP");
    expect(screen.getByText("mcp page")).toBeTruthy();
    expect(screen.queryByText("general page")).toBeNull();
  });

  it("opens on the requested tab", async () => {
    await renderScreen({ initialTab: "steroids" });

    expect(heading()).toBe("Steroids");
    expect(screen.getByRole("tab", { name: "Steroids" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("shows a page's status in the header only while that page is open", async () => {
    await renderScreen();
    expect(screen.queryByText("3 connected")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "AI Providers" }));
    expect(screen.getByText("3 connected")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.queryByText("3 connected")).toBeNull();
  });

  it("holds a page back until its first load lands, so it never paints half-loaded", async () => {
    let land: (serve: { running: boolean; configured: boolean }) => void = () => {};
    vi.mocked(getServeStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    await renderScreen({ initialTab: "remote" });
    // Still loading: the page (and the Off it would flip from) stays hidden.
    expect(waiting()).toBe(true);

    await act(async () => {
      land({ running: true, configured: true });
      await Promise.resolve();
    });

    expect(waiting()).toBe(false);
    expect(document.querySelector(".picker-head")?.textContent).toContain("Live");
  });

  it("stops waiting on a slow page and lets its own loading state show", async () => {
    vi.useFakeTimers();
    vi.mocked(getServeStatus).mockImplementationOnce(() => new Promise(() => {}));
    await renderScreen({ initialTab: "remote" });
    expect(waiting()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(SETTINGS_PAGE_WAIT_MS);
    });

    expect(waiting()).toBe(false);
  });

  it("never holds a page that has nothing to load", async () => {
    await renderScreen({ initialTab: "remote" });
    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    expect(waiting()).toBe(false);
  });

  it("puts Remote's state and its start button in the header bar", async () => {
    await renderScreen({ initialTab: "remote" });

    expect(heading()).toBe("Remote");
    const header = document.querySelector(".picker-head");
    expect(header?.textContent).toContain("Off");
    const start = screen.getByRole("button", { name: "Start serving" });
    // In the header bar's right-aligned action group, not the page body.
    expect(start.closest(".settings-head-actions")).not.toBeNull();
    // No bot configured yet: serving cannot start, and the hover says why.
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(start.getAttribute("title")).toBe("Save your bot first");
    expect(screen.getByText("telegram setup")).toBeTruthy();
  });

  it("clears a page's header buttons when another tab opens", async () => {
    await renderScreen({ initialTab: "remote" });
    expect(screen.queryByRole("button", { name: "Start serving" })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));

    expect(screen.queryByRole("button", { name: "Start serving" })).toBeNull();
  });

  it("ends with the About tab", async () => {
    await renderScreen();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[tabs.length - 1]?.getAttribute("aria-label")).toBe("About");

    fireEvent.click(screen.getByRole("tab", { name: "About" }));

    expect(heading()).toBe("About");
    expect(screen.getByText("about page")).not.toBeNull();
  });

  it("goes back with the Back button", async () => {
    const { onClose } = await renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
