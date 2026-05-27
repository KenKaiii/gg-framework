import React from "react";
import { Box, Text } from "ink";
import { MessageResponse } from "../components/MessageResponse.js";
import { ToolUseLoader } from "../components/ToolUseLoader.js";
import { useTheme } from "../theme/theme.js";
import { truncateGoalProgressText } from "../goal-progress.js";
import type { GoalItem, GoalProgressItem } from "../app-items.js";
import { presentGoal, presentGoalProgress } from "./presentation.js";

function goalProgressColor(item: GoalProgressItem, theme: ReturnType<typeof useTheme>): string {
  const isError = item.status === "failed" || item.status === "fail" || item.status === "blocked";
  if (isError) return theme.error;
  if (item.phase === "worker_finished" || item.phase === "terminal") return theme.success;
  if (item.phase === "verifier_finished" || item.phase === "verifier_started") return theme.accent;
  if (item.phase === "orchestrator_reviewing" || item.phase === "orchestrator_working") {
    return theme.secondary;
  }
  if (item.phase === "continuing") return theme.warning;
  return theme.primary;
}

export function GoalRow({ item, columns }: { item: GoalItem; columns: number }) {
  const theme = useTheme();
  const presentation = presentGoal(item);

  return (
    <Box key={item.id} paddingLeft={1} width={columns} flexShrink={1}>
      <Text color={theme.success} wrap="truncate">
        {truncateGoalProgressText(presentation.text, Math.max(8, columns - 2))}
      </Text>
    </Box>
  );
}

export function GoalProgressRow({ item, columns }: { item: GoalProgressItem; columns: number }) {
  const theme = useTheme();
  const color = goalProgressColor(item, theme);
  const presentation = presentGoalProgress(item);

  return (
    <Box key={item.id} flexDirection="column" width={columns}>
      <Box flexDirection="row" paddingLeft={1} width={columns}>
        <ToolUseLoader status={presentation.loaderStatus} staticDisplay color={color} />
        <Text color={color} bold wrap="truncate">
          {truncateGoalProgressText(presentation.titleText, Math.max(8, columns - 4))}
        </Text>
      </Box>
      {presentation.hasResponseBody ? (
        <MessageResponse>
          <Box flexDirection="column" flexShrink={1}>
            {item.detail ? (
              <Text color={theme.textDim} wrap="wrap">
                {item.detail}
              </Text>
            ) : null}
            {item.summaryRows?.map((row) => (
              <Text key={`${item.id}-${row.label}`} wrap="wrap">
                <Text color={theme.textDim}>{row.label.padEnd(12)}</Text>
                <Text color={theme.text}>{row.value}</Text>
                {row.detail ? <Text color={theme.textDim}>{` · ${row.detail}`}</Text> : null}
              </Text>
            ))}
            {item.summarySections?.map((section) => (
              <Box key={`${item.id}-${section.title}`} flexDirection="column" flexShrink={1}>
                <Text color={theme.textDim}>{section.title}</Text>
                {section.lines.map((line, lineIndex) => (
                  <Text
                    key={`${item.id}-${section.title}-${lineIndex}`}
                    color={theme.text}
                    wrap="wrap"
                  >
                    {`• ${line}`}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        </MessageResponse>
      ) : null}
    </Box>
  );
}
