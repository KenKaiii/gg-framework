import React from "react";
import { Text } from "ink";
import { useTheme } from "../theme/theme.js";

interface ScrollIndicatorProps {
  direction: "up" | "down";
  count: number;
}

export function ScrollIndicator({ direction, count }: ScrollIndicatorProps) {
  const theme = useTheme();
  const arrow = direction === "up" ? "↑" : "↓";
  return (
    <Text color={theme.textDim}>
      ── {arrow} {count} more ──
    </Text>
  );
}
