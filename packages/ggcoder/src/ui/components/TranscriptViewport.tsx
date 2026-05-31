import React from "react";
import { Box, Text } from "ink";
import { windowTranscriptLines } from "../transcript/transcript-lines.js";
import { useTranscriptScrollOffset } from "../stores/transcript-scroll-store.js";

interface TranscriptViewportProps {
  /** Flat ANSI transcript lines (history + liveItems + streaming, serialized). */
  lines: readonly string[];
  /** Terminal width — bounds each rendered row. */
  columns: number;
  /** Number of rows the transcript region occupies. */
  viewportRows: number;
}

/**
 * Bounded, bottom-anchored transcript region rendered entirely inside Ink.
 *
 * Renders a windowed slice of the pre-flattened transcript line buffer as
 * truncated <Text> rows. The controls sit below it in the same full-height
 * frame, so the footer stays pinned to the bottom while the transcript scrolls
 * *within* this box.
 *
 * Sizing: `height={viewportRows}` is the PREFERRED height, but the box is
 * `flexShrink={1}` so it yields when the controls region grows taller than
 * expected — e.g. when the slash-command menu or a task picker opens below
 * the input. Without this the menu would overflow off the bottom of the screen
 * (it's pinned). `justifyContent="flex-end"` + `overflowY="hidden"` means any
 * shrink clips the OLDEST rows at the top, keeping the newest output and the
 * controls visible.
 */
function TranscriptViewportImpl({ lines, columns, viewportRows }: TranscriptViewportProps) {
  // Subscribe to the external scroll store directly. Because only this subtree
  // consumes the offset, a wheel/key scroll re-renders just the viewport — not
  // the whole App — which is what makes scrolling smooth.
  const scrollOffsetFromBottom = useTranscriptScrollOffset();
  const window = windowTranscriptLines(lines, viewportRows, scrollOffsetFromBottom);

  // Emit EXACTLY `viewportRows` rows every frame — blank lines pad the top when
  // the content is shorter than the viewport. A constant child count keeps the
  // total frame line-count stable across renders, so Ink's incremental renderer
  // diffs pure line *content* and never has to reflow/erase the controls below.
  // That stability (not just flex anchoring) is what removes the scroll flicker.
  const rows = new Array<string>(viewportRows).fill("");
  for (let i = 0; i < window.lines.length; i++) {
    rows[window.topPadding + i] = window.lines[i] ?? "";
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={1}
      flexGrow={0}
      width={columns}
      height={viewportRows}
      overflowY="hidden"
      justifyContent="flex-end"
    >
      {rows.map((line, index) => (
        <Text key={`row-${index}`} wrap="truncate-end">
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Memoized so unrelated App re-renders (streaming ticks, footer timers, status
 * shimmer) don't force the transcript subtree to reconcile. It only re-renders
 * when its line buffer, dimensions, or scroll offset actually change.
 */
export const TranscriptViewport = React.memo(TranscriptViewportImpl);
