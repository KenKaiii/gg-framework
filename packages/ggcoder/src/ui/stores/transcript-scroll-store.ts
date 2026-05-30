import { createStore, useStore } from "./create-store.js";

/**
 * Scroll position for the fullscreen alt-screen transcript viewport, held in an
 * external store (useSyncExternalStore) so that scrolling re-renders ONLY the
 * `TranscriptViewport` subtree — not the whole App. Driving scroll through
 * App-level useState forced a full re-render of every hook/memo per wheel tick,
 * which is what made scrolling jaggy.
 *
 * useSyncExternalStore is level-triggered: a burst of synchronous wheel events
 * (one physical notch fires several SGR sequences) collapses into a single
 * render that reads the final offset, so no debounce/coalescing timer is needed.
 */
interface TranscriptScrollState {
  /** Lines scrolled up from the bottom. 0 = stuck to the newest output. */
  offset: number;
  /** True once the user has scrolled away from the bottom. */
  isUserScrolled: boolean;
}

const store = createStore<TranscriptScrollState>({ offset: 0, isUserScrolled: false });

/**
 * Scroll bounds kept OUTSIDE the reactive store: they change as content/layout
 * change (driven by App), but on their own they should not trigger a viewport
 * re-render — only an actual offset change should. `setTranscriptScrollBounds`
 * re-clamps the offset and emits only when the visible offset actually moves.
 */
let maxOffset = 0;

function clamp(value: number): number {
  return Math.min(Math.max(0, value), maxOffset);
}

/**
 * Update the maximum scroll offset (total transcript lines − viewport rows).
 * Called by App whenever content length or viewport height changes. Re-pins to
 * the bottom when the user hasn't scrolled, otherwise clamps their offset into
 * the new range. Emits only when the offset actually changes, so growing
 * content during a scroll-locked read doesn't churn renders.
 */
export function setTranscriptScrollBounds(nextMaxOffset: number): void {
  maxOffset = Math.max(0, Math.floor(nextMaxOffset));
  const { offset, isUserScrolled } = store.getSnapshot();
  const next = isUserScrolled ? Math.min(offset, maxOffset) : 0;
  if (next !== offset) store.setState({ offset: next });
}

/**
 * Scroll by a signed number of lines. Positive scrolls UP (toward older
 * output), negative scrolls DOWN (toward newest). No-op when clamped to an
 * edge, so wheel jitter at the top/bottom can't churn renders.
 */
export function scrollTranscriptByLines(deltaLines: number): void {
  if (deltaLines === 0) return;
  const { offset } = store.getSnapshot();
  const next = clamp(offset + deltaLines);
  if (next === offset) return;
  store.setState({ offset: next, isUserScrolled: next > 0 });
}

/** Set the absolute offset (used by PageUp/Down, Shift+Arrows, g/G). */
export function setTranscriptScrollOffset(targetOffset: number): void {
  const { offset } = store.getSnapshot();
  const next = clamp(targetOffset);
  if (next === offset) return;
  store.setState({ offset: next, isUserScrolled: next > 0 });
}

/** Page up/down relative to the current offset by `page` lines. */
export function pageTranscriptScroll(page: number): void {
  const { offset } = store.getSnapshot();
  setTranscriptScrollOffset(offset + page);
}

/** Snap back to the newest output (offset 0) — e.g. on a new prompt submit. */
export function resetTranscriptScroll(): void {
  const { offset, isUserScrolled } = store.getSnapshot();
  if (offset === 0 && !isUserScrolled) return;
  store.setState({ offset: 0, isUserScrolled: false });
}

/** Jump to the very top (oldest output). */
export function scrollTranscriptToTop(): void {
  setTranscriptScrollOffset(maxOffset);
}

/** Current clamped offset, non-reactively (for tests / imperative reads). */
export function getTranscriptScrollOffset(): number {
  return clamp(store.getSnapshot().offset);
}

/** Reactive hook: re-renders the caller only when the scroll offset changes. */
export function useTranscriptScrollOffset(): number {
  return useStore(store).offset;
}
