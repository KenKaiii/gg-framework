import React from "react";
import { Box, Text } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { ActivityIndicator } from "./ActivityIndicator.js";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";
import type { useTheme } from "../theme/theme.js";

interface ChatStatusRowProps {
  visible: boolean;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  doneStatus: { verb: string; durationMs: number } | null;
  columns: number;
  theme: ReturnType<typeof useTheme>;
  activityPhase: ActivityPhase;
  elapsedMs: number;
  runStartRef: React.RefObject<number>;
  thinkingMs: number;
  isThinking: boolean;
  thinkingLevel?: ThinkingLevel;
  tokenEstimate: number;
  charCountRef: React.RefObject<number>;
  realTokensAccumRef: React.RefObject<number>;
  userMessage?: string;
  activeToolNames: string[];
  retryInfo?: RetryInfo | null;
  planDone: number;
  planTotal: number;
  renderMarkdown: boolean;
  formatDuration: (durationMs: number) => string;
}

export function ChatStatusRow({
  visible,
  activityVisible,
  stallStatusVisible,
  doneStatus,
  columns,
  theme,
  activityPhase,
  elapsedMs,
  runStartRef,
  thinkingMs,
  isThinking,
  thinkingLevel,
  tokenEstimate,
  charCountRef,
  realTokensAccumRef,
  userMessage,
  activeToolNames,
  retryInfo,
  planDone,
  planTotal,
  renderMarkdown,
  formatDuration,
}: ChatStatusRowProps) {
  return (
    <Box paddingLeft={1} paddingRight={1} width={columns}>
      {visible ? (
        activityVisible ? (
          <ActivityIndicator
            phase={activityPhase}
            elapsedMs={elapsedMs}
            runStartRef={runStartRef}
            thinkingMs={thinkingMs}
            isThinking={isThinking}
            thinkingEnabled={!!thinkingLevel}
            tokenEstimate={tokenEstimate}
            charCountRef={charCountRef}
            realTokensAccumRef={realTokensAccumRef}
            userMessage={userMessage}
            activeToolNames={activeToolNames}
            retryInfo={retryInfo}
            planDone={planDone}
            planTotal={planTotal}
            staticDisplay
          />
        ) : stallStatusVisible ? (
          <Text color={theme.warning} wrap="truncate">
            {
              "⚠ API provider stream interrupted — retries exhausted. Your conversation is preserved."
            }
          </Text>
        ) : doneStatus ? (
          <Text color={theme.success}>
            {"✻ "}
            {doneStatus.verb} {formatDuration(doneStatus.durationMs)}
          </Text>
        ) : (
          <ReadyStatus theme={theme} renderMarkdown={renderMarkdown} />
        )
      ) : (
        <ReadyStatus theme={theme} renderMarkdown />
      )}
    </Box>
  );
}

function ReadyStatus({
  theme,
  renderMarkdown,
}: {
  theme: ReturnType<typeof useTheme>;
  renderMarkdown: boolean;
}) {
  return (
    <Text>
      <Text color={theme.commandColor}>{"⠿ "}</Text>
      <Text color={theme.textDim}>{"Ready to go.."}</Text>
      {!renderMarkdown && <Text color={theme.warning}>{" · raw markdown mode"}</Text>}
    </Text>
  );
}
