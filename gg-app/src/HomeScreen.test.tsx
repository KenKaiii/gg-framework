// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { error as logError } from "@tauri-apps/plugin-log";
import { authStatus, getSettings } from "./agent";
import { HomeScreen } from "./HomeScreen";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(async () => undefined) }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.0.0") }));
vi.mock("./AsciiLogo", () => ({ AsciiLogo: () => null }));
vi.mock("./HomeScenery", () => ({ HomeScenery: () => null, withScenery: (b: unknown) => b }));
vi.mock("./HomeCritters", () => ({ HomeCritters: () => null }));
vi.mock("./RankBadge", () => ({ RankBadge: () => null }));
vi.mock("./ScorecardModal", () => ({ ScorecardModal: () => null }));
vi.mock("./update", () => ({ useAppUpdate: () => ({ status: "idle" }) }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  waitForReady: vi.fn(async () => undefined),
  getSettings: vi.fn(),
  authStatus: vi.fn(),
  openWhatsNewWindow: vi.fn(),
  getProgress: vi.fn(async () => null),
  setRemoteActive: vi.fn(),
  getServeStatus: vi.fn(async () => ({ running: false })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeScreen", () => {
  it("logs a failed setup check instead of swallowing it", async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error("settings unreadable"));
    vi.mocked(authStatus).mockResolvedValue([]);

    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith("Home setup check failed: Error: settings unreadable"),
    );
    expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers Motion beside Code and Chat and opens it once set up", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(authStatus).mockResolvedValue([
      {
        value: "anthropic",
        label: "Anthropic",
        description: "",
        methods: [],
        connected: true,
        connectedMethods: [],
      },
    ]);
    const onMotion = vi.fn();

    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={onMotion}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const motion = screen.getByRole("button", { name: "Motion" });
    expect(screen.getByRole("button", { name: "Code" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Chat" })).toBeDefined();
    await waitFor(() => expect(motion.getAttribute("aria-disabled")).toBeNull());

    fireEvent.click(motion);

    expect(onMotion).toHaveBeenCalledOnce();
  });

  it("orders the workspaces Code, Goals, Chat, Motion and opens Goals", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(authStatus).mockResolvedValue([
      {
        value: "anthropic",
        label: "Anthropic",
        description: "",
        methods: [],
        connected: true,
        connectedMethods: [],
      },
    ]);
    const onGoals = vi.fn();

    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={onGoals}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const names = ["Code", "Goals", "Chat", "Motion"];
    const buttons = names.map((name) => screen.getByRole("button", { name }));
    for (let i = 1; i < buttons.length; i++) {
      const prev = buttons[i - 1];
      const next = buttons[i];
      if (!prev || !next) throw new Error("missing workspace button");
      expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const goals = screen.getByRole("button", { name: "Goals" });
    await waitFor(() => expect(goals.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(goals);
    expect(onGoals).toHaveBeenCalledOnce();
  });

  it("shows the running version beside What's new, not in the update corner", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(authStatus).mockResolvedValue([]);

    const { container } = render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const version = await screen.findByText("v1.0.0");
    const row = version.closest(".home-version-row");
    expect(row?.classList.contains("is-pending")).toBe(false);
    expect(row?.querySelector("button")?.textContent).toBe("What's new");
    // With no update out, the top corner stays empty.
    expect(container.querySelector(".home-version-corner")?.childElementCount).toBe(0);
  });

  it("shows Goals with no Beta tag and leaves the byline to Settings", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "/workspaces", configured: true });
    vi.mocked(authStatus).mockResolvedValue([]);

    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const goals = await screen.findByRole("button", { name: "Goals" });
    expect(goals.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.queryByText("In beta")).toBeNull();
    expect(screen.queryByText(/By Ken Kai/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Skool" })).toBeNull();
    expect(screen.getByRole("button", { name: "Motion" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Code" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Chat" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
  });

  it("offers World after Motion, never dimmed, and enters it", async () => {
    // No folder and no provider: the workspace modes are dimmed, World isn't.
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "", configured: false });
    vi.mocked(authStatus).mockResolvedValue([]);
    const onWorld = vi.fn();
    render(
      <HomeScreen
        onProjects={vi.fn()}
        onGoals={vi.fn()}
        onChat={vi.fn()}
        onMotion={vi.fn()}
        onWorld={onWorld}
        onSettings={vi.fn()}
      />,
    );
    const motion = screen.getByRole("button", { name: "Motion" });
    const world = screen.getByRole("button", { name: "World" });
    expect(motion.compareDocumentPosition(world) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(motion.getAttribute("aria-disabled")).toBe("true"));
    expect(world.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(world);
    await waitFor(() => expect(onWorld).toHaveBeenCalledOnce());
  });

  it("holds the World plate down from the click until World is on screen", async () => {
    vi.mocked(getSettings).mockResolvedValue({ projectsRoot: "", configured: false });
    vi.mocked(authStatus).mockResolvedValue([]);
    const props = {
      onProjects: vi.fn(),
      onGoals: vi.fn(),
      onChat: vi.fn(),
      onMotion: vi.fn(),
      onWorld: vi.fn(),
      onSettings: vi.fn(),
    };
    const { rerender } = render(<HomeScreen {...props} />);
    const world = screen.getByRole("button", { name: "World" });
    expect(world.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(world);
    await waitFor(() => expect(props.onWorld).toHaveBeenCalledOnce());
    expect(world.getAttribute("aria-busy")).toBe("true");
    rerender(<HomeScreen {...props} worldShown />);
    await waitFor(() => expect(world.getAttribute("aria-busy")).toBeNull());
  });
});
