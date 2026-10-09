import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Shared behaviour for the app's floating panels (`.pop-panel`) and every
// scrollable menu (`.pop-scroll`). The look lives in App.css under "Popovers".

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

export type PopoverSide = "above" | "below";

/**
 * Marks a `.pop-scroll` element with `data-more-above` / `data-more-below`
 * while there is more to scroll that way. The scrollbar is hidden, so the CSS
 * fades those edges instead. Updates at most once per frame, straight on the
 * DOM, so scrolling never re-renders React. Also re-checks when the element or
 * its content resizes (rows arriving, filtering).
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, active: boolean): () => void {
  const frame = useRef(0);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.toggleAttribute("data-more-above", el.scrollTop > 1);
    el.toggleAttribute("data-more-below", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, [ref]);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      update();
    });
  }, [update]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(onScroll);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return onScroll;
}

interface AnchoredPopover<A extends HTMLElement, P extends HTMLElement> {
  anchorRef: RefObject<A | null>;
  popoverRef: RefObject<P | null>;
  /** Inline position for the portaled, `position: fixed` panel. */
  style: React.CSSProperties;
}

/**
 * Places a portaled panel against its trigger (clamped into the viewport),
 * closes it on an outside press or Escape, and moves focus in on open: to the
 * `[data-pop-focus]` element when there is one. Escape, or closing while focus
 * is inside, returns focus to the trigger.
 */
export function useAnchoredPopover<A extends HTMLElement, P extends HTMLElement>(
  open: boolean,
  close: () => void,
  side: PopoverSide,
): AnchoredPopover<A, P> {
  const anchorRef = useRef<A>(null);
  const popoverRef = useRef<P>(null);
  const [place, setPlace] = useState<{
    left: number;
    edge: number;
    originX: number;
    room: number;
  } | null>(null);
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  });

  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = popoverRef.current?.offsetWidth ?? 0;
      const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
      setPlace({
        left,
        edge:
          side === "below" ? rect.bottom + ANCHOR_GAP : window.innerHeight - rect.top + ANCHOR_GAP,
        // The panel grows out of the trigger's centre.
        originX: Math.round(rect.left + rect.width / 2 - left),
        // Height left between the trigger and the window edge it opens toward,
        // so the panel never runs off-screen (its list scrolls instead).
        room: Math.max(
          120,
          Math.floor(
            side === "below"
              ? window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN
              : rect.top - ANCHOR_GAP - VIEWPORT_MARGIN,
          ),
        ),
      });
    };
    measure();
    // Once more after the panel has real dimensions.
    const raf = requestAnimationFrame(measure);
    popoverRef.current
      ?.querySelector<HTMLElement>("[data-pop-focus]")
      ?.focus({ preventScroll: true });
    window.addEventListener("resize", measure);
    const popover = popoverRef.current;
    const anchor = anchorRef.current;
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      if (popover?.contains(document.activeElement)) anchor?.focus();
    };
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const edge = place?.edge ?? 0;
  const style: React.CSSProperties & Record<"--pop-origin-x" | "--pop-room", string> = {
    left: place?.left ?? 0,
    top: side === "below" ? edge : undefined,
    bottom: side === "above" ? edge : undefined,
    visibility: place ? "visible" : "hidden",
    "--pop-origin-x": `${place?.originX ?? 24}px`,
    "--pop-room": place ? `${place.room}px` : "100vh",
  };
  return { anchorRef, popoverRef, style };
}
