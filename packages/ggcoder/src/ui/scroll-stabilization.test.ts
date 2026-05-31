import { describe, expect, it } from "vitest";
import {
  getScrollStabilizationDecision,
  getStaticHistoryKey,
  isTallLiveUserMessage,
} from "./layout-decisions.js";

describe("getScrollStabilizationDecision", () => {
  it("preserves Static and disables auto-follow when the user is intentionally scrolled and output arrives", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: true,
        hasNewOutput: true,
      }),
    ).toEqual({ preserveStatic: true, autoFollow: false });
  });

  it("keeps normal auto-follow behavior at the bottom for short prompts, queued messages, and live updates", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: false,
        hasNewOutput: true,
      }),
    ).toEqual({ preserveStatic: false, autoFollow: true });
  });

  it("stabilizes while a tall live user prompt is rendered so it remains scrollable during agent work", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: false,
        hasNewOutput: true,
        hasTallLiveUserMessage: true,
      }),
    ).toEqual({ preserveStatic: true, autoFollow: false });
  });

  it("does not stabilize a tall live user prompt after agent output stops", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: false,
        hasNewOutput: false,
        hasTallLiveUserMessage: true,
      }),
    ).toEqual({ preserveStatic: false, autoFollow: false });
  });

  it("keeps the Static history key independent of scroll stabilization state", () => {
    const before = getScrollStabilizationDecision({
      isUserScrolled: false,
      hasNewOutput: true,
      hasTallLiveUserMessage: false,
    });
    const duringTallPrompt = getScrollStabilizationDecision({
      isUserScrolled: false,
      hasNewOutput: true,
      hasTallLiveUserMessage: true,
    });
    const after = getScrollStabilizationDecision({
      isUserScrolled: false,
      hasNewOutput: false,
      hasTallLiveUserMessage: false,
    });

    expect(before.preserveStatic).toBe(false);
    expect(duringTallPrompt.preserveStatic).toBe(true);
    expect(after.preserveStatic).toBe(false);
    expect(getStaticHistoryKey({ resizeKey: 10 })).toBe("10");
    expect(getStaticHistoryKey({ resizeKey: 10 })).toBe("10");
  });

  it("classifies only multi-line prompts tall enough to occupy most of the terminal", () => {
    expect(
      isTallLiveUserMessage(Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n"), 20),
    ).toBe(true);
    expect(isTallLiveUserMessage("short prompt", 20)).toBe(false);
    expect(
      isTallLiveUserMessage(Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n"), 20),
    ).toBe(false);
  });

  it("does not request stabilization when no new output is rendered", () => {
    expect(
      getScrollStabilizationDecision({
        isUserScrolled: true,
        hasNewOutput: false,
      }),
    ).toEqual({ preserveStatic: false, autoFollow: false });
  });
});
