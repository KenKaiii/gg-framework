import type { LanguageId } from "../core/language-detector.js";
import type { TerminalHistoryContext } from "./terminal-history.js";
import { BLACK_CIRCLE } from "./constants/figures.js";
import {
  RESPONSE_LEFT_PADDING,
  block,
  color,
  dim,
  formatTokenCount,
  indent,
  normalizeStatusText,
  renderLeftBorderBox,
  renderRoundBorderBox,
  wrapPlain,
} from "./terminal-history-format.js";
import {
  presentError,
  presentSetupHint,
  presentStepDone,
  presentStylePack,
  presentUpdateNotice,
} from "./transcript/presentation.js";

export function renderStatusLine(
  glyph: string,
  text: string,
  context: TerminalHistoryContext,
  glyphColor: string,
  bold: boolean,
  textAlreadyStyled = false,
): string {
  const prefix = ` ${color(glyphColor, glyph, true)} `;
  const continuation = "   ";
  const body = textAlreadyStyled
    ? text
    : color(bold ? glyphColor : context.theme.textDim, text, bold);
  return prefixFirstLine(body, prefix, continuation);
}

export function renderError(
  headline: string,
  message: string,
  guidance: string,
  context: TerminalHistoryContext,
): string {
  const presentation = presentError({
    kind: "error",
    headline,
    message,
    guidance,
    id: "history-error",
  });
  const lines = [color(context.theme.error, `${presentation.glyph}${presentation.headline}`)];
  if (presentation.message) {
    lines.push(dim(context, indent(wrapPlain(presentation.message, context.columns - 4), "  ")));
  }
  lines.push(dim(context, indent(wrapPlain(presentation.guidance, context.columns - 4), "  ")));
  return indent(block(lines), RESPONSE_LEFT_PADDING);
}

export function renderStylePack(
  added: readonly LanguageId[],
  showSetupHint: boolean,
  context: TerminalHistoryContext,
): string {
  const presentation = presentStylePack({
    kind: "style_pack",
    added,
    showSetupHint,
    id: "history-style-pack",
  });
  const lines = [
    `${color(context.theme.language, "◆ ", true)}${color(context.theme.language, presentation.headerLabel, true)}`,
    color(context.theme.text, presentation.names, true),
  ];
  if (presentation.showSetupHint) {
    lines.push(
      "",
      `${dim(context, "Tip: run ")}${color(context.theme.language, "/setup", true)}${dim(context, presentation.setupHint)}`,
    );
  }
  return renderRoundBorderBox(lines, context, context.theme.language);
}

export function renderSetupHint(context: TerminalHistoryContext): string {
  const presentation = presentSetupHint();
  return renderRoundBorderBox(
    [
      `${color(context.theme.language, "◆ ", true)}${color(context.theme.language, presentation.headerLabel, true)}`,
      dim(context, presentation.body),
      "",
      `${dim(context, "Tip: run ")}${color(context.theme.language, "/setup", true)}${dim(context, presentation.setupHint)}`,
    ],
    context,
    context.theme.language,
  );
}

export function renderUpdateNotice(_text: string, context: TerminalHistoryContext): string {
  const presentation = presentUpdateNotice();
  return renderRoundBorderBox(
    [color(context.theme.commandColor, presentation.text, true)],
    context,
    context.theme.commandColor,
  );
}

export function renderCompacting(context: TerminalHistoryContext): string {
  return renderLeftBorderBox(
    [
      `${color(context.theme.warning, "· ")}${dim(context, "Compacting conversation")}${dim(context, "...")}`,
    ],
    context.theme.warning,
    { padding: 2 },
  );
}

export function renderCompacted(
  originalCount: number,
  newCount: number,
  tokensBefore: number,
  tokensAfter: number,
  context: TerminalHistoryContext,
): string {
  const reduction = tokensBefore > 0 ? Math.round((1 - tokensAfter / tokensBefore) * 100) : 0;
  return renderLeftBorderBox(
    [
      `${color(context.theme.warning, "⟳ ")}${dim(context, "Conversation compacted")}`,
      dim(
        context,
        `  ${originalCount} → ${newCount} messages · ${formatTokenCount(tokensBefore)} → ${formatTokenCount(tokensAfter)} tokens · ${reduction}% reduction`,
      ),
    ],
    context.theme.warning,
  );
}

export function renderPlanEvent(
  event: "approved" | "rejected" | "dismissed",
  detail: string | undefined,
  context: TerminalHistoryContext,
): string {
  const labels = {
    approved: "Plan approved",
    rejected: "Plan rejected",
    dismissed: "Plan dismissed",
  } satisfies Record<typeof event, string>;
  const lines = [color(context.theme.commandColor, ` ○ ${labels[event]}`, true)];
  if (detail) lines[0] += dim(context, ` — "${detail}"`);
  return block(lines);
}

export function renderStepDone(
  stepNum: number,
  description: string,
  context: TerminalHistoryContext,
): string {
  const presentation = presentStepDone({
    kind: "step_done",
    stepNum,
    description,
    id: "history-step-done",
  });
  return `${RESPONSE_LEFT_PADDING}${color(context.theme.success, presentation.glyph.trim(), true)} ${color(context.theme.success, presentation.text, true)}${presentation.description ? dim(context, presentation.description) : ""}`;
}

export { BLACK_CIRCLE, normalizeStatusText };

function prefixFirstLine(text: string, firstPrefix: string, nextPrefix: string): string {
  return text
    .split("\n")
    .map((lineText, index) => {
      if (lineText.length === 0) return "";
      return `${index === 0 ? firstPrefix : nextPrefix}${lineText}`;
    })
    .join("\n");
}
