// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningSchedulesButton, type ActiveSchedule } from "./RunningSchedulesButton";
import { nextRunLabel } from "./schedule-labels";

function schedule(over: Partial<ActiveSchedule> = {}): ActiveSchedule {
  return {
    id: "s1",
    prompt: "check the railway logs and fix any issues",
    intervalMs: 15 * 60_000,
    runCount: null,
    nextRunAt: Date.now() + 5 * 60_000,
    runsCompleted: 0,
    ...over,
  };
}

afterEach(cleanup);

describe("nextRunLabel", () => {
  const now = 1_000_000;

  it("shows seconds under a minute so an imminent run visibly ticks", () => {
    expect(nextRunLabel(now + 42_000, now)).toBe("in 42s");
  });

  it("shows minutes under an hour", () => {
    expect(nextRunLabel(now + 12 * 60_000, now)).toBe("in 12m");
  });

  it("spells out hours and minutes past an hour", () => {
    expect(nextRunLabel(now + 90 * 60_000, now)).toBe("in 1 hr 30 min");
  });

  it("reports a due run rather than a negative countdown", () => {
    expect(nextRunLabel(now - 5_000, now)).toBe("due now");
  });
});

describe("RunningSchedulesButton", () => {
  it("pluralises the count", () => {
    const { unmount } = render(
      <RunningSchedulesButton schedules={[schedule()]} onStop={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /1 schedule$/ })).toBeTruthy();
    unmount();

    render(
      <RunningSchedulesButton schedules={[schedule(), schedule({ id: "s2" })]} onStop={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /2 schedules/ })).toBeTruthy();
  });

  it("keeps the popover closed until clicked", () => {
    render(<RunningSchedulesButton schedules={[schedule()]} onStop={vi.fn()} />);
    expect(document.querySelector(".schedules-menu")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("lists each schedule with its cadence when opened", () => {
    render(<RunningSchedulesButton schedules={[schedule()]} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/ }));
    expect(screen.getByText(/check the railway logs/)).toBeTruthy();
    expect(screen.getByText(/Every 15 min · until stopped/)).toBeTruthy();
  });

  it("shows run progress for a bounded schedule", () => {
    render(
      <RunningSchedulesButton
        schedules={[schedule({ runCount: 10, runsCompleted: 3 })]}
        onStop={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule/ }));
    expect(screen.getByText(/10 runs · 3\/10/)).toBeTruthy();
  });

  it("stops a schedule by id", () => {
    const onStop = vi.fn();
    render(<RunningSchedulesButton schedules={[schedule({ id: "abc" })]} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Stop schedule: check the railway logs/ }));
    expect(onStop).toHaveBeenCalledWith("abc");
  });

  it("truncates a long prompt but keeps the full text as a tooltip", () => {
    const long = "a".repeat(120);
    render(<RunningSchedulesButton schedules={[schedule({ prompt: long })]} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/ }));
    const cell = document.querySelector(".bgtasks-cmd");
    expect(cell?.textContent?.length).toBeLessThan(60);
    expect(cell?.getAttribute("title")).toBe(long);
  });
});
