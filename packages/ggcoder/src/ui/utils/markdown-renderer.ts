import chalk from "chalk";
import { common, createLowlight } from "lowlight";
import type { Element, ElementContent, Root, RootContent, Text as HastText } from "hast";
import stripAnsi from "strip-ansi";
import wrapAnsi from "wrap-ansi";
import type { Theme } from "../theme/theme.js";
import { convertLatexToUnicode } from "./latex-to-unicode.js";
import { renderAnsiTable } from "./markdown-table.js";
import { stripUnsafeCharacters } from "./text-utils.js";

const EMPTY_RENDER_LINE = "";
const MASK_SENTINEL = "\uE000";
const MASK_PATTERN = /\uE000(\d+)\uE000/g;
const lowlight = createLowlight(common);

function colorize(text: string, color: string | undefined): string {
  return color ? chalk.hex(color)(text) : text;
}

function convertLatexPreservingSpans(text: string): string {
  const preserved: string[] = [];
  const masked = text.replace(/(`+)([^`\n]+?)\1|https?:\/\/\S+/g, (match) => {
    const index = preserved.push(match) - 1;
    return `${MASK_SENTINEL}${index}${MASK_SENTINEL}`;
  });
  const converted = convertLatexToUnicode(masked);
  return converted.replace(
    MASK_PATTERN,
    (match, index: string) => preserved[Number(index)] ?? match,
  );
}

export function renderInlineMarkdownToAnsi(
  rawText: string,
  theme: Theme,
  defaultColor?: string,
): string {
  const baseColor = defaultColor ?? theme.text;
  const text = convertLatexPreservingSpans(rawText);
  if (!/[*_~`<[]|https?:\/\//.test(text)) {
    return colorize(text, baseColor);
  }

  const inlineRegex =
    /(\*\*\*.*?\*\*\*|\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += colorize(text.slice(lastIndex, match.index), baseColor);
    }

    const fullMatch = match[0];
    let styledPart = "";

    if (fullMatch.endsWith("***") && fullMatch.startsWith("***") && fullMatch.length > 6) {
      styledPart = chalk.bold(
        chalk.italic(renderInlineMarkdownToAnsi(fullMatch.slice(3, -3), theme, baseColor)),
      );
    } else if (fullMatch.endsWith("**") && fullMatch.startsWith("**") && fullMatch.length > 4) {
      styledPart = chalk.bold(renderInlineMarkdownToAnsi(fullMatch.slice(2, -2), theme, baseColor));
    } else if (
      fullMatch.length > 2 &&
      ((fullMatch.startsWith("*") && fullMatch.endsWith("*")) ||
        (fullMatch.startsWith("_") && fullMatch.endsWith("_"))) &&
      !/\w/.test(text.substring(match.index - 1, match.index)) &&
      !/\w/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 1)) &&
      !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
      !/[./\\]\S/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 2))
    ) {
      styledPart = chalk.italic(
        renderInlineMarkdownToAnsi(fullMatch.slice(1, -1), theme, baseColor),
      );
    } else if (fullMatch.startsWith("~~") && fullMatch.endsWith("~~") && fullMatch.length > 4) {
      styledPart = chalk.strikethrough(
        renderInlineMarkdownToAnsi(fullMatch.slice(2, -2), theme, baseColor),
      );
    } else if (fullMatch.startsWith("`") && fullMatch.endsWith("`") && fullMatch.length > 1) {
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
      if (codeMatch?.[2]) styledPart = colorize(codeMatch[2], theme.accent);
    } else if (fullMatch.startsWith("[") && fullMatch.includes("](") && fullMatch.endsWith(")")) {
      const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
      if (linkMatch) {
        const linkText = linkMatch[1] ?? "";
        const url = linkMatch[2] ?? "";
        styledPart = `${renderInlineMarkdownToAnsi(linkText, theme, baseColor)}${colorize(" (", baseColor)}${colorize(url, theme.link)}${colorize(")", baseColor)}`;
      }
    } else if (fullMatch.startsWith("<u>") && fullMatch.endsWith("</u>") && fullMatch.length > 7) {
      styledPart = chalk.underline(
        renderInlineMarkdownToAnsi(fullMatch.slice(3, -4), theme, baseColor),
      );
    } else if (fullMatch.match(/^https?:\/\//)) {
      styledPart = colorize(fullMatch, theme.link);
    }

    result += styledPart || colorize(fullMatch, baseColor);
    lastIndex = inlineRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result += colorize(text.slice(lastIndex), baseColor);
  }

  return result;
}

export function wrapAnsiMarkdownLine(text: string, width: number): string[] {
  return wrapAnsi(text || " ", Math.max(1, width), { hard: true, wordWrap: true }).split("\n");
}

/** `plainColor` colours text no token claimed; undefined leaves it to the caller. */
function renderHastToAnsi(
  node: Root | Element | HastText | RootContent,
  theme: Theme,
  inheritedColor: string | undefined,
  plainColor: string | undefined,
): string {
  if (node.type === "text") return colorize(node.value, inheritedColor ?? plainColor);
  if (node.type === "element") {
    const nodeClasses = (node.properties?.className as string[] | undefined) ?? [];
    const elementColorClass = nodeClasses.find((className) => getHighlightColor(className, theme));
    const colorToPassDown = elementColorClass
      ? getHighlightColor(elementColorClass, theme)
      : inheritedColor;
    return node.children
      .map((child: ElementContent) => renderHastToAnsi(child, theme, colorToPassDown, plainColor))
      .join("");
  }
  if (node.type === "root") {
    return node.children
      .map((child: RootContent) => renderHastToAnsi(child, theme, inheritedColor, plainColor))
      .join("");
  }
  return "";
}

function getHighlightColor(className: string, theme: Theme): string | undefined {
  switch (className) {
    case "hljs-keyword":
    case "hljs-selector-tag":
    case "hljs-title":
      return theme.secondary;
    case "hljs-string":
    case "hljs-attr":
    case "hljs-symbol":
      return theme.success;
    case "hljs-number":
    case "hljs-literal":
      return theme.warning;
    case "hljs-comment":
    case "hljs-quote":
      return theme.textDim;
    case "hljs-built_in":
    case "hljs-type":
    case "hljs-class":
      return theme.accent;
    case "hljs-variable":
    case "hljs-template-variable":
      return theme.primary;
    case "hljs-deletion":
      return theme.error;
    case "hljs-addition":
      return theme.success;
    default:
      return undefined;
  }
}

function highlightLineToAnsi(line: string, language: string | null, theme: Theme): string {
  try {
    const strippedLine = stripAnsi(line);
    const tree =
      !language || !lowlight.registered(language)
        ? lowlight.highlightAuto(strippedLine)
        : lowlight.highlight(language, strippedLine);
    const rendered = renderHastToAnsi(tree, theme, undefined, theme.text);
    return rendered.length > 0 ? rendered : strippedLine;
  } catch {
    return stripAnsi(line);
  }
}

/**
 * Highlight code in a known language with the theme's syntax colours. Text no
 * token claims keeps the caller's colour (e.g. a diff line's foreground).
 * Returns the code unchanged for an unknown or missing language; never guesses.
 */
export function highlightCodeToAnsi(
  code: string,
  language: string | undefined,
  theme: Theme,
): string {
  if (!language || !lowlight.registered(language)) return code;
  try {
    return renderHastToAnsi(lowlight.highlight(language, code), theme, undefined, undefined);
  } catch {
    return code;
  }
}

export function renderMarkdownCodeBlockToAnsi({
  content,
  language,
  maxWidth,
  theme,
  hideLineNumbers = false,
}: {
  content: readonly string[];
  language?: string | null;
  maxWidth: number;
  theme: Theme;
  hideLineNumbers?: boolean;
}): string[] {
  const finalLines = content.join("\n").replace(/\n$/u, "").split(/\r?\n/);
  const padWidth = String(finalLines.length).length;
  return finalLines.map((line, index) => {
    const visibleLine = line.slice(0, Math.max(0, maxWidth));
    const highlighted = highlightLineToAnsi(visibleLine, language ?? null, theme);
    if (hideLineNumbers) return highlighted;
    return `${colorize(String(index + 1).padStart(padWidth, " "), theme.textDim)} ${highlighted}`;
  });
}

export interface RenderMarkdownToAnsiOptions {
  text: string;
  theme: Theme;
  width: number;
  isPending?: boolean;
  availableTerminalHeight?: number;
  renderMarkdown?: boolean;
}

export function renderMarkdownToAnsiLines({
  text,
  theme,
  width,
  isPending = false,
  availableTerminalHeight,
  renderMarkdown = true,
}: RenderMarkdownToAnsiOptions): string[] {
  const safeText = stripUnsafeCharacters(text);
  if (!safeText) return [];

  if (!renderMarkdown) {
    return renderMarkdownCodeBlockToAnsi({
      content: safeText.split(/\r?\n/),
      language: "markdown",
      maxWidth: width - 1,
      theme,
      hideLineNumbers: true,
    });
  }

  const lines = safeText.split(/\r?\n/);
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([\w-]*?) *$/;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *(?:-{2,}|(?:[-*_] *){3,}) *$/;
  const tableRowRegex = /^\s*\|(.+)\|\s*$/;
  const tableSeparatorRegex = /^\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)+\|?\s*$/;

  const output: string[] = [];
  let inCodeBlock = false;
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = "";
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];

  const addLines = (renderedLines: readonly string[]): void => {
    if (renderedLines.length === 0) return;
    output.push(...renderedLines);
    lastLineEmpty = false;
  };

  const addInlineLine = (rawLine: string, defaultColor = theme.text): void => {
    addLines(wrapAnsiMarkdownLine(renderInlineMarkdownToAnsi(rawLine, theme, defaultColor), width));
  };

  const addCodeBlock = (content: readonly string[]): void => {
    const maxWidth = Math.max(1, width - 1);
    if (isPending && availableTerminalHeight !== undefined) {
      const minLinesForMessage = 1;
      const reservedLines = 2;
      const maxCodeLinesWhenPending = Math.max(0, availableTerminalHeight - reservedLines);
      if (content.length > maxCodeLinesWhenPending) {
        if (maxCodeLinesWhenPending < minLinesForMessage) {
          addLines([colorize("... code is being written ...", theme.textMuted)]);
          return;
        }
        addLines(
          renderMarkdownCodeBlockToAnsi({
            content: content.slice(0, maxCodeLinesWhenPending),
            language: codeBlockLang,
            maxWidth,
            theme,
          }),
        );
        addLines([colorize("... generating more ...", theme.textMuted)]);
        return;
      }
    }
    addLines(renderMarkdownCodeBlockToAnsi({ content, language: codeBlockLang, maxWidth, theme }));
  };

  const flushTable = (): void => {
    if (tableHeaders.length > 0 && tableRows.length > 0) {
      const styledHeaders = tableHeaders.map((header) =>
        renderInlineMarkdownToAnsi(stripUnsafeCharacters(header), theme, theme.link),
      );
      const styledRows = tableRows.map((row) =>
        row.map((cell) =>
          renderInlineMarkdownToAnsi(stripUnsafeCharacters(cell), theme, theme.text),
        ),
      );
      const tableLines = renderAnsiTable({
        headers: styledHeaders,
        rows: styledRows,
        terminalWidth: width,
        theme,
      });
      // While streaming, a tall in-progress table must not overflow the live
      // region: Ink can't erase rows that scroll past the terminal top, which
      // strands stale lines in scrollback. Mirror addCodeBlock's clamp.
      if (isPending && availableTerminalHeight !== undefined) {
        const reservedLines = 2;
        const maxTableLinesWhenPending = Math.max(0, availableTerminalHeight - reservedLines);
        if (tableLines.length > maxTableLinesWhenPending) {
          if (maxTableLinesWhenPending < 1) {
            addLines([colorize("... table is being written ...", theme.textMuted)]);
          } else {
            addLines(tableLines.slice(0, maxTableLinesWhenPending));
            addLines([colorize("... generating more ...", theme.textMuted)]);
          }
          inTable = false;
          tableRows = [];
          tableHeaders = [];
          return;
        }
      }
      addLines(tableLines);
    }
    inTable = false;
    tableRows = [];
    tableHeaders = [];
  };

  // While streaming, trailing `|`-prefixed lines are an in-progress table tail
  // (a partial row, or a header whose separator hasn't arrived). Rendering them
  // raw flushes the half-built table and dumps pipe soup on every chunk — hold
  // them back until they complete.
  let pendingTableTailStart = lines.length;
  if (isPending) {
    while (
      pendingTableTailStart > 0 &&
      /^\s*\|/.test(lines[pendingTableTailStart - 1] ?? "") &&
      lines.length - pendingTableTailStart < 2
    ) {
      pendingTableTailStart -= 1;
    }
  }

  lines.forEach((line, index) => {
    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      if (
        fenceMatch &&
        fenceMatch[1]?.startsWith(codeBlockFence[0] ?? "") &&
        fenceMatch[1].length >= codeBlockFence.length
      ) {
        addCodeBlock(codeBlockContent);
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = "";
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockFence = codeFenceMatch[1] ?? "```";
      codeBlockLang = codeFenceMatch[2] || null;
    } else if (tableRowMatch && !inTable) {
      if (index + 1 < lines.length && tableSeparatorRegex.test(lines[index + 1] ?? "")) {
        inTable = true;
        tableHeaders = tableRowMatch[1]?.split("|").map((cell) => cell.trim()) ?? [];
        tableRows = [];
      } else if (index < pendingTableTailStart) {
        addInlineLine(line);
      }
    } else if (inTable && tableSeparatorMatch) {
      // Separator belongs to current table.
    } else if (inTable && tableRowMatch) {
      const cells = tableRowMatch[1]?.split("|").map((cell) => cell.trim()) ?? [];
      while (cells.length < tableHeaders.length) cells.push("");
      if (cells.length > tableHeaders.length) cells.length = tableHeaders.length;
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      if (index >= pendingTableTailStart) {
        // Partial row of the streaming table — keep the table open and drop
        // the incomplete line; the next chunk completes it.
        return;
      }
      flushTable();
      if (line.trim().length > 0) addInlineLine(line);
    } else if (hrMatch) {
      addLines([chalk.dim("─".repeat(Math.max(1, width)))]);
    } else if (headerMatch) {
      const level = headerMatch[1]?.length ?? 1;
      const headerText = headerMatch[2] ?? "";
      const headerColor = level <= 2 ? theme.link : level === 4 ? theme.textMuted : theme.text;
      const rendered = renderInlineMarkdownToAnsi(headerText, theme, headerColor);
      const styled = level <= 3 ? chalk.bold(rendered) : chalk.italic(rendered);
      addLines(wrapAnsiMarkdownLine(styled, width));
    } else if (ulMatch) {
      const indentation = (ulMatch[1] ?? "").length + 1;
      const prefix = `${" ".repeat(indentation)}${ulMatch[2] ?? "-"} `;
      addLines(
        wrapAnsiMarkdownLine(
          `${prefix}${renderInlineMarkdownToAnsi(ulMatch[3] ?? "", theme, theme.text)}`,
          width,
        ),
      );
    } else if (olMatch) {
      const indentation = (olMatch[1] ?? "").length + 1;
      const prefix = `${" ".repeat(indentation)}${olMatch[2] ?? "1"}. `;
      addLines(
        wrapAnsiMarkdownLine(
          `${prefix}${renderInlineMarkdownToAnsi(olMatch[3] ?? "", theme, theme.text)}`,
          width,
        ),
      );
    } else if (line.trim().length === 0 && !inCodeBlock) {
      if (!lastLineEmpty) {
        output.push(EMPTY_RENDER_LINE);
        lastLineEmpty = true;
      }
    } else if (index < pendingTableTailStart) {
      addInlineLine(line);
    }
  });

  if (inCodeBlock) addCodeBlock(codeBlockContent);
  if (inTable) flushTable();

  return output;
}
