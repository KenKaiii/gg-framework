// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { theme } from "./theme";
import { INITIAL_ACTIVITY, type TaskActivity, type TaskPhase } from "./task-activity";
import { describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./ActivityBar";

const baseProps = {
  running: true,
  tokens: 0,
  doneStatus: null,
  isThinking: false,
  thinkingStartTs: null,
  thinkingAccumMs: 0,
};

describe("ActivityBar plan progress", () => {
  it("shows approved-plan progress only while a run is active", () => {
    const { rerender } = render(<ActivityBar {...baseProps} planTotal={3} planDone={2} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();

    rerender(<ActivityBar {...baseProps} planTotal={3} planDone={3} />);
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.queryByText("3/3")).toBeNull();

    rerender(<ActivityBar {...baseProps} running={false} planTotal={3} planDone={2} />);
    expect(screen.queryByText("Plan")).toBeNull();
  });
});

const glyphOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".activity-glyph");

describe("ActivityBar glyph", () => {
  it("leads with a live work glyph while running and a still idle glyph when ready", () => {
    const { container, rerender } = render(<ActivityBar {...baseProps} isThinking />);
    expect(glyphOf(container)?.dataset.glyph).toBe("work");
    expect(glyphOf(container)?.hasAttribute("data-live")).toBe(true);
    expect(glyphOf(container)?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Working…").classList.contains("shimmer-text")).toBe(true);

    rerender(<ActivityBar {...baseProps} running={false} />);
    expect(glyphOf(container)?.dataset.glyph).toBe("idle");
    expect(glyphOf(container)?.hasAttribute("data-live")).toBe(false);
  });

  it.each([
    ["Thinking…", "think"],
    ["Writing a response…", "write"],
    ["Reading the relevant code…", "read"],
    ["Editing the code…", "edit"],
    ["Consulting reference material…", "web"],
    ["Executing a command…", "run"],
    ["Running verification…", "check"],
    ["Agents working…", "agents"],
    ["Keeping the task context…", "context"],
  ] as const)("shows %s as the %s glyph", (label, glyph) => {
    const { container } = render(
      <ActivityBar {...baseProps} activity={{ ...INITIAL_ACTIVITY, phase: "working", label }} />,
    );
    expect(glyphOf(container)?.dataset.glyph).toBe(glyph);
  });

  it("keeps elapsed and token wells in place before the first token arrives", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        activity={{ ...INITIAL_ACTIVITY, phase: "working", label: "Thinking…", startedAt: 1 }}
      />,
    );
    const tokens = container.querySelector<HTMLElement>(".activity-token-count");
    expect(container.querySelector(".activity-elapsed")).toBeTruthy();
    expect(tokens?.style.visibility).toBe("hidden");
  });
});

describe("ActivityBar task outcomes", () => {
  it("shows earlier workspace warnings separately without relabelling the current answer", () => {
    const activity = {
      ...INITIAL_ACTIVITY,
      phase: "done" as const,
      label: "Response ready",
      startedAt: 6,
      endedAt: 1000,
      workspaceWarning: "Earlier checks failed",
    };
    const { container, rerender } = render(
      <ActivityBar {...baseProps} running={false} activity={activity} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Answer ready. GG.");
    expect(screen.getByText("Earlier checks failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel agent run" })).toBeNull();
    const label = container.querySelector(".activity-label-reveal");
    rerender(
      <ActivityBar {...baseProps} running={false} activity={{ ...activity, tokens: 1000 }} />,
    );
    expect(container.querySelector(".activity-label-reveal")).toBe(label);
    expect(screen.getByText("Earlier checks failed")).toBeTruthy();
  });
  it("does not show the previous success while a new request is starting", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={true}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "done",
          endedAt: 1000,
          label: "Done · checks passed",
        }}
      />,
    );
    expect(screen.getByText("Starting…")).toBeTruthy();
    expect(screen.queryByText("Checks passed")).toBeNull();
    expect(glyphOf(container)?.dataset.glyph).toBe("start");
    expect(container.querySelector(".activity-meta")).toBeNull();
  });

  it("shows a failed stop in red without pretending the run has stopped", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "working",
          label: "Cancellation failed · task still running",
        }}
      />,
    );
    expect(screen.getByText("Stop failed").style.getPropertyValue("--shimmer-base")).toBe(
      theme.error,
    );
    expect(glyphOf(container)?.dataset.glyph).toBe("warn");
    expect(glyphOf(container)?.style.color).toBe(theme.error);
  });

  it.each([
    ["done", "Done · checks passed", "Checks passed. Nice.", theme.success],
    ["failed", "Checks failed", "A check failed", theme.error],
    ["failed", "Task failed", "Run hit a snag", theme.error],
    ["unverified", "Changed · verification incomplete", "Checks still needed", theme.warning],
    ["attention", "Your decision needed", "Your call from here", theme.warning],
    ["stopped", "Stopped · unfinished", "Stopped. Not finished", theme.warning],
  ] as const)("pairs %s color with a readable status", (phase, label, compact, color) => {
    render(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{ ...INITIAL_ACTIVITY, phase, label }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(compact);
    const expected = document.createElement("span");
    expected.style.color = color;
    expect(screen.getByText(compact).style.color).toBe(expected.style.color);
  });

  it("reveals changed labels without remounting the glyph well or replaying on usage updates", () => {
    const activity = { ...INITIAL_ACTIVITY, phase: "working" as const, label: "Thinking…" };
    const { container, rerender } = render(<ActivityBar {...baseProps} activity={activity} />);
    const region = screen.getByRole("status");
    const well = glyphOf(container);
    const art = container.querySelector(".activity-glyph-art");
    const thinking = container.querySelector(".activity-label-reveal");
    rerender(<ActivityBar {...baseProps} activity={{ ...activity, tokens: 100 }} />);
    expect(container.querySelector(".activity-label-reveal")).toBe(thinking);
    expect(container.querySelector(".activity-glyph-art")).toBe(art);

    rerender(
      <ActivityBar {...baseProps} activity={{ ...activity, label: "Writing a response…" }} />,
    );
    const writing = container.querySelector(".activity-label-reveal");
    expect(writing).not.toBe(thinking);
    expect(writing?.textContent).toBe("Writing…");
    expect(glyphOf(container)).toBe(well);
    expect(well?.dataset.glyph).toBe("write");
    expect(screen.getByRole("status")).toBe(region);

    rerender(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{ ...activity, phase: "done", label: "Done · checks passed" }}
      />,
    );
    expect(container.querySelector(".activity-label-reveal")).not.toBe(writing);
    expect(region.textContent).toContain("Checks passed");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(glyphOf(container)?.dataset.glyph).toBe("done");
    expect(glyphOf(container)?.hasAttribute("data-live")).toBe(false);
  });

  it("keeps the live glyph and shimmer while Ken reviews without an active builder", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "reviewing",
          label: "Ken reviewing…",
          startedAt: 100,
        }}
      />,
    );
    expect(glyphOf(container)?.dataset.glyph).toBe("review");
    expect(glyphOf(container)?.hasAttribute("data-live")).toBe(true);
    expect(screen.getByText("Ken reviewing…").classList.contains("shimmer-text")).toBe(true);
    expect(screen.queryByText("Response ready")).toBeNull();
  });
  it("shows a compact outcome and metrics without a details panel", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={false}
        doneStatus="Brewed a response in 32s"
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "unverified",
          label: "Changed · verification incomplete",
          detail: "Run the missing tests before using the changes.",
          startedAt: 1000,
          endedAt: 33000,
          tokens: 1300,
        }}
      />,
    );
    expect(screen.queryByText(/Brewed/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("No passing check yet");
    expect(screen.getByRole("status").textContent).not.toContain("tokens");
    expect(container.querySelector(".activity-elapsed")?.textContent).toBe("32s");
    expect(screen.getByTitle("Output tokens").textContent).toBe("1.3k tok");
    expect(glyphOf(container)?.dataset.glyph).toBe("check");
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Run the missing tests before using the changes.")).toBeNull();
    expect(container.querySelector(".activity-details")).toBeNull();
  });
  it("stops animation while waiting for a decision", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "attention",
          label: "Your decision needed",
          detail: "Answer in chat.",
        }}
      />,
    );
    expect(glyphOf(container)?.dataset.glyph).toBe("ask");
    expect(glyphOf(container)?.hasAttribute("data-live")).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Your call from here");
  });
});

describe("ActivityBar cancellation state", () => {
  it("has no Stop of its own: the composer's send key stops runs and reviews", () => {
    const { rerender } = render(<ActivityBar {...baseProps} />);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    const well = screen.getByRole("status").querySelector(".activity-glyph");
    expect(well?.getAttribute("aria-hidden")).toBe("true");
    rerender(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "reviewing",
          label: "Ken is reviewing",
          startedAt: 1,
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("says the task is stopping while cancellation settles", () => {
    render(<ActivityBar {...baseProps} cancelling />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});

describe("ActivityBar outcome glyphs", () => {
  const settled = (
    phase: TaskPhase,
    label: string,
    extra: Partial<TaskActivity> = {},
  ): TaskActivity => ({
    ...INITIAL_ACTIVITY,
    phase,
    label,
    startedAt: 1,
    endedAt: 2,
    ...extra,
  });

  it.each([
    ["done", settled("done", "Done · checks passed"), "done", theme.success],
    ["stopped", settled("stopped", "Stopped · unfinished"), "stop", theme.warning],
    ["needs you", settled("attention", "Your decision needed"), "ask", theme.warning],
    ["checks failed", settled("failed", "Checks failed"), "check", theme.error],
    ["run failed", settled("failed", "Task failed"), "fail", theme.error],
    ["unchecked edits", settled("done", "Changes saved"), "edit", theme.success],
  ] as const)("%s says so in its colour, led by its glyph", (_name, activity, glyph, colour) => {
    const { container } = render(
      <ActivityBar {...baseProps} running={false} activity={activity} />,
    );
    const left = container.querySelector(".statusrow-left");
    const lead = left?.firstElementChild as HTMLElement | null;
    expect(lead?.dataset.glyph).toBe(glyph);
    expect(lead?.style.color).toBe(colour);
    const words = left?.querySelector<HTMLElement>(".activity-label-reveal > span");
    expect(words?.style.color).toBe(colour);
  });
});

describe("ActivityBar check count", () => {
  it("says how many checks passed", () => {
    render(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "done",
          label: "Done · checks passed",
          verification: "passed",
          verifiedChecks: 3,
          startedAt: 6,
          endedAt: 9,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("3 checks passed. Nice.");
  });
});

describe("ActivityBar timer", () => {
  it("keeps counting from the run's start when the chat is hidden and shown again", async () => {
    // Regression: going to a goal's Workers view and back restarted the timer
    // at 0s, because the bar took a fresh start when its effects re-ran.
    const { Activity } = await import("react");
    const { act } = await import("@testing-library/react");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const startedAt = 100_000;
      const view = (shown: boolean) => (
        <Activity mode={shown ? "visible" : "hidden"}>
          <ActivityBar {...baseProps} runStartedAt={startedAt} />
        </Activity>
      );
      const { rerender, container } = render(view(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(24_000);
      });
      expect(container.textContent).toContain("24s");
      rerender(view(false));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      rerender(view(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(container.textContent).toContain("30s");
    } finally {
      vi.useRealTimers();
    }
  });
});
