import React, { useMemo } from "react";
import { Text, Box, useStdout } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { useTheme, type Theme } from "../theme/theme.js";
import { highlightCode } from "../utils/highlight.js";

/**
 * Render a markdown string as Ink components.
 */
export function Markdown({ children }: { children: string }) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const tokens = useMemo(() => marked.lexer(children), [children]);
  return (
    <Box flexDirection="column" flexShrink={1}>
      {renderTokens(tokens, theme, columns)}
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
      const highlighted = highlightCode(raw, lang);
      return (
        <Box key={key} marginTop={gap} paddingLeft={1}>
          <Text color={theme.border}>{"▎ "}</Text>
          <Box flexDirection="column" flexShrink={1}>
            {lang && (
              <Text color={theme.textDim} italic>
                {lang}
              </Text>
            )}
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
            // Distribute remaining evenly among unlocked columns
            const unlockedIdxs = colWidths.map((_, i) => i).filter((i) => !locked.has(i));
            const each = Math.floor(remaining / unlockedIdxs.length);
            for (const i of unlockedIdxs) {
              colWidths[i] = Math.max(3, each);
            }
            break;
          }
        }
      }

      const borderColor = theme.border;
      const hLine = (left: string, mid: string, right: string) =>
        left + colWidths.map((w) => "─".repeat(w + 2)).join(mid) + right;

      return (
        <Box key={key} flexDirection="column" marginTop={gap}>
          {/* Top border */}
          <Text color={borderColor}>{hLine("┌", "┬", "┐")}</Text>
          {/* Header cells */}
          <Box>
            {table.header.map((cell, ci) => (
              <React.Fragment key={ci}>
                <Text color={borderColor}>{"│"}</Text>
                <Text bold color={theme.primary}>
                  {" "}
                  {renderInlineCentered(cell.tokens, colWidths[ci], theme)}{" "}
                </Text>
              </React.Fragment>
            ))}
            <Text color={borderColor}>{"│"}</Text>
          </Box>
          {/* Header/body separator */}
          <Text color={borderColor}>{hLine("├", "┼", "┤")}</Text>
          {/* Body rows */}
          {table.rows.map((row, ri) => (
            <React.Fragment key={ri}>
              <Box>
                {row.map((cell, ci) => (
                  <React.Fragment key={ci}>
                    <Text color={borderColor}>{"│"}</Text>
                    <Text> {renderInlinePadRight(cell.tokens, colWidths[ci], theme)} </Text>
                  </React.Fragment>
                ))}
                <Text color={borderColor}>{"│"}</Text>
              </Box>
              {/* Row separator (between rows, not after last) */}
              {ri < table.rows.length - 1 && (
                <Text color={borderColor}>{hLine("├", "┼", "┤")}</Text>
              )}
            </React.Fragment>
          ))}
          {/* Bottom border */}
          <Text color={borderColor}>{hLine("└", "┴", "┘")}</Text>
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

function plainTextLength(tokens: Token[]): number {
  let len = 0;
  for (const t of tokens) {
    const tok = t as Token & { tokens?: Token[]; text?: string };
    if (tok.tokens && Array.isArray(tok.tokens)) {
      len += plainTextLength(tok.tokens);
    } else if (typeof tok.text === "string") {
      len += tok.text.length;
    } else if ("raw" in t && typeof t.raw === "string") {
      len += t.raw.length;
    }
  }
  return len;
}

function truncatePlainText(tokens: Token[], maxLen: number): string {
  let text = "";
  for (const t of tokens) {
    const tok = t as Token & { tokens?: Token[]; text?: string };
    if (tok.tokens && Array.isArray(tok.tokens)) {
      text += truncatePlainText(tok.tokens, maxLen - text.length);
    } else if (typeof tok.text === "string") {
      text += tok.text;
    } else if ("raw" in t && typeof t.raw === "string") {
      text += t.raw;
    }
    if (text.length >= maxLen) break;
  }
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

function renderInlinePadRight(tokens: Token[], width: number, theme: Theme): React.ReactNode[] {
  const textLen = plainTextLength(tokens);
  if (textLen > width) {
    const truncated = truncatePlainText(tokens, width);
    return [
      <React.Fragment key="trunc">
        <Text color={theme.text}>{truncated}</Text>
      </React.Fragment>,
    ];
  }
  const content = renderInline(tokens, theme);
  const pad = Math.max(0, width - textLen);
  return [...content, <React.Fragment key="rpad">{" ".repeat(pad)}</React.Fragment>];
}

function renderInlineCentered(tokens: Token[], width: number, theme: Theme): React.ReactNode[] {
  const textLen = plainTextLength(tokens);
  if (textLen > width) {
    const truncated = truncatePlainText(tokens, width);
    return [
      <React.Fragment key="trunc">
        <Text bold>{truncated}</Text>
      </React.Fragment>,
    ];
  }
  const content = renderInline(tokens, theme);
  const total = Math.max(0, width - textLen);
  const left = Math.floor(total / 2);
  const right = total - left;
  return [
    <React.Fragment key="lpad">{" ".repeat(left)}</React.Fragment>,
    ...content,
    <React.Fragment key="rpad">{" ".repeat(right)}</React.Fragment>,
  ];
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
