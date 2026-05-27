import React from "react";
import { Box, Text } from "ink";
import type { SessionSummary } from "../session-summary.js";
import { getToolSuccessRate } from "../session-summary.js";
import { formatDuration } from "../duration-format.js";
import { useTheme } from "../theme/theme.js";

function formatCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Box>
      <Box width={18} flexShrink={0}>
        <Text color={theme.link}>{label}</Text>
      </Box>
      <Box flexShrink={1}>{children}</Box>
    </Box>
  );
}

function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text} bold>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function topTools(summary: SessionSummary): string {
  const entries = Object.entries(summary.tools.byName)
    .sort(([, a], [, b]) => b.calls - a.calls || b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(([name, stats]) => `${name} ×${stats.calls}`);
  return entries.length > 0 ? entries.join(", ") : "none";
}

export function SessionSummaryDisplay({ summary }: { summary: SessionSummary }) {
  const theme = useTheme();
  const successRate = getToolSuccessRate(summary.tools);
  const cacheTokens = (summary.usage.cacheRead ?? 0) + (summary.usage.cacheWrite ?? 0);
  const changedLines = summary.linesChanged.added > 0 || summary.linesChanged.removed > 0;

  return (
    <Box paddingLeft={1} flexShrink={1}>
      <Box
        flexDirection="column"
        flexShrink={1}
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
      >
        <Text color={theme.secondary} bold>
          {summary.title}
        </Text>

        <SummarySection title="Session">
          {summary.sessionId && (
            <SummaryRow label="ID">
              <Text color={theme.textDim} wrap="truncate-end">
                {summary.sessionId}
              </Text>
            </SummaryRow>
          )}
          <SummaryRow label="Model">
            <Text color={theme.text} wrap="truncate-end">
              {summary.provider}:{summary.model}
            </Text>
          </SummaryRow>
          <SummaryRow label="Directory">
            <Text color={theme.textDim} wrap="truncate-end">
              {summary.cwd}
            </Text>
          </SummaryRow>
        </SummarySection>

        <SummarySection title="Usage">
          <SummaryRow label="Wall time">
            <Text color={theme.text}>{formatDuration(summary.wallDurationMs)}</Text>
          </SummaryRow>
          <SummaryRow label="Turns">
            <Text color={theme.text}>{summary.turns.toLocaleString()}</Text>
          </SummaryRow>
          <SummaryRow label="Tokens">
            <Text color={theme.text}>
              {formatCount(summary.usage.inputTokens)} in /{" "}
              {formatCount(summary.usage.outputTokens)} out
              {cacheTokens > 0 ? (
                <Text color={theme.textDim}> / {formatCount(cacheTokens)} cache</Text>
              ) : null}
            </Text>
          </SummaryRow>
        </SummarySection>

        <SummarySection title="Work">
          <SummaryRow label="Tool calls">
            <Text color={theme.text}>
              {summary.tools.totalCalls.toLocaleString()} {"("}
              <Text color={theme.success}>
                ✓ {summary.tools.totalSuccess.toLocaleString()}
              </Text>{" "}
              <Text color={theme.error}>× {summary.tools.totalFail.toLocaleString()}</Text>
              {successRate == null ? null : (
                <Text color={theme.textDim}> · {successRate.toFixed(1)}%</Text>
              )}
              {")"}
            </Text>
          </SummaryRow>
          <SummaryRow label="Top tools">
            <Text color={theme.textDim} wrap="wrap">
              {topTools(summary)}
            </Text>
          </SummaryRow>
          {summary.serverToolCalls > 0 && (
            <SummaryRow label="Server tools">
              <Text color={theme.text}>{summary.serverToolCalls.toLocaleString()}</Text>
            </SummaryRow>
          )}
          {changedLines && (
            <SummaryRow label="Code changes">
              <Text>
                <Text color={theme.success}>+{summary.linesChanged.added.toLocaleString()}</Text>{" "}
                <Text color={theme.error}>-{summary.linesChanged.removed.toLocaleString()}</Text>
              </Text>
            </SummaryRow>
          )}
        </SummarySection>

        {summary.footer && (
          <Box marginTop={1}>
            <Text color={theme.textMuted} wrap="wrap">
              {summary.footer}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
