import type { CompletedItem } from "../app-items.js";
import {
  serializeCompletedItemToTerminalHistory,
  type TerminalHistoryContext,
} from "../terminal-history.js";
import { formatHistoryWrite } from "../terminal-history-format.js";
import { shouldSeparateTranscriptItems } from "./spacing.js";

/**
 * Flatten a list of completed transcript items into the exact flat ANSI line
 * buffer the scrollback printer would have written. Reuses the same serializer
 * (`serializeCompletedItemToTerminalHistory`) and the same inter-item spacing
 * rules (`formatHistoryWrite` + `shouldSeparateTranscriptItems`) so the
 * in-Ink viewport renders byte-identically to the legacy scrollback transcript.
 *
 * Pure (no Ink, no stdout) so it can be unit-tested and windowed cheaply at the
 * line level instead of relying on fragile React height measurement.
 */
export function buildTranscriptLines(
  items: readonly CompletedItem[],
  context: TerminalHistoryContext,
): string[] {
  let buffer = "";
  let previousPrintedKind: CompletedItem["kind"] | null = null;

  for (const item of items) {
    const output = serializeCompletedItemToTerminalHistory(item, context);
    const endsWithBlankLine = item.kind === "banner";
    // A continuation assistant chunk is the next paragraph of a response whose
    // earlier paragraphs were already flushed mid-stream. Re-insert the blank
    // line that separated them so the reassembled transcript matches the whole
    // response (assistant→assistant is otherwise compact).
    const isContinuationParagraph =
      item.kind === "assistant" &&
      item.continuation === true &&
      previousPrintedKind === "assistant";
    const formatted = formatHistoryWrite(output, {
      leadingSeparator:
        item.kind === "plan_transition"
          ? false
          : isContinuationParagraph
            ? true
            : shouldSeparateTranscriptItems({
                previousKind: previousPrintedKind ?? undefined,
                currentKind: item.kind,
              }),
      trailingBlankLine: endsWithBlankLine,
      trailingNewlines: item.kind === "user" ? 1 : undefined,
    });
    if (formatted.length === 0) continue;
    buffer += formatted;
    previousPrintedKind = item.kind;
  }

  if (buffer.length === 0) return [];
  // The serialized buffer always ends with at least one trailing newline; drop
  // the final empty element so the line count matches the visible row count.
  const lines = buffer.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface TranscriptWindow {
  /** The slice of lines to render, top-to-bottom. */
  lines: string[];
  /** Blank rows to pad above `lines` so content stays bottom-anchored. */
  topPadding: number;
  /** Clamped scroll offset from the bottom (0 = stuck to newest). */
  offset: number;
  /** Total line count (for scroll math / "more above" affordances). */
  total: number;
}

/**
 * Window a flat transcript line buffer to a bottom-anchored viewport of
 * `viewportRows` rows. `offsetFromBottom` scrolls the window upward (0 keeps
 * the newest line pinned to the bottom). When the content is shorter than the
 * viewport, `topPadding` blank rows are reported so the controls region stays
 * pinned to the very bottom of the screen.
 */
export function windowTranscriptLines(
  lines: readonly string[],
  viewportRows: number,
  offsetFromBottom: number,
): TranscriptWindow {
  const rows = Math.max(0, Math.floor(viewportRows));
  const total = lines.length;

  if (total <= rows) {
    return {
      lines: [...lines],
      topPadding: Math.max(0, rows - total),
      offset: 0,
      total,
    };
  }

  const maxOffset = total - rows;
  const offset = Math.min(Math.max(0, Math.floor(offsetFromBottom)), maxOffset);
  const end = total - offset;
  const start = end - rows;
  return {
    lines: lines.slice(start, end),
    topPadding: 0,
    offset,
    total,
  };
}
