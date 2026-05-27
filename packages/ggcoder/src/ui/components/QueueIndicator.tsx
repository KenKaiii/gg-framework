import React from "react";
import { Box, Text } from "ink";
import type { useTheme } from "../theme/theme.js";

interface QueueIndicatorProps {
  hiddenQueuedCount: number;
  marginTop: number;
  theme: ReturnType<typeof useTheme>;
}

export function QueueIndicator({ hiddenQueuedCount, marginTop, theme }: QueueIndicatorProps) {
  if (hiddenQueuedCount <= 0) return null;

  return (
    <Box flexDirection="row" paddingLeft={1} marginTop={marginTop} flexShrink={0}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.warning} bold>
          {"• "}
        </Text>
      </Box>
      <Text color={theme.textDim}>
        {hiddenQueuedCount} message{hiddenQueuedCount > 1 ? "s" : ""} queued
      </Text>
    </Box>
  );
}
