import React from "react";
import { Text, Box } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { useTheme } from "../theme/theme.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { getContextWindow, type ContextWindowOptions } from "../../core/model-registry.js";
import { PARTIAL_BLOCKS, LIGHT_SHADE } from "../constants/figures.js";
import { useFocusedAnimation, useReducedMotion } from "./AnimationContext.js";

interface FooterProps {
  model: string;
  tokensIn: number;
  contextWindowOptions?: ContextWindowOptions;
  cwd: string;
  gitBranch?: string | null;
  /**
   * Active thinking tier, or `undefined` when thinking is off. The footer
   * renders the tier verbatim (`Thinking xhigh`) and color-codes by power.
   * `xhigh` additionally shimmers to signal it's the top tier.
   */
  thinkingLevel?: ThinkingLevel;
  planMode?: boolean;
  exitPending?: boolean;
  /** Hide the plan-mode toggle entirely (for products that don't have plan mode). */
  hidePlan?: boolean;
  /** Optional left-side status string (e.g. "Connected · DaVinci Resolve"). */
  statusLabel?: string;
  /** Color for the status label. */
  statusColor?: string;
  /** Hide the cwd label (for products where the working directory isn't useful). */
  hideCwd?: boolean;
  /** Hide the git branch label. */
  hideGitBranch?: boolean;
  /**
   * Render the status label on its own line BELOW the model + tokens row
   * instead of inline on the left. Used by gg-editor where the host
   * connection status ("Connected to DaVinci Resolve…") is more readable on
   * a dedicated row.
   */
  statusBelow?: boolean;
}

// Model ID → short display name
const MODEL_SHORT_NAMES: Record<string, string> = {
  "claude-opus-4-7": "Opus",
  "claude-sonnet-4-6": "Sonnet",
  "claude-haiku-4-5": "Haiku",
  "claude-haiku-4-5-20251001": "Haiku",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
};

function getShortModelName(model: string): string {
  return MODEL_SHORT_NAMES[model] ?? model;
}

function getContextPercent(
  model: string,
  tokensIn: number,
  options?: ContextWindowOptions,
): number {
  const limit = getContextWindow(model, options);
  if (!limit || tokensIn === 0) return 0;
  return Math.round((tokensIn / limit) * 100);
}

function getContextColor(pct: number, theme: ReturnType<typeof useTheme>): string {
  if (pct >= 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

// ── Thinking-level visual treatment ─────────────────────────
//
// Higher tier = warmer / more saturated color. `xhigh` adds a moving shimmer
// so the top tier reads as visibly "on full power" at a glance.

const XHIGH_COLOR = "#db2777"; // hot pink — the visible "max power" tone
const XHIGH_SHIMMER_COLOR = "#f472b6"; // brighter pink that rides the shimmer
const SHIMMER_WIDTH = 2;

function getThinkingColor(
  level: ThinkingLevel | undefined,
  theme: ReturnType<typeof useTheme>,
): string {
  if (!level) return theme.textDim;
  if (level === "low") return theme.textMuted;
  if (level === "medium") return theme.accent;
  if (level === "high") return theme.warning;
  return XHIGH_COLOR; // xhigh
}

/**
 * Per-char shimmer for the xhigh thinking label. A bright spot rides across
 * the text; chars within `SHIMMER_WIDTH` of the spot render bright/bold, the
 * rest stay in the base color. Subscribes to the global animation tick so
 * the timer only runs while xhigh is visible.
 */
const XhighShimmer: React.FC<{ text: string; active?: boolean }> = ({ text, active = true }) => {
  const { active: animationActive, tick } = useFocusedAnimation(active);
  const cycle = text.length + SHIMMER_WIDTH * 2;
  const pos = animationActive ? (tick % cycle) - SHIMMER_WIDTH : -SHIMMER_WIDTH;
  return (
    <Text>
      {text.split("").map((ch, i) => {
        const isBright = Math.abs(i - pos) <= SHIMMER_WIDTH;
        return (
          <Text key={i} color={isBright ? XHIGH_SHIMMER_COLOR : XHIGH_COLOR} bold={isBright}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
};

export function Footer({
  model,
  tokensIn,
  contextWindowOptions,
  cwd,
  gitBranch,
  thinkingLevel,
  planMode,
  exitPending,
  hidePlan,
  statusLabel,
  statusColor,
  hideCwd,
  hideGitBranch,
  statusBelow,
}: FooterProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();

  // Show only the current directory name
  const parts = cwd.split("/").filter(Boolean);
  const displayPath = parts.length > 0 ? parts[parts.length - 1] : cwd;

  const contextPct = getContextPercent(model, tokensIn, contextWindowOptions);
  const contextColor = getContextColor(contextPct, theme);
  const sep = <Text color={theme.border}>{" \u2502 "}</Text>;

  const modelName = getShortModelName(model);

  // Context bar with partial block precision
  const barWidth = 8;
  const fillFloat = Math.min((contextPct / 100) * barWidth, barWidth);
  const barChars: React.ReactElement[] = [];
  for (let i = 0; i < barWidth; i++) {
    const cellFill = Math.max(0, Math.min(1, fillFloat - i));
    const eighths = Math.round(cellFill * 8);
    if (eighths === 8) {
      barChars.push(
        <Text key={i} color={contextColor}>
          {PARTIAL_BLOCKS[8]}
        </Text>,
      );
    } else if (eighths > 0) {
      barChars.push(
        <Text key={i} color={contextColor}>
          {PARTIAL_BLOCKS[eighths]}
        </Text>,
      );
    } else {
      barChars.push(
        <Text key={i} color={theme.textDim}>
          {LIGHT_SHADE}
        </Text>,
      );
    }
  }

  // Plan/Thinking labels
  const planText = planMode ? "Plan on" : "Plan off";
  // Show the actual tier when on (`Thinking xhigh`) so users see what they're
  // paying for. Off is the only state that stays generic.
  const thinkingText = thinkingLevel ? `Thinking ${thinkingLevel}` : "Thinking off";
  const thinkingColor = getThinkingColor(thinkingLevel, theme);
  const reducedMotion = useReducedMotion();
  const shimmerXhigh = thinkingLevel === "xhigh" && !reducedMotion;
  const showPlan = !hidePlan;

  // Calculate whether everything fits on one line
  const leftLen = displayPath.length + 2 + (gitBranch ? gitBranch.length + 5 : 0);
  const rightLen =
    barWidth +
    1 +
    String(contextPct).length +
    1 +
    3 +
    modelName.length +
    (showPlan ? 3 + planText.length : 0) +
    3 +
    thinkingText.length;
  const availableWidth = columns - 2;
  const fitsOnOneLine = leftLen + rightLen <= availableWidth;

  const maxPath = fitsOnOneLine ? availableWidth - rightLen - 2 : availableWidth;
  const truncPath =
    displayPath.length > maxPath && maxPath > 10
      ? "\u2026" + displayPath.slice(displayPath.length - maxPath + 1)
      : displayPath;

  // Shared right-side content
  const rightContent = (
    <>
      <Text>{barChars}</Text>
      <Text color={contextColor}> {contextPct}%</Text>
      {sep}
      <Text color={theme.primary} bold>
        {modelName}
      </Text>
      {showPlan ? (
        <>
          {sep}
          <Text color={planMode ? theme.planPrimary : theme.textDim}>{planText}</Text>
        </>
      ) : null}
      {sep}
      {shimmerXhigh ? (
        <XhighShimmer text={thinkingText} active={!exitPending} />
      ) : (
        <Text color={thinkingColor} bold={thinkingLevel === "high"}>
          {thinkingText}
        </Text>
      )}
    </>
  );

  if (exitPending) {
    return (
      <Box paddingLeft={1} paddingRight={1} width={columns}>
        <Text color={theme.warning}>Press Ctrl+C again to exit</Text>
      </Box>
    );
  }

  const showCwd = !hideCwd;
  const showGitBranch = !hideGitBranch && !!gitBranch;
  // When statusBelow is set, the status renders on its own line under
  // the right content — it's NOT part of the left-chunk layout.
  const showStatusInLeft = !!statusLabel && !statusBelow;

  // First-rendered left chunk: track if we've started the line with the cwd
  // so we know when to insert separators.
  const leftHasContent = showCwd || showGitBranch || showStatusInLeft;
  // Sep helper that only renders if there's already content before it.
  let leftStarted = false;
  const renderLeftSep = (key: string): React.ReactElement | null => {
    if (!leftStarted) {
      leftStarted = true;
      return null;
    }
    return <React.Fragment key={key}>{sep}</React.Fragment>;
  };

  // statusBelow forces the two-line layout (status sits on its own row
  // under model + tokens). The left-chunk render still respects fits-on-one-
  // line for whatever non-status content remains (cwd, git branch).
  if (fitsOnOneLine && !statusBelow) {
    return (
      <Box paddingLeft={1} paddingRight={1} width={columns}>
        <Box flexGrow={1}>
          {showCwd && (
            <>
              {renderLeftSep("sep-cwd")}
              <Text color={theme.textDim}>{truncPath}</Text>
            </>
          )}
          {showGitBranch && (
            <>
              {renderLeftSep("sep-git")}
              <Text color={theme.secondary}>
                {"\u2387 "}
                {gitBranch}
              </Text>
            </>
          )}
          {showStatusInLeft && (
            <>
              {renderLeftSep("sep-status")}
              <Text color={statusColor ?? theme.text}>{statusLabel}</Text>
            </>
          )}
        </Box>
        <Box flexShrink={0}>{rightContent}</Box>
      </Box>
    );
  }

  // statusBelow layout: model + tokens row, then status row underneath.
  // The left-chunk content (cwd / git) merges into the model row's left side
  // when present; for gg-editor (hideCwd + hideGitBranch) only the status
  // line is added.
  if (statusBelow) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={columns}>
        <Box>
          <Box flexGrow={1}>
            {showCwd && <Text color={theme.textDim}>{truncPath}</Text>}
            {showGitBranch && (
              <>
                {showCwd ? sep : null}
                <Text color={theme.secondary}>
                  {"\u2387 "}
                  {gitBranch}
                </Text>
              </>
            )}
          </Box>
          <Box flexShrink={0}>{rightContent}</Box>
        </Box>
        {statusLabel && (
          <Box>
            <Text color={statusColor ?? theme.text} wrap="truncate">
              {statusLabel}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // Two-line layout
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={columns}>
      {leftHasContent && (
        <Box>
          {showCwd && (
            <Text color={theme.textDim} wrap="truncate">
              {truncPath}
            </Text>
          )}
          {showGitBranch && (
            <>
              {showCwd ? sep : null}
              <Text color={theme.secondary} wrap="truncate">
                {"\u2387 "}
                {gitBranch}
              </Text>
            </>
          )}
          {statusLabel && (
            <>
              {showCwd || showGitBranch ? sep : null}
              <Text color={statusColor ?? theme.text} wrap="truncate">
                {statusLabel}
              </Text>
            </>
          )}
        </Box>
      )}
      <Box>{rightContent}</Box>
    </Box>
  );
}
