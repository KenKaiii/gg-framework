import { useCallback, useEffect, useRef, useState } from "react";
import { type DOMElement } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ContextWindowOptions } from "../../core/model-registry.js";
import { doesFooterFitOnOneLine } from "../components/Footer.js";
import {
  getFooterStatusLayoutDecision,
  type FooterStatusLayoutDecision,
} from "../components/BackgroundTasksBar.js";
import {
  getChatControlsLayoutDecision,
  MIN_LIVE_AREA_ROWS,
  type DoneStatus,
} from "../layout-decisions.js";

interface UseChatLayoutMeasurementsOptions {
  rows: number;
  columns: number;
  backgroundTaskCount: number;
  updatePending: boolean;
  agentRunning: boolean;
  activityPhase: string;
  stallError: unknown;
  doneStatus: DoneStatus | null;
  currentModel: string;
  contextUsed: number;
  contextWindowOptions?: ContextWindowOptions;
  displayedCwd: string;
  gitBranch?: string | null;
  thinkingLevel?: ThinkingLevel;
  exitPending: boolean;
  taskBarExpanded: boolean;
  /** Current LiveToolPanel feed length; the panel renders min(count, 3) rows. */
  liveToolFeedCount: number;
}

interface ChatLayoutMeasurements {
  footerStatusLayout: FooterStatusLayoutDecision;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  doneStatusVisible: boolean;
  statusSlotVisible: boolean;
  mainControlsRef: (node: DOMElement | null) => void;
  measuredLiveAreaRows: number;
  /**
   * Transcript region height for the fullscreen alt-screen viewport. Unlike
   * `measuredLiveAreaRows` (which subtracts a 2-row cushion to keep Ink out of
   * its fullscreen clear path in the legacy scrollback model), the fullscreen
   * viewport intentionally owns the full screen, so this is simply
   * `rows - controlsRows` (floored at MIN_LIVE_AREA_ROWS).
   */
  viewportRows: number;
}

export function useChatLayoutMeasurements({
  rows,
  columns,
  backgroundTaskCount,
  updatePending,
  agentRunning,
  activityPhase,
  stallError,
  doneStatus,
  currentModel,
  contextUsed,
  contextWindowOptions,
  displayedCwd,
  gitBranch,
  thinkingLevel,
  exitPending,
  taskBarExpanded,
  liveToolFeedCount,
}: UseChatLayoutMeasurementsOptions): ChatLayoutMeasurements {
  const footerStatusLayout = getFooterStatusLayoutDecision({
    columns,
    backgroundTaskCount,
    updatePending,
  });
  const activityVisible = agentRunning && activityPhase !== "idle";
  // The pinned LiveToolPanel renders while the activity bar is visible, there is
  // at least one tool in the feed, and the agent is NOT yet streaming its reply.
  // Once the model transitions to "generating", the panel is hidden so the reply
  // area above the activity bar keeps its full breathing height instead of being
  // clamped smaller by the panel's rows. Keep this predicate identical to
  // ChatInputStack's render gate so the budget and the rendered rows never differ.
  const liveToolPanelVisible = activityVisible && activityPhase !== "generating";
  const liveToolPanelRows =
    liveToolPanelVisible && liveToolFeedCount > 0 ? Math.min(liveToolFeedCount, 3) : 0;
  const stallStatusVisible = !activityVisible && !!stallError;
  const doneStatusVisible =
    !activityVisible && !stallStatusVisible && !!doneStatus && !agentRunning;
  const statusSlotVisible = activityVisible || stallStatusVisible || doneStatusVisible;

  const [controlsHeight, setControlsHeight] = useState(0);
  const controlsObserverRef = useRef<ResizeObserver | null>(null);
  const mainControlsRef = useCallback((node: DOMElement | null) => {
    if (controlsObserverRef.current) {
      controlsObserverRef.current.disconnect();
      controlsObserverRef.current = null;
    }
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const roundedHeight = Math.round(entry.contentRect.height);
      setControlsHeight((prev) => (roundedHeight !== prev ? roundedHeight : prev));
    });
    observer.observe(node as unknown as Element);
    controlsObserverRef.current = observer;
  }, []);
  useEffect(() => () => controlsObserverRef.current?.disconnect(), []);

  const footerFitsOnOneLine = doesFooterFitOnOneLine({
    columns,
    model: currentModel,
    tokensIn: contextUsed,
    contextWindowOptions,
    cwd: displayedCwd,
    gitBranch,
    thinkingLevel,
  });
  const chatControlsLayout = getChatControlsLayoutDecision({
    rows,
    columns,
    agentRunning,
    activityVisible,
    doneStatusVisible,
    stallStatusVisible,
    exitPending,
    footerStatusLayout,
    taskBarExpanded,
    footerFitsOnOneLine,
    liveToolPanelRows,
  });
  // Mirror Gemini's stableControlsHeight: while a turn is active, never let the
  // measured controls height shrink (transient ResizeObserver dips would grow the
  // live budget for one frame and bounce the footer). Reset to the live value at
  // idle so legitimate shrink (e.g. background task finished) is picked up.
  const prevControlsHeightRef = useRef(0);
  const measuredControlsRows =
    controlsHeight > 0 ? controlsHeight : chatControlsLayout.controlsRows;
  // While running, take the max of: the carried-forward height, the measured
  // height, and the freshly computed formula (which now includes the live tool
  // panel rows). The formula updates synchronously with the tool feed, so it
  // acts as a proactive floor that shrinks the live area in the SAME render the
  // panel grows — beating the one-frame ResizeObserver lag that otherwise lets
  // the frame overflow the terminal and bounce the footer on each tool step.
  const stableControlsRows = agentRunning
    ? Math.max(prevControlsHeightRef.current, measuredControlsRows, chatControlsLayout.controlsRows)
    : measuredControlsRows;
  prevControlsHeightRef.current = stableControlsRows;
  // Subtract a 2-row cushion (not 1) so the total live frame stays <= rows - 1
  // even with rounding from the ResizeObserver-measured controlsHeight, keeping
  // Ink out of its fullscreen clearTerminal path that snaps the controls upward.
  const measuredLiveAreaRows = Math.max(MIN_LIVE_AREA_ROWS, rows - stableControlsRows - 2);
  const viewportRows = Math.max(MIN_LIVE_AREA_ROWS, rows - stableControlsRows);

  return {
    footerStatusLayout,
    activityVisible,
    stallStatusVisible,
    doneStatusVisible,
    statusSlotVisible,
    mainControlsRef,
    measuredLiveAreaRows,
    viewportRows,
  };
}
