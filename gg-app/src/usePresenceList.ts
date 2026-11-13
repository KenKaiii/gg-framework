import { useEffect, useRef, useState } from "react";

/** One rendered entry: the item, its stable key, and whether it is animating out. */
export interface Presence<T> {
  readonly item: T;
  readonly key: string;
  readonly leaving: boolean;
}

/**
 * Merge the live list into what is on screen. Items still present are refreshed
 * in place; items that disappeared stay at their old position marked `leaving`
 * (so their exit can play where they stood); brand-new items are appended. An
 * item that comes back while still leaving is revived rather than duplicated.
 */
function merge<T>(
  prev: readonly Presence<T>[],
  items: readonly T[],
  keyOf: (item: T) => string,
): Presence<T>[] {
  const live = new Map<string, T>();
  for (const item of items) live.set(keyOf(item), item);
  const out: Presence<T>[] = [];
  const seen = new Set<string>();
  for (const r of prev) {
    const fresh = live.get(r.key);
    if (fresh !== undefined) {
      out.push({ item: fresh, key: r.key, leaving: false });
      seen.add(r.key);
    } else {
      out.push(r.leaving ? r : { ...r, leaving: true });
    }
  }
  for (const [key, item] of live) {
    if (!seen.has(key)) out.push({ item, key, leaving: false });
  }
  return out;
}

/**
 * Record an element's natural border-box size as `--pin-w` / `--pin-h`, so a
 * max-width / max-height collapse (or grow) keyframe can run from its REAL size
 * instead of a guessed cap — a guess leaves dead time at the start of an exit
 * and a snap at the end of an enter. `scroll*` covers the case where the
 * element is already clipped to 0 by the first enter keyframe.
 */
export function pinSize(el: HTMLElement | null): void {
  if (!el) return;
  el.style.setProperty("--pin-w", `${Math.max(el.offsetWidth, el.scrollWidth)}px`);
  el.style.setProperty("--pin-h", `${Math.max(el.offsetHeight, el.scrollHeight)}px`);
}

/**
 * List-level enter/exit presence: the rendered list lags the live one so a
 * removed item can play its exit animation before it unmounts (the same idea
 * Toaster uses, generalised to a keyed list). Items are dropped
 * `exitMs` after they leave — keep that in step with the CSS exit duration.
 *
 * Changing `flush` drops every leaving item in that same render, with no exit.
 * Composer strips pass the send count: a send's own layout transaction
 * (chat-layout-motion.ts) moves the composer and transcript, so a strip still
 * folding after that commit would resize the transcript under it, cancel it,
 * and push the chat up before pulling it back down.
 */
export function usePresenceList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  exitMs: number,
  flush = 0,
): readonly Presence<T>[] {
  // Derived during render (not in an effect) so a removed item is never
  // missing for a frame and a new one appears in the same commit it was added.
  const [prevItems, setPrevItems] = useState(items);
  const [prevFlush, setPrevFlush] = useState(flush);
  const [rendered, setRendered] = useState<readonly Presence<T>[]>(() =>
    items.map((item) => ({ item, key: keyOf(item), leaving: false })),
  );
  let current = rendered;
  if (items !== prevItems || flush !== prevFlush) {
    current = merge(rendered, items, keyOf);
    if (flush !== prevFlush) current = current.filter((r) => !r.leaving);
    setPrevItems(items);
    setPrevFlush(flush);
    setRendered(current);
  }

  // One removal timer per leaving key; a revived key cancels its timer.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const map = timers.current;
    const leaving = new Set(rendered.filter((r) => r.leaving).map((r) => r.key));
    for (const [key, timer] of map) {
      if (!leaving.has(key)) {
        clearTimeout(timer);
        map.delete(key);
      }
    }
    for (const key of leaving) {
      if (map.has(key)) continue;
      map.set(
        key,
        setTimeout(() => {
          map.delete(key);
          setRendered((cur) => cur.filter((r) => !(r.key === key && r.leaving)));
        }, exitMs),
      );
    }
  }, [rendered, exitMs]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  return current;
}
