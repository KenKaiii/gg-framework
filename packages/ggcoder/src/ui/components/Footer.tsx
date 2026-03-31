import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { getContextWindow } from "../../core/model-registry.js";
import { PARTIAL_BLOCKS, LIGHT_SHADE, DOWN_ARROW, UP_ARROW } from "../constants/figures.js";

interface FooterProps {
  model: string;
  tokensIn: number;
  tokensOut?: number;
  sessionCost?: number;
  linesAdded?: number;
  linesRemoved?: number;
  cwd: string;
  gitBranch?: string | null;
  thinkingEnabled?: boolean;
  planMode?: boolean;
}

// Model ID → short display name
const MODEL_SHORT_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Opus",
  "claude-sonnet-4-6": "Sonnet",
  "claude-haiku-4-5": "Haiku",
  "claude-haiku-4-5-20251001": "Haiku",
  "gpt-4.1": "GPT-4.1",
  "gpt-4.1-mini": "GPT-4.1 Mini",
  "gpt-4.1-nano": "GPT-4.1 Nano",
  o3: "o3",
  "o4-mini": "o4-mini",
};

function getShortModelName(model: string): string {
  return MODEL_SHORT_NAMES[model] ?? model;
}

function getContextPercent(model: string, tokensIn: number): number {
  const limit = getContextWindow(model);
  if (!limit || tokensIn === 0) return 0;
  return Math.round((tokensIn / limit) * 100);
}

function getContextColor(pct: number, theme: ReturnType<typeof useTheme>): string {
  if (pct >= 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

function formatCost(cost: number): string {
  if (cost < 0.01) return "$0.00";
  return "$" + cost.toFixed(2);
}

export function Footer({
  model,
  tokensIn,
  tokensOut = 0,
  sessionCost = 0,
  linesAdded = 0,
  linesRemoved = 0,
  cwd,
  gitBranch,
  thinkingEnabled,
  planMode,
}: FooterProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();

  // Show only the current directory name
  const parts = cwd.split("/").filter(Boolean);
  const displayPath = parts.length > 0 ? parts[parts.length - 1] : cwd;

  const contextPct = getContextPercent(model, tokensIn);
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
  const thinkingText = thinkingEnabled ? "Thinking on" : "Thinking off";

  // Token/cost/lines info segments
  const tokenInfo = `${DOWN_ARROW}${formatTokens(tokensIn)} ${UP_ARROW}${formatTokens(tokensOut)}`;
  const costInfo = sessionCost > 0 ? formatCost(sessionCost) : "";
  const hasLines = linesAdded > 0 || linesRemoved > 0;

  // Calculate whether everything fits on one line
  const leftLen = displayPath.length + 2 + (gitBranch ? gitBranch.length + 5 : 0);
  const rightLen =
    barWidth +
    1 +
    String(contextPct).length +
    1 +
    3 +
    modelName.length +
    3 +
    tokenInfo.length +
    (costInfo ? 3 + costInfo.length : 0) +
    (hasLines ? 3 + String(linesAdded).length + 2 + String(linesRemoved).length : 0) +
    3 +
    planText.length +
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
      {sep}
      <Text color={theme.textDim}>{tokenInfo}</Text>
      {costInfo && (
        <>
          {sep}
          <Text color={theme.textDim}>{costInfo}</Text>
        </>
      )}
      {hasLines && (
        <>
          {sep}
          <Text color={theme.success}>+{linesAdded}</Text>
          <Text color={theme.textDim}>/</Text>
          <Text color={theme.error}>-{linesRemoved}</Text>
        </>
      )}
      {sep}
      <Text color={planMode ? theme.planPrimary : theme.textDim}>{planText}</Text>
      {sep}
      <Text color={thinkingEnabled ? theme.accent : theme.textDim}>{thinkingText}</Text>
    </>
  );

  if (fitsOnOneLine) {
    return (
      <Box paddingLeft={1} paddingRight={1} width={columns}>
        <Box flexGrow={1}>
          <Text color={theme.textDim}>{truncPath}</Text>
          {gitBranch && (
            <>
              {sep}
              <Text color={theme.secondary}>
                {"\u2387 "}
                {gitBranch}
              </Text>
            </>
          )}
        </Box>
        <Box flexShrink={0}>{rightContent}</Box>
      </Box>
    );
  }

  // Two-line layout
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={columns}>
      <Box>
        <Text color={theme.textDim} wrap="truncate">
          {truncPath}
        </Text>
        {gitBranch && (
          <>
            {sep}
            <Text color={theme.secondary} wrap="truncate">
              {"\u2387 "}
              {gitBranch}
            </Text>
          </>
        )}
      </Box>
      <Box>{rightContent}</Box>
    </Box>
  );
}
