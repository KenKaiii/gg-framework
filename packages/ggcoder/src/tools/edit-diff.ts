import { diffLines } from "diff";

/**
 * Normalize text for fuzzy matching:
 * - Strip trailing whitespace per line
 * - Replace smart quotes with straight quotes
 * - Replace unicode dashes with hyphens
 */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .replace(/[^\S\n]+$/gm, "") // trailing whitespace per line
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes
    .replace(/[\u201C\u201D]/g, '"') // smart double quotes
    .replace(/[\u2013\u2014]/g, "-"); // en/em dashes
}

/**
 * Aider's `match_but_for_leading_whitespace`: returns the uniform leading
 * whitespace prefix that — if prepended to every non-blank line of `partLines`
 * — would make them equal to `wholeLines`. Returns null when:
 *   - line counts differ
 *   - any line's non-whitespace content doesn't match
 *   - the leading whitespace delta isn't uniform across all non-blank lines
 *
 * This is the precision check that anchors `applyMissingLeadingWhitespace`.
 */
function matchButForLeadingWhitespace(wholeLines: string[], partLines: string[]): string | null {
  if (wholeLines.length !== partLines.length) return null;

  for (let i = 0; i < wholeLines.length; i++) {
    if (wholeLines[i].trimStart() !== partLines[i].trimStart()) return null;
  }

  const prefixes = new Set<string>();
  for (let i = 0; i < wholeLines.length; i++) {
    if (wholeLines[i].trim() === "") continue;
    const wholeLead = wholeLines[i].length - wholeLines[i].trimStart().length;
    const partLead = partLines[i].length - partLines[i].trimStart().length;
    if (wholeLead < partLead) return null;
    prefixes.add(wholeLines[i].slice(0, wholeLead - partLead));
  }

  if (prefixes.size !== 1) return null;
  return [...prefixes][0];
}

/**
 * Aider's `replace_part_with_missing_leading_whitespace` (~10k stars between
 * aider/devon/codemcp/qwen-coder use this exact pattern). Models very often
 * mess up leading whitespace — uniformly across both old_text and new_text.
 * Strategy:
 *   1. Outdent old/new uniformly by the smallest leading-whitespace count
 *      across all non-blank lines (handles "model included some but not all").
 *   2. Scan the file for a window where every line matches when stripped AND
 *      the file's actual leading prefix is uniform across non-blank lines.
 *   3. Re-apply that uniform file-prefix to every non-blank line of new_text
 *      before substituting.
 *
 * Returns the rewritten file content on success, null when no unique match.
 */
export function applyMissingLeadingWhitespace(
  working: string,
  old: string,
  next: string,
): string | null {
  const workingLines = working.split("\n");
  let oldLines = old.split("\n");
  let newLines = next.split("\n");

  if (oldLines.length === 0) return null;

  // Outdent both uniformly by the min leading-whitespace count across all
  // non-blank lines in either old or new. Handles the common case where the
  // model wrote SOME indentation but less than the file's actual amount.
  const nonBlank = [...oldLines, ...newLines].filter((l) => l.trim() !== "");
  if (nonBlank.length > 0) {
    const minLead = Math.min(...nonBlank.map((l) => l.length - l.trimStart().length));
    if (minLead > 0) {
      oldLines = oldLines.map((l) => (l.trim() !== "" ? l.slice(minLead) : l));
      newLines = newLines.map((l) => (l.trim() !== "" ? l.slice(minLead) : l));
    }
  }

  const numOld = oldLines.length;
  let matchIdx = -1;
  let matchPrefix: string | null = null;
  let matchCount = 0;

  for (let i = 0; i + numOld <= workingLines.length; i++) {
    const window = workingLines.slice(i, i + numOld);
    const prefix = matchButForLeadingWhitespace(window, oldLines);
    if (prefix !== null) {
      matchCount++;
      if (matchIdx === -1) {
        matchIdx = i;
        matchPrefix = prefix;
      }
      // Two matches → ambiguous; let the caller fall through to the not_found
      // path so the model adds context. (Same safety bar as our other matchers.)
      if (matchCount > 1) return null;
    }
  }

  if (matchIdx === -1 || matchPrefix === null) return null;

  const newWithPrefix = newLines.map((l) => (l.trim() !== "" ? matchPrefix + l : l));
  const result = [
    ...workingLines.slice(0, matchIdx),
    ...newWithPrefix,
    ...workingLines.slice(matchIdx + numOld),
  ];
  return result.join("\n");
}

/**
 * Aider-style `...` elision matching: when `old_text` contains lines that are
 * just `...`, treat them as "skip whatever's here" placeholders. The model
 * writes:
 *
 *   old:  function foo() {
 *           ...
 *           return bar;
 *         }
 *   new:  function foo() {
 *           ...
 *           return baz;
 *         }
 *
 * We split both `old` and `next` on the `...` lines, then anchor the bookend
 * pieces in `working` (greedy, in order). The elided middle from `working` is
 * preserved verbatim and stitched in between the new bookends. Returns the
 * rewritten buffer on success, null when:
 *   - `old` has no `...` lines (caller should try other strategies)
 *   - piece counts differ between `old` and `next` (ambiguous elision)
 *   - any piece is empty (means dots at start/end or adjacent — too risky)
 *   - any old piece doesn't appear in `working` after the previous one
 *
 * Greedy first-match-then-forward. We DO NOT support `replace_all` with
 * elision — `...` is intrinsically a single edit.
 */
export function applyDotdotdots(working: string, old: string, next: string): string | null {
  const dotLineRe = /^[ \t]*\.\.\.[ \t]*$/m;
  if (!dotLineRe.test(old)) return null;

  // Split consumes the dot line including its trailing newline (if present),
  // so the next piece starts cleanly at its first real character.
  const splitRe = /^[ \t]*\.\.\.[ \t]*\r?\n?/m;
  const oldPieces = old.split(splitRe);
  const newPieces = next.split(splitRe);

  if (oldPieces.length !== newPieces.length) return null;
  if (oldPieces.length < 2) return null;
  if (oldPieces.some((p) => p === "") || newPieces.some((p) => p === "")) return null;

  let cursor = 0;
  const positions: { start: number; end: number }[] = [];
  for (const piece of oldPieces) {
    const idx = working.indexOf(piece, cursor);
    if (idx === -1) return null;
    positions.push({ start: idx, end: idx + piece.length });
    cursor = idx + piece.length;
  }

  let result = working.slice(0, positions[0].start);
  for (let i = 0; i < oldPieces.length; i++) {
    result += newPieces[i];
    if (i < oldPieces.length - 1) {
      // The elided middle from the original file is preserved verbatim —
      // that's the whole point of the `...` placeholder.
      result += working.slice(positions[i].end, positions[i + 1].start);
    }
  }
  result += working.slice(positions[positions.length - 1].end);
  return result;
}

/**
 * Models often add a spurious leading blank line to `old_text` (e.g. when
 * copying a code block out of fenced markdown). Aider noticed this back at
 * its issue #25. If the first line is blank, return the same text minus that
 * line so the caller can retry the match. Returns null when no leading blank
 * line exists, so callers can cheaply skip the retry.
 */
export function stripLeadingBlankLine(text: string): string | null {
  if (!text) return null;
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx === -1) return null;
  if (text.slice(0, newlineIdx).trim() !== "") return null;
  return text.slice(newlineIdx + 1);
}

/**
 * Find text in content, trying exact match first then fuzzy.
 */
export function fuzzyFindText(
  content: string,
  oldText: string,
): { found: boolean; index: number; matchLength: number; usedFuzzy: boolean } {
  // Exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzy: false };
  }

  // Fuzzy match: normalize both sides
  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOld = normalizeForFuzzyMatch(oldText);

  const fuzzyIndex = normalizedContent.indexOf(normalizedOld);
  if (fuzzyIndex !== -1) {
    // Map back to original content: find the actual length in original
    // Since normalization only changes per-character substitutions and trailing whitespace,
    // we need to find the original range.
    // Strategy: match line by line to find the original span.
    const normalizedBefore = normalizedContent.slice(0, fuzzyIndex);
    const linesBefore = normalizedBefore.split("\n").length - 1;
    const normalizedMatch = normalizedContent.slice(fuzzyIndex, fuzzyIndex + normalizedOld.length);
    const matchLineCount = normalizedMatch.split("\n").length;

    const contentLines = content.split("\n");
    const matchLines = contentLines.slice(linesBefore, linesBefore + matchLineCount);
    const originalMatch = matchLines.join("\n");

    // Find actual index of the first match line start
    let actualIndex = 0;
    for (let i = 0; i < linesBefore; i++) {
      actualIndex += contentLines[i].length + 1; // +1 for \n
    }

    return {
      found: true,
      index: actualIndex,
      matchLength: originalMatch.length,
      usedFuzzy: true,
    };
  }

  return { found: false, index: -1, matchLength: 0, usedFuzzy: false };
}

/**
 * Count occurrences of oldText in content (exact first, then fuzzy).
 */
export function countOccurrences(content: string, oldText: string): number {
  // Try exact first
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(oldText, pos)) !== -1) {
    count++;
    pos += oldText.length;
  }
  if (count > 0) return count;

  // Fuzzy count
  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOld = normalizeForFuzzyMatch(oldText);
  pos = 0;
  while ((pos = normalizedContent.indexOf(normalizedOld, pos)) !== -1) {
    count++;
    pos += normalizedOld.length;
  }
  return count;
}

function tokenize(line: string): string[] {
  return line
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.toLowerCase());
}

/**
 * When old_text isn't found, locate up to `maxResults` lines in `content` with
 * the highest token-overlap to the first non-empty line of `oldText` and
 * return ±contextLines around each as numbered snippets, joined by `---`.
 * Returns null if there's no plausible match (no shared tokens at all).
 * Cuts retry loops by showing the model what's actually in the file at the
 * expected location(s) — multiple results help disambiguate when several
 * regions look similar (e.g. repeated function bodies).
 */
export interface ClosestSnippet {
  snippet: string;
  // 1-based line number of the strongest candidate — used by callers to build
  // a targeted re-read suggestion (`read offset=X limit=Y`) so the model
  // doesn't have to slurp the whole file just to recover from one bad edit.
  topLine: number;
}

export function findClosestSnippet(
  content: string,
  oldText: string,
  contextLines = 3,
  maxResults = 3,
): ClosestSnippet | null {
  const oldFirstLine = oldText.split("\n").find((l) => l.trim().length > 0);
  if (!oldFirstLine) return null;
  const oldTokens = new Set(tokenize(oldFirstLine));
  if (oldTokens.size === 0) return null;

  const lines = content.split("\n");
  const candidates: { line: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = tokenize(lines[i]);
    if (lineTokens.length === 0) continue;
    let overlap = 0;
    for (const t of lineTokens) if (oldTokens.has(t)) overlap++;
    if (overlap > 0) candidates.push({ line: i, score: overlap });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.line - b.line);
  const bestScore = candidates[0].score;
  const topLine = candidates[0].line + 1;
  // Drop candidates that are dramatically weaker than the best match —
  // keeps the snippet focused instead of dumping the whole file.
  const minScore = Math.max(1, Math.ceil(bestScore / 3));
  const top = candidates.filter((c) => c.score >= minScore).slice(0, maxResults);

  // Render in source order so line numbers ascend down the snippet.
  top.sort((a, b) => a.line - b.line);

  const renderRange = (centerLine: number): string => {
    const start = Math.max(0, centerLine - contextLines);
    const end = Math.min(lines.length, centerLine + contextLines + 1);
    return lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6, " ")}\t${l}`)
      .join("\n");
  };

  return { snippet: top.map((c) => renderRange(c.line)).join("\n---\n"), topLine };
}

/**
 * Locate every occurrence of `text` in `content` and return the 1-indexed line
 * number plus a trimmed preview of that line. Tries exact first, then the same
 * fuzzy normalization as `countOccurrences` so the line numbers match what the
 * caller saw in `countOccurrences`. Capped at `max` so error messages stay
 * compact when a token like `}` matches dozens of times.
 */
export function findOccurrenceLines(
  content: string,
  text: string,
  max = 6,
): { line: number; preview: string }[] {
  const collectOffsets = (haystack: string, needle: string): number[] => {
    if (!needle) return [];
    const offsets: number[] = [];
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
      offsets.push(pos);
      pos += needle.length;
    }
    return offsets;
  };

  let source = content;
  let offsets = collectOffsets(content, text);
  if (offsets.length === 0) {
    source = normalizeForFuzzyMatch(content);
    offsets = collectOffsets(source, normalizeForFuzzyMatch(text));
  }

  const out: { line: number; preview: string }[] = [];
  for (const offset of offsets.slice(0, max)) {
    const before = source.slice(0, offset);
    const line = before.split("\n").length;
    const lineStart = before.lastIndexOf("\n") + 1;
    const nextNewline = source.indexOf("\n", lineStart);
    const lineText = source.slice(lineStart, nextNewline === -1 ? undefined : nextNewline);
    out.push({ line, preview: lineText.trim() });
  }
  return out;
}

/**
 * Generate a unified diff string.
 */
export function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  const changes = diffLines(oldContent, newContent);
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const change of changes) {
    const prefix = change.added ? "+" : change.removed ? "-" : " ";
    const changeLines = change.value.replace(/\n$/, "").split("\n");
    for (const line of changeLines) {
      lines.push(`${prefix}${line}`);
    }
  }

  return lines.join("\n");
}
