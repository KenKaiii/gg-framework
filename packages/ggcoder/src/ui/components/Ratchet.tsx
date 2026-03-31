import React, { useRef, useState, useLayoutEffect, useCallback } from "react";
import { Box, measureElement, type DOMElement } from "ink";

interface Props {
  /**
   * `"always"` — permanently lock height to the maximum seen.
   * `"offscreen"` — same behaviour for now; full viewport detection
   * can be added later without changing callers.
   */
  lock?: "always" | "offscreen";
  children: React.ReactNode;
}

/**
 * Height-ratchet: once content grows to N rows the outer Box never
 * shrinks below N, preventing jarring visual jumps when streaming
 * content temporarily shortens (e.g. markdown re-parse flicker).
 *
 * Mirrors claude-code's Ratchet component.
 */
export function Ratchet({ children, lock: _lock = "always" }: Props): React.ReactNode {
  const innerRef = useRef<DOMElement | null>(null);
  const maxHeight = useRef(0);
  const [minHeight, setMinHeight] = useState(0);

  const outerRef = useCallback((_el: DOMElement | null) => {
    // Placeholder for future viewport tracking.
  }, []);

  useLayoutEffect(() => {
    if (!innerRef.current) return;
    const { height } = measureElement(innerRef.current);
    const termRows = process.stdout.rows ?? 24;
    if (height > maxHeight.current) {
      maxHeight.current = Math.min(height, termRows);
      setMinHeight(maxHeight.current);
    }
  });

  return (
    <Box minHeight={minHeight} ref={outerRef}>
      <Box ref={innerRef} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
