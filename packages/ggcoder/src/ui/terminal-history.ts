import chalk from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { Provider } from "@kenkaiiii/gg-ai";
import { getModel } from "../core/model-registry.js";
import type { CompletedItem } from "./App.js";
import { isPanelReplacedToolItem } from "./app-items.js";
import type { PasteInfo } from "./components/InputArea.js";
import { BLACK_CIRCLE, RETURN_SYMBOL } from "./constants/figures.js";
import { SPINNER_FRAMES } from "./spinner-frames.js";
import type { Theme } from "./theme/theme.js";
import { getUserMessageDisplayParts } from "./utils/user-message-display.js";
import { buildToolGroupSummary } from "./tool-group-summary.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderMarkdownToAnsiLines } from "./utils/markdown-renderer.js";
import { detectGraphicsProtocol, encodeInlineImage } from "./utils/terminal-graphics.js";
import { createHyperlink } from "./utils/hyperlink.js";
import { supportsHyperlinks } from "./utils/supports-hyperlinks.js";
import { shouldSeparateTranscriptItems } from "./transcript/spacing.js";
import {
  MAX_OUTPUT_LINES,
  RESPONSE_LEFT_PADDING,
  USER_MESSAGE_BACKGROUND,
  USER_MESSAGE_BOTTOM_FILL,
  USER_MESSAGE_HORIZONTAL_PADDING,
  USER_MESSAGE_PREFIX,
  USER_MESSAGE_TOP_FILL,
  block,
  color,
  dim,
  formatCompactTokens,
  formatDuration,
  formatHistoryWrite,
  gradientLine,
  indent,
  stripAnsi,
  truncatePlain,
  userChipSegment,
  wrapPlain,
} from "./terminal-history-format.js";
import {
  renderCompacted,
  renderCompacting,
  renderError,
  renderSetupHint,
  renderStatusLine,
  renderStepDone,
  renderStylePack,
  renderUpdateNotice,
} from "./terminal-history-status-renderers.js";
import {
  presentDuration,
  presentInfo,
  presentModelTransition,
  presentPlanEvent,
  presentQueued,
  presentStopped,
  presentTask,
  presentThemeTransition,
} from "./transcript/presentation.js";
import { toolTonePalette } from "./transcript/tool-presentation.js";

const LOGO_LINES = [" ▄▀▀▀ ▄▀▀▀", " █ ▀█ █ ▀█", " ▀▄▄▀ ▀▄▄▀"];
const PLAN_MODE_LOGO = [
  "▗▄▄▖ ▗▖    ▗▄▖ ▗▖  ▗▖    ▗▖  ▗▖ ▗▄▖ ▗▄▄▄ ▗▄▄▄▖",
  "▐▌ ▐▌▐▌   ▐▌ ▐▌▐▛▚▖▐▌    ▐▛▚▞▜▌▐▌ ▐▌▐▌  █▐▌",
  "▐▛▀▘ ▐▌   ▐▛▀▜▌▐▌ ▝▜▌    ▐▌  ▐▌▐▌ ▐▌▐▌  █▐▛▀▀▘",
  "▐▌   ▐▙▄▄▖▐▌ ▐▌▐▌  ▐▌    ▐▌  ▐▌▝▚▄▞▘▐▙▄▄▀▐▙▄▄▖",
];
const PLAN_MODE_GRADIENT = [
  "#f59e0b",
  "#fbbf24",
  "#f59e0b",
  "#d97706",
  "#f59e0b",
  "#fbbf24",
  "#d97706",
];
const GRADIENT = [
  "#60a5fa",
  "#6da1f9",
  "#7a9df7",
  "#8799f5",
  "#9495f3",
  "#a18ff1",
  "#a78bfa",
  "#a18ff1",
  "#9495f3",
  "#8799f5",
  "#7a9df7",
  "#6da1f9",
];
const GAP = "   ";
const LOGO_WIDTH = 9;
const SIDE_BY_SIDE_MIN = LOGO_WIDTH + GAP.length + 62;
const COMPACT_TOOLS = new Set(["read", "grep", "find", "ls", "source_path"]);
const STATE_TOOLS = new Set(["tasks"]);
const SERVER_STYLE_TOOLS = new Set(["web_search"]);

export interface TerminalHistoryPrinter {
  print(
    items: readonly CompletedItem[],
    context: TerminalHistoryContext,
    options?: { force?: boolean; write?: (data: string) => void },
  ): void;
  clear(): void;
  resetPrinted(): void;
  readonly printedIds: ReadonlySet<string>;
}

export interface TerminalHistoryPrinterOptions {
  stream?: NodeJS.WriteStream;
}

export interface TerminalHistoryContext {
  theme: Theme;
  columns: number;
  version: string;
  model: string;
  provider: Provider;
  cwd: string;
}

export function createTerminalHistoryPrinter({
  stream = process.stdout,
}: TerminalHistoryPrinterOptions = {}): TerminalHistoryPrinter {
  const printed = new Set<string>();
  let previousPrintedKind: CompletedItem["kind"] | null = null;

  return {
    print(items, context, options) {
      const writeOutput = options?.write ?? ((data: string) => void stream.write(data));
      for (const item of items) {
        if (!options?.force && printed.has(item.id)) continue;
        // Tool activity is shown live in the pinned LiveToolPanel, not the
        // scrollback transcript. Skip without touching spacing state so the
        // surrounding non-tool rows keep their separators.
        if (isPanelReplacedToolItem(item)) continue;
        const output = serializeCompletedItemToTerminalHistory(item, context);
        const endsWithBlankLine = item.kind === "banner";
        // A continuation assistant chunk is the next paragraph of a response
        // whose earlier paragraphs were already flushed mid-stream. Re-insert
        // the blank line that separated them so the reassembled scrollback
        // matches the whole response (assistant→assistant is otherwise compact).
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
        printed.add(item.id);
        writeOutput(formatted);
        // Inline image previews render in the Static scrollback region (straight
        // to the stream, above Ink's live frame). Only emit graphics escapes on
        // terminals that support them; everything else keeps the text-only line.
        const previews =
          (item.kind === "tool_done" || item.kind === "user") && item.imagePreviews
            ? item.imagePreviews
            : undefined;
        if (previews && previews.length > 0) {
          const protocol = detectGraphicsProtocol();
          // Indent the image to the message text column (after the `⏺ ` dot),
          // matching assistant/tool label alignment. Graphics protocols anchor
          // the image at the cursor column, so leading spaces shift it right.
          const imageLeftPad = "   ";
          const canLink = supportsHyperlinks();
          for (const preview of previews) {
            if (protocol !== "none") {
              writeOutput(`\n${imageLeftPad}${encodeInlineImage(preview.base64, protocol)}\n`);
            }
            // Clickable "open" affordance — Cmd/Ctrl-click opens the file in the
            // OS default viewer. The pixels themselves aren't clickable, so the
            // path is the open handle.
            if (preview.path && canLink) {
              const fileUrl = pathToFileURL(preview.path).href;
              const linkLabel = `↗ ${path.basename(preview.path)}`;
              const lead = protocol === "none" ? "\n" : "";
              writeOutput(`${lead}${imageLeftPad}${createHyperlink(fileUrl, linkLabel)}\n`);
            }
          }
        }
        previousPrintedKind = item.kind;
      }
    },
    clear() {
      printed.clear();
      previousPrintedKind = null;
    },
    resetPrinted() {
      printed.clear();
      previousPrintedKind = null;
    },
    get printedIds() {
      return printed;
    },
  };
}

export function serializeCompletedItemToTerminalHistory(
  item: CompletedItem,
  context: TerminalHistoryContext,
): string {
  switch (item.kind) {
    case "banner":
      return renderBanner(context);
    case "user":
      return renderUser(item.text, item.imageCount, item.pasteInfo, context);
    case "queued":
      return renderQueued(item.text, item.imageCount, context);
    case "assistant":
      return renderAssistant(item.text, context, item.continuation);
    case "ideal_hook":
      return renderIdealHook(item.text, context);
    case "tool_start":
      if (item.name === "enter_plan") return "";
      return renderToolStart(item.name, item.args, item.progressOutput, context);
    case "tool_done":
      if (item.name === "enter_plan") return "";
      return renderToolDone(
        item.name,
        item.args,
        item.result,
        item.isError,
        item.durationMs,
        context,
      );
    case "tool_group":
      return renderToolGroup(item.tools, context);
    case "server_tool_start":
      return renderServerToolStart(item.name, item.input, context);
    case "server_tool_done":
      return renderServerToolDone(item.name, item.input, item.resultType, item.durationMs, context);
    case "subagent_group":
      return renderSubAgentGroup(item.agents, item.aborted, context);
    case "task": {
      const presentation = presentTask(item);
      return renderStatusLine(
        presentation.glyph.trim(),
        `${dim(context, presentation.label ?? "")}${color(context.theme.commandColor, presentation.text, true)}`,
        context,
        context.theme.commandColor,
        presentation.bold,
        true,
      );
    }
    case "error":
      return renderError(item.headline, item.message, item.guidance, context);
    case "info": {
      const presentation = presentInfo(item);
      return renderStatusLine(
        presentation.glyph.trim(),
        presentation.text,
        context,
        context.theme.commandColor,
        presentation.bold,
      );
    }
    case "style_pack":
      return renderStylePack(item.added, item.showSetupHint, context);
    case "setup_hint":
      return renderSetupHint(context);
    case "update_notice":
      return renderUpdateNotice(item.text, context);
    case "compacting":
      return renderCompacting(context);
    case "compacted":
      return renderCompacted(
        item.originalCount,
        item.newCount,
        item.tokensBefore,
        item.tokensAfter,
        context,
      );
    case "duration": {
      const presentation = presentDuration(item);
      return indent(
        dim(context, `${presentation.glyph}${presentation.text}`),
        RESPONSE_LEFT_PADDING,
      );
    }
    case "session_summary":
      return renderSessionSummary(item.summary, context);
    case "plan_transition":
      return renderPlanModeLogo(context);
    case "model_transition": {
      const presentation = presentModelTransition(item);
      return renderStatusLine(
        presentation.glyph.trim(),
        `${dim(context, presentation.label ?? "")}${color(context.theme.commandColor, presentation.text, true)}`,
        context,
        context.theme.commandColor,
        presentation.bold,
        true,
      );
    }
    case "theme_transition": {
      const presentation = presentThemeTransition(item);
      return renderStatusLine(
        presentation.glyph.trim(),
        `${dim(context, presentation.label ?? "")}${color(context.theme.commandColor, presentation.text, true)}`,
        context,
        context.theme.commandColor,
        presentation.bold,
        true,
      );
    }
    case "plan_event": {
      const presentation = presentPlanEvent(item);
      return renderStatusLine(
        presentation.glyph.trim(),
        `${color(context.theme.commandColor, presentation.text, true)}${presentation.detail ? dim(context, presentation.detail) : ""}`,
        context,
        context.theme.commandColor,
        presentation.bold,
        true,
      );
    }
    case "stopped": {
      const presentation = presentStopped(item);
      return renderStatusLine(
        presentation.glyph.trim(),
        presentation.text,
        context,
        context.theme.commandColor,
        presentation.bold,
      );
    }
    case "step_done":
      return renderStepDone(item.stepNum, item.description, context);
    case "tombstone":
      return "";
  }
}

function renderSessionSummary(
  summary: Extract<CompletedItem, { kind: "session_summary" }>["summary"],
  context: TerminalHistoryContext,
): string {
  const cacheTokens = (summary.usage.cacheRead ?? 0) + (summary.usage.cacheWrite ?? 0);
  const successRate =
    summary.tools.totalCalls > 0
      ? (summary.tools.totalSuccess / summary.tools.totalCalls) * 100
      : null;
  const topTools = Object.entries(summary.tools.byName)
    .sort(([, a], [, b]) => b.calls - a.calls || b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(([name, stats]) => `${name} ×${stats.calls}`)
    .join(", ");
  const lines = [
    color(context.theme.secondary, summary.title, true),
    "",
    `${color(context.theme.text, "Session", true)}`,
    summary.sessionId
      ? `${color(context.theme.link, "ID:")} ${dim(context, summary.sessionId)}`
      : undefined,
    `${color(context.theme.link, "Model:")} ${summary.provider}:${summary.model}`,
    `${color(context.theme.link, "Directory:")} ${dim(context, summary.cwd)}`,
    "",
    `${color(context.theme.text, "Usage", true)}`,
    `${color(context.theme.link, "Wall time:")} ${formatDuration(summary.wallDurationMs)}`,
    `${color(context.theme.link, "Turns:")} ${summary.turns.toLocaleString()}`,
    `${color(context.theme.link, "Tokens:")} ${summary.usage.inputTokens.toLocaleString()} in / ${summary.usage.outputTokens.toLocaleString()} out${cacheTokens > 0 ? dim(context, ` / ${cacheTokens.toLocaleString()} cache`) : ""}`,
    "",
    `${color(context.theme.text, "Work", true)}`,
    `${color(context.theme.link, "Tool calls:")} ${summary.tools.totalCalls.toLocaleString()} (${color(context.theme.success, `✓ ${summary.tools.totalSuccess.toLocaleString()}`)} ${color(context.theme.error, `× ${summary.tools.totalFail.toLocaleString()}`)}${successRate == null ? "" : dim(context, ` · ${successRate.toFixed(1)}%`)})`,
    `${color(context.theme.link, "Top tools:")} ${dim(context, topTools || "none")}`,
    summary.linesChanged.added > 0 || summary.linesChanged.removed > 0
      ? `${color(context.theme.link, "Code changes:")} ${color(context.theme.success, `+${summary.linesChanged.added.toLocaleString()}`)} ${color(context.theme.error, `-${summary.linesChanged.removed.toLocaleString()}`)}`
      : undefined,
    summary.footer ? "" : undefined,
    summary.footer ? dim(context, summary.footer) : undefined,
  ].filter((line): line is string => line !== undefined);
  return indent(lines.join("\n"), RESPONSE_LEFT_PADDING);
}

function renderBanner(context: TerminalHistoryContext): string {
  const modelInfo = getModel(context.model);
  const modelName = modelInfo?.name ?? context.model;
  const home = process.env.HOME ?? "";
  const displayPath =
    home && context.cwd.startsWith(home) ? `~${context.cwd.slice(home.length)}` : context.cwd;
  const logo = LOGO_LINES.map((lineText) => gradientLine(lineText, GRADIENT));

  const shortcuts = `${color(context.theme.primary, "Ctrl+T")} ${dim(context, "tasks · ")}${color(context.theme.primary, "Ctrl+S")} ${dim(context, "skills · ")}${color(context.theme.primary, "Shift+Tab")} ${dim(context, "toggle thinking")}`;

  if (context.columns < SIDE_BY_SIDE_MIN) {
    return block([
      "",
      ...logo,
      "",
      `${color(context.theme.primary, "GG Coder", true)}${dim(context, ` v${context.version}`)}`,
      `${color(context.theme.secondary, modelName)}  ${dim(context, truncatePlain(displayPath, context.columns))}`,
      shortcuts,
      "",
    ]);
  }

  return block([
    "",
    `${logo[0]}${GAP}${color(context.theme.primary, "GG Coder", true)}${dim(context, ` v${context.version} · By `)}${color(context.theme.text, "Ken Kai", true)}`,
    `${logo[1]}${GAP}${color(context.theme.secondary, modelName)}  ${dim(context, truncatePlain(displayPath, Math.max(10, context.columns - LOGO_WIDTH - GAP.length - stringWidth(modelName) - 2)))}`,
    `${logo[2]}${GAP}${shortcuts}`,
    "",
  ]);
}

function renderUser(
  text: string,
  imageCount: number | undefined,
  pasteInfo: PasteInfo | undefined,
  context: TerminalHistoryContext,
): string {
  const imageBadges = Array.from({ length: imageCount ?? 0 }, (_, index) =>
    userChipSegment(`[Image #${index + 1}]`, context.theme.accent),
  );
  const userMessageText = context.theme.commandColor;
  const separator = userChipSegment(" ", userMessageText);
  const content = [
    ...getUserMessageDisplayParts(text, pasteInfo).map((part) =>
      userChipSegment(part.text, part.kind === "paste" ? context.theme.textDim : userMessageText),
    ),
    ...imageBadges,
  ]
    .filter((part) => part.length > 0)
    .join(separator);
  const messageWidth = Math.max(10, context.columns);
  const contentWidth = Math.max(
    1,
    messageWidth - USER_MESSAGE_HORIZONTAL_PADDING - USER_MESSAGE_PREFIX.length,
  );
  const wrapped = wrapAnsi(content || userChipSegment("(empty)", userMessageText), contentWidth, {
    hard: true,
    wordWrap: true,
  });
  const top = chalk.hex(USER_MESSAGE_BACKGROUND)(USER_MESSAGE_TOP_FILL.repeat(messageWidth));
  const bottom = chalk.hex(USER_MESSAGE_BACKGROUND)(USER_MESSAGE_BOTTOM_FILL.repeat(messageWidth));
  const rows = wrapped.split("\n").map((lineText, index) => {
    const prefix =
      index === 0
        ? userChipSegment(USER_MESSAGE_PREFIX, userMessageText, true)
        : userChipSegment(" ".repeat(USER_MESSAGE_PREFIX.length), userMessageText);
    const line = `${userChipSegment(" ", userMessageText)}${prefix}${lineText}`;
    const fillWidth = Math.max(0, messageWidth - stringWidth(stripAnsi(line)));
    return `${line}${userChipSegment(" ".repeat(fillWidth), userMessageText)}`;
  });
  return [top, ...rows, bottom].join("\n");
}

function renderQueued(
  text: string,
  imageCount: number | undefined,
  context: TerminalHistoryContext,
): string {
  const presentation = presentQueued({ kind: "queued", text, imageCount, id: "history-queued" });
  return prefixFirstLine(
    wrapPlain(
      `${dim(context, presentation.label)}${color(context.theme.text, presentation.text)}${color(context.theme.text, presentation.suffix)}`,
      context.columns - 4,
    ),
    ` ${color(context.theme.warning, presentation.glyph.trim(), true)} `,
    "   ",
  );
}

function renderAssistant(
  text: string,
  context: TerminalHistoryContext,
  continuation = false,
): string {
  const lines: string[] = [];
  const body = renderMarkdownToAnsiLines({
    text,
    theme: context.theme,
    width: Math.max(10, context.columns - 4),
  })
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  if (body.length > 0) {
    lines.push(
      continuation
        ? indent(body, "   ")
        : prefixFirstLine(body, ` ${color(context.theme.primary, BLACK_CIRCLE)} `, "   "),
    );
  }
  return lines.join("\n");
}

function renderIdealHook(text: string, context: TerminalHistoryContext): string {
  // Same dot prefix + indent as an assistant row, but in the secondary color
  // (bold) so the ideal-review hook visibly stands apart from normal output.
  const body = color(context.theme.secondary, text, true);
  return prefixFirstLine(body, ` ${color(context.theme.secondary, BLACK_CIRCLE)} `, "   ");
}

function renderPlanModeLogo(_context: TerminalHistoryContext): string {
  return PLAN_MODE_LOGO.map((line) => ` ${gradientLine(line, PLAN_MODE_GRADIENT)}`).join("\n");
}

function renderToolStart(
  name: string,
  args: Record<string, unknown>,
  progressOutput: string | undefined,
  context: TerminalHistoryContext,
): string {
  if (SERVER_STYLE_TOOLS.has(name)) {
    const { label, detail } = getToolHeaderParts(name, args);
    return block([
      toolHeader("running", label, detail, context, { quoteDetail: true }),
      ...messageResponse([dim(context, "Searching...")], context),
    ]);
  }

  if (COMPACT_TOOLS.has(name)) {
    return toolHeader("running", getCompactRunningLabel(name, args), "", context);
  }

  if (STATE_TOOLS.has(name)) {
    const { label, detail } = getToolHeaderParts(name, args);
    return stateToolHeader("running", label, detail, "", context);
  }

  const { label, detail } = getToolHeaderParts(name, args);
  const header = toolHeader("running", label, detail, context);
  if (name !== "bash" || !progressOutput?.trim()) return header;
  return block([
    header,
    ...messageResponse(
      outputPreview(progressOutput, context, context.theme.textMuted, { tail: true }),
      context,
    ),
  ]);
}

function renderToolDone(
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  durationMs: number,
  context: TerminalHistoryContext,
): string {
  if (SERVER_STYLE_TOOLS.has(name)) {
    return renderServerStyleToolDone(name, args, result, isError, context);
  }

  if (COMPACT_TOOLS.has(name) && !isError) {
    return toolHeader("done", getCompactDoneLabel(name, args, result), "", context);
  }

  // Screenshot collapses to a single header line, e.g. `Screenshot (image/png)`.
  // The inline image is appended separately by the printer; the multi-line
  // "Captured …" text would be redundant above it.
  if (name === "screenshot" && !isError) {
    const mediaType = result.match(/\[(image\/[a-z0-9.+-]+)\]/i)?.[1] ?? "image";
    return toolHeader("done", "Screenshot", mediaType, context);
  }

  if (STATE_TOOLS.has(name)) {
    const { label, detail } = getToolHeaderParts(name, args);
    return stateToolHeader(
      isError ? "error" : "done",
      label,
      detail,
      getInlineSummary(name, result, isError),
      context,
    );
  }

  const { label, detail } = getToolHeaderParts(name, args);
  const inline = getInlineSummary(name, result, isError);
  const suffix =
    inline.length > 0 && toolResultPreview(name, result, isError, context).length === 0
      ? inline
      : "";
  const header = toolHeader(isError ? "error" : "done", label, detail, context, { suffix });
  const preview = toolResultPreview(name, result, isError, context);
  if (name === "edit" && !isError) {
    const diff = extractDiff(result);
    if (diff)
      return block([header, ...messageResponse(renderDiffPreview(diff, args, context), context)]);
  }
  return block(preview.length > 0 ? [header, ...messageResponse(preview, context)] : [header]);
}

function renderToolGroup(
  tools: readonly {
    name: string;
    args: Record<string, unknown>;
    status: "running" | "done";
    isError?: boolean;
    result?: string;
  }[],
  context: TerminalHistoryContext,
): string {
  const allDone = tools.every((tool) => tool.status === "done");
  const hasError = tools.some((tool) => tool.isError);
  const status = allDone ? (hasError ? "error" : "done") : "running";
  return toolHeader(
    status,
    renderSummarySegments(buildToolGroupSummary(tools, allDone), context),
    "",
    context,
    {
      labelAlreadyStyled: true,
    },
  );
}

function renderServerToolStart(
  name: string,
  input: unknown,
  context: TerminalHistoryContext,
): string {
  const { label, detail } = getServerToolHeaderParts(name, input);
  return block([
    toolHeader("running", label, detail, context, { quoteDetail: true }),
    ...messageResponse([dim(context, "Searching...")], context),
  ]);
}

function renderServerToolDone(
  name: string,
  input: unknown,
  resultType: string,
  durationMs: number,
  context: TerminalHistoryContext,
): string {
  const { label, detail } = getServerToolHeaderParts(name, input);
  const isAborted = resultType === "aborted";
  const summary = isAborted ? "Stopped." : `Did 1 search in ${Math.round(durationMs / 1000)}s`;
  return block([
    toolHeader(isAborted ? "error" : "done", label, detail, context, { quoteDetail: true }),
    ...messageResponse([dim(context, summary)], context),
  ]);
}

function renderSubAgentGroup(
  agents: readonly {
    status: "running" | "done" | "error" | "aborted" | string;
    task: string;
    tokenUsage?: { input: number; output: number };
    currentActivity?: string;
    result?: string;
    durationMs?: number;
  }[],
  aborted: boolean | undefined,
  context: TerminalHistoryContext,
): string {
  if (agents.length === 0) return "";
  const runningCount = agents.filter((agent) => agent.status === "running").length;
  const allDone = runningCount === 0;
  const headerText = aborted
    ? `${agents.length} agent${agents.length !== 1 ? "s" : ""} interrupted`
    : allDone
      ? `${agents.length} agent${agents.length !== 1 ? "s" : ""} completed`
      : `${agents.length} agent${agents.length !== 1 ? "s" : ""} launched`;
  const lines = [
    toolHeader(aborted ? "error" : allDone ? "done" : "running", headerText, "", context),
  ];
  agents.forEach((agent, index) => {
    lines.push(
      ...renderSubAgentRows(agent, index === agents.length - 1, aborted === true, context),
    );
  });
  return block(lines);
}

function renderServerStyleToolDone(
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  context: TerminalHistoryContext,
): string {
  const { label, detail } = getToolHeaderParts(name, args);
  const searchCount = (result.match(/^\d+\./gm) ?? []).length;
  const summaryText = isError
    ? (result.split("\n")[0] ?? "")
    : `${searchCount} result${searchCount !== 1 ? "s" : ""}`;
  return block([
    toolHeader(isError ? "error" : "done", label, detail, context, { quoteDetail: true }),
    ...messageResponse([dim(context, summaryText)], context),
  ]);
}

function renderSubAgentRows(
  agent: {
    status: "running" | "done" | "error" | "aborted" | string;
    task: string;
    tokenUsage?: { input: number; output: number };
    currentActivity?: string;
    durationMs?: number;
  },
  isLast: boolean,
  aborted: boolean,
  context: TerminalHistoryContext,
): string[] {
  const branch = isLast ? "└─" : "├─";
  const continuation = isLast ? "   " : "│  ";
  const isRunning = agent.status === "running" && !aborted;
  const firstLine = agent.task.split("\n")[0]?.replace(/\*\*/g, "") ?? "";
  const taskDisplay = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  const taskPrefix =
    agent.status === "done"
      ? color(context.theme.success, "✓ ", true)
      : agent.status === "error"
        ? color(context.theme.error, "✗ ", true)
        : "";
  const taskLine = `${dim(context, `   ${branch.padEnd(3)}`)}${taskPrefix}${color(agent.status === "done" ? context.theme.success : context.theme.text, taskDisplay, isRunning)}`;

  const totalTokens = agent.tokenUsage ? agent.tokenUsage.input + agent.tokenUsage.output : 0;
  let detail: string;
  if (isRunning) {
    detail = `${color(context.theme.primary, "· ")}${dim(context, agent.currentActivity ?? "Starting…")}`;
  } else if (agent.status === "done") {
    detail = dim(
      context,
      `${formatCompactTokens(totalTokens)} tokens${agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}`,
    );
  } else {
    detail = color(
      context.theme.error,
      `${agent.status === "aborted" || aborted ? "Interrupted" : "Failed"}${agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}`,
    );
  }

  return [taskLine, `${dim(context, `   ${continuation}${RETURN_SYMBOL} `)}${detail}`];
}

function toolResultPreview(
  name: string,
  result: string,
  isError: boolean,
  context: TerminalHistoryContext,
): string[] {
  if (isError) return outputPreview(result, context, context.theme.error);
  if (["read", "write", "skill", "web_fetch", "source_path", "task_stop"].includes(name)) return [];
  if (name === "edit" && extractDiff(result)) return [];
  const lines = result.split("\n").filter((lineText) => lineText.length > 0);
  if (name === "bash" && /^Exit code:/.test(lines[0] ?? "")) lines.shift();
  if (lines.length === 0 || result === "No matches found.") return [];
  return outputPreview(
    lines.join("\n"),
    context,
    name === "bash" && getBashExitCode(result) !== "0"
      ? context.theme.warning
      : context.theme.textMuted,
  );
}

function outputPreview(
  text: string,
  context: TerminalHistoryContext,
  colorHex: string,
  options: { tail?: boolean } = {},
): string[] {
  const lines = text.split("\n").filter((lineText) => lineText.length > 0);
  const selected = options.tail ? lines.slice(-3) : lines.slice(0, MAX_OUTPUT_LINES);
  const display = selected.map((lineText) => {
    const wrapped = wrapPlain(truncatePlain(lineText, context.columns - 8), context.columns - 8);
    return color(colorHex, wrapped);
  });
  if (lines.length > MAX_OUTPUT_LINES) {
    display.push(
      dim(
        context,
        `… +${lines.length - MAX_OUTPUT_LINES} line${lines.length - MAX_OUTPUT_LINES === 1 ? "" : "s"}`,
      ),
    );
  }
  return display;
}

function toolHeader(
  status: "running" | "done" | "error",
  label: string,
  detail: string,
  context: TerminalHistoryContext,
  options: {
    suffix?: string;
    quoteDetail?: boolean;
    dotColor?: string;
    indicator?: string;
    labelAlreadyStyled?: boolean;
  } = {},
): string {
  const dotColor =
    options.dotColor ??
    (status === "error"
      ? context.theme.error
      : status === "done"
        ? context.theme.success
        : context.theme.spinnerColor);
  const indicator = options.indicator ?? (status === "running" ? SPINNER_FRAMES[0] : BLACK_CIRCLE);
  const labelColor =
    status === "error"
      ? context.theme.error
      : status === "done"
        ? context.theme.success
        : context.theme.toolName;
  const detailText = detail
    ? color(
        context.theme.text,
        options.quoteDetail ? `(${dim(context, '"')}${detail}${dim(context, '"')})` : `(${detail})`,
      )
    : "";
  const suffixText = options.suffix ? dim(context, ` ${options.suffix}`) : "";
  const labelText = options.labelAlreadyStyled ? label : color(labelColor, label, true);
  return `${RESPONSE_LEFT_PADDING}${color(dotColor, indicator)} ${labelText}${detailText}${suffixText}`;
}

function renderSummarySegments(
  segments: ReturnType<typeof buildToolGroupSummary>,
  context: TerminalHistoryContext,
): string {
  return segments
    .map((segment) =>
      segment.tone
        ? color(toolTonePalette(context.theme, segment.tone).primary, segment.text, segment.bold)
        : color(context.theme.text, segment.text, segment.bold),
    )
    .join("");
}

function stateToolHeader(
  status: "running" | "done" | "error",
  label: string,
  detail: string,
  inline: string,
  context: TerminalHistoryContext,
): string {
  const suffix = [detail, inline ? `· ${inline}` : ""]
    .filter((value) => value.length > 0)
    .join(" ");
  return `${toolHeader(status, label, "", context)}${suffix ? dim(context, ` ${suffix}`) : ""}`;
}

function messageResponse(lines: readonly string[], context: TerminalHistoryContext): string[] {
  if (lines.length === 0) return [];
  const [first, ...rest] = lines;
  return [
    `${RESPONSE_LEFT_PADDING}${dim(context, `  ${RETURN_SYMBOL}  `)}${first}`,
    ...rest.map((lineText) => `${RESPONSE_LEFT_PADDING}${dim(context, "     ")}${lineText}`),
  ];
}

function prefixFirstLine(text: string, firstPrefix: string, nextPrefix: string): string {
  return text
    .split("\n")
    .map((lineText, index) => {
      if (lineText.length === 0) return "";
      return `${index === 0 ? firstPrefix : nextPrefix}${lineText}`;
    })
    .join("\n");
}

function getToolHeaderParts(
  name: string,
  args: Record<string, unknown>,
): { label: string; detail: string } {
  const displayName = toolDisplayName(name);
  switch (name) {
    case "bash": {
      const command = String(args.command ?? "");
      const firstLine = command.split("\n")[0] ?? "";
      const detail = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
      return { label: displayName, detail: command.includes("\n") ? `${detail} …` : detail };
    }
    case "edit":
    case "write":
      return { label: displayName, detail: shortenPath(String(args.file_path ?? "")) };
    case "read":
      return { label: "Read", detail: shortenPath(String(args.file_path ?? "")) };
    case "grep":
    case "find": {
      const pattern = String(args.pattern ?? "");
      return {
        label: displayName,
        detail: pattern.length > 40 ? `${pattern.slice(0, 37)}…` : pattern,
      };
    }
    case "ls":
      return { label: displayName, detail: shortenPath(String(args.path ?? ".")) };
    case "subagent": {
      const task = String(args.task ?? "");
      return { label: displayName, detail: task.length > 50 ? `${task.slice(0, 47)}…` : task };
    }
    case "skill":
      return { label: displayName, detail: String(args.skill ?? "") };
    case "task_output":
    case "task_stop":
      return { label: displayName, detail: String(args.id ?? "") };
    case "web_search": {
      const query = String(args.query ?? "");
      return { label: "Web Search", detail: query.length > 60 ? `${query.slice(0, 57)}…` : query };
    }
    case "source_path": {
      const packageName = String(args.package ?? "");
      return {
        label: displayName,
        detail: packageName.length > 60 ? `${packageName.slice(0, 57)}…` : packageName,
      };
    }
    case "web_fetch": {
      const url = String(args.url ?? "");
      return { label: displayName, detail: url.length > 60 ? `${url.slice(0, 57)}…` : url };
    }
    case "tasks":
      return { label: displayName, detail: String(args.action ?? "") };
    default:
      return { label: displayName, detail: name.startsWith("mcp__") ? getMCPDetailArg(args) : "" };
  }
}

function toolDisplayName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return snakeToTitle(parts[2] ?? parts[1] ?? "mcp");
  }
  switch (name) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Update";
    case "grep":
      return "Search";
    case "find":
      return "Find";
    case "ls":
      return "List";
    case "subagent":
      return "Agent";
    case "skill":
      return "Skill";
    case "web_fetch":
      return "Fetch";
    case "web_search":
      return "Web Search";
    case "task_output":
      return "Task Output";
    case "task_stop":
      return "Task Stop";
    case "source_path":
      return "Source";
    case "tasks":
      return "Task";
    default:
      return snakeToTitle(name);
  }
}

function snakeToTitle(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function getMCPDetailArg(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (entries.length === 0) return "";
  const preferred = ["query", "prompt", "url", "path", "pattern", "name", "command", "repo"];
  const preferredEntry = preferred
    .map((key) => entries.find(([entryKey]) => entryKey.toLowerCase() === key))
    .find((entry): entry is [string, unknown] => entry !== undefined);
  const best =
    preferredEntry ??
    entries
      .filter(([, value]) => typeof value === "string")
      .sort((a, b) => String(a[1]).length - String(b[1]).length)[0] ??
    entries[0];
  const value = String(best?.[1] ?? "");
  return value.length > 50 ? `${value.slice(0, 47)}…` : value;
}

function getCompactRunningLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "grep":
      return "Searching…";
    case "read":
      return "Reading…";
    case "find":
      return "Finding files…";
    case "ls":
      return "Listing…";
    case "source_path": {
      const packageName = String(args.package ?? "");
      return `Resolving source${packageName ? ` for ${packageName}` : ""}…`;
    }
    default:
      return `${name}…`;
  }
}

function getCompactDoneLabel(name: string, args: Record<string, unknown>, result: string): string {
  switch (name) {
    case "grep": {
      const lines = result.split("\n").filter((lineText) => lineText.length > 0);
      const matchCount = lines.filter(
        (lineText) => !/^\d+ match|^\[Truncated/.test(lineText),
      ).length;
      return `Searched for 1 pattern${matchCount > 0 ? ` (${matchCount} match${matchCount !== 1 ? "es" : ""})` : ""}`;
    }
    case "read":
      return `Read ${shortenPath(String(args.file_path ?? ""))}`;
    case "find": {
      const lines = result.split("\n").filter((lineText) => lineText.length > 0);
      return `Found ${lines.length} file${lines.length !== 1 ? "s" : ""}`;
    }
    case "ls": {
      const lines = result.split("\n").filter((lineText) => lineText.length > 0);
      return `Listed ${lines.length} item${lines.length !== 1 ? "s" : ""}`;
    }
    case "source_path": {
      const packageName = String(args.package ?? "source");
      const sourcePath = extractSourcePath(result);
      return `Resolved ${packageName} → ${sourcePath ? shortenPath(sourcePath) : "source path"}`;
    }
    default:
      return name;
  }
}

function getInlineSummary(name: string, result: string, isError: boolean): string {
  if (isError) {
    const firstLine = result.split("\n")[0] ?? "";
    return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  }
  switch (name) {
    case "read": {
      const lines = result.split("\n").filter((lineText) => lineText.length > 0);
      return `${lines.length} line${lines.length !== 1 ? "s" : ""}`;
    }
    case "write":
      return result.match(/^Wrote \d+ lines?/)?.[0] ?? result.split("\n")[0] ?? "";
    case "bash": {
      const exitCode = result.match(/^Exit code: (.+)/)?.[1];
      return exitCode ? `exit ${exitCode}` : "done";
    }
    case "subagent":
      return "completed";
    case "skill":
      return result.startsWith("Error") ? (result.split("\n")[0] ?? "") : "loaded";
    case "web_fetch": {
      if (result.startsWith("Error")) return result.split("\n")[0] ?? "";
      const lines = result.split("\n").filter((lineText) => lineText.length > 0);
      return `${lines.length} line${lines.length !== 1 ? "s" : ""}`;
    }
    case "source_path":
      return extractSourcePath(result) ? shortenPath(extractSourcePath(result) ?? "") : "resolved";
    case "task_stop":
      return result.split("\n")[0] ?? "stopped";
    case "tasks": {
      const quoted = result.match(/"([^"]+)"/)?.[1];
      if (quoted) return quoted.length > 50 ? `${quoted.slice(0, 47)}…` : quoted;
      const firstLine = result.split("\n")[0] ?? "";
      return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
    }
    default: {
      if (!name.startsWith("mcp__")) return "";
      const lines = result.split("\n").filter((lineText) => lineText.length > 0);
      if (lines.length === 0) return "no results";
      const first = lines[0] ?? "";
      return lines.length === 1
        ? first.length > 50
          ? `${first.slice(0, 47)}…`
          : first
        : `${lines.length} lines`;
    }
  }
}

function shortenPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return `…/${parts.slice(-2).join("/")}`;
}

function extractSourcePath(result: string): string | undefined {
  return result.match(/^Source path:\s*(.+)$/m)?.[1]?.trim();
}

function getServerToolHeaderParts(name: string, input: unknown): { label: string; detail: string } {
  const values = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (name === "web_search") {
    const query = String(values.query ?? "");
    return { label: "Web Search", detail: query.length > 60 ? `${query.slice(0, 57)}…` : query };
  }
  return { label: name, detail: "" };
}

function getBashExitCode(result: string): string {
  return result.match(/^Exit code: (.+)/)?.[1]?.trim() ?? "0";
}

function extractDiff(result: string): string | undefined {
  return result.includes("---") && result.includes("+++") ? result : undefined;
}

function renderDiffPreview(
  diff: string,
  args: Record<string, unknown>,
  context: TerminalHistoryContext,
): string[] {
  const added = (diff.match(/^\+[^+]/gm) ?? []).length;
  const removed = (diff.match(/^-[^-]/gm) ?? []).length;
  const lines = [
    dim(
      context,
      `Added ${added} line${added !== 1 ? "s" : ""}, removed ${removed} line${removed !== 1 ? "s" : ""}`,
    ),
  ];
  const diffLines = buildDiffLines(diff, String(args.file_path ?? ""), context);
  if (diffLines.length > 0) {
    lines.push(dim(context, "────────────────────────────────────────────────────────────────"));
    lines.push(...diffLines);
    lines.push(dim(context, "────────────────────────────────────────────────────────────────"));
  }
  const hiddenCount = Math.max(0, countDisplayDiffLines(diff) + 1 - (diffLines.length + 1));
  if (hiddenCount > 0) lines.push(dim(context, `… +${hiddenCount} lines`));
  return lines;
}

function countDisplayDiffLines(diff: string): number {
  return diff
    .split("\n")
    .filter(
      (lineText) =>
        !lineText.startsWith("---") && !lineText.startsWith("+++") && !lineText.startsWith("@@"),
    ).length;
}

function buildDiffLines(diff: string, filePath: string, context: TerminalHistoryContext): string[] {
  const lang = langFromFilePath(filePath);
  const displayLines = diff
    .split("\n")
    .filter(
      (lineText) =>
        !lineText.startsWith("---") && !lineText.startsWith("+++") && !lineText.startsWith("@@"),
    )
    .slice(0, MAX_OUTPUT_LINES);
  return displayLines.map((lineText, index) => {
    const marker = lineText[0] === "+" || lineText[0] === "-" ? lineText[0] : " ";
    const content = truncatePlain(
      lineText.slice(marker === " " ? 0 : 1),
      Math.max(10, context.columns - 12),
    );
    const lineNo = String(index + 1).padStart(2, " ");
    if (marker === "+") return chalk.bgHex("#16a34a").hex("#ffffff")(`${lineNo} + ${content}`);
    if (marker === "-") return chalk.bgHex("#dc2626").hex("#ffffff")(`${lineNo} - ${content}`);
    return `${color(context.theme.textDim, `${lineNo}   `)}${colorCode(content, lang, context)}`;
  });
}

function langFromFilePath(filePath: string): "ts" | "js" | "json" | "text" {
  if (/\.tsx?$/.test(filePath)) return "ts";
  if (/\.jsx?$/.test(filePath)) return "js";
  if (/\.json$/.test(filePath)) return "json";
  return "text";
}

function colorCode(
  text: string,
  lang: "ts" | "js" | "json" | "text",
  context: TerminalHistoryContext,
): string {
  if (lang === "text") return color(context.theme.text, text);
  return color(context.theme.text, text);
}
