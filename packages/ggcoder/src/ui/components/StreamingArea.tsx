import React, { memo, useMemo } from "react";
import { Box } from "ink";
import { stripDoneMarkers } from "../../utils/plan-steps.js";
import { AssistantMessage } from "./AssistantMessage.js";

interface StreamingTextPreview {
  text: string;
  isTruncated: boolean;
}

function estimateWrappedLineCount(text: string, width: number): number {
  return text
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / width)), 0);
}

export function getStreamingTextPreview(text: string, width: number): StreamingTextPreview {
  const safeWidth = Math.max(10, width);
  if (estimateWrappedLineCount(text, safeWidth) <= 12) {
    return { text, isTruncated: false };
  }

  return { text: "", isTruncated: true };
}

interface StreamingAreaProps {
  isRunning: boolean;
  streamingText: string;
  streamingThinking: string;
  showThinking?: boolean;
  thinkingMs?: number;
  reserveSpacing?: boolean;
  renderMarkdown?: boolean;
  availableTerminalHeight?: number;
  assistantMarginTop?: number;
  continuation?: boolean;
}

export const StreamingArea = memo(function StreamingArea({
  isRunning,
  streamingText,
  streamingThinking,
  showThinking = false,
  thinkingMs,
  reserveSpacing = false,
  renderMarkdown = true,
  availableTerminalHeight,
  assistantMarginTop = 0,
  continuation = false,
}: StreamingAreaProps) {
  const displayText = useMemo(
    () => (streamingText ? stripDoneMarkers(streamingText) : ""),
    [streamingText],
  );
  const trimmedDisplay = displayText.trim();
  const hasThinking = showThinking && !!streamingThinking;

  if (!trimmedDisplay && !hasThinking) {
    return reserveSpacing ? <Box height={1} /> : null;
  }
  if (!isRunning && !trimmedDisplay) return null;

  return (
    <AssistantMessage
      text={trimmedDisplay}
      thinking={streamingThinking}
      thinkingMs={thinkingMs}
      showThinking={showThinking}
      streaming
      renderMarkdown={renderMarkdown}
      availableTerminalHeight={availableTerminalHeight}
      marginTop={assistantMarginTop}
      continuation={continuation}
    />
  );
});
