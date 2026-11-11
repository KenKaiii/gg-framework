import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { createChatLayoutMotion } from "./chat-layout-motion";
import { firstOpenAskId } from "./ask-user";
import { isHiddenScroller, pinAfterScroll, pinAfterWheel } from "./transcript-pin";
import { earlierStartId, windowStartIndex } from "./transcript-window";
import { dissolveInAbove, teleport } from "./transcript-motion";
import type { Item } from "./transcript-item";

/**
 * Transcript scroll pinning, the mounted history window, and the jump controls
 * (latest / new / open question). Extracted from App.tsx; App passes the shared
 * transcript ref + layout motion in and reads everything back.
 */
export function useTranscriptScroll({
  items,
  scrollRef,
  chatLayout,
}: {
  items: Item[];
  scrollRef: RefObject<HTMLDivElement | null>;
  chatLayout: ReturnType<typeof createChatLayoutMotion>;
}) {
  // Whether the transcript is "pinned" to the bottom. Auto-scroll only runs
  // while pinned. The user scrolling up un-pins it — so they can read freely
  // even while the agent keeps streaming — and scrolling back down to the
  // bottom re-pins (rules in transcript-pin.ts). Default true so a fresh
  // transcript follows the newest output.
  const stickToBottomRef = useRef(true);
  // The transcript's offset as last seen by a scroll event or left by our own
  // scrollToBottom — the baseline that tells an up-scroll from a down-scroll.
  const lastScrollTopRef = useRef(0);
  // The transcript's viewport size as last seen, so a scroll caused by a
  // resize or a zoom step isn't mistaken for the reader's (transcript-pin.ts).
  const lastViewportRef = useRef({ width: 0, height: 0 });
  const noteTranscriptViewport = useCallback((el: HTMLElement): boolean => {
    const last = lastViewportRef.current;
    if (last.width === el.clientWidth && last.height === el.clientHeight) return false;
    lastViewportRef.current = { width: el.clientWidth, height: el.clientHeight };
    return true;
  }, []);

  // Pin to the bottom. Images (screenshots / attachments) load asynchronously
  // and grow the content after this fires, so it's also called from each image's
  // onLoad to keep the newest content visible.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Lifted, not cancelled: this also runs every frame the dock resizes, and
    // ending a glide there snapped the chat the rest of the way in one frame.
    chatLayout.still(() => {
      el.scrollTo({ top: el.scrollHeight });
      // A reader's scroll landing in this same frame shares one scroll event with
      // this jump; measuring it from the pre-jump offset would read up as down.
      lastScrollTopRef.current = el.scrollTop;
    });
  }, [chatLayout, scrollRef]);

  // Same as scrollToBottom, but a no-op while the user has scrolled up to read.
  const maybeScrollToBottom = useCallback(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  // ── History window + the way back down ──
  // Only the newest page of turns stays mounted (rules in transcript-window.ts);
  // reading up to the top mounts the page before it. `windowStartId` null
  // follows the newest turns; once the reader scrolls up it pins the first
  // mounted row so nothing they're reading shifts as replies arrive below, and
  // returning to the bottom lets go, unmounting the older pages again.
  const [windowStartId, setWindowStartId] = useState<number | null>(null);
  // Mirrors stickToBottomRef for rendering the jump controls.
  const [following, setFollowing] = useState(true);
  // Newest row id the reader had when they scrolled up; anything newer shows
  // the "new chats" pill. Null while following.
  const [seenUpToId, setSeenUpToId] = useState<number | null>(null);
  const windowStart = useMemo(() => windowStartIndex(items, windowStartId), [items, windowStartId]);
  const visibleItems = useMemo(
    () => (windowStart === 0 ? items : items.slice(windowStart)),
    [items, windowStart],
  );
  const firstNewId = useMemo(
    () =>
      seenUpToId === null ? null : (visibleItems.find((it) => it.id > seenUpToId)?.id ?? null),
    [visibleItems, seenUpToId],
  );
  // Latest list + window start for the scroll handlers, which are stable
  // callbacks and don't re-capture render values.
  const windowRef = useRef<{ items: readonly Item[]; start: number }>({ items: [], start: 0 });
  useLayoutEffect(() => {
    windowRef.current = { items, start: windowStart };
  }, [items, windowStart]);
  // The oldest question still waiting on the user, for the "You have a
  // question" pill, and where it sits in the transcript.
  const openAskId = useMemo(() => firstOpenAskId(items), [items]);
  const openAskPromptId = useMemo(() => {
    const ask = items.find((it) => it.id === openAskId);
    return ask?.kind === "ask" ? ask.prompt.id : null;
  }, [items, openAskId]);
  // Where that question is relative to the view: on screen, or above / below
  // it (the agent kept talking after asking, or the reader scrolled away).
  // Null when there is no open question.
  const [askPlace, setAskPlace] = useState<"visible" | "above" | "below" | null>(null);
  // The row that was first before older turns mounted above it, and where it
  // sat on screen, so the layout effect below can hold it in place.
  const pendingLoadRef = useRef<{ anchor: Element; top: number } | null>(null);
  const newMarkerRef = useRef<HTMLDivElement>(null);
  const cancelTeleportRef = useRef<(() => void) | null>(null);

  // Read the reader's position after the pin rules ran: follow or hold the
  // window, track what's new, and mount older turns near the top.
  const syncReaderPosition = useCallback((el: HTMLDivElement): void => {
    const pinned = stickToBottomRef.current;
    setFollowing(pinned);
    if (pinned) {
      setWindowStartId(null);
      setSeenUpToId(null);
      return;
    }
    const { items: all, start } = windowRef.current;
    const newestId = all[all.length - 1]?.id ?? 0;
    setSeenUpToId((prev) => prev ?? newestId);
    setWindowStartId((prev) => prev ?? all[start]?.id ?? null);
    if (el.scrollTop > Math.min(400, el.clientHeight / 2) || pendingLoadRef.current) return;
    const earlier = earlierStartId(all, start);
    const anchor = el.firstElementChild;
    if (earlier === null || !anchor) return;
    pendingLoadRef.current = { anchor, top: anchor.getBoundingClientRect().top };
    setWindowStartId(earlier);
  }, []);

  // Track the user's scroll intent by direction, not distance: while a reply
  // streams, every commit re-pins, so any "near the bottom" allowance snapped a
  // small scroll up straight back down. The wheel handler runs before the
  // scroll it causes, so a commit landing in between can't erase the move.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isHiddenScroller(el)) return;
    if (el.scrollTop !== lastScrollTopRef.current) chatLayout.cancel();
    stickToBottomRef.current = pinAfterScroll(
      stickToBottomRef.current,
      lastScrollTopRef.current,
      el,
      noteTranscriptViewport(el),
    );
    lastScrollTopRef.current = el.scrollTop;
    syncReaderPosition(el);
  }, [syncReaderPosition, chatLayout, scrollRef, noteTranscriptViewport]);
  const onTranscriptWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      if (!el) return;
      chatLayout.cancel();
      stickToBottomRef.current = pinAfterWheel(stickToBottomRef.current, e, el);
      // A chat whose newest page fits on screen can't scroll, so no scroll event
      // will ever ask for older turns: a wheel up is the request.
      if (e.deltaY < 0 && el.scrollHeight <= el.clientHeight && windowRef.current.start > 0) {
        stickToBottomRef.current = false;
        syncReaderPosition(el);
      }
    },
    [syncReaderPosition, chatLayout, scrollRef],
  );

  // Older turns just mounted above: put the reader's row back where it was
  // (prepending pushed it down), then dissolve the new rows in.
  useLayoutEffect(() => {
    const pending = pendingLoadRef.current;
    pendingLoadRef.current = null;
    const el = scrollRef.current;
    if (!pending || !el || !pending.anchor.isConnected) return;
    el.scrollTop += pending.anchor.getBoundingClientRect().top - pending.top;
    lastScrollTopRef.current = el.scrollTop;
    dissolveInAbove(el, pending.anchor);
  }, [windowStart, scrollRef]);

  // Anything that re-pins the chat to the bottom without a scroll (a session
  // reset, a hydrate, a project switch) also drops the reader's scrolled-up
  // state: a short new chat never scrolls, so no scroll event would.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    setFollowing(true);
    setSeenUpToId(null);
    setWindowStartId(null);
  }, [items]);

  useEffect(() => () => cancelTeleportRef.current?.(), []);
  const jumpTo = useCallback(
    (land: (el: HTMLDivElement) => void) => {
      const el = scrollRef.current;
      if (!el) return;
      cancelTeleportRef.current?.();
      cancelTeleportRef.current = teleport(el, () => land(el));
    },
    [scrollRef],
  );
  const jumpToLatest = useCallback(() => {
    jumpTo(() => {
      stickToBottomRef.current = true;
      setFollowing(true);
      setSeenUpToId(null);
      setWindowStartId(null);
      scrollToBottom();
    });
  }, [jumpTo, scrollToBottom]);
  const jumpToNew = useCallback(() => {
    jumpTo((el) => {
      const marker = newMarkerRef.current;
      const { items: all } = windowRef.current;
      setSeenUpToId(all[all.length - 1]?.id ?? null);
      if (!marker) return;
      // Land with the first new row at the top, a little breathing room above.
      el.scrollTop += marker.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    });
  }, [jumpTo]);

  // Track the open question's place against the transcript viewport. Observed
  // rather than measured on scroll, so it also catches the agent's later output
  // pushing it up out of view. A band outside the mounted history window (older
  // pages are unmounted) has no element, so it counts as above.
  useEffect(() => {
    const root = scrollRef.current;
    if (!openAskPromptId || !root) {
      setAskPlace(null);
      return;
    }
    const band = root.querySelector(`.ask-band[data-ask-prompt="${CSS.escape(openAskPromptId)}"]`);
    if (!band) {
      setAskPlace("above");
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const bounds = entry.rootBounds ?? root.getBoundingClientRect();
        setAskPlace(
          entry.isIntersecting
            ? "visible"
            : entry.boundingClientRect.top >= bounds.bottom
              ? "below"
              : "above",
        );
      },
      { root },
    );
    observer.observe(band);
    return () => observer.disconnect();
  }, [openAskPromptId, windowStart, scrollRef]);

  // "You have a new question": dissolve to the open question, with a little
  // room above it, mounting its page of history first if it was unloaded.
  const jumpToAsk = useCallback(() => {
    const askId = openAskId;
    const promptId = openAskPromptId;
    if (askId === null || promptId === null) return;
    jumpTo((el) => {
      const selector = `.ask-band[data-ask-prompt="${CSS.escape(promptId)}"]`;
      // Reading it means leaving the bottom: stop following, and count what is
      // below it as already seen, so the "new chats" pill doesn't pop up too.
      stickToBottomRef.current = false;
      const { items: all } = windowRef.current;
      flushSync(() => {
        setFollowing(false);
        setSeenUpToId(all[all.length - 1]?.id ?? null);
        if (!el.querySelector(selector)) setWindowStartId(askId);
      });
      const band = el.querySelector(selector);
      if (!band) return;
      // The reply the question belongs to sits just above it: keep a line of it.
      el.scrollTop += band.getBoundingClientRect().top - el.getBoundingClientRect().top - 56;
      lastScrollTopRef.current = el.scrollTop;
    });
  }, [jumpTo, openAskId, openAskPromptId]);
  return {
    stickToBottomRef,
    lastScrollTopRef,
    noteTranscriptViewport,
    scrollToBottom,
    maybeScrollToBottom,
    windowStartId,
    setWindowStartId,
    following,
    setFollowing,
    seenUpToId,
    setSeenUpToId,
    windowStart,
    visibleItems,
    firstNewId,
    windowRef,
    openAskId,
    openAskPromptId,
    askPlace,
    setAskPlace,
    pendingLoadRef,
    newMarkerRef,
    cancelTeleportRef,
    syncReaderPosition,
    onTranscriptScroll,
    onTranscriptWheel,
    jumpTo,
    jumpToLatest,
    jumpToNew,
    jumpToAsk,
  };
}
