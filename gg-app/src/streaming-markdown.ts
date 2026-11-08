import remend from "remend";

/**
 * Make a STREAMING reply's tail safe to render as markdown, so the reader sees
 * formatting from the first letter instead of raw syntax that later snaps into
 * place ("**He" shown as asterisks, then re-rendered bold a moment later).
 *
 * Four jobs, all only ever about the unfinished end of the text:
 *
 *  1. Close what is open: `**bold`, `*italic*`, `` `code ``, `~~strike`, and a
 *     half-written `[link](`. This is `remend`, the same repair step
 *     Streamdown (Vercel) uses; code blocks and lone `*` / `$` are left alone.
 *     A link is a link from its first letter, pointing at a placeholder until
 *     its address lands (ExternalLink makes that inert): showing it as plain
 *     text first and swapping in the link later rebuilt its words, and they
 *     faded in twice.
 *  2. Hold back a table that has no `|---|` line yet. Until that line arrives
 *     the header is just a paragraph of pipes; it renders as a table, header
 *     included, once the delimiter row lands.
 *  3. Hold back a last line that is so far only a block marker (`-`, `1.`,
 *     `##`, `>`). A lone `-` under a line of text is a heading underline, so
 *     the line above flashed up as a big heading for a frame before the list
 *     item's text arrived; `1.` read as text at the end of the paragraph.
 *  4. Hold back a short, punctuation-free line standing alone ("Summary")
 *     until its NEXT line shows what it is. A `---` or `===` under it turns it
 *     into a heading, and turning a paragraph into a heading replaces its
 *     element, so its words faded in a second time at a new size. Ordinary
 *     sentences never wait: they rarely get underlined, and a `---` under a
 *     sentence is drawn as a rule after it, not a heading.
 *
 * Re-rendering a bold run the moment its closing `**` arrived also replaced
 * the word elements inside it, so those words faded in a second time. Closing
 * the run from the start keeps the structure stable, which is what removes
 * that flicker.
 *
 * The finished reply is never touched: this runs only while streaming.
 */
export function displayStreamingMarkdown(text: string): string {
  return remend(holdBackPendingTable(holdBackPendingHeading(holdBackPendingMarker(text))));
}

/**
 * The text minus a final line that a `---` / `===` underline could still turn
 * into a heading: a line standing on its own (a blank line or the start of the
 * reply above it, nothing written after it yet) that looks like a title: short,
 * and not ending like a sentence. Lines that start a list, heading, quote,
 * table or fence are already what they are. This holds the line while it is
 * still being typed too: a network gap after "Summary" used to show it as
 * text, and the `---` arriving a moment later rebuilt it as a heading.
 */
export function holdBackPendingHeading(text: string): string {
  const body = text.replace(/\n+$/, "");
  const cut = body.lastIndexOf("\n");
  const last = body.slice(cut + 1);
  if (!last.trim() || /^\s{0,3}([-*+>#|]|\d{1,9}[.)]|```|~~~)/.test(last)) return text;
  if (last.trim().length > 60 || /[.!?:;,)`*_]$/.test(last.trim())) return text;
  // Title-shaped: a few words, no sentence punctuation inside ("Summary",
  // "Next steps"). A sentence still being typed ("Got it, here's what") is not
  // held, or it would vanish for the length of every network gap.
  if (last.trim().split(/\s+/).length > 4 || /[,;:—–'"`*_[(]/.test(last)) return text;
  // A single-line paragraph with a blank line above it. Not the reply's own
  // first line: an underline there is all but unheard of, and holding it would
  // keep the first words of every reply waiting for a line break.
  if (cut < 0 || body.slice(0, cut).split("\n").pop()?.trim()) return text;
  let fenceOpen = false;
  for (const line of body.slice(0, Math.max(cut, 0)).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
  }
  return fenceOpen ? text : body.slice(0, Math.max(cut, 0));
}

/** A line that, so far, is nothing but the start of a list, heading or quote. */
const MARKER_ONLY = /^ {0,3}(?:[-*+=_]+|\d{1,9}[.)]?|#{1,6}|>)\s*$/;

/**
 * Drop a trailing line that is only a block marker so far. Only the line still
 * being written (no newline after it) is considered, and never inside an open
 * code fence.
 */
export function holdBackPendingMarker(text: string): string {
  const cut = text.lastIndexOf("\n");
  const last = text.slice(cut + 1);
  if (!MARKER_ONLY.test(last)) return text;
  let fenceOpen = false;
  for (const line of text.slice(0, cut + 1).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
  }
  return fenceOpen ? text : text.slice(0, Math.max(cut, 0));
}

/**
 * A line that starts like a table row. Only a leading `|` counts: that is how
 * models write tables, and a looser rule (any `a | b`) would hold back ordinary
 * prose such as "use a || b".
 */
const TABLE_ROW = /^\s*\|/;
/** A complete `|---|:--:|` line: one dash run per column of the header. */
function isDelimiterFor(header: string, line: string): boolean {
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) return false;
  const cells = (row: string): number =>
    row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
  return cells(line) >= cells(header);
}

/**
 * Drop a trailing run of table-looking lines that has no delimiter row yet,
 * plus a half-written delimiter row itself. A table already under way (its
 * delimiter is in) keeps all its rows; its last row simply grows. Code blocks
 * are skipped: a `|` inside a fence is code, not a table.
 */
export function holdBackPendingTable(text: string): string {
  const lines = text.split("\n");
  // Inside an open code fence nothing is a table.
  let fenceOpen = false;
  for (const line of lines) if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
  if (fenceOpen) return text;

  // A newline typed after the header row doesn't make it any less pending.
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  let start = end;
  while (start > 0 && TABLE_ROW.test(lines[start - 1] ?? "")) start--;
  if (start === end) return text;
  const run = lines.slice(start, end);
  // A delimiter with a dash run for every header column means a real table:
  // show it. A half-typed one (`|---|--` under three columns) still waits, or
  // the header would flash as a paragraph of pipes and then turn into a table.
  if (run.length >= 3 || (run.length === 2 && isDelimiterFor(run[0] ?? "", run[1] ?? ""))) {
    return text;
  }
  return lines.slice(0, start).join("\n").replace(/\n+$/, "");
}
