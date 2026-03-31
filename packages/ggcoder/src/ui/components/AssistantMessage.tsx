import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { Markdown } from "./Markdown.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { BLACK_CIRCLE } from "../constants/figures.js";

interface AssistantMessageProps {
  text: string;
  thinking?: string;
  thinkingMs?: number;
  showThinking?: boolean;
}

// BLACK_CIRCLE + " " = 2 chars
const PREFIX_WIDTH = 2;

export const AssistantMessage = React.memo(function AssistantMessage({
  text,
  thinking,
  thinkingMs,
  showThinking = true,
}: AssistantMessageProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const contentWidth = Math.max(10, columns - PREFIX_WIDTH);

  return (
    <Box flexDirection="column" marginTop={1}>
      {showThinking && thinking && <ThinkingBlock text={thinking} durationMs={thinkingMs} />}
      {text && (
        <Box flexDirection="row">
          <Box width={PREFIX_WIDTH} flexShrink={0}>
            <Text color={theme.primary}>{BLACK_CIRCLE} </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} width={contentWidth}>
            <Markdown>{text.trimStart()}</Markdown>
          </Box>
        </Box>
      )}
    </Box>
  );
});
