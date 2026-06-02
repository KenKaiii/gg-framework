export interface AssistantStreamSplit {
  flushedText: string;
  remainingText: string;
}

/**
 * Estimate how many terminal rows `text` occupies when wrapped at `columns`.
 *
 * A heuristic (counts characters, not grapheme/display width, and ignores
 * Markdown re-rendering) used only to decide whether in-flight streamed text is
 * about to overflow the live region. Over-counting slightly is fine — it just
 * flushes marginally earlier. Each newline-separated line wraps independently;
 * an empty line still occupies one row.
 */
export function estimateRenderedRows(text: string, columns: number): number {
  if (text.length === 0) return 0;
  const width = Math.max(1, Math.floor(columns));
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += line.length === 0 ? 1 : Math.ceil(line.length / width);
  }
  return rows;
}

function isInsideCodeFence(text: string): boolean {
  const fenceMatches = text.match(/^\s*(`{3,}|~{3,})/gm);
  return (fenceMatches?.length ?? 0) % 2 === 1;
}

/**
 * Decide how much of the in-flight assistant text can be flushed to terminal
 * scrollback while streaming, keeping the trailing in-progress block live.
 *
 * Flushing progressively (instead of dumping the whole response at the end)
 * keeps the live region small so it never has to scroll the full response into
 * scrollback in one shot — that single large write is what makes the TUI
 * "jump up" when the agent finishes.
 *
 * Splits ONLY at paragraph boundaries (blank lines) that sit OUTSIDE code
 * fences, and never trims interior whitespace, so each flushed chunk is a
 * self-contained set of Markdown blocks that renders identically whether shown
 * alone in history or as part of the whole response. (An earlier version split
 * mid-sentence and trimmed whitespace, which broke live/history parity.)
 *
 * Guarantees `flushedText + remainingText === text`.
 */
export function splitAssistantStreamingText(text: string): AssistantStreamSplit {
  const boundary = /\n[ \t]*\n/g;
  let best = -1;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    // Keep the trailing block live until it too ends in a blank line.
    if (boundaryEnd >= text.length) break;
    // Never split inside an open code fence — the chunk would render as broken
    // Markdown (unterminated fence) in history.
    if (isInsideCodeFence(text.slice(0, boundaryEnd))) continue;
    best = boundaryEnd;
  }
  if (best <= 0) return { flushedText: "", remainingText: text };
  return { flushedText: text.slice(0, best), remainingText: text.slice(best) };
}
