import { useState, useRef, useEffect } from "react";

/**
 * Hold a value for at least `minMs` milliseconds before switching to the
 * next value.  Prevents rapid visual flicker when values change faster
 * than a human can read (e.g. collapsed tool group hints).
 *
 * If the value changes again before the timer fires the timer restarts
 * with the newest value, so the displayed value is never stale by more
 * than one transition.
 */
export function useMinDisplayTime<T>(value: T, minMs = 700): T {
  const [displayed, setDisplayed] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(value);

  latestRef.current = value;

  useEffect(() => {
    // First render — sync immediately
    if (displayed === value) return;

    // Clear any pending timer
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      setDisplayed(latestRef.current);
      timerRef.current = null;
    }, minMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, minMs, displayed]);

  return displayed;
}
