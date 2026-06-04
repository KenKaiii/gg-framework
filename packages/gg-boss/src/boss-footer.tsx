import React from "react";
import { Text, Box } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { useTheme } from "@kenkaiiii/ggcoder/ui/theme";
import { useTerminalSize } from "@kenkaiiii/ggcoder/ui/hooks/terminal-size";
import { getContextWindow } from "@kenkaiiii/gg-core";
import { COLORS } from "./branding.js";

const PARTIAL_BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const LIGHT_SHADE = "░";
const BAR_WIDTH = 8;

const SHORT_MODELS: Record<string, string> = {
  "claude-opus-4-8": "Opus",
  "claude-sonnet-4-6": "Sonnet",
  "claude-haiku-4-5": "Haiku",
  "claude-haiku-4-5-20251001": "Haiku",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
};

function shortModel(model: string): string {
  return SHORT_MODELS[model] ?? model;
}

export function getBossFooterContextPercent(model: string, tokensIn: number): number {
  const limit = getContextWindow(model);
  if (!limit || tokensIn === 0) return 0;
  return Math.round((tokensIn / limit) * 100);
}

function getContextColor(pct: number, theme: ReturnType<typeof useTheme>): string {
  if (pct >= 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

function getThinkingColor(
  level: ThinkingLevel | undefined,
  theme: ReturnType<typeof useTheme>,
): string {
  if (!level) return theme.textDim;
  if (level === "low") return theme.textMuted;
  if (level === "medium") return theme.accent;
  if (level === "high") return theme.warning;
  return COLORS.accent;
}

export function getBossFooterThinkingLabel(level: ThinkingLevel | undefined): string {
  return level ? `Thinking ${level}` : "Thinking off";
}

interface BossFooterProps {
  bossModel: string;
  workerModel: string;
  /** Total input tokens of the boss's last turn — drives the context bar. */
  tokensIn: number;
  exitPending: boolean;
  /** Boss extended-thinking level. Falsy when thinking is off. */
  bossThinkingLevel?: ThinkingLevel;
  /** Auto-updater has installed a newer @kenkaiiii/gg-boss in the background. */
  updatePending?: boolean;
  /** id of the currently-playing radio station, or null when the radio is off. */
  currentRadioStationId?: string | null;
  scope: string;
  workerCount?: number;
  activeWorkerCount?: number;
}

const SHORT_RADIO: Record<string, string> = {
  "somafm-groove-salad": "Groove Salad",
  "somafm-drone-zone": "Drone Zone",
  "radio-paradise": "Radio Paradise",
  "george-fm": "George FM",
};

function renderContextBar({
  contextPct,
  contextColor,
  dimColor,
}: {
  contextPct: number;
  contextColor: string;
  dimColor: string;
}): React.ReactElement[] {
  const fillFloat = Math.min((contextPct / 100) * BAR_WIDTH, BAR_WIDTH);
  const barChars: React.ReactElement[] = [];
  for (let i = 0; i < BAR_WIDTH; i++) {
    const cellFill = Math.max(0, Math.min(1, fillFloat - i));
    const eighths = Math.round(cellFill * 8);
    barChars.push(
      <Text key={i} color={eighths > 0 ? contextColor : dimColor}>
        {eighths > 0 ? PARTIAL_BLOCKS[eighths] : LIGHT_SHADE}
      </Text>,
    );
  }
  return barChars;
}

export function getBossFooterScopeLabel(scope: string): string {
  return scope === "all" ? "all projects" : scope;
}

/** Footer matching ggcoder's structure: left context label, right status cluster. */
export function BossFooter({
  bossModel,
  workerModel,
  tokensIn,
  exitPending,
  bossThinkingLevel,
  updatePending,
  currentRadioStationId,
  scope,
}: BossFooterProps): React.ReactElement {
  const theme = useTheme();
  const { columns } = useTerminalSize();

  if (exitPending) {
    return (
      <Box paddingLeft={1} paddingRight={1} width={columns}>
        <Text color={theme.warning}>Press Ctrl+C again to exit</Text>
      </Box>
    );
  }

  const contextPct = getBossFooterContextPercent(bossModel, tokensIn);
  const contextColor = getContextColor(contextPct, theme);
  const sep = <Text color={theme.border}>{" │ "}</Text>;
  const bossName = shortModel(bossModel);
  const workerName = shortModel(workerModel);
  const thinkingText = getBossFooterThinkingLabel(bossThinkingLevel);
  const radioName = currentRadioStationId
    ? (SHORT_RADIO[currentRadioStationId] ?? currentRadioStationId)
    : null;
  const updateText = updatePending ? "Update ready. Restart GG Boss." : null;
  const leftText = getBossFooterScopeLabel(scope);

  const barChars = renderContextBar({
    contextPct,
    contextColor,
    dimColor: theme.textDim,
  });

  const rightLen =
    BAR_WIDTH +
    1 +
    String(contextPct).length +
    3 +
    bossName.length +
    3 +
    "workers ".length +
    workerName.length +
    3 +
    thinkingText.length +
    (radioName ? 3 + 2 + radioName.length : 0) +
    (updateText ? 3 + updateText.length : 0);
  const availableWidth = columns - 2;
  const fitsOnOneLine = leftText.length + rightLen <= availableWidth;
  const hideRadio = !!radioName && leftText.length + rightLen > availableWidth + 8;
  const compactUpdate = !!updateText && leftText.length + rightLen > availableWidth + 12;

  const rightContent = (
    <>
      <Text>{barChars}</Text>
      <Text color={contextColor}> {contextPct}%</Text>
      {sep}
      <Text color={theme.primary} bold>
        {bossName}
      </Text>
      {sep}
      <Text color={theme.textDim}>workers </Text>
      <Text color={COLORS.accent} bold>
        {workerName}
      </Text>
      {sep}
      <Text color={getThinkingColor(bossThinkingLevel, theme)} bold={bossThinkingLevel === "high"}>
        {thinkingText}
      </Text>
      {radioName && !hideRadio && (
        <>
          {sep}
          <Text color={theme.secondary}>♪ {radioName}</Text>
        </>
      )}
      {updateText && (
        <>
          {sep}
          <Text color={theme.success} bold wrap="truncate">
            {compactUpdate ? "Update ready" : updateText}
          </Text>
        </>
      )}
    </>
  );

  if (fitsOnOneLine) {
    return (
      <Box paddingLeft={1} paddingRight={1} width={columns}>
        <Box flexGrow={1}>
          <Text color={theme.textDim} wrap="truncate">
            {leftText}
          </Text>
        </Box>
        <Box flexShrink={0}>{rightContent}</Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={columns}>
      <Box>
        <Text color={theme.textDim} wrap="truncate">
          {leftText}
        </Text>
      </Box>
      <Box>{rightContent}</Box>
    </Box>
  );
}
