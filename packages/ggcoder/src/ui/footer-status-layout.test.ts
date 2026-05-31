import { describe, expect, it } from "vitest";
import { getFooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";
import { getFooterRightLength, getThinkingFooterLabel } from "./components/Footer.js";

describe("footer status layout decisions", () => {
  it("keeps a single wide row when footer status indicators are present", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 140,
        backgroundTaskCount: 2,
        updatePending: true,
      }),
    ).toEqual({
      hasBackgroundTasks: true,
      hasUpdateNotice: true,
      stack: false,
      compactBackgroundTasks: false,
    });
  });

  it("uses compact background task copy before stacking is needed", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 110,
        backgroundTaskCount: 1,
        updatePending: true,
      }),
    ).toMatchObject({
      stack: false,
      compactBackgroundTasks: true,
    });
  });

  it("stacks crowded status indicators on narrow terminals to avoid collisions", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 80,
        backgroundTaskCount: 1,
        updatePending: true,
      }),
    ).toEqual({
      hasBackgroundTasks: true,
      hasUpdateNotice: true,
      stack: true,
      compactBackgroundTasks: true,
    });
  });

  it("does not stack a lone update notice", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 60,
        backgroundTaskCount: 0,
        updatePending: true,
      }),
    ).toMatchObject({
      hasBackgroundTasks: false,
      hasUpdateNotice: true,
      stack: false,
    });
  });
});

describe("main footer mode layout", () => {
  it("labels the active thinking effort for the footer", () => {
    expect(getThinkingFooterLabel("medium")).toBe("Thinking medium");
    expect(getThinkingFooterLabel("high")).toBe("Thinking high");
    expect(getThinkingFooterLabel("xhigh")).toBe("Thinking xhigh");
  });

  it("labels thinking off in the footer when no effort is active", () => {
    expect(getThinkingFooterLabel(undefined)).toBe("Thinking off");
  });

  it("includes the Plan label plus separators in right-side width calculations", () => {
    const withoutModeWidth = 8 + 1 + 2 + 1 + 3 + "Sonnet".length + 3 + "Thinking off".length;

    expect(
      getFooterRightLength({
        barWidth: 8,
        contextPct: 12,
        modelName: "Sonnet",
        planText: "Plan on",
        thinkingText: "Thinking off",
      }),
    ).toBe(withoutModeWidth + 3 + "Plan on".length);
  });
});
