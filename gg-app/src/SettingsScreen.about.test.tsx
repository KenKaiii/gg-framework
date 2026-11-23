// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// About is the one Settings page that loads on demand (it carries the whole
// changelog), and a page is only ever loaded once. So every test here starts
// from a screen that has never loaded it (a fresh module graph), and the chunk
// arrives only when the test says so.
const about = { requested: false, arrive: () => {} };
vi.mock("./SettingsModal", () => ({ SettingsModal: () => <p>general page</p> }));
vi.mock("./McpModal", () => ({ McpModal: () => <p>mcp page</p> }));
vi.mock("./SteroidsModal", () => ({ SteroidsModal: () => <p>steroids page</p> }));
vi.mock("./TelegramSettingsModal", () => ({ TelegramSettingsModal: () => <p>telegram setup</p> }));
vi.mock("./LoginScreen", () => ({ LoginScreen: () => <p>providers page</p> }));
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

beforeEach(() => {
  vi.resetModules();
  about.requested = false;
  // Not hoisted like the others: the factory has to run again for every test,
  // which a hoisted mock's cached result would not.
  vi.doMock("./AboutPage", async () => {
    about.requested = true;
    await new Promise<void>((resolve) => {
      about.arrive = resolve;
    });
    return { AboutPage: () => <p>about page</p> };
  });
});

afterEach(cleanup);

function waiting(): boolean {
  return document.querySelector(".settings-screen")?.classList.contains("is-waiting") ?? false;
}

/** A Settings screen that has never opened About. */
async function openSettings(props: { initialTab?: "remote" } = {}): Promise<void> {
  const { SettingsScreen } = await import("./SettingsScreen");
  render(<SettingsScreen onClose={() => {}} {...props} />);
  // Let the status loads settle.
  await act(async () => {
    await Promise.resolve();
  });
}

async function openAboutTheFirstTime(): Promise<void> {
  fireEvent.click(screen.getByRole("tab", { name: "About" }));
  await waitFor(() => expect(about.requested).toBe(true));
}

/** The chunk lands, wherever the screen is at the time. */
async function chunkArrives(): Promise<void> {
  about.arrive();
  // The import settles on ticks of its own: flush until they are done. Fewer
  // than the gate's give-up timer, so nothing below can pass on that.
  for (let tick = 0; tick < 5; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("SettingsScreen's About tab", () => {
  it("stays back until its page has loaded, so the tab never paints empty", async () => {
    await openSettings();
    await openAboutTheFirstTime();

    // The chunk is still on its way.
    expect(waiting()).toBe(true);
    expect(screen.queryByText("about page")).toBeNull();

    await chunkArrives();

    // Shown the moment it is in: the hold ends with the chunk, not with the
    // gate's own give-up timer.
    expect(waiting()).toBe(false);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("About");
    expect(screen.getByText("about page")).toBeTruthy();
  });

  it("is not held again once its page is in", async () => {
    await openSettings({ initialTab: "remote" });
    await openAboutTheFirstTime();
    await chunkArrives();
    expect(waiting()).toBe(false);

    // A page that is held itself (Remote waits for its status) in between
    // must not bring About's hold back with it.
    fireEvent.click(screen.getByRole("tab", { name: "Remote" }));
    fireEvent.click(screen.getByRole("tab", { name: "About" }));

    expect(waiting()).toBe(false);
    expect(screen.getByText("about page")).toBeTruthy();
  });

  it("lets go of the other tabs when it is left before its page arrives", async () => {
    await openSettings();
    await openAboutTheFirstTime();
    expect(waiting()).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "General" }));

    expect(waiting()).toBe(false);
    expect(screen.getByText("general page")).toBeTruthy();

    // The chunk lands while another tab is open, and changes nothing there.
    await chunkArrives();
    expect(screen.queryByText("about page")).toBeNull();
    expect(waiting()).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "About" }));

    expect(waiting()).toBe(false);
    expect(screen.getByText("about page")).toBeTruthy();
  });
});
