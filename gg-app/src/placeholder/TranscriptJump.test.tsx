// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptJump } from "./TranscriptJump";

afterEach(cleanup);

function setup(away: boolean, hasNew: boolean, askAt: "above" | "below" | null = null) {
  const onScrollToBottom = vi.fn();
  const onJumpToNew = vi.fn();
  const onJumpToAsk = vi.fn();
  const view = render(
    <TranscriptJump
      away={away}
      hasNew={hasNew}
      askAt={askAt}
      onScrollToBottom={onScrollToBottom}
      onJumpToNew={onJumpToNew}
      onJumpToAsk={onJumpToAsk}
    />,
  );
  const toBottom = screen.queryByRole("button", { name: "Scroll to bottom" });
  const pill = screen.queryByRole("button", { name: /You have new chats/ });
  const askPill = screen.queryByRole("button", { name: /You have a new question/ });
  return { view, toBottom, pill, askPill, onScrollToBottom, onJumpToNew, onJumpToAsk };
}

describe("TranscriptJump", () => {
  it("shows nothing while following the newest output", () => {
    const { view } = setup(false, true);
    expect(view.container.firstChild).toBeNull();
  });

  it("offers scroll-to-bottom once scrolled up, and the new-chats pill only with new rows", () => {
    const quiet = setup(true, false);
    expect(quiet.toBottom).not.toBeNull();
    expect(quiet.pill).toBeNull();
    cleanup();

    const busy = setup(true, true);
    expect(busy.pill).not.toBeNull();
  });

  it("routes each button to its jump", () => {
    const { toBottom, pill, onScrollToBottom, onJumpToNew } = setup(true, true);
    toBottom?.click();
    pill?.click();
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
    expect(onJumpToNew).toHaveBeenCalledTimes(1);
  });

  it("shows the question pill whenever an open question is off screen, even at the bottom", () => {
    // Following the newest output (not scrolled up): the agent kept talking
    // after asking, so the question has scrolled away above.
    const { askPill, pill, toBottom, onJumpToAsk } = setup(false, false, "above");
    expect(askPill?.textContent).toContain("↑");
    expect(pill).toBeNull();
    expect(toBottom).toBeNull();
    askPill?.click();
    expect(onJumpToAsk).toHaveBeenCalledTimes(1);
  });

  it("puts the question ahead of new chats", () => {
    const { askPill, pill } = setup(true, true, "below");
    expect(askPill?.textContent).toContain("↓");
    expect(pill).toBeNull();
  });

  it("hides the question pill when the question is on screen or answered", () => {
    const { askPill } = setup(true, false, null);
    expect(askPill).toBeNull();
  });
});
