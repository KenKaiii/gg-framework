import type { CompletedItem } from "../app-items.js";

export const TRANSCRIPT_SPACING_KINDS = [
  "assistant",
  "queued",
  "task",
  "goal",
  "goal_progress",
  "tool_start",
  "tool_done",
  "tool_group",
  "server_tool_start",
  "server_tool_done",
  "subagent_group",
  "info",
  "error",
  "stopped",
  "plan_transition",
  "goal_agent_transition",
  "model_transition",
  "theme_transition",
  "plan_event",
  "update_notice",
  "compacting",
  "compacted",
  "duration",
  "step_done",
  "style_pack",
  "setup_hint",
] as const satisfies readonly CompletedItem["kind"][];

const TRANSCRIPT_SPACING_KIND_SET = new Set<CompletedItem["kind"]>(TRANSCRIPT_SPACING_KINDS);

const LIVE_ASSISTANT_BOUNDARY_KINDS = new Set<CompletedItem["kind"]>([
  "goal_progress",
  "tool_start",
  "tool_done",
  "tool_group",
  "server_tool_start",
  "server_tool_done",
  "subagent_group",
  "plan_transition",
  "goal_agent_transition",
]);

export function isTranscriptSpacingKind(kind: CompletedItem["kind"]): boolean {
  return TRANSCRIPT_SPACING_KIND_SET.has(kind);
}

export function isTranscriptSpacingItem(item: CompletedItem): boolean {
  return isTranscriptSpacingKind(item.kind);
}

export function shouldTopSpaceAfterPrintedTranscriptBoundary({
  currentKind,
  previousLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
}: {
  currentKind: CompletedItem["kind"];
  previousLiveItem?: CompletedItem;
  lastPendingHistoryItem?: CompletedItem;
  lastHistoryItem?: CompletedItem;
}): boolean {
  if (!isTranscriptSpacingKind(currentKind)) return false;
  if (previousLiveItem !== undefined) return false;
  const previousKind = lastPendingHistoryItem?.kind ?? lastHistoryItem?.kind;
  return previousKind !== undefined && isTranscriptSpacingKind(previousKind);
}

export function shouldTopSpaceAssistantAfterToolBoundary({
  text,
  previousLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
}: {
  text: string;
  previousLiveItem?: CompletedItem;
  lastPendingHistoryItem?: CompletedItem;
  lastHistoryItem?: CompletedItem;
}): boolean {
  if (text.trim().length === 0) return false;
  if (
    shouldTopSpaceAfterPrintedTranscriptBoundary({
      currentKind: "assistant",
      previousLiveItem,
      lastPendingHistoryItem,
      lastHistoryItem,
    })
  ) {
    return true;
  }
  const previousKind = previousLiveItem?.kind;
  return previousKind !== undefined && LIVE_ASSISTANT_BOUNDARY_KINDS.has(previousKind);
}

export function getTranscriptItemMarginTop({
  item,
  previousLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
}: {
  item: CompletedItem;
  previousLiveItem?: CompletedItem;
  lastPendingHistoryItem?: CompletedItem;
  lastHistoryItem?: CompletedItem;
}): number {
  if (item.kind === "assistant") {
    return shouldTopSpaceAssistantAfterToolBoundary({
      text: item.text,
      previousLiveItem,
      lastPendingHistoryItem,
      lastHistoryItem,
    })
      ? 1
      : 0;
  }
  return isTranscriptSpacingItem(item) ? 1 : 0;
}

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
  return shouldTopSpaceAssistantAfterToolBoundary({
    text: visibleStreamingText,
    previousLiveItem: lastLiveItem,
    lastPendingHistoryItem,
    lastHistoryItem,
  });
}
