// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StatusPill, formatFor } from "./StatusPill";
import type { GoalStatus } from "./goal-status";

const reading: GoalStatus = {
  key: "tool:1",
  tone: "work",
  icon: "read",
  headline: "Reading search.ts",
  detail: "In src/server/rag",
  opens: false,
  thinking: false,
  timed: true,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("StatusPill", () => {
  it("says what the coordinator is doing, for how long, and where", () => {
    render(<StatusPill status={reading} />);
    const pill = screen.getByRole("status");
    expect(pill.textContent).toContain("Reading search.ts");
    expect(pill.textContent).toContain("In src/server/rag");
    wait(5_000);
    expect(pill.textContent).toContain("5s");
  });

  it("restarts its timer for a new moment", () => {
    const { rerender } = render(<StatusPill status={reading} />);
    wait(12_000);
    rerender(<StatusPill status={{ ...reading, key: "tool:2", headline: "Reading a.ts" }} />);
    wait(1_000);
    expect(screen.getByRole("status").textContent).toContain("1s");
    expect(screen.getByRole("status").textContent).not.toContain("13s");
  });

  it("notes a long think after a minute and a half", () => {
    const thinking: GoalStatus = {
      ...reading,
      key: "think:1",
      icon: "think",
      headline: "Thinking",
      detail: null,
      thinking: true,
    };
    render(<StatusPill status={thinking} />);
    wait(60_000);
    expect(screen.queryByText(/Long think/)).toBeNull();
    wait(31_000);
    expect(screen.getByText(/Long think/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("1m 31s");
  });

  it("marks a stopped goal as an error", () => {
    render(
      <StatusPill
        status={{
          ...reading,
          key: "stopped",
          tone: "error",
          icon: "error",
          headline: "Stopped",
          detail: "Overloaded",
          opens: true,
          timed: false,
        }}
      />,
    );
    expect(screen.getByRole("img", { name: "Stopped" }).getAttribute("data-tone")).toBe("error");
  });
});

describe("formatFor", () => {
  it("reads as seconds, then minutes and seconds, then minutes", () => {
    expect(formatFor(8_000)).toBe("8s");
    expect(formatFor(88_000)).toBe("1m 28s");
    expect(formatFor(754_000)).toBe("12m");
  });
});
