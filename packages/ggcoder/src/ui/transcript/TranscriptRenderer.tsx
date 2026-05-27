import React from "react";
import type { Provider } from "@kenkaiiii/gg-ai";
import { UserMessage } from "../components/UserMessage.js";
import { AssistantMessage } from "../components/AssistantMessage.js";
import { CompactionDone, CompactionSpinner } from "../components/CompactionNotice.js";
import { Banner } from "../components/Banner.js";
import type { useTheme } from "../theme/theme.js";
import type { CompletedItem } from "../app-items.js";
import { TranscriptItemFrame } from "./TranscriptItemFrame.js";
import { getTranscriptItemMarginTop } from "./spacing.js";
import { GoalProgressRow, GoalRow } from "./GoalRows.js";
import {
  DurationRow,
  ErrorRow,
  QueuedRow,
  SetupHintRow,
  StepDoneRow,
  StylePackRow,
  UpdateNoticeRow,
} from "./MiscRows.js";
import {
  presentGoalAgentTransition,
  presentInfo,
  presentModelTransition,
  presentPlanEvent,
  presentPlanTransition,
  presentStopped,
  presentTask,
  presentThemeTransition,
} from "./presentation.js";
import { StatusRow } from "./StatusRow.js";
import {
  ServerToolDoneRow,
  ServerToolStartRow,
  SubAgentGroupRow,
  ToolDoneRow,
  ToolGroupRow,
  ToolStartRow,
} from "./ToolRows.js";

interface RenderTranscriptItemOptions {
  item: CompletedItem;
  index: number;
  items: CompletedItem[];
  pendingHistoryFlushLastItem?: CompletedItem;
  historyLastItem?: CompletedItem;
  version: string;
  currentModel: string;
  currentProvider: Provider;
  displayedCwd: string;
  columns: number;
  theme: ReturnType<typeof useTheme>;
  renderMarkdown: boolean;
  measuredLiveAreaRows: number;
}

export function renderTranscriptItem({
  item,
  index,
  items,
  pendingHistoryFlushLastItem,
  historyLastItem,
  version,
  currentModel,
  currentProvider,
  displayedCwd,
  columns,
  theme: _theme,
  renderMarkdown,
  measuredLiveAreaRows,
}: RenderTranscriptItemOptions): React.ReactNode {
  const previousLiveItem = index > 0 ? items[index - 1] : undefined;
  const transcriptMarginTop = getTranscriptItemMarginTop({
    item,
    previousLiveItem,
    lastPendingHistoryItem: pendingHistoryFlushLastItem,
    lastHistoryItem: historyLastItem,
  });
  const withTranscriptSpacing = (node: React.ReactNode): React.ReactNode => (
    <TranscriptItemFrame key={`${item.id}-transcript-frame`} marginTop={transcriptMarginTop}>
      {node}
    </TranscriptItemFrame>
  );

  switch (item.kind) {
    case "tombstone":
      return null;
    case "banner":
      return (
        <Banner
          key={item.id}
          version={version}
          model={currentModel}
          provider={currentProvider}
          cwd={displayedCwd}
        />
      );
    case "user":
      return (
        <UserMessage
          key={item.id}
          text={item.text}
          imageCount={item.imageCount}
          pasteInfo={item.pasteInfo}
        />
      );
    case "goal":
      return withTranscriptSpacing(<GoalRow item={item} columns={columns} />);
    case "goal_progress":
      return withTranscriptSpacing(<GoalProgressRow item={item} columns={columns} />);
    case "style_pack":
      return withTranscriptSpacing(<StylePackRow item={item} />);
    case "setup_hint":
      return withTranscriptSpacing(<SetupHintRow item={item} />);
    case "assistant":
      return withTranscriptSpacing(
        <AssistantMessage
          key={item.id}
          text={item.text}
          thinking={item.thinking}
          thinkingMs={item.thinkingMs}
          renderMarkdown={renderMarkdown}
          availableTerminalHeight={measuredLiveAreaRows}
        />,
      );
    case "tool_start":
      return withTranscriptSpacing(<ToolStartRow item={item} />);
    case "tool_done":
      return withTranscriptSpacing(<ToolDoneRow item={item} />);
    case "tool_group":
      return withTranscriptSpacing(<ToolGroupRow item={item} />);
    case "server_tool_start":
      return withTranscriptSpacing(<ServerToolStartRow item={item} />);
    case "server_tool_done":
      return withTranscriptSpacing(<ServerToolDoneRow item={item} />);
    case "error":
      return withTranscriptSpacing(<ErrorRow item={item} />);
    case "info":
      return withTranscriptSpacing(<StatusRow id={item.id} presentation={presentInfo(item)} />);
    case "update_notice":
      return withTranscriptSpacing(<UpdateNoticeRow item={item} />);
    case "plan_transition":
      return withTranscriptSpacing(
        <StatusRow id={item.id} presentation={presentPlanTransition(item)} />,
      );
    case "goal_agent_transition":
      return withTranscriptSpacing(
        <StatusRow id={item.id} presentation={presentGoalAgentTransition(item)} />,
      );
    case "task":
      return withTranscriptSpacing(<StatusRow id={item.id} presentation={presentTask(item)} />);
    case "model_transition":
      return withTranscriptSpacing(
        <StatusRow id={item.id} presentation={presentModelTransition(item)} />,
      );
    case "theme_transition":
      return withTranscriptSpacing(
        <StatusRow id={item.id} presentation={presentThemeTransition(item)} />,
      );
    case "plan_event":
      return withTranscriptSpacing(
        <StatusRow id={item.id} presentation={presentPlanEvent(item)} />,
      );
    case "stopped":
      return withTranscriptSpacing(<StatusRow id={item.id} presentation={presentStopped(item)} />);
    case "step_done":
      return withTranscriptSpacing(<StepDoneRow item={item} />);
    case "queued":
      return withTranscriptSpacing(<QueuedRow item={item} />);
    case "compacting":
      return withTranscriptSpacing(<CompactionSpinner key={item.id} staticDisplay />);
    case "compacted":
      return withTranscriptSpacing(
        <CompactionDone
          key={item.id}
          originalCount={item.originalCount}
          newCount={item.newCount}
          tokensBefore={item.tokensBefore}
          tokensAfter={item.tokensAfter}
        />,
      );
    case "duration":
      return withTranscriptSpacing(<DurationRow item={item} />);
    case "subagent_group":
      return withTranscriptSpacing(<SubAgentGroupRow item={item} />);
  }
}
