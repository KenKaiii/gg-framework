import React, { useRef, useState, useLayoutEffect, useMemo } from "react";
import { Text, Box, useStdout, measureElement, type DOMElement } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { useTheme, type Theme } from "../theme/theme.js";
import { highlightCode } from "../utils/highlight.js";
import {
  centerToWidth,
  fitToWidth,
  plainTextLength,
  wrapPlainTextLines,
} from "../utils/table-text.js";
import { markdownTokenCache, containsMarkdownSyntax } from "../utils/markdown-cache.js";

/**
 * Render a markdown string as Ink components.
 *
 * Pass an explicit `width` to bypass self-measurement — strongly
 * recommended during streaming to avoid 30+ measureElement calls/sec.
 * Required inside Ink's `<Static>` where re-renders don't update
 * flushed output.
 */
export const Markdown = React.memo(function Markdown({
  children,
  width: explicitWidth,
}: {
  children: string;
  width?: number;
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const ref = useRef<DOMElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  // Only self-measure when no explicit width is provided. When explicitWidth
  // is set (e.g. during streaming), this effect is a no-op — avoiding
  // ~30 measureElement calls/sec that cause layout thrashing.
  useLayoutEffect(() => {
    if (explicitWidth != null) return;
    if (ref.current) {
      const { width } = measureElement(ref.current);
      if (width > 0 && width !== measuredWidth) {
        setMeasuredWidth(width);
      }
    }
    // Depend on measuredWidth so we re-measure if it changes (e.g. resize),
    // but NOT on children — that's what caused 30/sec measurements.
  }, [measuredWidth, explicitWidth]);

  const columns =
    explicitWidth != null
      ? explicitWidth
      : measuredWidth > 0
        ? measuredWidth
        : Math.max(40, (stdout?.columns || 80) - 4);

  // Stabilise table rendering during streaming: if the text ends with an
  // incomplete table row (starts with `|` but doesn't end with `|`), strip
  // that trailing fragment before parsing.  This prevents marked from
  // flip-flopping between "text" and "table" tokens as each character
  // arrives, which is the primary cause of table flicker.
  const stabilised = useMemo(() => {
    const lines = children.split("\n");
    let trailingFragment = "";
    // Walk backwards to find an incomplete trailing table row
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      if (lastLine.startsWith("|") && !lastLine.trimEnd().endsWith("|")) {
        trailingFragment = lines.pop()!;
      }
    }

    // Detect unclosed code fences: if there's an opening ``` without a matching
    // close, strip just the opening fence line so marked doesn't swallow all
    // subsequent content (lists, bullets, etc.) into one giant code block.
    // The content after the fence is kept in the body as regular markdown.
    let body = lines.join("\n");
    const fencePattern = /^(`{3,}|~{3,})([^\n]*)/m;
    let searchFrom = 0;
    while (searchFrom < body.length) {
      const openMatch = fencePattern.exec(body.slice(searchFrom));
      if (!openMatch) break;
      const openIdx = searchFrom + openMatch.index;
      const fence = openMatch[1];
      const afterOpen = body.indexOf("\n", openIdx);
      if (afterOpen === -1) break; // fence is the last line
      // Find the closing fence (same char, same or more length, at start of line)
      const closePattern = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`, "m");
      const closeMatch = closePattern.exec(body.slice(afterOpen));
      if (closeMatch) {
        // Fence is closed — skip past it
        searchFrom = afterOpen + closeMatch.index + closeMatch[0].length;
      } else {
        // Unclosed fence — remove the opening fence line so the content
        // after it gets parsed as normal markdown (lists, bullets, etc.)
        body = body.slice(0, openIdx) + body.slice(afterOpen + 1);
        break;
      }
    }

    return { body, trailingFragment };
  }, [children]);

  // Throttle markdown parsing during streaming: only re-parse when the
  // stabilised body has changed by a meaningful amount (100+ chars) or
  // on the final value. This reduces expensive marked.lexer calls from
  // ~30/sec to ~5-10/sec during heavy streaming.
  //
  // Layered caching:
  // 1. Plain-text fast path — skip marked.lexer() entirely for text with no markdown syntax
  // 2. LRU cache (500 entries) — avoids re-parsing completed messages on scroll
  // 3. Streaming throttle — skip re-parse if body grew < 100 chars
  const lastParsedBodyRef = useRef("");
  const lastTokensRef = useRef<Token[]>([]);

  const tokens = useMemo(() => {
    const body = stabilised.body;
    const delta = body.length - lastParsedBodyRef.current.length;

    // Streaming throttle: skip if delta is small and we already have tokens
    if (lastTokensRef.current.length > 0 && delta > 0 && delta < 100) {
      return lastTokensRef.current;
    }

    // Check LRU cache first (mainly benefits completed messages on re-render)
    const cached = markdownTokenCache.get(body);
    if (cached) {
      lastParsedBodyRef.current = body;
      lastTokensRef.current = cached;
      return cached;
    }

    // Plain-text fast path: skip marked.lexer() for text with no markdown syntax
    let result: Token[];
    if (!containsMarkdownSyntax(body)) {
      result = [
        {
          type: "paragraph",
          raw: body,
          text: body,
          tokens: [{ type: "text", raw: body, text: body }],
        } as Tokens.Paragraph,
      ];
    } else {
      result = marked.lexer(body);
    }

    lastParsedBodyRef.current = body;
    lastTokensRef.current = result;
    markdownTokenCache.set(body, result);
    return result;
  }, [stabilised.body]);

  return (
    <Box ref={ref} flexDirection="column" flexShrink={1}>
      {renderTokens(tokens, theme, columns)}
      {stabilised.trailingFragment && <Text color={theme.text}>{stabilised.trailingFragment}</Text>}
    </Box>
  );
});

function renderTokens(tokens: Token[], theme: Theme, columns: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const node = renderToken(tokens[i], theme, i, columns);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

function renderToken(token: Token, theme: Theme, key: number, columns: number): React.ReactNode {
  const gap = key > 0 ? 1 : 0;

  switch (token.type) {
    case "heading": {
      // h1 = bright + bold, h2 = bold, h3+ = regular weight
      const depth = (token as Tokens.Heading).depth;
      const color = depth === 1 ? "#93c5fd" : depth === 2 ? theme.primary : theme.secondary;
      return (
        <Box key={key} marginTop={gap} flexShrink={1}>
          <Text bold color={color}>
            {renderInline(token.tokens ?? [], theme, { color })}
          </Text>
        </Box>
      );
    }

    case "paragraph":
      return (
        <Box key={key} marginTop={gap} flexShrink={1}>
          <Text>{renderInline(token.tokens ?? [], theme)}</Text>
        </Box>
      );

    case "list":
      return (
        <Box key={key} flexDirection="column" marginTop={gap} paddingLeft={1}>
          {(token as Tokens.List).items.map((item: Tokens.ListItem, idx: number) => (
            <Box key={idx}>
              <Text color={theme.primary}>
                {(token as Tokens.List).ordered
                  ? `${Number((token as Tokens.List).start ?? 1) + idx}. `
                  : "• "}
              </Text>
              <Box flexDirection="column" flexShrink={1}>
                {item.tokens.map((t: Token, j: number) => {
                  if (t.type === "text" && "tokens" in t && t.tokens) {
                    return <Text key={j}>{renderInline(t.tokens, theme)}</Text>;
                  }
                  if (t.type === "text") {
                    return (
                      <Text key={j} color={theme.text}>
                        {t.raw}
                      </Text>
                    );
                  }
                  return renderToken(t, theme, j, columns);
                })}
              </Box>
            </Box>
          ))}
        </Box>
      );

    case "code": {
      const lang = (token as Tokens.Code).lang ?? "";
      const raw = (token as Tokens.Code).text;

      // No language tag → render as pre-formatted block preserving line structure
      if (!lang) {
        const codeLines = raw.split("\n");
        return (
          <Box key={key} marginTop={gap} paddingLeft={1} flexDirection="column">
            {codeLines.map((line: string, idx: number) => (
              <Box key={idx}>
                <Text color={theme.border}>{"▎ "}</Text>
                <Box flexShrink={1}>
                  <Text color={theme.text}>{line}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        );
      }

      const highlighted = highlightCode(raw, lang);
      return (
        <Box key={key} marginTop={gap} paddingLeft={1}>
          <Text color={theme.border}>{"▎ "}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text color={theme.textDim} italic>
              {lang}
            </Text>
            {highlighted.split("\n").map((line: string, idx: number) => (
              <Text key={idx}>{line}</Text>
            ))}
          </Box>
        </Box>
      );
    }

    case "blockquote":
      return (
        <Box key={key} marginTop={gap} paddingLeft={1}>
          <Text color={theme.accent}>│ </Text>
          <Box flexDirection="column" flexShrink={1}>
            {((token as Tokens.Blockquote).tokens ?? []).map((t: Token, j: number) => {
              if (t.type === "paragraph") {
                return (
                  <Text key={j} italic color={theme.textMuted}>
                    {renderInline((t as Tokens.Paragraph).tokens ?? [], theme, {
                      color: theme.textMuted,
                    })}
                  </Text>
                );
              }
              return renderToken(t, theme, j, columns);
            })}
          </Box>
        </Box>
      );

    case "table": {
      const table = token as Tokens.Table;
      // Calculate natural column widths
      const naturalWidths = table.header.map((cell, ci) => {
        const headerLen = plainTextLength(cell.tokens);
        const rowMax = table.rows.reduce(
          (max, row) => Math.max(max, plainTextLength(row[ci]?.tokens ?? [])),
          0,
        );
        return Math.max(headerLen, rowMax, 3);
      });

      // Cap to fit terminal: each col uses width + 2 (padding) + 1 (border), plus 1 final border
      const numCols = naturalWidths.length;
      const overhead = numCols + 1; // │ between and around each column
      const paddingTotal = numCols * 2; // 1 space padding on each side of each cell
      const availableForContent = columns - overhead - paddingTotal;
      const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);

      let colWidths: number[];
      if (totalNatural <= availableForContent) {
        colWidths = naturalWidths;
      } else {
        // Shrink widest columns first — distribute available space evenly,
        // keeping columns that are already small enough at their natural width
        colWidths = [...naturalWidths];
        let remaining = availableForContent;
        const locked = new Set<number>();
        while (locked.size < numCols) {
          const unlocked = colWidths.filter((_, i) => !locked.has(i));
          const fair = Math.floor(remaining / unlocked.length);
          let changed = false;
          for (let i = 0; i < colWidths.length; i++) {
            if (locked.has(i)) continue;
            if (colWidths[i] <= fair) {
              locked.add(i);
              remaining -= colWidths[i];
              changed = true;
            }
          }
          if (!changed) {
            // Distribute remaining evenly among unlocked columns, then
            // spread the Math.floor remainder across the first few columns
            const unlockedIdxs = colWidths.map((_, i) => i).filter((i) => !locked.has(i));
            const each = Math.floor(remaining / unlockedIdxs.length);
            let leftover = remaining - each * unlockedIdxs.length;
            for (const i of unlockedIdxs) {
              colWidths[i] = each + (leftover > 0 ? 1 : 0);
              if (leftover > 0) leftover--;
            }
            break;
          }
        }

        // Clamp: ensure total never exceeds available (guards against edge cases)
        const totalAllocated = colWidths.reduce((a, b) => a + b, 0);
        if (totalAllocated > availableForContent) {
          const excess = totalAllocated - availableForContent;
          // Trim from the widest column first
          const sorted = colWidths.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
          let toTrim = excess;
          for (const entry of sorted) {
            if (toTrim <= 0) break;
            const trim = Math.min(toTrim, entry.w - 1);
            colWidths[entry.i] -= trim;
            toTrim -= trim;
          }
        }
      }

      const borderColor = "white";
      const hLine = (left: string, mid: string, right: string) =>
        left + colWidths.map((w) => "━".repeat(w + 2)).join(mid) + right;

      // Pre-wrap all cells into plain strings (each exactly colWidths[ci] chars)
      const headerWrapped = table.header.map((cell, ci) =>
        wrapCellCentered(cell.tokens, colWidths[ci]),
      );
      const headerLineCount = Math.max(1, ...headerWrapped.map((lines) => lines.length));

      const bodyWrapped = table.rows.map((row) =>
        row.map((cell, ci) => wrapCellPadRight(cell.tokens, colWidths[ci])),
      );
      const bodyLineCounts = bodyWrapped.map((row) =>
        Math.max(1, ...row.map((lines) => lines.length)),
      );

      /** Build a single string for one visual line of a row */
      const buildRowLine = (wrappedCells: string[][], lineIdx: number) => {
        let row = "";
        for (let ci = 0; ci < wrappedCells.length; ci++) {
          // fitToWidth guarantees exactly colWidths[ci] visual columns
          const cell = wrappedCells[ci][lineIdx] ?? fitToWidth("", colWidths[ci]);
          row += "┃ " + cell + " ";
        }
        row += "┃";
        return row;
      };

      return (
        <Box key={key} flexDirection="column" marginTop={gap}>
          {/* Top border */}
          <Text color={borderColor}>{hLine("┏", "┳", "┓")}</Text>
          {/* Header lines */}
          {Array.from({ length: headerLineCount }, (_, li) => (
            <Text key={`hdr-L${li}`} color={borderColor} bold>
              {buildRowLine(headerWrapped, li)}
            </Text>
          ))}
          {/* Header/body separator */}
          <Text color={borderColor}>{hLine("┣", "╋", "┫")}</Text>
          {/* Body rows */}
          {bodyWrapped.map((wrappedRow, ri) => (
            <React.Fragment key={ri}>
              {Array.from({ length: bodyLineCounts[ri] }, (_, li) => (
                <Text key={`r${ri}-L${li}`} color={borderColor}>
                  {buildRowLine(wrappedRow, li)}
                </Text>
              ))}
              {/* Row separator (between rows, not after last) */}
              {ri < table.rows.length - 1 && (
                <Text color={borderColor}>{hLine("┣", "╋", "┫")}</Text>
              )}
            </React.Fragment>
          ))}
          {/* Bottom border */}
          <Text color={borderColor}>{hLine("┗", "┻", "┛")}</Text>
        </Box>
      );
    }

    case "hr":
      return (
        <Box key={key} marginTop={gap}>
          <Text color={theme.border}>{"─".repeat(50)}</Text>
        </Box>
      );

    case "space":
      return null;

    default:
      if ("raw" in token && typeof token.raw === "string") {
        return (
          <Text key={key} color={theme.text}>
            {token.raw}
          </Text>
        );
      }
      return null;
  }
}

// ── Table helpers ──────────────────────────────────────────

/** Wrap cell content into padded strings, each exactly `width` visual columns. */
function wrapCellPadRight(tokens: Token[], width: number): string[] {
  const lines = wrapPlainTextLines(tokens, width);
  return lines.map((line) => fitToWidth(line, width));
}

/** Wrap header cell content into centered strings, each exactly `width` visual columns. */
function wrapCellCentered(tokens: Token[], width: number): string[] {
  const lines = wrapPlainTextLines(tokens, width);
  return lines.map((line) => centerToWidth(line, width));
}

// ── Inline rendering ───────────────────────────────────────

interface InlineStyle {
  color?: string;
}

function renderInline(tokens: Token[], theme: Theme, parentStyle?: InlineStyle): React.ReactNode[] {
  const defaultColor = parentStyle?.color ?? theme.text;

  return tokens.map((token, i) => {
    switch (token.type) {
      case "strong":
        return (
          <Text key={i} bold color={defaultColor}>
            {renderInline((token as Tokens.Strong).tokens ?? [], theme, { color: defaultColor })}
          </Text>
        );

      case "em":
        return (
          <Text key={i} italic color={defaultColor}>
            {renderInline((token as Tokens.Em).tokens ?? [], theme, { color: defaultColor })}
          </Text>
        );

      case "codespan":
        return (
          <Text key={i} color="#e2b553">
            {(token as Tokens.Codespan).text}
          </Text>
        );

      case "del":
        return (
          <Text key={i} strikethrough color={theme.textDim}>
            {(token as Tokens.Del).text}
          </Text>
        );

      case "link":
        return (
          <Text key={i} color={theme.primary} underline>
            {(token as Tokens.Link).text}
          </Text>
        );

      case "text": {
        const textToken = token as Tokens.Text;
        if ("tokens" in textToken && textToken.tokens) {
          return (
            <Text key={i} color={defaultColor}>
              {renderInline(textToken.tokens, theme, parentStyle)}
            </Text>
          );
        }
        // Preserve newlines — LLM output uses \n intentionally for structure
        return (
          <Text key={i} color={defaultColor}>
            {textToken.raw}
          </Text>
        );
      }

      case "escape":
        return (
          <Text key={i} color={defaultColor}>
            {(token as Tokens.Escape).text}
          </Text>
        );

      case "br":
        return <Text key={i}>{"\n"}</Text>;

      default:
        if ("raw" in token && typeof token.raw === "string") {
          return (
            <Text key={i} color={defaultColor}>
              {token.raw}
            </Text>
          );
        }
        return null;
    }
  });
}

// ── Streaming Markdown ────────────────────────────────────────
//
// Splits text at the last top-level block boundary.  Everything before
// the boundary is "stable" — memoized, never re-parsed.  Only the
// final (unstable) block is re-parsed on each streaming delta, making
// the cost O(unstable tail) instead of O(full text).

/**
 * Strip trailing incomplete table rows and unclosed code fences,
 * identical to the stabilisation logic in <Markdown>.
 */
function stabilize(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    if (lastLine.startsWith("|") && !lastLine.trimEnd().endsWith("|")) {
      lines.pop();
    }
  }
  let body = lines.join("\n");
  const fencePattern = /^(`{3,}|~{3,})([^\n]*)/m;
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const openMatch = fencePattern.exec(body.slice(searchFrom));
    if (!openMatch) break;
    const openIdx = searchFrom + openMatch.index;
    const fence = openMatch[1];
    const afterOpen = body.indexOf("\n", openIdx);
    if (afterOpen === -1) break;
    const closePattern = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`, "m");
    const closeMatch = closePattern.exec(body.slice(afterOpen));
    if (closeMatch) {
      searchFrom = afterOpen + closeMatch.index + closeMatch[0].length;
    } else {
      body = body.slice(0, openIdx) + body.slice(afterOpen + 1);
      break;
    }
  }
  return body;
}

export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  children,
  width,
}: {
  children: string;
  width: number;
}) {
  const stableBoundaryRef = useRef(0);

  const stripped = useMemo(() => stabilize(children), [children]);

  // Find the last top-level block boundary and advance stableBoundaryRef monotonically
  const { stablePrefix, unstableSuffix } = useMemo(() => {
    const boundary = stableBoundaryRef.current;
    const tail = stripped.substring(boundary);

    // Skip full lexing if tail is short enough — not worth the split overhead
    if (tail.length < 200) {
      return { stablePrefix: stripped.substring(0, boundary), unstableSuffix: tail };
    }

    const tokens = containsMarkdownSyntax(tail) ? marked.lexer(tail) : [];

    // Find last non-space content token
    let lastContentIdx = tokens.length - 1;
    while (lastContentIdx >= 0 && tokens[lastContentIdx]?.type === "space") {
      lastContentIdx--;
    }

    // Sum raw lengths of all tokens except the last = stable advancement
    let advance = 0;
    for (let i = 0; i < lastContentIdx; i++) {
      advance += tokens[i]!.raw.length;
    }

    // Only advance forward (monotonic)
    if (advance > 0) {
      stableBoundaryRef.current = boundary + advance;
    }

    return {
      stablePrefix: stripped.substring(0, stableBoundaryRef.current),
      unstableSuffix: stripped.substring(stableBoundaryRef.current),
    };
  }, [stripped]);

  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown width={width}>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown width={width}>{unstableSuffix}</Markdown>}
    </Box>
  );
});
