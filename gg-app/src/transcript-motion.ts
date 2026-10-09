/**
 * The transcript's two scripted moves, in the same dissolve language as the
 * plan pane (`plan-dissolve-in` in App.css): content resolves out of a soft
 * blur instead of sliding.
 *
 * Both run as Web Animations with NO `fill`, so a finished animation drops off
 * the timeline by itself. A held (`fill: "forwards"`) animation on a node that
 * is later removed stays on WebKit's timeline for the life of the window (see
 * `discard` in critter-fx.ts), so nothing here holds a frame.
 */

/** Equal to `--ease-out` / `--ease-in` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

const HIDDEN: Keyframe = { opacity: 0, filter: "blur(8px)" };
const SHOWN: Keyframe = { opacity: 1, filter: "blur(0px)" };

/** Session-local high-water mark: cancellation, paging and Activity cannot replay rows. */
export function createEntranceLifetime(firstId: number): {
  consume: (id: number) => boolean;
  settle: (id: number) => void;
} {
  let next = firstId;
  return {
    consume(id) {
      if (id < next) return false;
      next = id + 1;
      return true;
    },
    settle(id) {
      next = Math.max(next, id + 1);
    },
  };
}

/** Opacity only. Geometry belongs to the layout transaction, not each new row. */
export function enterTranscriptRow(el: HTMLElement): () => void {
  if (prefersReducedMotion() || typeof el.animate !== "function") return () => {};
  const token = getComputedStyle(el).getPropertyValue("--dur-dissolve").trim();
  const duration = parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
  const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: Number.isFinite(duration) ? duration : 0,
    easing: EASE_OUT,
  });
  return () => animation.cancel();
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Older rows just mounted above the reader: blur-fade them in. Walks up from
 * `below` (the row that was first before the load) and stops a screen above
 * the viewport, since rows further up finish animating before anyone scrolls
 * to them.
 */
export function dissolveInAbove(scroller: HTMLElement, below: Element): void {
  if (typeof below.animate !== "function") return;
  const reduce = prefersReducedMotion();
  const limit = scroller.getBoundingClientRect().top - scroller.clientHeight;
  for (let node = below.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.getBoundingClientRect().bottom < limit) break;
    node.animate(reduce ? [{ opacity: 0 }, { opacity: 1 }] : [HIDDEN, SHOWN], {
      duration: reduce ? 160 : 420,
      easing: EASE_OUT,
    });
  }
}

/**
 * Restored history just replaced the skeleton: blur-fade in the rows on
 * screen, together, so the chat resolves in place instead of snapping. Rows
 * off screen are left alone (nobody sees them arrive). Same no-`fill` rule as
 * everything here.
 */
export function dissolveInVisible(scroller: HTMLElement): void {
  if (typeof scroller.animate !== "function") return;
  const reduce = prefersReducedMotion();
  const view = scroller.getBoundingClientRect();
  for (const node of Array.from(scroller.children)) {
    const box = node.getBoundingClientRect();
    if (box.bottom < view.top || box.top > view.bottom) continue;
    node.animate(reduce ? [{ opacity: 0 }, { opacity: 1 }] : [HIDDEN, SHOWN], {
      duration: reduce ? 160 : 420,
      easing: EASE_OUT,
    });
  }
}

/**
 * Dissolve the transcript out, `land` (jump the scroll position) while it is
 * invisible, then resolve it back in, so a long jump reads as one cut instead
 * of a blur of passing rows. Returns a cancel (for unmount, or a newer jump
 * taking over); it never lands. Reduced motion just lands.
 */
export function teleport(scroller: HTMLElement, land: () => void): () => void {
  if (typeof scroller.animate !== "function" || prefersReducedMotion()) {
    land();
    return () => undefined;
  }
  let current: Animation = scroller.animate([SHOWN, HIDDEN], {
    duration: 160,
    easing: EASE_IN,
  });
  current.onfinish = () => {
    land();
    // Started in the same task the out-dissolve ends, so the frame that would
    // show the old position at full opacity is never painted.
    current = scroller.animate([HIDDEN, SHOWN], { duration: 260, easing: EASE_OUT });
  };
  return () => current.cancel();
}
