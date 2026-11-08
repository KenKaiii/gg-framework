// @vitest-environment jsdom
/**
 * Regression: growing the composer past ~3 line breaks used to un-pin the
 * transcript, so the input box covered the newest messages instead of pushing
 * them up (the first few breaks looked fine, which is what made it confusing).
 *
 * Cause: `height: auto` collapses the textarea to one row for one layout pass,
 * handing its pixels back to the transcript. The browser then clamps the
 * transcript's scrollTop to the smaller max scroll, and the scroll event that
 * follows reads as "the user scrolled up" — dropping App's stick-to-bottom pin.
 *
 * jsdom has no layout, so this models the two browser behaviours that produce
 * the bug: the shell splits a fixed height between composer and transcript, and
 * scrollTop is clamped to `scrollHeight - clientHeight` whenever that shrinks.
 * With real numbers taken from a headless-Chromium repro at 900×700.
 */
import { describe, expect, it, vi } from "vitest";
import { autosizeComposer } from "./composer-autosize";
import { pinAfterScroll } from "./transcript-pin";

const SHELL = 700; // window height
const CHROME = 123; // chat head + live region + footer + composer padding
const ROW = 21; // 14px × 1.5 line-height
const CONTENT = 541; // transcript scrollHeight: just taller than the viewport

/** A transcript whose viewport is whatever the composer leaves it. */
function makeShell() {
  const transcript = document.createElement("div");
  let composerHeight = ROW;
  let scrollTop = 0;
  const clientHeight = () => SHELL - CHROME - composerHeight;
  const maxScroll = () => Math.max(0, CONTENT - clientHeight());
  const scrollEvents: number[] = [];

  Object.defineProperty(transcript, "scrollHeight", { get: CONTENT.valueOf.bind(CONTENT) });
  Object.defineProperty(transcript, "clientHeight", { get: clientHeight });
  Object.defineProperty(transcript, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      const next = Math.min(Math.max(0, v), maxScroll());
      if (next === scrollTop) return;
      scrollTop = next;
      scrollEvents.push(next);
    },
  });

  return {
    transcript,
    scrollEvents,
    maxScroll,
    /** Browser behaviour: a taller viewport clamps an out-of-range scrollTop. */
    setComposerHeight(px: number) {
      composerHeight = px;
      if (scrollTop > maxScroll()) {
        scrollTop = maxScroll();
        scrollEvents.push(scrollTop);
      }
    },
    distanceFromBottom: () => CONTENT - scrollTop - clientHeight(),
  };
}

/** A textarea that reports `rows` worth of content and drives the shell. */
function makeComposer(shell: ReturnType<typeof makeShell>, rows: () => number) {
  const el = document.createElement("textarea");
  document.body.append(el);
  Object.defineProperty(el, "scrollHeight", { get: () => rows() * ROW });
  const style = el.style;
  Object.defineProperty(style, "height", {
    get: () => "",
    set: (v: string) => {
      // `auto` = the rows=1 intrinsic height, NOT the content height.
      shell.setComposerHeight(v === "auto" ? ROW : parseFloat(v));
    },
  });
  return el;
}

/** Type `breaks` newlines, re-pinning after each grow the way App does. */
function typeLineBreaks(breaks: number) {
  const shell = makeShell();
  let rows = 1;
  const el = makeComposer(shell, () => rows);
  // App's stick-to-bottom pin, updated by every scroll event exactly as
  // onTranscriptScroll does.
  let pinned = true;
  let lastTop = 0;
  const observeScrolls = () => {
    while (shell.scrollEvents.length) {
      shell.scrollEvents.shift();
      pinned = pinAfterScroll(pinned, lastTop, shell.transcript);
      lastTop = shell.transcript.scrollTop;
    }
  };

  shell.transcript.scrollTop = CONTENT; // start pinned to the newest message
  observeScrolls();
  const offBottomAfterAutosize: number[] = [];

  for (let n = 0; n < breaks; n++) {
    rows += 1;
    const wasPinned = pinned;
    autosizeComposer(el, shell.transcript, pinned); // useLayoutEffect on `input`
    observeScrolls();
    // A pinned composer must already be at the bottom by the time the
    // ResizeObserver runs; anything left for the RO to correct is a frame of
    // visible bounce while typing.
    if (wasPinned) offBottomAfterAutosize.push(shell.distanceFromBottom());
    if (pinned) {
      // ResizeObserver re-pin: scrollToBottom, which records its own offset.
      shell.transcript.scrollTop = CONTENT;
      lastTop = shell.transcript.scrollTop;
    }
    observeScrolls();
  }
  return { pinned, shell, el, offBottomAfterAutosize };
}

describe("autosizeComposer", () => {
  it("sizes the textarea to its content", () => {
    const shell = makeShell();
    const el = makeComposer(shell, () => 4);
    autosizeComposer(el, shell.transcript);
    expect(shell.transcript.clientHeight).toBe(SHELL - CHROME - 4 * ROW);
    expect(el.style.overflowY).toBe("hidden");
  });

  it("keeps the transcript pinned through the first breaks", () => {
    const { pinned, shell } = typeLineBreaks(3);
    expect(pinned).toBe(true);
    expect(shell.transcript.scrollTop).toBe(shell.maxScroll());
  });

  // The regression itself: without the scrollTop snapshot/restore inside
  // autosizeComposer the pin is lost and never comes back, so the composer
  // overlaps the newest messages. Under the old 48px pin that began at the 4th
  // break; the direction-based pin (transcript-pin.ts) loses it on the first.
  it("keeps the transcript pinned past 3 line breaks", () => {
    const { pinned, shell } = typeLineBreaks(6);
    expect(pinned).toBe(true);
    expect(shell.transcript.scrollTop).toBe(shell.maxScroll());
    expect(shell.distanceFromBottom()).toBe(0);
  });

  it("survives a composer that is already tall (no measurement flicker)", () => {
    const { pinned, shell } = typeLineBreaks(12);
    expect(pinned).toBe(true);
    expect(shell.distanceFromBottom()).toBe(0);
  });

  // Second regression: the pin was restored a frame LATE (the ResizeObserver
  // did it), so every keystroke that wrapped a line showed the transcript sit a
  // row off the bottom and then settle — the jitter Ken saw while typing.
  it("lands at the bottom in the same pass, leaving nothing for the observer", () => {
    const { offBottomAfterAutosize } = typeLineBreaks(6);
    expect(offBottomAfterAutosize).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("leaves a reader who scrolled up exactly where they were", () => {
    const shell = makeShell();
    let rows = 8; // tall enough that the transcript can actually scroll
    const el = makeComposer(shell, () => rows);
    autosizeComposer(el, shell.transcript, false);
    shell.transcript.scrollTop = 100; // scrolled up, un-pinned
    rows = 9;
    autosizeComposer(el, shell.transcript, false);
    expect(shell.transcript.scrollTop).toBe(100);
  });

  it("does nothing without a transcript", () => {
    const shell = makeShell();
    const el = makeComposer(shell, () => 2);
    expect(() => autosizeComposer(el, null)).not.toThrow();
    expect(() => autosizeComposer(null, shell.transcript)).not.toThrow();
  });
});

describe("growth animation", () => {
  it("never leaves the collapsed measurement height as the transition's start value", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);
    el.value = "a draft that wraps";
    Object.defineProperty(el, "scrollHeight", { get: () => 60 });
    // The box is already two lines tall from the previous keystroke.
    el.style.height = "40px";

    // Record every height written during one autosize pass, while keeping reads
    // working — the pass snapshots the current height before measuring.
    const seen: string[] = [];
    let current = el.style.height;
    Object.defineProperty(el.style, "height", {
      configurable: true,
      get: () => current,
      set: (v: string) => {
        seen.push(v);
        current = v;
      },
    });

    autosizeComposer(el, null);

    // The transient "auto" must be undone before the final value lands, or the
    // browser animates one line → N on every keystroke instead of 40 → 60.
    expect(seen).toEqual(["auto", "40px", "60px"]);
  });

  it("does not rewrite the height when the content has not changed", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);
    Object.defineProperty(el, "scrollHeight", { get: () => 40 });
    el.style.height = "40px";
    autosizeComposer(el, null);
    expect(el.style.height).toBe("40px");
  });
});

describe("transition start value", () => {
  it("commits the restored height with a layout read before writing the target", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);
    el.value = "a draft that wraps";
    Object.defineProperty(el, "scrollHeight", { get: () => 60 });
    el.style.height = "40px";

    // Record writes AND the forced layout read, in order. Without the read
    // between the restore and the target the browser coalesces both writes and
    // animates from the collapsed measurement height instead of 40px.
    const trace: string[] = [];
    let current = el.style.height;
    Object.defineProperty(el.style, "height", {
      configurable: true,
      get: () => current,
      set: (v: string) => {
        trace.push(`set:${v}`);
        current = v;
      },
    });
    Object.defineProperty(el, "offsetHeight", {
      configurable: true,
      get: () => {
        trace.push("read");
        return 40;
      },
    });

    autosizeComposer(el, null);

    expect(trace).toEqual(["set:auto", "set:40px", "read", "set:60px"]);
  });

  // A draft replaced wholesale eases down over 160ms; a keystroke mid-ease must
  // continue from the height ON SCREEN, not jump to the last target first.
  it("restores the live animated height, not the last written target", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);
    el.value = "a draft that wraps";
    Object.defineProperty(el, "scrollHeight", { get: () => 30 });
    el.style.height = "30px"; // the target the box is easing toward
    const seen: string[] = [];
    let current = el.style.height;
    Object.defineProperty(el.style, "height", {
      configurable: true,
      get: () => current,
      set: (v: string) => {
        seen.push(v);
        current = v;
      },
    });
    // Mid-transition the computed height is still 55px.
    const computed = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ height: "55px", maxHeight: "" } as CSSStyleDeclaration);
    try {
      autosizeComposer(el, null);
    } finally {
      computed.mockRestore();
    }
    expect(seen).toEqual(["auto", "55px", "30px"]);
  });

  it("skips the restore dance when the height is unchanged", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);
    Object.defineProperty(el, "scrollHeight", { get: () => 40 });
    el.style.height = "40px";
    let reads = 0;
    Object.defineProperty(el, "offsetHeight", {
      configurable: true,
      get: () => {
        reads += 1;
        return 40;
      },
    });
    autosizeComposer(el, null);
    // Nothing is animating, so no forced synchronous layout is paid for.
    expect(reads).toBe(0);
    expect(el.style.height).toBe("40px");
  });
});

describe("one-line vs wrapped composer row", () => {
  function harness(contentHeight: number) {
    const row = document.createElement("div");
    row.className = "inputrow";
    const el = document.createElement("textarea");
    row.appendChild(el);
    document.body.appendChild(row);
    Object.defineProperty(el, "scrollHeight", { get: () => contentHeight });
    el.style.lineHeight = "21px";
    el.style.paddingTop = "4.5px";
    el.style.paddingBottom = "4.5px";
    return { row, el };
  }

  it("keeps the caret beside the paperclip while the draft is one line", () => {
    // 21px line + 9px padding = the single-line height.
    const { row, el } = harness(30);
    autosizeComposer(el, null);
    expect(row.classList.contains("is-multiline")).toBe(false);
  });

  it("gives the field the whole row on the second line", () => {
    const { row, el } = harness(51);
    autosizeComposer(el, null);
    expect(row.classList.contains("is-multiline")).toBe(true);
  });

  // The bug: an empty draft plus one newline is genuinely two lines, and must
  // behave exactly like text plus one newline.
  it("treats an empty draft with a newline as two lines", () => {
    const empty = harness(51);
    autosizeComposer(empty.el, null);
    const withText = harness(51);
    autosizeComposer(withText.el, null);
    expect(empty.row.className).toBe(withText.row.className);
    expect(empty.row.classList.contains("is-multiline")).toBe(true);
  });

  it("returns to one row when the draft shrinks back", () => {
    const { row, el } = harness(30);
    row.classList.add("is-multiline");
    autosizeComposer(el, null);
    expect(row.classList.contains("is-multiline")).toBe(false);
  });
});

// The bounce Ken saw: typing to the exact edge of the one-line field wrapped
// it, which handed it the whole row (wider), which un-wrapped the text, which
// took the row away again — one flip per keystroke, each animated.
describe("at the wrap edge", () => {
  const ROW_H = 21;
  const PAD = 9;
  /** A draft that needs 2 lines beside the circles but fits on the full row. */
  function edgeHarness() {
    const row = document.createElement("div");
    row.className = "inputrow";
    const stack = document.createElement("div");
    const el = document.createElement("textarea");
    stack.appendChild(el);
    row.appendChild(stack);
    document.body.appendChild(row);
    Object.defineProperty(el, "scrollHeight", {
      get: () => (row.classList.contains("is-multiline") ? 1 : 2) * ROW_H + PAD,
    });
    el.style.lineHeight = `${ROW_H}px`;
    el.style.paddingTop = "4.5px";
    el.style.paddingBottom = "4.5px";
    return { row, el };
  }

  it("settles on the full row instead of flipping every keystroke", () => {
    const { row, el } = edgeHarness();
    const states: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      autosizeComposer(el, null);
      states.push(row.classList.contains("is-multiline"));
    }
    expect(states).toEqual([true, true, true, true, true, true]);
  });

  it("holds the height steady once it has settled", () => {
    const { el } = edgeHarness();
    autosizeComposer(el, null);
    const settled = el.style.height;
    autosizeComposer(el, null);
    expect(el.style.height).toBe(settled);
  });

  it("sizes the box to the width it keeps, not the one it just lost", () => {
    const { el } = edgeHarness();
    autosizeComposer(el, null);
    // Full-row width fits the draft on one line, so one line is the height.
    expect(el.style.height).toBe(`${ROW_H + PAD}px`);
  });

  it("gives the row back only when the draft fits beside the circles", () => {
    const row = document.createElement("div");
    row.className = "inputrow is-multiline";
    const el = document.createElement("textarea");
    row.appendChild(el);
    document.body.appendChild(row);
    // Short draft: one line at either width.
    Object.defineProperty(el, "scrollHeight", { get: () => ROW_H + PAD });
    el.style.lineHeight = `${ROW_H}px`;
    el.style.paddingTop = "4.5px";
    el.style.paddingBottom = "4.5px";
    autosizeComposer(el, null);
    expect(row.classList.contains("is-multiline")).toBe(false);
  });
});

describe("wrap animation (FLIP)", () => {
  function harness(contentHeight: number, rects: DOMRect[]) {
    const row = document.createElement("div");
    row.className = "inputrow";
    const stack = document.createElement("div");
    stack.className = "input-stack";
    const el = document.createElement("textarea");
    stack.appendChild(el);
    row.appendChild(stack);
    document.body.appendChild(row);
    Object.defineProperty(el, "scrollHeight", { get: () => contentHeight });
    el.style.lineHeight = "21px";
    el.style.paddingTop = "4.5px";
    el.style.paddingBottom = "4.5px";
    // Model the reflow: the field sits right of the paperclip, then claims the
    // whole row one line lower.
    let call = 0;
    stack.getBoundingClientRect = () => rects[call++] ?? rects[rects.length - 1]!;
    return { row, stack, el };
  }
  const rect = (left: number, top: number): DOMRect => ({ left, top }) as DOMRect;

  it("inverts the reflow so the move up-and-left animates", () => {
    const { row, stack, el } = harness(51, [rect(36, 10), rect(0, 0)]);
    el.value = "a draft that wraps";
    // Trace transform writes AND the forced layout read between them.
    const trace: string[] = [];
    let current = "";
    Object.defineProperty(stack.style, "transform", {
      configurable: true,
      get: () => current,
      set: (v: string) => {
        trace.push(v === "" ? "release" : v);
        current = v;
      },
    });
    Object.defineProperty(stack, "offsetHeight", {
      configurable: true,
      get: () => {
        trace.push("commit");
        return 51;
      },
    });

    autosizeComposer(el, null);

    expect(row.classList.contains("is-multiline")).toBe(true);
    // Translated back, committed, then released for CSS to animate it away.
    // Without the commit both writes coalesce and nothing animates.
    expect(trace).toEqual(["translate(36px, 10px)", "commit", "release"]);
  });

  it("does not touch transform when the row does not reflow", () => {
    const { stack, el } = harness(30, [rect(36, 10)]);
    autosizeComposer(el, null);
    expect(stack.style.transform).toBe("");
  });
});

// "Pushes up, then corrects" on send: submit clears the draft in the same
// frame the sent message is added. If the field eased down from N lines, the
// transcript viewport grew under the new bubble for 160ms, so the bubble
// appeared above where it rests and slid down into place.
describe("emptied draft (send)", () => {
  function sentHarness() {
    const row = document.createElement("div");
    row.className = "inputrow is-multiline";
    const stack = document.createElement("div");
    const el = document.createElement("textarea");
    stack.appendChild(el);
    row.appendChild(stack);
    document.body.appendChild(row);
    Object.defineProperty(el, "scrollHeight", { get: () => 30 });
    el.style.lineHeight = "21px";
    el.style.paddingTop = "4.5px";
    el.style.paddingBottom = "4.5px";
    el.style.height = "72px"; // three lines, just before send
    el.value = "";
    let call = 0;
    const rects = [
      { left: 0, top: 0 },
      { left: 36, top: 10 },
    ] as DOMRect[];
    stack.getBoundingClientRect = () => rects[call++] ?? rects[1]!;
    return { row, stack, el };
  }

  it("lands at one line with the height transition suspended", () => {
    const { el } = sentHarness();
    const trace: string[] = [];
    let height = el.style.height;
    let transition = "";
    Object.defineProperty(el.style, "height", {
      configurable: true,
      get: () => height,
      set: (v: string) => {
        trace.push(`height:${v}`);
        height = v;
      },
    });
    Object.defineProperty(el.style, "transition", {
      configurable: true,
      get: () => transition,
      set: (v: string) => {
        trace.push(`transition:${v || "restore"}`);
        transition = v;
      },
    });
    Object.defineProperty(el, "offsetHeight", {
      configurable: true,
      get: () => {
        trace.push("commit");
        return 30;
      },
    });

    autosizeComposer(el, null);

    // No restore of the old 72px as a start value: the target is written with
    // transitions off and committed before they come back.
    expect(trace).toEqual([
      "height:auto",
      "transition:none",
      "height:30px",
      "commit",
      "transition:restore",
    ]);
  });

  it("gives the row back without a FLIP", () => {
    const { row, stack, el } = sentHarness();
    // A FLIP always ends by clearing the transform, so record writes rather
    // than checking the final value.
    const writes: string[] = [];
    Object.defineProperty(stack.style, "transform", {
      configurable: true,
      get: () => "",
      set: (v: string) => writes.push(v),
    });
    autosizeComposer(el, null);
    expect(row.classList.contains("is-multiline")).toBe(false);
    expect(writes).toEqual([]);
  });
});
