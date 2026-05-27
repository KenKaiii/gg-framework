import type { GoalMode } from "../core/runtime-mode.js";
import type { FooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";
import type { CompletedItem } from "./app-items.js";
import {
  isTranscriptSpacingItem,
  shouldTopSpaceAfterPrintedTranscriptBoundary,
  shouldTopSpaceAssistantAfterToolBoundary as shouldTopSpaceAssistantAfterToolBoundaryFromTranscript,
  shouldTopSpaceStreamingAssistant as shouldTopSpaceStreamingAssistantFromTranscript,
} from "./transcript/spacing.js";

export type OverlayPaneKind = "model" | "goal" | "skills" | "plan" | "theme" | "pixel";

export function shouldHideHistoryForOverlayView(
  isOverlayView: boolean,
  _isAgentRunning: boolean,
): boolean {
  // Overlay panes are standalone full-screen states. Finalized chat rows are
  // printed outside Ink, so overlays should never replay transcript UI behind them.
  return isOverlayView;
}

export function shouldStabilizeOverlayPaneRerender({
  overlayPane,
  isAgentRunning,
}: {
  overlayPane: OverlayPaneKind | null;
  isAgentRunning: boolean;
}): boolean {
  return isAgentRunning && overlayPane === "goal";
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
  goalMode,
  goalAutoExpand,
}: {
  planOverlayPending: boolean;
  goalMode: GoalMode;
  goalAutoExpand: boolean;
}): DoneFlushDecision {
  return {
    showDoneStatus: !(
      planOverlayPending ||
      goalMode === "planner" ||
      goalMode === "setup" ||
      goalAutoExpand
    ),
    flushLiveItems: true,
  };
}

export interface GoalSetupPaneTransition {
  overlay: "goal";
  goalAutoExpand: true;
  planAutoExpand: false;
  suppressDoneStatus: true;
}

export function getGoalSetupFinishedPaneTransition(): GoalSetupPaneTransition {
  return {
    overlay: "goal",
    goalAutoExpand: true,
    planAutoExpand: false,
    suppressDoneStatus: true,
  };
}

export function getGoalSetupPaneTransitionAfterRun({
  isGoalSetupCommand,
  setupPanePending,
}: {
  isGoalSetupCommand: boolean;
  setupPanePending: boolean;
}): GoalSetupPaneTransition | null {
  return isGoalSetupCommand && setupPanePending ? getGoalSetupFinishedPaneTransition() : null;
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

export const shouldResetUIForGoalSetupPaneTransition = shouldResetUIForSetupPaneTransition;

export interface GoalActivationPaneTransition {
  overlay: null;
  goalAutoExpand: false;
  planAutoExpand: false;
  resetReviewScreen: boolean;
}

export function getGoalActivationPaneTransition(): GoalActivationPaneTransition {
  return { overlay: null, goalAutoExpand: false, planAutoExpand: false, resetReviewScreen: true };
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

export function nextGoalModeAfterAgentDone({
  currentMode,
  runningGoalIds,
  queuedSyntheticEvents,
  activeContinuationFlights = 0,
  wasGoalSetupTurn,
}: {
  currentMode: GoalMode;
  runningGoalIds: number;
  queuedSyntheticEvents: number;
  activeContinuationFlights?: number;
  wasGoalSetupTurn?: boolean;
}): GoalMode {
  if (wasGoalSetupTurn) return "off";
  if (currentMode === "planner" || currentMode === "setup") return currentMode;
  if (queuedSyntheticEvents > 0) return "coordinator";
  if (activeContinuationFlights > 0) return "coordinator";
  if (currentMode === "coordinator" && runningGoalIds > 0) return "coordinator";
  return "off";
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
const GOAL_STATUS_ROWS = 1;
const COLLAPSED_FOOTER_STATUS_ROWS = 1;
const MAX_EXPANDED_BACKGROUND_TASK_ROWS = 7;

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
  goalStatusEntryCount: number;
  footerFitsOnOneLine: boolean;
}

export interface ChatControlsLayoutDecision {
  controlsRows: number;
  liveAreaRows: number;
}

export function getChatControlsLayoutDecision({
  rows,
  agentRunning,
  activityVisible,
  doneStatusVisible,
  stallStatusVisible,
  exitPending,
  footerStatusLayout,
  taskBarExpanded,
  goalStatusEntryCount,
  footerFitsOnOneLine,
}: ChatControlsLayoutOptions): ChatControlsLayoutDecision {
  const statusRows =
    activityVisible || stallStatusVisible || doneStatusVisible || agentRunning
      ? STATUS_SLOT_ROWS
      : 0;
  const footerRows =
    exitPending || footerFitsOnOneLine ? FOOTER_ONE_LINE_ROWS : FOOTER_TWO_LINE_ROWS;
  const goalRows = !exitPending && goalStatusEntryCount > 0 ? GOAL_STATUS_ROWS : 0;
  const footerStatusRows = footerStatusLayout.stack
    ? Number(footerStatusLayout.hasBackgroundTasks) + Number(footerStatusLayout.hasUpdateNotice)
    : footerStatusLayout.hasBackgroundTasks || footerStatusLayout.hasUpdateNotice
      ? COLLAPSED_FOOTER_STATUS_ROWS
      : 0;
  const expandedTaskRows =
    taskBarExpanded && footerStatusLayout.hasBackgroundTasks
      ? MAX_EXPANDED_BACKGROUND_TASK_ROWS - COLLAPSED_FOOTER_STATUS_ROWS
      : 0;
  const controlsRows =
    statusRows + INPUT_AREA_ROWS + footerRows + goalRows + footerStatusRows + expandedTaskRows;
  const maxControlsRows = Math.max(1, rows - MIN_LIVE_AREA_ROWS);
  const boundedControlsRows = Math.min(controlsRows, maxControlsRows);

  return {
    controlsRows: boundedControlsRows,
    liveAreaRows: Math.max(MIN_LIVE_AREA_ROWS, rows - boundedControlsRows),
  };
}
