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
  videoCount?: number;
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
  /** Action line — "Retry, this is an OpenAI issue" / "Report this GG Coder bug …". */
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

/** Copy shown when the loop-breaker hook fires because the agent looks stuck. */
export const LOOP_BREAK_NOTICE_TEXT =
  "Hook engaged — breaking a stuck loop and rethinking the approach.";

/** Copy shown when the post-compaction re-grounding hook re-pins the request. */
export const REGROUNDING_NOTICE_TEXT =
  "Hook engaged — re-grounding on the original request after compaction.";

/** Copy shown when a turn hit the model's output-token limit and the loop
 *  injected a continuation to resume the clipped output. */
export const TRUNCATED_CONTINUING_NOTICE_TEXT =
  "Output hit the model's output-token limit — continuing where it stopped.";

/** Copy shown when a run ended on a non-clean stop and could not continue —
 *  the response may be incomplete. */
export const TRUNCATED_INCOMPLETE_NOTICE_TEXT =
  "Output hit the model's output-token limit — the response may be incomplete.";

/** Copy shown when the provider ended the turn with a refusal stop. */
export const TRUNCATED_REFUSAL_NOTICE_TEXT =
  "The model refused to continue — the response may be incomplete.";

/** Copy shown when the provider reported an error stop mid-response. */
export const TRUNCATED_PROVIDER_ERROR_NOTICE_TEXT =
  "The provider reported an error mid-response — the response may be incomplete.";

/**
 * Semantic tone for an agent-hook notice. Each maps to a theme color so the
 * three hooks read distinctly: a reflective review, a corrective break, and
 * an informational re-orientation.
 *  - "review"  → secondary (ideal review, a quality pass)
 *  - "warning" → warning   (loop-breaker, the agent was stuck)
 *  - "info"    → primary   (re-grounding after compaction)
 */
export type HookTone = "review" | "warning" | "info";

/** Theme color key for each hook tone. Shared by every render path (live Ink,
 *  Static scrollback, transcript) so colors stay consistent. */
export const HOOK_TONE_COLOR: Record<HookTone, "secondary" | "warning" | "primary"> = {
  review: "secondary",
  warning: "warning",
  info: "primary",
};

/**
 * Rendered like an assistant message (same prefix dot, left padding and
 * spacing) but in a tone-specific color so it's obvious which hook just took
 * over the turn. Pushed when an agent hook injects a message into the loop.
 */
export interface IdealHookItem {
  kind: "ideal_hook";
  text: string;
  /** Defaults to "review" when omitted. */
  tone?: HookTone;
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
  videoCount?: number;
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
 * Client tools (tool_*) and server tools (server_tool_*, e.g. Anthropic's
 * native web_search) both feed the panel so search/fetch looks identical across
 * providers. Sub-agent groups are intentionally excluded: their multi-line tree
 * carries nested activity the single-row panel can't represent, so they keep
 * their own richer transcript row.
 */
const PANEL_REPLACED_TOOL_KINDS = new Set<string>([
  "tool_start",
  "tool_done",
  "tool_group",
  "server_tool_start",
  "server_tool_done",
]);

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

/**
 * True when a transcript item carries one or more inline-image previews.
 *
 * Used to detect images in a transcript region before the bottom-anchor shrink
 * backfill tries to reconstruct it as text. A graphics escape's base64 payload
 * is not recognized as zero-width by `wrapAnsi` (it hard-wraps into literal
 * base64 text) and its visual row count never matches its newline count, so a
 * text-only repaint of an image region desyncs Ink's erase math and displaces
 * the on-screen image. Callers bail out of the text repaint when this is true.
 */
export function itemHasImagePreviews(item: {
  kind: string;
  imagePreviews?: readonly unknown[];
}): boolean {
  return !!(item.imagePreviews && item.imagePreviews.length > 0);
}
