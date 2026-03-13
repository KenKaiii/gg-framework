import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";

interface ThinkingBlockProps {
  text: string;
  durationMs?: number;
  /** Whether currently streaming (always expanded, no toggle) */
  streaming?: boolean;
  /** Start collapsed (default true for completed, ignored when streaming) */
  defaultCollapsed?: boolean;
}

function formatThinkingDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function ThinkingBlock({
  text,
  durationMs,
  streaming = false,
  defaultCollapsed = true,
}: ThinkingBlockProps) {
  const theme = useTheme();
  const [collapsed, setCollapsed] = useState(!streaming && defaultCollapsed);

  // When streaming finishes (streaming goes from true to false), auto-collapse
  const [wasStreaming, setWasStreaming] = useState(streaming);
  useEffect(() => {
    if (wasStreaming && !streaming) {
      setCollapsed(true);
    }
    setWasStreaming(streaming);
  }, [streaming, wasStreaming]);

  if (!text) return null;

  const durationLabel =
    durationMs != null && durationMs > 0 ? formatThinkingDuration(durationMs) : null;
  const headerText = streaming
    ? durationLabel
      ? `Thinking... (${durationLabel})`
      : "Thinking..."
    : durationLabel
      ? `Thought for ${durationLabel}`
      : "Thought";

  // Never show content while streaming — it causes scroll fighting in the
  // live area because every reveal tick re-renders a growing block.  The full
  // text is available once the block moves to Static history (collapsed).
  const showContent = !streaming && !collapsed;
  const chevron = showContent ? " ▼" : " ▶";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Header line */}
      <Box>
        <Text color={theme.accent}>{"💭 "}</Text>
        <Text color={theme.textMuted} italic>
          {headerText}
        </Text>
        {!streaming && <Text color={theme.textDim}>{chevron}</Text>}
      </Box>

      {/* Thinking content with left border accent */}
      {showContent && (
        <Box
          marginLeft={1}
          borderStyle="single"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          borderLeftColor={streaming ? theme.accent : theme.border}
          paddingLeft={1}
        >
          <Text color={theme.textDim} wrap="wrap">
            {text}
          </Text>
        </Box>
      )}
    </Box>
  );
}
