import type { FooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";
import type { CompletedItem } from "./app-items.js";
import {
  isTranscriptSpacingItem,
  shouldTopSpaceAfterPrintedTranscriptBoundary,
  shouldTopSpaceAssistantAfterToolBoundary as shouldTopSpaceAssistantAfterToolBoundaryFromTranscript,
  shouldTopSpaceStreamingAssistant as shouldTopSpaceStreamingAssistantFromTranscript,
} from "./transcript/spacing.js";

export type OverlayPaneKind = "model" | "skills" | "plan" | "theme" | "pixel";

export function shouldHideHistoryForOverlayView(
  isOverlayView: boolean,
  _isAgentRunning: boolean,
): boolean {
  // Overlay panes are standalone full-screen states. Finalized chat rows are
  // printed outside Ink, so overlays should never replay transcript UI behind them.
  return isOverlayView;
}

export function shouldStabilizeOverlayPaneRerender({
  overlayPane: _overlayPane,
  isAgentRunning: _isAgentRunning,
}: {
  overlayPane: OverlayPaneKind | null;
  isAgentRunning: boolean;
}): boolean {
  return false;
}

export function shouldHideStaticItemsForOverlayView({
  shouldHideHistoryForOverlay,
  stabilizeOverlayPaneRerender: _stabilizeOverlayPaneRerender,
}: {
  shouldHideHistoryForOverlay: boolean;
  stabilizeOverlayPaneRerender: boolean;
}): boolean {
  return shouldHideHistoryForOverlay;
}

export interface DoneFlushDecision {
  showDoneStatus: boolean;
  flushLiveItems: boolean;
}

export function getDoneFlushDecision({
  planOverlayPending,
}: {
  planOverlayPending: boolean;
}): DoneFlushDecision {
  return {
    showDoneStatus: !planOverlayPending,
    flushLiveItems: true,
  };
}

export function shouldResetUIForSetupPaneTransition({
  hasResetUI,
  hasSessionStore,
}: {
  hasResetUI: boolean;
  hasSessionStore: boolean;
}): boolean {
  // Opening a review pane is a full-screen state transition. A bare React state
  // flip hides history in the virtual tree, but it does not reset Ink/log-update's
  // already-written terminal frame, so the pane can render below prior chat.
  return hasResetUI && hasSessionStore;
}

export interface ScrollStabilizationDecision {
  /** Legacy signal for tests that modeled Static replay avoidance. */
  preserveStatic: boolean;
  /** New output should still appear normally when the user is at the bottom. */
  autoFollow: boolean;
}

export interface DoneStatus {
  durationMs: number;
  toolsUsed: string[];
  verb: string;
}

export function getScrollStabilizationDecision({
  isUserScrolled,
  hasNewOutput,
  hasTallLiveUserMessage = false,
  hasParagraphBreakLiveUserMessage = false,
}: {
  isUserScrolled: boolean;
  hasNewOutput: boolean;
  hasTallLiveUserMessage?: boolean;
  hasParagraphBreakLiveUserMessage?: boolean;
}): ScrollStabilizationDecision {
  const shouldPreserveStatic =
    isUserScrolled || hasTallLiveUserMessage || hasParagraphBreakLiveUserMessage;
  const shouldAutoFollow = !(isUserScrolled || hasTallLiveUserMessage);
  return {
    preserveStatic: shouldPreserveStatic && hasNewOutput,
    autoFollow: shouldAutoFollow,
  };
}

export function hasParagraphBreakLiveUserMessage(text: string): boolean {
  return /\n[ \t]*\n/.test(text);
}

export function isTallLiveUserMessage(text: string, rows: number): boolean {
  return text.split("\n").length > Math.max(8, Math.floor(rows * 0.6));
}

export function getStaticHistoryKey({ resizeKey }: { resizeKey: number }): string {
  return `${resizeKey}`;
}

export const MIN_LIVE_AREA_ROWS = 3;
const INPUT_AREA_ROWS = 3;
const STATUS_SLOT_ROWS = 2;
const FOOTER_ONE_LINE_ROWS = 1;
const FOOTER_TWO_LINE_ROWS = 2;
const COLLAPSED_FOOTER_STATUS_ROWS = 1;
const MAX_EXPANDED_BACKGROUND_TASK_ROWS = 7;
/** Rolling window the LiveToolPanel renders at most (see LIVE_TOOL_PANEL_ROWS). */
const MAX_LIVE_TOOL_PANEL_ROWS = 3;

export function isAgentSpacingItem(item: CompletedItem): boolean {
  return isTranscriptSpacingItem(item);
}

export const shouldTopSpaceAfterPrintedAgentBoundary = shouldTopSpaceAfterPrintedTranscriptBoundary;
export const shouldTopSpaceAssistantAfterToolBoundary =
  shouldTopSpaceAssistantAfterToolBoundaryFromTranscript;

export function shouldTopSpaceStreamingAssistant({
  visibleStreamingText,
  lastLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
}: {
  visibleStreamingText: string;
  lastLiveItem?: CompletedItem;
  lastPendingHistoryItem?: CompletedItem;
  lastHistoryItem?: CompletedItem;
}): boolean {
  return shouldTopSpaceStreamingAssistantFromTranscript({
    visibleStreamingText,
    lastLiveItem,
    lastPendingHistoryItem,
    lastHistoryItem,
  });
}

export interface ChatControlsLayoutOptions {
  rows: number;
  columns: number;
  agentRunning: boolean;
  activityVisible: boolean;
  doneStatusVisible: boolean;
  stallStatusVisible: boolean;
  exitPending: boolean;
  footerStatusLayout: FooterStatusLayoutDecision;
  taskBarExpanded: boolean;
  footerFitsOnOneLine: boolean;
  /**
   * Rows the pinned LiveToolPanel currently occupies inside the controls block
   * (0 when hidden). Folding this into the budget makes the live area shrink in
   * the SAME render the tool feed grows, so the panel growing row-by-row never
   * transiently overflows the terminal and bounces the footer.
   */
  liveToolPanelRows: number;
}

export interface ChatControlsLayoutDecision {
  controlsRows: number;
  liveAreaRows: number;
}

export function getChatControlsLayoutDecision({
  rows,
  exitPending,
  footerStatusLayout,
  taskBarExpanded,
  footerFitsOnOneLine,
  liveToolPanelRows,
}: ChatControlsLayoutOptions): ChatControlsLayoutDecision {
  // The status slot is always reserved so the controls block height is identical
  // idle vs running. Idle it renders ReadyStatus ("Ready to go.."); running it
  // renders the activity bar / done status. Keeping it constant means starting or
  // stopping a turn never changes controlsRows — so the live-area budget and the
  // footer row stay put (matches Gemini's constant composer height).
  const statusRows = STATUS_SLOT_ROWS;
  const footerRows =
    exitPending || footerFitsOnOneLine ? FOOTER_ONE_LINE_ROWS : FOOTER_TWO_LINE_ROWS;
  const footerStatusRows = footerStatusLayout.stack
    ? Number(footerStatusLayout.hasBackgroundTasks) + Number(footerStatusLayout.hasUpdateNotice)
    : footerStatusLayout.hasBackgroundTasks || footerStatusLayout.hasUpdateNotice
      ? COLLAPSED_FOOTER_STATUS_ROWS
      : 0;
  const expandedTaskRows =
    taskBarExpanded && footerStatusLayout.hasBackgroundTasks
      ? MAX_EXPANDED_BACKGROUND_TASK_ROWS - COLLAPSED_FOOTER_STATUS_ROWS
      : 0;
  const toolPanelRows = Math.max(0, Math.min(liveToolPanelRows, MAX_LIVE_TOOL_PANEL_ROWS));
  const controlsRows =
    statusRows + INPUT_AREA_ROWS + footerRows + footerStatusRows + expandedTaskRows + toolPanelRows;
  const maxControlsRows = Math.max(1, rows - MIN_LIVE_AREA_ROWS);
  const boundedControlsRows = Math.min(controlsRows, maxControlsRows);

  return {
    controlsRows: boundedControlsRows,
    liveAreaRows: Math.max(MIN_LIVE_AREA_ROWS, rows - boundedControlsRows),
  };
}
