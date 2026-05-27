import chalk from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { TerminalHistoryContext } from "./terminal-history.js";

export const RESPONSE_LEFT_PADDING = " ";
export const MAX_OUTPUT_LINES = 4;
export const USER_MESSAGE_BACKGROUND = "#374151";
export const USER_MESSAGE_PREFIX = "> ";
export const USER_MESSAGE_TOP_FILL = "▄";
export const USER_MESSAGE_BOTTOM_FILL = "▀";
export const USER_MESSAGE_HORIZONTAL_PADDING = 2;
export const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "gu");
export const SINGLE_LEFT_BORDER = "│";
export const ROUND_BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

export function formatHistoryWrite(
  output: string,
  options: { leadingSeparator: boolean; trailingBlankLine: boolean; trailingNewlines?: number },
): string {
  const trimmed = output.replace(/\n+$/u, "");
  if (trimmed.length === 0) return "";
  const leading = options.leadingSeparator ? "\n" : "";
  const trailingCount = options.trailingNewlines ?? (options.trailingBlankLine ? 2 : 1);
  const trailing = "\n".repeat(trailingCount);
  return `${leading}${trimmed}${trailing}`;
}

export function normalizeStatusText(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function renderRoundBorderBox(
  lines: readonly string[],
  context: TerminalHistoryContext,
  borderColor: string,
): string {
  const longestLineWidth = Math.max(
    0,
    ...lines.map((lineText) => stringWidth(stripAnsi(lineText))),
  );
  const maxFrameWidth = Math.max(4, context.columns - stringWidth(RESPONSE_LEFT_PADDING));
  const frameWidth = Math.max(4, Math.min(maxFrameWidth, longestLineWidth + 4));
  const contentWidth = Math.max(1, frameWidth - 4);
  const horizontal = color(borderColor, ROUND_BORDER.horizontal.repeat(frameWidth - 2));
  const top = `${color(borderColor, ROUND_BORDER.topLeft)}${horizontal}${color(borderColor, ROUND_BORDER.topRight)}`;
  const bottom = `${color(borderColor, ROUND_BORDER.bottomLeft)}${horizontal}${color(borderColor, ROUND_BORDER.bottomRight)}`;
  const rows = lines.flatMap((lineText) => wrapBoxLine(lineText, contentWidth));
  const body = rows.map((lineText) => {
    const fillWidth = Math.max(0, contentWidth - stringWidth(stripAnsi(lineText)));
    return `${color(borderColor, ROUND_BORDER.vertical)} ${lineText}${" ".repeat(fillWidth)} ${color(borderColor, ROUND_BORDER.vertical)}`;
  });
  return indent([top, ...body, bottom].join("\n"), RESPONSE_LEFT_PADDING);
}

export function renderLeftBorderBox(
  lines: readonly string[],
  borderColor: string,
  options: { padding?: number } = {},
): string {
  const padding = " ".repeat(options.padding ?? 1);
  return indent(
    lines
      .map((lineText) => `${color(borderColor, SINGLE_LEFT_BORDER)}${padding}${lineText}`)
      .join("\n"),
    RESPONSE_LEFT_PADDING,
  );
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

export function block(lines: readonly string[]): string {
  return lines.filter((lineText) => lineText.length > 0).join("\n");
}

export function wrapPlain(text: string, width: number): string {
  return wrapAnsi(text, Math.max(10, width), { hard: true, wordWrap: true });
}

export function wrapBoxLine(text: string, width: number): string[] {
  if (text.length === 0) return [""];
  return wrapAnsi(text, Math.max(1, width), { hard: true, wordWrap: true, trim: false }).split(
    "\n",
  );
}

export function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((lineText) => `${prefix}${lineText}`)
    .join("\n");
}

export function truncatePlain(text: string, width: number): string {
  const max = Math.max(1, width);
  if (stringWidth(text) <= max) return text;
  let result = "";
  for (const char of text) {
    if (stringWidth(`${result}${char}…`) > max) break;
    result += char;
  }
  return `${result}…`;
}

export function color(hex: string, text: string, bold = false): string {
  const styled = chalk.hex(hex)(text);
  return bold ? chalk.bold(styled) : styled;
}

export function userChipSegment(text: string, foregroundHex: string, bold = false): string {
  const styled = chalk.bgHex(USER_MESSAGE_BACKGROUND).hex(foregroundHex)(text);
  return bold ? chalk.bold(styled) : styled;
}

export function dim(context: TerminalHistoryContext, text: string): string {
  return color(context.theme.textDim, text);
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

export function gradientLine(text: string, gradient: readonly string[]): string {
  let colorIndex = 0;
  let result = "";
  for (const char of text) {
    if (char === " ") {
      result += char;
      continue;
    }
    result += chalk.hex(gradient[colorIndex % gradient.length] ?? gradient[0])(char);
    colorIndex++;
  }
  return result;
}
