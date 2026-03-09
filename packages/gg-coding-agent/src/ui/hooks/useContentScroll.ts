import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { log } from "../../core/logger.js";

const VIEWPORT_SIZE = 15;

interface UseContentScrollOptions<T> {
  items: T[];
  viewportSize?: number;
}

interface UseContentScrollResult<T> {
  visibleItems: T[];
  itemsAbove: number;
  itemsBelow: number;
  scrollUp: (count?: number) => void;
  scrollDown: (count?: number) => void;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  halfViewport: number;
}

export function useContentScroll<T>({
  items,
  viewportSize = VIEWPORT_SIZE,
}: UseContentScrollOptions<T>): UseContentScrollResult<T> {
  const [scrollOffset, setScrollOffset] = useState(0);
  const isAutoScrollRef = useRef(true);
  const prevLengthRef = useRef(items.length);

  // When items change and auto-scroll is on, stay pinned to bottom
  useEffect(() => {
    if (isAutoScrollRef.current) {
      setScrollOffset(0);
    }
    prevLengthRef.current = items.length;
  }, [items.length]);

  const maxOffset = Math.max(0, items.length - viewportSize);
  const halfViewport = Math.floor(viewportSize / 2);

  // Use ref so scroll callbacks always read the latest maxOffset
  const maxOffsetRef = useRef(maxOffset);
  maxOffsetRef.current = maxOffset;

  const scrollUp = useCallback(
    (count = 1) => {
      const mo = maxOffsetRef.current;
      log("INFO", "contentScroll", `scrollUp(${count}) maxOffset=${mo}`);
      setScrollOffset((prev) => {
        const next = Math.min(prev + count, mo);
        if (next > 0) isAutoScrollRef.current = false;
        return next;
      });
    },
    [], // stable — reads maxOffset from ref
  );

  const scrollDown = useCallback((count = 1) => {
    log("INFO", "contentScroll", `scrollDown(${count})`);
    setScrollOffset((prev) => {
      const next = Math.max(0, prev - count);
      if (next === 0) isAutoScrollRef.current = true;
      return next;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    setScrollOffset(0);
    isAutoScrollRef.current = true;
  }, []);

  const scrollToTop = useCallback(() => {
    const mo = maxOffsetRef.current;
    setScrollOffset(mo);
    if (mo > 0) isAutoScrollRef.current = false;
  }, []);

  const visibleItems = useMemo(() => {
    if (items.length <= viewportSize) return items;
    // scrollOffset is items from the bottom
    const end = items.length - scrollOffset;
    const start = Math.max(0, end - viewportSize);
    return items.slice(start, end);
  }, [items, scrollOffset, viewportSize]);

  const itemsAbove = useMemo(() => {
    if (items.length <= viewportSize) return 0;
    const end = items.length - scrollOffset;
    return Math.max(0, end - viewportSize);
  }, [items.length, scrollOffset, viewportSize]);

  const itemsBelow = useMemo(() => {
    return scrollOffset;
  }, [scrollOffset]);

  return {
    visibleItems,
    itemsAbove,
    itemsBelow,
    scrollUp,
    scrollDown,
    scrollToBottom,
    scrollToTop,
    halfViewport,
  };
}
