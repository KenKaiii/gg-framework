import type { CompletedItem } from "../app-items.js";

export interface TranscriptSpacingItem {
  id: string;
  kind: string;
  text?: string;
  tools?: unknown;
  continuation?: boolean;
}

export const TRANSCRIPT_SPACING_KINDS = [
  "user",
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

export const DEFAULT_TRANSCRIPT_SPACING_KINDS = TRANSCRIPT_SPACING_KINDS;

const TRANSCRIPT_SPACING_KIND_SET = new Set<string>(TRANSCRIPT_SPACING_KINDS);

const COMPACT_TRANSCRIPT_BOUNDARIES = new Set<string>([
  "user→assistant",
  "assistant→user",
  "user→queued",
  "assistant→assistant",
]);

export function shouldSeparateTranscriptItems({
  previousKind,
  currentKind,
  spacingKinds,
  compactBoundaries,
}: {
  previousKind?: string;
  currentKind: string;
  spacingKinds?: ReadonlySet<string>;
  compactBoundaries?: ReadonlySet<string>;
}): boolean {
  return shouldSeparateTranscriptItemKinds({
    previousKind,
    currentKind,
    spacingKinds,
    compactBoundaries,
  });
}

export function shouldSeparateTranscriptItemKinds({
  previousKind,
  currentKind,
  spacingKinds = TRANSCRIPT_SPACING_KIND_SET,
  compactBoundaries = COMPACT_TRANSCRIPT_BOUNDARIES,
}: {
  previousKind?: string;
  currentKind: string;
  spacingKinds?: ReadonlySet<string>;
  compactBoundaries?: ReadonlySet<string>;
}): boolean {
  if (previousKind === undefined) return false;
  if (!spacingKinds.has(previousKind) || !spacingKinds.has(currentKind)) return false;
  return !compactBoundaries.has(`${previousKind}→${currentKind}`);
}

export function isTranscriptSpacingKind(kind: string): boolean {
  return TRANSCRIPT_SPACING_KIND_SET.has(kind);
}

export function isTranscriptSpacingItem(item: TranscriptSpacingItem): boolean {
  return isTranscriptSpacingKind(item.kind);
}

export function shouldTopSpaceAfterPrintedTranscriptBoundary({
  currentKind,
  previousLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
  spacingKinds,
  compactBoundaries,
}: {
  currentKind: string;
  previousLiveItem?: TranscriptSpacingItem;
  lastPendingHistoryItem?: TranscriptSpacingItem;
  lastHistoryItem?: TranscriptSpacingItem;
  spacingKinds?: ReadonlySet<string>;
  compactBoundaries?: ReadonlySet<string>;
}): boolean {
  if (previousLiveItem !== undefined) return false;
  const previousKind = lastPendingHistoryItem?.kind ?? lastHistoryItem?.kind;
  return shouldSeparateTranscriptItems({
    previousKind,
    currentKind,
    spacingKinds,
    compactBoundaries,
  });
}

export function shouldTopSpaceAssistantAfterToolBoundary({
  text,
  previousLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
  spacingKinds,
  compactBoundaries,
}: {
  text: string;
  previousLiveItem?: TranscriptSpacingItem;
  lastPendingHistoryItem?: TranscriptSpacingItem;
  lastHistoryItem?: TranscriptSpacingItem;
  spacingKinds?: ReadonlySet<string>;
  compactBoundaries?: ReadonlySet<string>;
}): boolean {
  if (text.trim().length === 0) return false;
  const previousKind =
    previousLiveItem?.kind ?? lastPendingHistoryItem?.kind ?? lastHistoryItem?.kind;
  return shouldSeparateTranscriptItems({
    previousKind,
    currentKind: "assistant",
    spacingKinds,
    compactBoundaries,
  });
}

export function getTranscriptItemMarginTop({
  item,
  previousLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
  spacingKinds,
  compactBoundaries,
}: {
  item: TranscriptSpacingItem;
  previousLiveItem?: TranscriptSpacingItem;
  lastPendingHistoryItem?: TranscriptSpacingItem;
  lastHistoryItem?: TranscriptSpacingItem;
  spacingKinds?: ReadonlySet<string>;
  compactBoundaries?: ReadonlySet<string>;
}): number {
  const previousKind =
    previousLiveItem?.kind ?? lastPendingHistoryItem?.kind ?? lastHistoryItem?.kind;
  if (item.kind === "assistant") {
    // A continuation chunk is the next paragraph of a response whose earlier
    // paragraphs were already flushed mid-stream. assistant→assistant is
    // otherwise compact (0 margin), but the paragraphs were separated by a
    // blank line in the original response, so re-insert it. Mirrors the
    // fullscreen serializer's `leadingSeparator: true` for continuations.
    if (item.continuation === true && previousKind === "assistant") return 1;
    return shouldTopSpaceAssistantAfterToolBoundary({
      text: typeof item.text === "string" ? item.text : "",
      previousLiveItem,
      lastPendingHistoryItem,
      lastHistoryItem,
      spacingKinds,
      compactBoundaries,
    })
      ? 1
      : 0;
  }
  if (item.kind === "plan_transition") return 0;
  return shouldSeparateTranscriptItems({
    previousKind,
    currentKind: item.kind,
    spacingKinds,
    compactBoundaries,
  })
    ? 1
    : 0;
}

export function shouldTopSpaceStreamingAssistant({
  visibleStreamingText,
  lastLiveItem,
  lastPendingHistoryItem,
  lastHistoryItem,
  spacingKinds,
  compactBoundaries,
}: {
  visibleStreamingText: string;
  lastLiveItem?: TranscriptSpacingItem;
  lastPendingHistoryItem?: TranscriptSpacingItem;
  lastHistoryItem?: TranscriptSpacingItem;
  spacingKinds?: ReadonlySet<string>;
  compactBoundaries?: ReadonlySet<string>;
}): boolean {
  return shouldTopSpaceAssistantAfterToolBoundary({
    text: visibleStreamingText,
    previousLiveItem: lastLiveItem,
    lastPendingHistoryItem,
    lastHistoryItem,
    spacingKinds,
    compactBoundaries,
  });
}
