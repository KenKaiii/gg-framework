import { useRef, useCallback, useState, useEffect, type RefObject } from "react";
import {
  showJumpToLatest,
  followsOutput,
  isHiddenScroller,
  TOUCH_SETTLE_MS,
  pinAfterTouchScroll,
  pinAfterScroll,
  pinAfterWheel,
} from "./transcript-pin";
import { isPhone } from "./platform";

// iPhone: a drag on the transcript this long puts the keyboard away.
const KEYBOARD_DISMISS_DRAG_PX = 10;

export function useTranscriptScroll({
  scrollRef,
  readerMovedRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Told after each scroll (and each wheel up) once the pin rules ran. */
  readerMovedRef?: RefObject<((el: HTMLDivElement, wheelUp: boolean) => void) | null>;
}) {
  // NOTE: the build-session event machine's private refs (streaming bubble id,
  // rAF buffer, per-run accumulators, sub-agent / compaction group ids) now live
  // inside the useAgentEvents hook. Only the cross-cutting refs that App's render
  // + other handlers also touch (stateRef above, the plan refs + stickToBottom
  // below) stay here and are passed into the hook.

  // Whether the transcript is "pinned" to the bottom. Auto-scroll only runs
  // while pinned. The user scrolling up un-pins it — so they can read freely
  // even while the agent keeps streaming — and scrolling back down to the
  // bottom re-pins (rules in transcript-pin.ts). Default true so a fresh
  // transcript follows the newest output.
  const stickToBottomRef = useRef(true);
  // The transcript's offset as last seen by a scroll event or left by our own
  // scrollToBottom — the baseline that tells an up-scroll from a down-scroll.
  const lastScrollTopRef = useRef(0);

  // Pin to the bottom. Images (screenshots / attachments) load asynchronously
  // and grow the content after this fires, so it's also called from each image's
  // onLoad to keep the newest content visible.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    // A reader's scroll landing in this same frame shares one scroll event with
    // this jump; measuring it from the pre-jump offset would read up as down.
    lastScrollTopRef.current = el.scrollTop;
  }, [scrollRef]);

  // iPhone: a finger on the transcript, or the fling it left behind, "holds"
  // it — new output must not scroll the page out from under the reader. The
  // hold ends once scrolling has been quiet for TOUCH_SETTLE_MS after the
  // finger lifts (see transcript-pin.ts `followsOutput`).
  const transcriptHeldRef = useRef(false);
  const transcriptTouchingRef = useRef(false);
  const transcriptTouchYRef = useRef(0);
  const transcriptSettleRef = useRef<number | null>(null);
  // iPhone: the round "jump to latest" button, shown once the reader is well
  // away from the newest line. Mirrored in a ref so scroll events only
  // re-render when it actually flips.
  const [jumpToLatestShown, setJumpToLatestShown] = useState(false);
  const jumpToLatestRef = useRef(false);
  const syncJumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    const next = el !== null && isPhone() && showJumpToLatest(stickToBottomRef.current, el);
    if (next === jumpToLatestRef.current) return;
    jumpToLatestRef.current = next;
    setJumpToLatestShown(next);
  }, [scrollRef]);

  // Same as scrollToBottom, but a no-op while the user has scrolled up to read
  // (or, on the iPhone, while their finger is on the transcript).
  const maybeScrollToBottom = useCallback(() => {
    if (followsOutput(stickToBottomRef.current, transcriptHeldRef.current)) scrollToBottom();
    syncJumpToLatest();
  }, [scrollToBottom, syncJumpToLatest]);

  const releaseTranscript = useCallback(() => {
    transcriptSettleRef.current = null;
    transcriptHeldRef.current = false;
    maybeScrollToBottom();
  }, [maybeScrollToBottom]);
  const settleTranscript = useCallback(() => {
    if (transcriptSettleRef.current !== null) window.clearTimeout(transcriptSettleRef.current);
    transcriptSettleRef.current = window.setTimeout(releaseTranscript, TOUCH_SETTLE_MS);
  }, [releaseTranscript]);
  useEffect(
    () => () => {
      if (transcriptSettleRef.current !== null) window.clearTimeout(transcriptSettleRef.current);
    },
    [],
  );
  const onTranscriptTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    transcriptHeldRef.current = true;
    transcriptTouchingRef.current = true;
    transcriptTouchYRef.current = e.touches[0]?.clientY ?? 0;
    if (transcriptSettleRef.current !== null) {
      window.clearTimeout(transcriptSettleRef.current);
      transcriptSettleRef.current = null;
    }
  }, []);
  const onTranscriptTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    // Put the keyboard away the moment the transcript is dragged, the way
    // Messages does — not on a tap, which may be a link or a copy.
    const y = e.touches[0]?.clientY ?? transcriptTouchYRef.current;
    if (Math.abs(y - transcriptTouchYRef.current) < KEYBOARD_DISMISS_DRAG_PX) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      active.blur();
    }
  }, []);
  const onTranscriptTouchEnd = useCallback(() => {
    transcriptTouchingRef.current = false;
    settleTranscript();
  }, [settleTranscript]);

  // The "jump to latest" button: follow again, and glide down to the end.
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    syncJumpToLatest();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [syncJumpToLatest, scrollRef]);

  // Track the user's scroll intent by direction, not distance: while a reply
  // streams, every commit re-pins, so any "near the bottom" allowance snapped a
  // small scroll up straight back down. The wheel handler runs before the
  // scroll it causes, so a commit landing in between can't erase the move.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isHiddenScroller(el)) return;
    // iPhone: only a finger (or its fling) can scroll the transcript, so
    // only a finger can stop the follow (transcript-pin.ts).
    stickToBottomRef.current = isPhone()
      ? pinAfterTouchScroll(
          stickToBottomRef.current,
          lastScrollTopRef.current,
          el,
          transcriptHeldRef.current,
        )
      : pinAfterScroll(stickToBottomRef.current, lastScrollTopRef.current, el);
    lastScrollTopRef.current = el.scrollTop;
    // A fling still running after the finger lifted keeps the hold on.
    if (transcriptHeldRef.current && !transcriptTouchingRef.current) settleTranscript();
    syncJumpToLatest();
    readerMovedRef?.current?.(el, false);
  }, [settleTranscript, syncJumpToLatest, scrollRef, readerMovedRef]);
  const onTranscriptWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      if (!el) return;
      stickToBottomRef.current = pinAfterWheel(stickToBottomRef.current, e, el);
      if (e.deltaY < 0) readerMovedRef?.current?.(el, true);
    },
    [scrollRef, readerMovedRef],
  );
  return {
    stickToBottomRef,
    lastScrollTopRef,
    jumpToLatestShown,
    maybeScrollToBottom,
    onTranscriptTouchStart,
    onTranscriptTouchMove,
    onTranscriptTouchEnd,
    jumpToLatest,
    onTranscriptScroll,
    onTranscriptWheel,
  };
}
