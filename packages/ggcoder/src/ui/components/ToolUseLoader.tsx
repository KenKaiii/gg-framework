import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { useBlink } from "../hooks/useBlink.js";
import { BLACK_CIRCLE } from "../constants/figures.js";

interface Props {
  status: "running" | "done" | "error" | "queued";
}

/**
 * Status dot indicator for tool executions.
 *
 * Matches claude-code's ToolUseLoader:
 * - running: blinking dot (dimColor, primary)
 * - done:    solid green dot
 * - error:   solid red dot
 * - queued:  solid dim dot
 *
 * All running instances blink in sync via the shared animation clock.
 * Fixed `minWidth={2}` ensures alignment when the dot blinks off.
 */
export function ToolUseLoader({ status }: Props): React.ReactNode {
  const theme = useTheme();
  const isVisible = useBlink(status === "running");

  let color: string;
  let dimColor = false;

  switch (status) {
    case "running":
      color = theme.primary;
      dimColor = true;
      break;
    case "done":
      color = theme.success;
      break;
    case "error":
      color = theme.error;
      break;
    case "queued":
      color = theme.textDim;
      dimColor = true;
      break;
  }

  return (
    <Box minWidth={2} flexShrink={0}>
      <Text color={color} dimColor={dimColor}>
        {isVisible ? BLACK_CIRCLE : " "}{" "}
      </Text>
    </Box>
  );
}
