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

/**
 * Render a markdown string as Ink components.
 * Measures its own available width via Ink's layout engine so tables
 * always fit regardless of parent padding, prefixes, or sidebars.
 */
export function Markdown({ children }: { children: string }) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const ref = useRef<DOMElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  useLayoutEffect(() => {
    if (ref.current) {
      const { width } = measureElement(ref.current);
      if (width > 0 && width !== measuredWidth) {
        setMeasuredWidth(width);
      }
    }
  }, [children, measuredWidth]);

  // Use measured width when available. On first mount (before layout runs)
  // fall back to stdout.columns minus padding overhead so tables don't
  // overflow. The "⏺ " prefix = 2 cols, live area paddingRight = 1 col,
  // plus 1 col safety margin = 4.  After the first layout pass,
  // measuredWidth takes over with the exact value.
  const columns = measuredWidth > 0 ? measuredWidth : Math.max(40, (stdout?.columns ?? 80) - 4);

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
    return { body: lines.join("\n"), trailingFragment };
  }, [children]);

  const tokens = useMemo(() => marked.lexer(stabilised.body), [stabilised.body]);

  return (
    <Box ref={ref} flexDirection="column" flexShrink={1}>
      {renderTokens(tokens, theme, columns)}
      {stabilised.trailingFragment && <Text color={theme.text}>{stabilised.trailingFragment}</Text>}
    </Box>
  );
}

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
      const color = depth === 1 ? theme.primary : depth === 2 ? theme.secondary : theme.accent;
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

      // No language tag → likely prose dumped in backticks; render as wrapped text
      if (!lang) {
        return (
          <Box key={key} marginTop={gap} paddingLeft={1}>
            <Text color={theme.border}>{"▎ "}</Text>
            <Box flexShrink={1}>
              <Text color={theme.text}>{raw.replace(/\n/g, " ")}</Text>
            </Box>
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

      const borderColor = theme.text;
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
          <Text key={i} color={theme.codeSpan}>
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
        // Single \n in markdown is a soft break (space), not a line break
        return (
          <Text key={i} color={defaultColor}>
            {textToken.raw.replace(/\n/g, " ")}
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
