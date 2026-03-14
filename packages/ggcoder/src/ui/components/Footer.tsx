import React from "react";
import { Text, Box, useStdout } from "ink";
import { useTheme } from "../theme/theme.js";

interface FooterProps {
  model: string;
  tokensIn: number;
  cwd: string;
  gitBranch?: string | null;
  thinkingEnabled?: boolean;
  planMode?: string | null;
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

// Model ID → context window size in tokens
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  o3: 200_000,
  "o4-mini": 200_000,
};

function getShortModelName(model: string): string {
  return MODEL_SHORT_NAMES[model] ?? model;
}

function getContextPercent(model: string, tokensIn: number): number {
  const limit = MODEL_CONTEXT_LIMITS[model];
  if (!limit || tokensIn === 0) return 0;
  return Math.round((tokensIn / limit) * 100);
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return "0";
  if (tokens < 1000) return String(tokens);
  if (tokens < 100_000) return (tokens / 1000).toFixed(1) + "k";
  return Math.round(tokens / 1000) + "k";
}

function getContextColor(pct: number, theme: ReturnType<typeof useTheme>): string {
  if (pct >= 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

// ── Partial block gauge ───────────────────────────────────

const PARTIAL_BLOCKS = [
  " ",
  "\u258F",
  "\u258E",
  "\u258D",
  "\u258C",
  "\u258B",
  "\u258A",
  "\u2589",
  "\u2588",
];

export function Footer({
  model,
  tokensIn,
  cwd,
  gitBranch,
  thinkingEnabled,
  planMode,
}: FooterProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Show only last 2 path segments (project folder + immediate parent)
  const parts = cwd.split("/").filter(Boolean);
  const displayPath = parts.length <= 2 ? cwd : parts.slice(-2).join("/");

  const contextPct = getContextPercent(model, tokensIn);
  const contextColor = getContextColor(contextPct, theme);
  const sep = <Text color={theme.border}>{" \u2502 "}</Text>;

  // Build right side segments
  const modelName = getShortModelName(model);

  // Build a context bar with partial block precision (8 chars × 8 levels = 64 granularity)
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
          {"\u2591"}
        </Text>,
      );
    }
  }

  // "Thinking on" / "Thinking off" + key hint (⇧⇹)
  const thinkingText = thinkingEnabled ? "Thinking on" : "Thinking off";
  const thinkingLen = thinkingText.length + 3 + 3; // " │ " separator + " ⇧⇹"

  // Truncate path if footer would overflow
  const planLen = planMode ? 3 + 4 : 0; // " │ " + "Plan"
  const rightLen =
    modelName.length +
    thinkingLen +
    planLen +
    3 +
    barWidth +
    1 +
    String(contextPct).length +
    1 +
    (gitBranch ? gitBranch.length + 5 : 0) +
    formatTokens(tokensIn).length +
    3 +
    10;
  const maxPath = columns - rightLen - 4;
  const truncPath =
    displayPath.length > maxPath && maxPath > 10
      ? "\u2026" + displayPath.slice(displayPath.length - maxPath + 1)
      : displayPath;

  return (
    <Box paddingLeft={1} paddingRight={1}>
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
      <Box>
        <Text color={theme.textDim}>{formatTokens(tokensIn)}</Text>
        {sep}
        <Text>{barChars}</Text>
        <Text color={contextColor}> {contextPct}%</Text>
        {sep}
        <Text color={theme.primary} bold>
          {modelName}
        </Text>
        {sep}
        <Text color={thinkingEnabled ? theme.accent : theme.textDim}>{thinkingText}</Text>
        <Text color={theme.border}>{" \u21E7\u21B9"}</Text>
        {planMode && (
          <>
            {sep}
            <Text color={theme.warning} bold>
              Plan
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}
