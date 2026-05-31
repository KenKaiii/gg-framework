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
  "ideal_hook",
  "queued",
  "task",
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
]);

// NOTE: `assistant→assistant` is intentionally NOT compact. Two consecutive
// assistant items are separate responses (e.g. across tool turns, now that tool
// rows render in the pinned LiveToolPanel instead of the transcript) and need a
// blank-line separator. Continuation paragraphs of a SINGLE streamed response
// are handled earlier via the `continuation` flag, which re-inserts the same
// blank line before reaching this compact check — so paragraph breaks are not
// affected by this exclusion.

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
    // A continuation chunk is the next paragraph of a SINGLE response whose
    // earlier paragraphs were already flushed mid-stream. It always gets the
    // blank line that separated the paragraphs in the original response, even
    // when the text is empty. Mirrors the serializer's `leadingSeparator: true`
    // for continuations. (Separate assistant responses are also separated below
    // via the standard boundary rule, now that assistant→assistant is no longer
    // a compact boundary.)
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
