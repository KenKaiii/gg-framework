import { useEffect } from "react";
import { useInput, type Key } from "ink";
import {
  pageTranscriptScroll,
  resetTranscriptScroll,
  scrollTranscriptToTop,
  setTranscriptScrollBounds,
  setTranscriptScrollOffset,
} from "../stores/transcript-scroll-store.js";

interface UseTranscriptScrollOptions {
  /** Total number of transcript lines available to scroll through. */
  totalLines: number;
  /** Height of the transcript viewport in rows. */
  viewportRows: number;
  /** Disable key handling (e.g. while an overlay owns the screen). */
  active: boolean;
  /**
   * Bumped by the caller whenever a new prompt is submitted; resets scroll to
   * the bottom so the user always sees their newest message + the response.
   */
  resetToken: number;
}

/**
 * Keyboard + bounds controller for the fullscreen alt-screen transcript
 * viewport. The offset itself lives in the external transcript-scroll store so
 * that scrolling re-renders only the viewport, not the whole App (see
 * stores/transcript-scroll-store.ts). This hook just:
 *   - keeps the store's clamp bounds in sync with content/layout,
 *   - resets to the bottom on a new prompt,
 *   - maps keys to store actions.
 *
 * Mouse-wheel scrolling is routed straight into the store from the input
 * handler (scrollTranscriptByLines), bypassing React state entirely.
 *
 * Keys: PageUp/PageDown (page), Shift+Up/Down (line), g/G (top/bottom).
 */
export function useTranscriptScroll({
  totalLines,
  viewportRows,
  active,
  resetToken,
}: UseTranscriptScrollOptions): void {
  const maxOffset = Math.max(0, totalLines - viewportRows);
  const page = Math.max(1, viewportRows - 1);

  // Sync clamp bounds whenever content length or viewport height changes.
  useEffect(() => {
    setTranscriptScrollBounds(maxOffset);
  }, [maxOffset]);

  // Snap back to the newest output on a new prompt submit.
  useEffect(() => {
    resetTranscriptScroll();
  }, [resetToken]);

  useInput(
    (input: string, key: Key) => {
      if (key.pageUp) pageTranscriptScroll(page);
      else if (key.pageDown) pageTranscriptScroll(-page);
      else if (key.shift && key.upArrow) pageTranscriptScroll(1);
      else if (key.shift && key.downArrow) pageTranscriptScroll(-1);
      else if (input === "g") scrollTranscriptToTop();
      else if (input === "G") setTranscriptScrollOffset(0);
    },
    { isActive: active },
  );
}
