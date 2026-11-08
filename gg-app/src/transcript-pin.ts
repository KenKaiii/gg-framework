/**
 * Whether the transcript follows new output ("pinned" to the newest line).
 *
 * Lives outside App.tsx so the rules are testable without layout
 * (`transcript-pin.test.ts`); App feeds it the transcript's scroll and wheel
 * events and only auto-scrolls while it answers true.
 *
 * The pin follows the reader's DIRECTION, never their position alone. While a
 * reply streams, App re-pins on every commit (~30 times a second), so a rule
 * of "pinned while within 48px of the bottom" re-captured anyone who had not
 * yet scrolled past 48px in one go — a trackpad glide, one wheel notch — and
 * anyone the layout clamped back near the bottom (the tool panel below
 * closing, a reply past 8 KB folding its tail away). Each re-capture snapped
 * them back down on the next commit. So: any upward move by the reader
 * un-pins, and only moving back down near the bottom re-pins.
 */

/** A scroll down that ends this close to the bottom resumes following. */
export const REPIN_DISTANCE_PX = 48;

/**
 * iPhone: after the finger lifts, a transcript stays held until scrolling (the
 * fling) has been quiet this long; then it catches up if still following.
 */
export const TOUCH_SETTLE_MS = 160;

/**
 * Slack for "exactly at the bottom": scrollTop is fractional under zoom while
 * scrollHeight and clientHeight are each rounded to whole pixels, so a clamped
 * offset can read up to a pixel or so off zero.
 */
const AT_BOTTOM_PX = 2;

/** The scroll geometry the rules read — an HTMLElement satisfies it. */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The wheel fields the rules read — a WheelEvent satisfies it. */
export interface WheelIntent {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrlKey: boolean;
}

/** Pixels of content below the visible bottom edge. */
export function distanceFromBottom(el: ScrollGeometry): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * The pin after a scroll event. `lastTop` is the offset at the previous scroll
 * event OR App's own last scroll-to-bottom, whichever is later: a reader's
 * move that shares a frame with a re-pin must be measured from where the
 * re-pin left the view, or an up-scroll reads as down.
 */
/**
 * Whether a scroller is hidden behind another view: React's <Activity> hides
 * a subtree with an inline `display: none` on its top element. A hidden
 * scroller has no size, and the scroll the hide causes says nothing about
 * where the reader is.
 */
export function isHiddenScroller(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.style.display === "none") return true;
  }
  return false;
}

export function pinAfterScroll(pinned: boolean, lastTop: number, el: ScrollGeometry): boolean {
  // Content that fits the viewport (say, a cleared conversation) has nothing
  // above it to read, so whatever arrives next should be followed.
  if (el.scrollHeight <= el.clientHeight) return true;
  const distance = distanceFromBottom(el);
  if (el.scrollTop < lastTop) {
    // Up to exactly the bottom is the browser clamping the offset after the
    // content got shorter or the viewport taller — layout, not the reader.
    return distance <= AT_BOTTOM_PX ? pinned : false;
  }
  if (el.scrollTop > lastTop && distance <= REPIN_DISTANCE_PX) return true;
  return pinned;
}

/**
 * iPhone: the pin after a scroll event, where only a finger (or the fling it
 * left, `held`) can move the transcript. iOS settles a scroll container's
 * offset in its UI process and reports it back later, so a stale offset can
 * arrive just after the app jumped to the bottom; it reads as "scrolled up"
 * though nobody touched the glass. Scrolls made while not held are layout or
 * the app's own jumps, and never change who decides.
 */
export function pinAfterTouchScroll(
  pinned: boolean,
  lastTop: number,
  el: ScrollGeometry,
  held: boolean,
): boolean {
  return held ? pinAfterScroll(pinned, lastTop, el) : pinned;
}

/**
 * Whether new output should scroll the transcript to the bottom right now.
 *
 * Never while a finger is on the transcript or the momentum it left is still
 * running (iPhone; touch scrolls fire no wheel events). iOS applies a script's
 * scroll on top of the pan, so re-pinning mid-gesture yanks the page out from
 * under the finger and kills the fling. Once the scroll settles, the
 * transcript catches up — if the reader is still following.
 */
export function followsOutput(pinned: boolean, held: boolean): boolean {
  return pinned && !held;
}

/**
 * Share of the visible height the reader must be from the newest line before
 * the "jump to latest" button shows. Smaller moves still leave the end in view,
 * so a button for them would only flicker in and out as a reply streams.
 */
export const JUMP_TO_LATEST_FRACTION = 0.2;

/** Whether to offer the "jump to latest" button. */
export function showJumpToLatest(pinned: boolean, el: ScrollGeometry): boolean {
  if (pinned) return false;
  const threshold = Math.max(REPIN_DISTANCE_PX, el.clientHeight * JUMP_TO_LATEST_FRACTION);
  return distanceFromBottom(el) > threshold;
}

/**
 * The pin after a wheel event, which arrives BEFORE the scroll it causes.
 * Un-pinning here means no streaming commit can re-pin between the reader's
 * gesture and its scroll event and erase the move before it is measured.
 */
export function pinAfterWheel(pinned: boolean, wheel: WheelIntent, el: ScrollGeometry): boolean {
  // Pinch-zoom arrives as ctrl+wheel. A sideways swipe across a wide markdown
  // table (code blocks wrap, so tables are the only sideways scroller here)
  // carries a little vertical noise; only a mostly-vertical gesture means up
  // or down.
  if (wheel.ctrlKey || Math.abs(wheel.deltaY) <= Math.abs(wheel.deltaX)) return pinned;
  // Without overflow there is nothing to scroll up to.
  if (wheel.deltaY < 0) return el.scrollHeight > el.clientHeight ? false : pinned;
  // Down near the bottom resumes following — even at the very bottom, where
  // the offset cannot move and so no scroll event will follow.
  return distanceFromBottom(el) <= REPIN_DISTANCE_PX ? true : pinned;
}
