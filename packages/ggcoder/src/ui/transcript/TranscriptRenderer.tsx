import React from "react";
import type { Provider } from "@kenkaiiii/gg-ai";
import { UserMessage } from "../components/UserMessage.js";
import { AssistantMessage } from "../components/AssistantMessage.js";
import { IdealHookMessage } from "../components/IdealHookMessage.js";
import { CompactionDone, CompactionSpinner } from "../components/CompactionNotice.js";
import { Banner } from "../components/Banner.js";
import type { useTheme } from "../theme/theme.js";
import type { CompletedItem } from "../app-items.js";
import { isPanelReplacedToolItem, lastVisibleTranscriptItem } from "../app-items.js";
import { TranscriptItemFrame } from "./TranscriptItemFrame.js";
import { getTranscriptItemMarginTop } from "./spacing.js";
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
  presentInfo,
  presentModelTransition,
  presentPlanEvent,
  presentStopped,
  presentTask,
  presentThemeTransition,
} from "./presentation.js";
import { StatusRow } from "./StatusRow.js";
import { SessionSummaryDisplay } from "../components/SessionSummary.js";
import { PlanModeLogo } from "../components/PlanModeLogo.js";
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
  columns: _columns,
  theme: _theme,
  renderMarkdown,
  measuredLiveAreaRows,
}: RenderTranscriptItemOptions): React.ReactNode {
  // Skip panel-replaced tool rows (they render null) when looking back for the
  // spacing boundary — otherwise the assistant gets a blank separator above an
  // invisible row, leaving a phantom gap.
  const previousLiveItem = index > 0 ? lastVisibleTranscriptItem(items.slice(0, index)) : undefined;
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
      return withTranscriptSpacing(
        <UserMessage
          key={item.id}
          text={item.text}
          imageCount={item.imageCount}
          pasteInfo={item.pasteInfo}
        />,
      );
    case "style_pack":
      return withTranscriptSpacing(<StylePackRow item={item} />);
    case "setup_hint":
      return withTranscriptSpacing(<SetupHintRow item={item} />);
    case "assistant": {
      // Reserve the rows that render OUTSIDE the markdown body so the whole
      // finalized assistant frame stays within `measuredLiveAreaRows`:
      //   1. the transcript top-spacing margin (`transcriptMarginTop`), and
      //   2. the collapsed thinking header (header line + `marginBottom:1`).
      // Keep THINKING_HEADER_ROWS in sync with ThinkingBlock's collapsed layout.
      const THINKING_HEADER_ROWS = 2;
      const assistantLiveBudget = Math.max(
        1,
        measuredLiveAreaRows - transcriptMarginTop - (item.thinking ? THINKING_HEADER_ROWS : 0),
      );
      return withTranscriptSpacing(
        <AssistantMessage
          key={item.id}
          text={item.text}
          thinking={item.thinking}
          thinkingMs={item.thinkingMs}
          continuation={item.continuation}
          renderMarkdown={renderMarkdown}
          availableTerminalHeight={assistantLiveBudget}
        />,
      );
    }
    case "ideal_hook":
      return withTranscriptSpacing(<IdealHookMessage key={item.id} text={item.text} />);
    case "tool_start":
    case "tool_done":
    case "tool_group":
      // Tool activity now lives in the pinned LiveToolPanel above the activity
      // bar — suppress the in-transcript rows so they aren't shown twice.
      // Image-bearing results (read/screenshot) are the exception: they keep
      // their row so the inline preview still renders. Mirrors the scrollback
      // printer + fullscreen viewport, which use the same predicate.
      if (isPanelReplacedToolItem(item)) return null;
      if (item.kind === "tool_start") return withTranscriptSpacing(<ToolStartRow item={item} />);
      if (item.kind === "tool_done") return withTranscriptSpacing(<ToolDoneRow item={item} />);
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
      if (item.active) return withTranscriptSpacing(<PlanModeLogo key={item.id} />);
      return null;
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
    case "session_summary":
      return withTranscriptSpacing(<SessionSummaryDisplay summary={item.summary} />);
    case "subagent_group":
      return withTranscriptSpacing(<SubAgentGroupRow item={item} />);
  }
}
