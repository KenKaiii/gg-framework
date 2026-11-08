// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  distanceFromBottom,
  followsOutput,
  isHiddenScroller,
  pinAfterScroll,
  pinAfterTouchScroll,
  pinAfterWheel,
  showJumpToLatest,
} from "./transcript-pin";

/**
 * A transcript as App drives it, minus the DOM (jsdom has no layout).
 *
 * Browser half: the offset clamps to `scrollHeight - clientHeight`, and a
 * scroll event fires only when the offset actually moved. App half: the
 * scroll and wheel handlers feed the pin rules, and every streaming commit
 * re-pins to the bottom while pinned (StreamingMarkdown → maybeScrollToBottom,
 * ~30 times a second), recording the offset it left as the next scroll
 * event's baseline.
 */
function liveTranscript(content = 2000, viewport = 400) {
  const el = { scrollTop: 0, scrollHeight: content, clientHeight: viewport };
  let pinned = true;
  let lastTop = 0;
  // A finger on the transcript, or the momentum it left behind (iPhone).
  let held = false;
  const maxTop = (): number => Math.max(0, el.scrollHeight - el.clientHeight);
  const settle = (top: number): void => {
    const next = Math.min(Math.max(top, 0), maxTop());
    if (next === el.scrollTop) return;
    el.scrollTop = next;
    pinned = pinAfterScroll(pinned, lastTop, el);
    lastTop = el.scrollTop;
  };
  const toBottom = (): void => {
    el.scrollTop = maxTop();
    lastTop = el.scrollTop;
  };
  toBottom();
  return {
    get pinned(): boolean {
      return pinned;
    },
    get distance(): number {
      return distanceFromBottom(el);
    },
    get jumpChip(): boolean {
      return showJumpToLatest(pinned, el);
    },
    /** One streaming commit: the reply grows, then App re-pins if following. */
    commit(grow = 12): void {
      el.scrollHeight += grow;
      if (followsOutput(pinned, held)) toBottom();
    },
    /** A finger lands on the transcript. Touch scrolls fire no wheel events. */
    touch(): void {
      held = true;
    },
    /** The finger lifts and any momentum settles; App then catches up if following. */
    release(): void {
      held = false;
      if (followsOutput(pinned, held)) toBottom();
    },
    /** A vertical wheel/trackpad step: App reads the intent, then the browser scrolls. */
    wheel(deltaY: number): void {
      pinned = pinAfterWheel(pinned, { deltaX: 0, deltaY, ctrlKey: false }, el);
      settle(el.scrollTop + deltaY);
    },
    /** A move with no wheel at all: scrollbar drag, arrow keys, find-in-page. */
    drag(dy: number): void {
      settle(el.scrollTop + dy);
    },
    /** Content under the reader gets shorter (a reply past 8 KB folds its tail away). */
    shrinkContent(px: number): void {
      el.scrollHeight -= px;
      settle(el.scrollTop);
    },
    /** A panel below the transcript closes, handing its height to the viewport. */
    growViewport(px: number): void {
      el.clientHeight += px;
      settle(el.scrollTop);
    },
  };
}

type LiveTranscript = ReturnType<typeof liveTranscript>;

describe("scrolling up while a reply streams", () => {
  it.each([
    ["a slow trackpad glide", 12, -8],
    ["one mouse-wheel notch", 1, -40],
    ["a fast flick", 1, -120],
  ])("%s leaves the reader where they scrolled", (_name, steps, deltaY) => {
    const t = liveTranscript();

    for (let i = 0; i < steps; i++) {
      t.wheel(deltaY);
      t.commit();
    }

    expect(t.pinned).toBe(false);
    expect(t.distance).toBeGreaterThanOrEqual(steps * -deltaY);
  });

  it("escapes on a scrollbar drag or arrow key, with no wheel involved", () => {
    const t = liveTranscript();

    t.drag(-30);
    t.commit();

    expect(t.pinned).toBe(false);
    expect(t.distance).toBeGreaterThanOrEqual(30);
  });

  it("resumes following once the reader scrolls back down near the bottom", () => {
    const t = liveTranscript();
    t.wheel(-200);
    t.commit();

    t.wheel(t.distance - 20);
    t.commit();

    expect(t.pinned).toBe(true);
    expect(t.distance).toBe(0);
  });
});

// Layout can move the offset too: when the content under the viewport gets
// shorter, the browser clamps the offset to the new bottom and fires a scroll
// event the reader never asked for.
const RELAYOUTS: [string, (t: LiveTranscript) => void][] = [
  ["the reply folds its tail away", (t) => t.shrinkContent(150)],
  ["the tool panel below the transcript closes", (t) => t.growViewport(150)],
];

describe("layout moving the offset", () => {
  it.each(RELAYOUTS)("%s: a reader who scrolled up is not dragged back", (_name, relayout) => {
    const t = liveTranscript();
    t.wheel(-100);

    relayout(t);
    t.commit(30);

    expect(t.pinned).toBe(false);
    expect(t.distance).toBe(30);
  });

  it.each(RELAYOUTS)("%s: a following reader keeps following", (_name, relayout) => {
    const t = liveTranscript();

    relayout(t);
    t.commit(30);

    expect(t.pinned).toBe(true);
    expect(t.distance).toBe(0);
  });

  it("follows again once the content shrinks to fit, e.g. the conversation is cleared", () => {
    const t = liveTranscript();
    t.wheel(-100);

    t.shrinkContent(1700);
    t.commit(200);

    expect(t.pinned).toBe(true);
    expect(t.distance).toBe(0);
  });
});

// iPhone: touch scrolling. iOS applies a script's scroll on top of the pan, so
// a commit that re-pins mid-drag yanks the page out from under the finger.
describe("a finger on the transcript while a reply streams", () => {
  it("is never scrolled out from under, even before it moves", () => {
    const t = liveTranscript();

    t.touch();
    t.commit();
    t.commit();

    expect(t.distance).toBe(24);
  });

  it("un-pins on a small drag up, with no wheel involved", () => {
    const t = liveTranscript();

    t.touch();
    t.drag(-6);
    t.commit();
    t.release();
    t.commit();

    expect(t.pinned).toBe(false);
    expect(t.distance).toBeGreaterThanOrEqual(6);
  });

  it("catches up on release when the reader never scrolled away", () => {
    const t = liveTranscript();

    t.touch();
    t.commit(40);
    t.release();

    expect(t.pinned).toBe(true);
    expect(t.distance).toBe(0);
  });

  it("resumes following after dragging back down to the bottom", () => {
    const t = liveTranscript();
    t.touch();
    t.drag(-300);
    t.commit();

    t.drag(t.distance);
    t.release();
    t.commit();

    expect(t.pinned).toBe(true);
    expect(t.distance).toBe(0);
  });
});

describe("jump to latest", () => {
  it("shows once the reader has scrolled away from new output", () => {
    const t = liveTranscript();

    t.touch();
    t.drag(-200);
    t.release();

    expect(t.jumpChip).toBe(true);
  });

  it("stays hidden while following, even as a reply streams", () => {
    const t = liveTranscript();

    t.commit(30);
    t.commit(30);

    expect(t.jumpChip).toBe(false);
  });

  it("stays hidden for a nudge that leaves the newest line on screen", () => {
    const t = liveTranscript();

    t.touch();
    t.drag(-20);
    t.release();

    expect(t.pinned).toBe(false);
    expect(t.jumpChip).toBe(false);
  });
});

describe("wheel intent", () => {
  const atBottom = { scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 };
  const up = { deltaX: 0, deltaY: -40, ctrlKey: false };
  const down = { deltaX: 0, deltaY: 40, ctrlKey: false };

  it("ignores the vertical noise of a sideways swipe across a wide table", () => {
    expect(pinAfterWheel(true, { deltaX: -30, deltaY: -3, ctrlKey: false }, atBottom)).toBe(true);
  });

  it("ignores a pinch-zoom, which arrives as a ctrl+wheel", () => {
    expect(pinAfterWheel(true, { ...up, ctrlKey: true }, atBottom)).toBe(true);
  });

  it("does not un-pin a transcript too short to scroll", () => {
    const short = { scrollTop: 0, scrollHeight: 300, clientHeight: 400 };

    expect(pinAfterWheel(true, up, short)).toBe(true);
  });

  it("resumes following on a wheel down at the very bottom, where no scroll event follows", () => {
    expect(pinAfterWheel(false, down, atBottom)).toBe(true);
  });

  it("does not resume following on a wheel down far above the bottom", () => {
    const farUp = { ...atBottom, scrollTop: 200 };

    expect(pinAfterWheel(false, down, farUp)).toBe(false);
  });
});

// iPhone: a scroll container's offset is settled by the UI process, so a
// stale offset can arrive right after the app jumps to the bottom. It reads
// as "scrolled up", but no finger was on the glass.
describe("touch-only un-pinning (iPhone)", () => {
  const afterSend = { scrollTop: 3459, scrollHeight: 3950, clientHeight: 434 };

  it("keeps following through a scroll no finger made", () => {
    expect(pinAfterTouchScroll(true, 3516, afterSend, false)).toBe(true);
  });

  it("still un-pins when a finger scrolls up", () => {
    expect(pinAfterTouchScroll(true, 3516, afterSend, true)).toBe(false);
  });

  it("still re-pins when a fling carries the reader back to the bottom", () => {
    const nearBottom = { scrollTop: 3500, scrollHeight: 3950, clientHeight: 434 };

    expect(pinAfterTouchScroll(false, 3400, nearBottom, true)).toBe(true);
  });

  it("does not re-pin from a scroll no finger made", () => {
    const nearBottom = { scrollTop: 3500, scrollHeight: 3950, clientHeight: 434 };

    expect(pinAfterTouchScroll(false, 3400, nearBottom, false)).toBe(false);
  });
});

describe("isHiddenScroller", () => {
  it("knows a scroller hidden behind another view, so its scroll can't move the pin", () => {
    // Regression: going to a goal's Workers and back left the chat pushed up,
    // because the hide's scroll unpinned it from the bottom.
    const frame = document.createElement("div");
    const scroller = document.createElement("div");
    frame.appendChild(scroller);
    document.body.appendChild(frame);
    expect(isHiddenScroller(scroller)).toBe(false);
    frame.style.display = "none";
    expect(isHiddenScroller(scroller)).toBe(true);
    frame.remove();
  });
});
