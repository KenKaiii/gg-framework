/**
 * Page-change summaries for the browser tool: compare two accessibility
 * snapshots (Playwright `ariaSnapshot({ mode: "ai" })`) and keep the lines a
 * tester cares about, with element refs so the next step can act on them.
 */

const INTERACTIVE =
  /^\s*- (button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|switch|slider|spinbutton|tab|menuitem)\b/;
const REF = / \[ref=[^\]]+\]/g;
// Unnamed containers carry no information on their own.
const STRUCTURAL =
  /^- (generic|group|list|listitem|region|main|navigation|banner|contentinfo|article|section|paragraph|separator|none|presentation)( \[[^\]]*\])*:?$/;
export const MAX_CHANGE_LINES = 30;

/** Only the controls (buttons, links, fields) from a snapshot, one per line. */
export function interactiveLines(snapshot: string): string {
  return snapshot
    .split("\n")
    .filter((l) => INTERACTIVE.test(l))
    .map((l) => l.trim())
    .join("\n");
}

type Op = ["-" | "+", number];

/** Line-level diff (LCS), falling back to set difference on very large pages. */
export function lineDiff(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    const sa = new Set(a);
    const sb = new Set(b);
    return [
      ...a.flatMap((l, i): Op[] => (sb.has(l) ? [] : [["-", i]])),
      ...b.flatMap((l, j): Op[] => (sa.has(l) ? [] : [["+", j]])),
    ];
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(["-", i++]);
    else out.push(["+", j++]);
  }
  while (i < n) out.push(["-", i++]);
  while (j < m) out.push(["+", j++]);
  return out;
}

// Focus moving between elements isn't a page change.
const key = (l: string): string => l.replace(REF, "").replace(/ \[active\]/g, "");
// Same element if role and name match; its value or state may differ.
const identity = (l: string): string =>
  key(l)
    .replace(/ \[[^\]]*\]/g, "")
    .replace(/:.*$/, "");

/** Readable changes between two snapshots: `+` added, `-` removed, `~` updated. */
export function snapshotChanges(before: string, after: string): string[] {
  const clean = (s: string): string[] =>
    s
      .split("\n")
      .map((l) => l.trim().replace(/^- /, ""))
      .filter(Boolean);
  const a = clean(before);
  const b = clean(after);
  const ops = lineDiff(a.map(key), b.map(key));
  const lines: string[] = [];
  for (let k = 0; k < ops.length; k++) {
    const [op, idx] = ops[k]!;
    const next = ops[k + 1];
    // A removed line followed by an added line for the same element is an update.
    if (op === "-" && next?.[0] === "+" && identity(a[idx]!) === identity(b[next[1]]!)) {
      lines.push(`~ ${b[next[1]]!.replace(/ \[active\]/g, "")}`);
      k++;
      continue;
    }
    const line = op === "+" ? b[idx]!.replace(/ \[active\]/g, "") : key(a[idx]!);
    if (!STRUCTURAL.test(`- ${key(line)}`)) lines.push(`${op} ${line}`);
  }
  if (lines.length <= MAX_CHANGE_LINES) return lines;
  return [
    ...lines.slice(0, MAX_CHANGE_LINES),
    `… ${lines.length - MAX_CHANGE_LINES} more changes (snapshot() shows the whole page)`,
  ];
}

/**
 * Page changes after a viewport resize, worded as what the new size hides or
 * shows: a bare "- button" line was easy to read past as noise.
 */
export function describeResize(changes: readonly string[], size: string): string {
  const pick = (prefix: string): string[] =>
    changes.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  const hidden = pick("- ");
  const shown = pick("+ ");
  const changed = pick("~ ");
  const parts: string[] = [];
  if (hidden.length) parts.push(`No longer visible at ${size}:\n${hidden.join("\n")}`);
  if (shown.length) parts.push(`Now visible at ${size}:\n${shown.join("\n")}`);
  if (changed.length) parts.push(`Changed:\n${changed.join("\n")}`);
  parts.push(...changes.filter((l) => l.startsWith("…")));
  return parts.length ? parts.join("\n") : `Nothing appeared or disappeared at ${size}.`;
}
