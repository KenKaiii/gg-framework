import React from "react";
import { Box } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";
import type { useTheme } from "../theme/theme.js";
import { ChatInputFooterStack } from "./ChatLayout.js";
import { ChatStatusRow } from "./ChatStatusRow.js";

interface ChatInputStackProps {
  columns: number;
  theme: ReturnType<typeof useTheme>;
  statusSlotVisible: boolean;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  doneStatus: { verb: string; durationMs: number } | null;
  activityPhase: ActivityPhase;
  elapsedMs: number;
  runStartRef: React.RefObject<number>;
  thinkingMs: number;
  isThinking: boolean;
  thinkingLevel?: ThinkingLevel;
  tokenEstimate: number;
  charCountRef: React.RefObject<number>;
  realTokensAccumRef: React.RefObject<number>;
  lastUserMessage?: string;
  activeToolNames: string[];
  retryInfo?: RetryInfo | null;
  planDone: number;
  planTotal: number;
  renderMarkdown: boolean;
  formatDuration: (durationMs: number) => string;
}

export function ChatInputStack({
  columns,
  theme,
  statusSlotVisible,
  activityVisible,
  stallStatusVisible,
  doneStatus,
  activityPhase,
  elapsedMs,
  runStartRef,
  thinkingMs,
  isThinking,
  thinkingLevel,
  tokenEstimate,
  charCountRef,
  realTokensAccumRef,
  lastUserMessage,
  activeToolNames,
  retryInfo,
  planDone,
  planTotal,
  renderMarkdown,
  formatDuration,
}: ChatInputStackProps) {
  return (
    <ChatInputFooterStack columns={columns}>
      <Box
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.textDim}
        width={columns}
        height={0}
      />
      <ChatStatusRow
        visible={statusSlotVisible}
        activityVisible={activityVisible}
        stallStatusVisible={stallStatusVisible}
        doneStatus={doneStatus}
        columns={columns}
        theme={theme}
        activityPhase={activityPhase}
        elapsedMs={elapsedMs}
        runStartRef={runStartRef}
        thinkingMs={thinkingMs}
        isThinking={isThinking}
        thinkingLevel={thinkingLevel}
        tokenEstimate={tokenEstimate}
        charCountRef={charCountRef}
        realTokensAccumRef={realTokensAccumRef}
        userMessage={lastUserMessage}
        activeToolNames={activeToolNames}
        retryInfo={retryInfo}
        planDone={planDone}
        planTotal={planTotal}
        renderMarkdown={renderMarkdown}
        formatDuration={formatDuration}
      />
    </ChatInputFooterStack>
  );
}
