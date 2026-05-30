import { useCallback, useEffect, useRef, useState } from "react";
import { type DOMElement } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ContextWindowOptions } from "../../core/model-registry.js";
import type { GoalMode } from "../../core/runtime-mode.js";
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
  goalMode: GoalMode;
  exitPending: boolean;
  taskBarExpanded: boolean;
  goalStatusEntryCount: number;
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
  goalMode,
  exitPending,
  taskBarExpanded,
  goalStatusEntryCount,
}: UseChatLayoutMeasurementsOptions): ChatLayoutMeasurements {
  const footerStatusLayout = getFooterStatusLayoutDecision({
    columns,
    backgroundTaskCount,
    updatePending,
  });
  const activityVisible = agentRunning && activityPhase !== "idle";
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
    goalMode,
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
    goalStatusEntryCount,
    footerFitsOnOneLine,
  });
  const stableControlsRows = controlsHeight > 0 ? controlsHeight : chatControlsLayout.controlsRows;
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
