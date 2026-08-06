// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getSubscriptionUsage } from "./agent";
import { TitleUsageMeter } from "./TitleUsageMeter";
import { compactResetLabel } from "./usage-display";

vi.mock("./agent", () => ({ getSubscriptionUsage: vi.fn() }));

const getUsageMock = vi.mocked(getSubscriptionUsage);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TitleUsageMeter", () => {
  it("shows the active provider's current window and toggles to weekly", async () => {
    getUsageMock.mockResolvedValue({
      provider: "openai",
      displayName: "Codex",
      connected: true,
      windows: [
        { kind: "current", label: "5-hour", usedPercent: 22 },
        { kind: "weekly", label: "Weekly", usedPercent: 48 },
      ],
      fetchedAt: Date.now(),
    });

    render(<TitleUsageMeter currentProvider="openai" />);

    const meter = await screen.findByRole("button", { name: /Codex 5-hour: 22% used/ });
    expect(screen.getByText("5h")).toBeDefined();
    expect(meter.querySelector<HTMLElement>(".title-usage-fill")?.style.width).toBe("22%");
    fireEvent.click(meter);
    await waitFor(() => expect(screen.getByText("week")).toBeDefined());
    expect(meter.querySelector<HTMLElement>(".title-usage-fill")?.style.width).toBe("48%");
    expect(meter.getAttribute("aria-pressed")).toBe("true");
    expect(getUsageMock).toHaveBeenCalledWith("openai");
  });

  it("refreshes a partial Anthropic snapshot when the window regains focus", async () => {
    const baseSnapshot = {
      provider: "anthropic" as const,
      displayName: "Anthropic",
      connected: true,
      fetchedAt: Date.now(),
    };
    getUsageMock
      .mockResolvedValueOnce({
        ...baseSnapshot,
        windows: [
          { kind: "current", label: "5-hour", usedPercent: 18 },
          { kind: "weekly", label: "Weekly", usedPercent: 37 },
        ],
      })
      .mockResolvedValue({
        ...baseSnapshot,
        windows: [
          {
            kind: "current",
            label: "5-hour",
            usedPercent: 18,
            resetsAt: Date.now() + 90 * 60_000,
          },
          {
            kind: "weekly",
            label: "Weekly",
            usedPercent: 37,
            resetsAt: Date.now() + 72 * 60 * 60_000,
          },
        ],
      });

    render(<TitleUsageMeter currentProvider="anthropic" />);

    await waitFor(() => expect(screen.getByText("—")).toBeDefined());
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.getByText("1h 30m")).toBeDefined());
    expect(getUsageMock).toHaveBeenCalledTimes(2);
  });

  it("toggles a weekly-only Codex response to a truthful unavailable short-term view", async () => {
    getUsageMock.mockResolvedValue({
      provider: "openai",
      displayName: "Codex",
      connected: true,
      windows: [
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 11,
          resetsAt: Date.now() + 6 * 24 * 60 * 60_000,
        },
      ],
      unavailableWindowKinds: ["current"],
      fetchedAt: Date.now(),
    });

    render(<TitleUsageMeter currentProvider="openai" />);

    const meter = await screen.findByRole("button", { name: /Codex Weekly: 11% used/ });
    expect(screen.getByText("week")).toBeDefined();
    expect(screen.queryByText("168h")).toBeNull();
    expect(meter.querySelector<HTMLElement>(".title-usage-fill")?.style.width).toBe("11%");

    fireEvent.click(meter);
    await screen.findByRole("button", { name: /Codex Short-term: usage unavailable/ });
    expect(screen.getByText("short")).toBeDefined();
    expect(screen.getByText("unavailable")).toBeDefined();
    expect(meter.querySelector(".title-usage-fill")).toBeNull();
    expect(meter.className).toContain("is-unavailable");

    fireEvent.click(meter);
    await screen.findByRole("button", { name: /Codex Weekly: 11% used/ });
  });

  it("labels a preserved Codex short-term window as last known", async () => {
    getUsageMock.mockResolvedValue({
      provider: "openai",
      displayName: "Codex",
      connected: true,
      windows: [
        { kind: "current", label: "5-hour", usedPercent: 22 },
        { kind: "weekly", label: "Weekly", usedPercent: 48 },
      ],
      unavailableWindowKinds: ["current"],
      staleWindowKinds: ["current"],
      fetchedAt: Date.now(),
    });

    render(<TitleUsageMeter currentProvider="openai" />);

    const meter = await screen.findByRole("button", {
      name: /Codex 5-hour: 22% used.*last known.*not included in the latest response/,
    });
    expect(meter.className).toContain("is-stale");
    fireEvent.click(meter);
    await screen.findByRole("button", { name: /Codex Weekly: 48% used/ });
  });

  it("keeps the last good snapshot when a refresh comes back unavailable", async () => {
    getUsageMock
      .mockResolvedValueOnce({
        provider: "openai",
        displayName: "Codex",
        connected: true,
        windows: [{ kind: "current", label: "5-hour", usedPercent: 22 }],
        fetchedAt: Date.now(),
      })
      .mockResolvedValue({
        provider: "openai",
        displayName: "Codex",
        connected: true,
        windows: [],
        fetchedAt: Date.now(),
        error: "Usage is temporarily unavailable.",
      });

    render(<TitleUsageMeter currentProvider="openai" />);

    await screen.findByRole("button", { name: /Codex 5-hour: 22% used/ });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(getUsageMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Codex 5-hour: 22% used/ })).toBeDefined();
  });

  it("marks a replayed snapshot as last-known rather than live", async () => {
    getUsageMock.mockResolvedValue({
      provider: "openai",
      displayName: "Codex",
      connected: true,
      windows: [{ kind: "current", label: "5-hour", usedPercent: 22 }],
      fetchedAt: Date.now(),
      stale: true,
    });

    render(<TitleUsageMeter currentProvider="openai" />);

    const meter = await screen.findByRole("button", { name: /last known/ });
    expect(meter.className).toContain("is-stale");
  });

  it("hides when the provider is no longer connected", async () => {
    getUsageMock
      .mockResolvedValueOnce({
        provider: "openai",
        displayName: "Codex",
        connected: true,
        windows: [{ kind: "current", label: "5-hour", usedPercent: 22 }],
        fetchedAt: Date.now(),
      })
      .mockResolvedValue({
        provider: "openai",
        displayName: "Codex",
        connected: false,
        windows: [],
        fetchedAt: Date.now(),
      });

    const { container } = render(<TitleUsageMeter currentProvider="openai" />);
    await screen.findByRole("button", { name: /Codex 5-hour: 22% used/ });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("stays hidden for providers without subscription quota support", () => {
    const { container } = render(<TitleUsageMeter currentProvider="gemini" />);
    expect(container.firstChild).toBeNull();
    expect(getUsageMock).not.toHaveBeenCalled();
  });
});

describe("compactResetLabel", () => {
  it("formats current and weekly countdowns", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(compactResetLabel(now + 95 * 60_000, now)).toBe("1h 35m");
    expect(compactResetLabel(now + (2 * 24 + 3) * 60 * 60_000, now)).toBe("2d 3h");
  });
});
