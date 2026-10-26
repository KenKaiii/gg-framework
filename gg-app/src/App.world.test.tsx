// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "./agent";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (scrollToDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("World", () => {
  it("opens over Home from its plate, and Back goes straight home", async () => {
    mockWindows("main");
    mockIPC((command) => {
      switch (command) {
        case "window_restore_target":
          return null; // no project: the window starts on Home
        case "sidecar_port":
          return 12345;
        case "plugin:log|log":
          return null;
        default:
          return new Promise(() => {});
      }
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "World" }));

    const frame = await screen.findByLabelText("World");
    expect(frame.getAttribute("src")).toBe("world/index.html");
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(frame.closest(".world-overlay")).not.toBeNull();
    expect(document.querySelector(".home")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.querySelector(".world-overlay")).toBeNull());
    expect(document.querySelector(".home")).not.toBeNull();
  });

  it("opens over a workspace from the Deck's World key, and Back returns to it", async () => {
    const cwd = "/workspaces/world";
    const state: AgentState = {
      cwd,
      mode: "code",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      running: false,
    };
    mockWindows("main");
    mockIPC((cmd) => {
      switch (cmd) {
        case "window_restore_target":
          return { mode: "code", cwd, sessionPath: null };
        case "sidecar_port":
          return 12345;
        case "agent_state":
          return state;
        case "agent_models":
          return { models: [{ id: state.model, provider: state.provider }] };
        case "agent_commands":
          return { commands: [] };
        case "agent_tasks":
          return { tasks: [] };
        case "agent_history":
          return { history: [] };
        case "agent_progress":
          return {
            level: 3,
            rankName: "Rookie",
            tier: 0,
            tierName: "Bronze",
            tierGlyph: "",
            effectId: "",
            xp: 120,
            xpIntoLevel: 20,
            xpForLevel: 100,
            percent: 20,
            streak: { current: 0, best: 0 },
            totals: { prompts: 0, commits: 0, linesShipped: 0, projects: 0 },
            xpBySource: { prompts: 0, commits: 0, streakBonus: 0 },
            memberSince: "2026-01-01",
            ladder: [],
            levelUp: null,
          };
        default:
          return new Promise(() => {});
      }
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Usage$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "World" }));

    const frame = await screen.findByLabelText("World");
    expect(frame.closest(".world-overlay")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.querySelector(".world-overlay")).toBeNull());
  });
});
