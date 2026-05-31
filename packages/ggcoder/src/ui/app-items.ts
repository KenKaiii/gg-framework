import type { PasteInfo } from "./components/InputArea.js";
import type { SubAgentInfo } from "./components/SubAgentPanel.js";
import type { LanguageId } from "../core/language-detector.js";
import type { SessionSummary } from "./session-summary.js";

/** Decoded image bytes for inline terminal-graphics preview (kitty/iTerm2). */
export interface ImagePreview {
  base64: string;
  mediaType: string;
  /** Absolute path to the on-disk image, rendered as a clickable OSC 8 link. */
  path?: string;
}

export interface UserItem {
  kind: "user";
  text: string;
  imageCount?: number;
  pasteInfo?: PasteInfo;
  /** Inline previews for attached images, rendered after the user row. */
  imagePreviews?: ImagePreview[];
  id: string;
}

export interface TaskItem {
  kind: "task";
  title: string;
  id: string;
}

export interface AssistantItem {
  kind: "assistant";
  text: string;
  thinking?: string;
  thinkingMs?: number;
  continuation?: boolean;
  id: string;
}

export interface ToolStartItem {
  kind: "tool_start";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  id: string;
  startedAt: number;
  animateUntil: number;
  /** Live progress output (e.g., bash streaming stdout). */
  progressOutput?: string;
}

export interface ToolDoneItem {
  kind: "tool_done";
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
  details?: unknown;
  /** Inline previews for image-bearing tool results (read/screenshot). */
  imagePreviews?: ImagePreview[];
  id: string;
}

export interface ErrorItem {
  kind: "error";
  /** Plain-English headline, e.g. "OpenAI returned an error." */
  headline: string;
  /** Detailed message body (clean, no JSON). */
  message: string;
  /** Action line — "Retry, this is an OpenAI issue" / "Report this ggcoder bug …". */
  guidance: string;
  id: string;
}

export interface InfoItem {
  kind: "info";
  text: string;
  id: string;
}

export interface StylePackItem {
  kind: "style_pack";
  /** Newly-added language ids in this injection. Rendered via LANGUAGE_DISPLAY_NAMES. */
  added: readonly LanguageId[];
  /** Show the one-time /setup hint. Only true for the first badge in a session. */
  showSetupHint: boolean;
  id: string;
}

/**
 * Shown once per session when initial language detection finds no packs —
 * keeps `/setup` discoverable in dirs that don't look like a project root
 * (parent folders, scratch dirs, etc.).
 */
export interface SetupHintItem {
  kind: "setup_hint";
  id: string;
}

export const UPDATE_NOTICE_TEXT = "KEN HAS PUSHED A NEW GG CODER UPDATE";

/** Copy shown when the automatic pre-final ideal-review hook engages. */
export const IDEAL_HOOK_NOTICE_TEXT = "Hook engaged — running an ideal review before finalizing.";

/**
 * Rendered like an assistant message (same prefix dot, left padding and
 * spacing) but in a distinct color so it's obvious the ideal-review hook
 * just took over the turn. Pushed when `getIdealReviewMessage` injects the
 * review prompt before the agent's final response.
 */
export interface IdealHookItem {
  kind: "ideal_hook";
  text: string;
  id: string;
}

export interface UpdateNoticeItem {
  kind: "update_notice";
  text: string;
  id: string;
}

export interface QueuedItem {
  kind: "queued";
  text: string;
  imageCount?: number;
  id: string;
}

export interface CompactingItem {
  kind: "compacting";
  id: string;
}

export interface CompactedItem {
  kind: "compacted";
  originalCount: number;
  newCount: number;
  tokensBefore: number;
  tokensAfter: number;
  id: string;
}

export interface DurationItem {
  kind: "duration";
  durationMs: number;
  toolsUsed: string[];
  verb: string;
  id: string;
}

export interface SessionSummaryItem {
  kind: "session_summary";
  summary: SessionSummary;
  id: string;
}

export interface BannerItem {
  kind: "banner";
  id: string;
}

export interface SubAgentGroupItem {
  kind: "subagent_group";
  agents: SubAgentInfo[];
  aborted?: boolean;
  id: string;
}

export interface ServerToolStartItem {
  kind: "server_tool_start";
  serverToolCallId: string;
  name: string;
  input: unknown;
  startedAt: number;
  animateUntil: number;
  id: string;
}

export interface ServerToolDoneItem {
  kind: "server_tool_done";
  name: string;
  input: unknown;
  resultType: string;
  data: unknown;
  durationMs: number;
  id: string;
}

export interface PlanTransitionItem {
  kind: "plan_transition";
  text: string;
  active: boolean;
  id: string;
}

export interface ModelTransitionItem {
  kind: "model_transition";
  modelName: string;
  id: string;
}

export interface ThemeTransitionItem {
  kind: "theme_transition";
  themeName: string;
  id: string;
}

export interface PlanEventItem {
  kind: "plan_event";
  event: "approved" | "rejected" | "dismissed";
  /** Free-form detail (reject feedback, etc.) — quoted in the rendered row. */
  detail?: string;
  id: string;
}

export interface StoppedItem {
  kind: "stopped";
  text: string;
  id: string;
}

export interface TombstoneItem {
  kind: "tombstone";
  id: string;
}

export interface StepDoneItem {
  kind: "step_done";
  stepNum: number;
  description: string;
  id: string;
}

export interface ToolGroupTool {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  animateUntil?: number;
  result?: string;
  isError?: boolean;
}

export interface ToolGroupItem {
  kind: "tool_group";
  tools: ToolGroupTool[];
  id: string;
}

/**
 * Tool-activity item kinds whose transcript rendering is REPLACED by the pinned
 * LiveToolPanel. These items still flow through live/history state (so flush,
 * overflow, and persistence logic is unchanged) but render to nothing in the
 * transcript — the panel above the activity bar is now their sole display.
 *
 * Server tools and sub-agent groups are intentionally excluded: they keep their
 * own richer transcript rows.
 */
const PANEL_REPLACED_TOOL_KINDS = new Set<string>(["tool_start", "tool_done", "tool_group"]);

/**
 * True when an item's transcript row is replaced by the LiveToolPanel.
 *
 * Image-bearing tool results (read/screenshot) are an exception: the inline
 * image is real content the user asked to see, so those items keep rendering
 * in the transcript. Only the text-only activity rows are suppressed.
 */
export function isPanelReplacedToolItem(item: {
  kind: string;
  imagePreviews?: readonly unknown[];
}): boolean {
  if (!PANEL_REPLACED_TOOL_KINDS.has(item.kind)) return false;
  return !(item.imagePreviews && item.imagePreviews.length > 0);
}

/**
 * The last item in a transcript slice that actually renders a row. Panel-replaced
 * tool items (now shown only in the LiveToolPanel) render `null`, so they must be
 * skipped when deriving the "previous item" for spacing decisions — otherwise a
 * tool→assistant boundary inserts a blank separator above an invisible row,
 * leaving a phantom gap above the response.
 */
export function lastVisibleTranscriptItem<
  T extends { kind: string; imagePreviews?: readonly unknown[] },
>(items: readonly T[]): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && !isPanelReplacedToolItem(item)) return item;
  }
  return undefined;
}

export type CompletedItem =
  | UserItem
  | TaskItem
  | AssistantItem
  | IdealHookItem
  | ToolStartItem
  | ToolDoneItem
  | ServerToolStartItem
  | ServerToolDoneItem
  | ErrorItem
  | InfoItem
  | StylePackItem
  | SetupHintItem
  | UpdateNoticeItem
  | QueuedItem
  | CompactingItem
  | CompactedItem
  | DurationItem
  | SessionSummaryItem
  | BannerItem
  | SubAgentGroupItem
  | ToolGroupItem
  | PlanTransitionItem
  | ModelTransitionItem
  | ThemeTransitionItem
  | PlanEventItem
  | StoppedItem
  | TombstoneItem
  | StepDoneItem;
