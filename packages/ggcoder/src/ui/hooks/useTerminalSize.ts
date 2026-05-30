import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from "react";
import { useStdout } from "ink";

interface TerminalSizeValue {
  columns: number;
  rows: number;
  resizeKey: number;
}

// Minimum terminal dimensions — below these values layout calculations can
// produce zero/negative widths that cause Ink to enter infinite re-render
// loops with ghost/duplicate content.  Every consumer of useTerminalSize()
// is guaranteed at least these values.
const MIN_COLUMNS = 40;
const MIN_ROWS = 10;

const TerminalSizeContext = createContext<TerminalSizeValue | null>(null);

/**
 * Provider that attaches a single resize listener to stdout and shares
 * { columns, rows, resizeKey } with all descendants via context.
 *
 * Mount this once near the root of the component tree (e.g. in render.ts
 * or App.tsx) to avoid the MaxListenersExceededWarning that occurs when
 * every component independently listens for resize events.
 */
export function TerminalSizeProvider({
  children,
  isAgentRunning,
  fullscreen = false,
}: React.PropsWithChildren<{
  /**
   * Optional getter — when it returns true, the resize debounce skips its
   * resizeKey bump while the agent is running. The deferred resetUI() in
   * App.tsx cleans up reflow drift the moment the agent goes idle, so the
   * visual cost of skipping here is minimal.
   */
  isAgentRunning?: () => boolean;
  /**
   * Fullscreen alt-screen mode. Ink owns the whole screen and repaints the
   * full-height frame in place, so on resize we only re-measure dimensions —
   * no manual screen clear (which would flash) and no resizeKey bump (the
   * full-height layout reflows on the dimension change alone).
   */
  fullscreen?: boolean;
}>) {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: Math.max(MIN_COLUMNS, stdout?.columns ?? 80),
    rows: Math.max(MIN_ROWS, stdout?.rows ?? 24),
  });
  const [resizeKey, setResizeKey] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAgentRunningRef = useRef(isAgentRunning);
  isAgentRunningRef.current = isAgentRunning;

  const onResize = useCallback(() => {
    if (!stdout) return;

    // Do NOT update dimensions immediately — doing so triggers React
    // re-renders on every resize event (many per drag), but Ink's internal
    // line-tracking still assumes the old width, so each re-render at the
    // new width is positioned incorrectly, leaving ghost/duplicate copies
    // of the input area in the terminal.  Instead, debounce everything so
    // we update once after the user finishes dragging.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const running = isAgentRunningRef.current?.() ?? false;
      if (running) {
        // Update dimensions only — skip the resizeKey bump. render.ts flags
        // pendingResetUI; App.tsx fires a clean resetUI() the moment the agent
        // goes idle, fixing any reflow drift then.
        setSize({
          columns: Math.max(MIN_COLUMNS, stdout.columns ?? 80),
          rows: Math.max(MIN_ROWS, stdout.rows ?? 24),
        });
        return;
      }
      if (fullscreen) {
        // Alt screen: re-measure only. The full-height frame reflows to the new
        // dimensions on this state change; Ink repaints it in place with no
        // native scrollback to disturb, so there's nothing to clear.
        setSize({
          columns: Math.max(MIN_COLUMNS, stdout.columns ?? 80),
          rows: Math.max(MIN_ROWS, stdout.rows ?? 24),
        });
        return;
      }
      // Clear visible screen only. Completed chat rows are real terminal
      // scrollback now; preserve them while dropping malformed live frames left
      // behind by resize reflow.
      stdout.write("\x1b[2J\x1b[H");
      setSize({
        columns: Math.max(MIN_COLUMNS, stdout.columns ?? 80),
        rows: Math.max(MIN_ROWS, stdout.rows ?? 24),
      });
      setResizeKey((k) => k + 1);
    }, 300);
  }, [stdout, fullscreen]);

  useEffect(() => {
    if (!stdout) return;
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [stdout, onResize]);

  const value = React.useMemo(() => ({ ...size, resizeKey }), [size, resizeKey]);

  return React.createElement(TerminalSizeContext.Provider, { value }, children);
}

/**
 * Returns { columns, rows, resizeKey } from the nearest TerminalSizeProvider.
 *
 * All values (`columns`, `rows`, `resizeKey`) update together after resize
 * events settle (300ms debounce).  Updating dimensions immediately would
 * trigger React re-renders on every resize event while Ink's internal
 * line-tracking still assumes the old width, causing ghost/duplicate renders.
 *
 * `resizeKey` can be used as a React `key` to force live-area remounts after
 * terminal dimensions settle.
 */
export function useTerminalSize() {
  const ctx = useContext(TerminalSizeContext);
  if (!ctx) {
    throw new Error("useTerminalSize must be used within a <TerminalSizeProvider>");
  }
  return ctx;
}
