import type { PasteInfo } from "./components/InputArea.js";
import type { SubAgentInfo } from "./components/SubAgentPanel.js";
import type { GoalSummaryRow, GoalSummarySection } from "./goal-summary.js";
import type { LanguageId } from "../core/language-detector.js";
import type { SessionSummary } from "./session-summary.js";

export interface UserItem {
  kind: "user";
  text: string;
  imageCount?: number;
  pasteInfo?: PasteInfo;
  id: string;
}

export interface GoalItem {
  kind: "goal";
  title: string;
  workerId?: string;
  id: string;
}

export interface TaskItem {
  kind: "task";
  title: string;
  id: string;
}

export interface GoalProgressItem {
  kind: "goal_progress";
  phase:
    | "worker_started"
    | "worker_finished"
    | "orchestrator_reviewing"
    | "orchestrator_working"
    | "continuing"
    | "verifier_started"
    | "verifier_finished"
    | "terminal";
  title: string;
  detail?: string;
  summaryRows?: GoalSummaryRow[];
  summarySections?: GoalSummarySection[];
  workerId?: string;
  status?: string;
  id: string;
}

export type GoalProgressDraft = Omit<GoalProgressItem, "id">;

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

export interface GoalAgentTransitionItem {
  kind: "goal_agent_transition";
  text: string;
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

export type CompletedItem =
  | UserItem
  | GoalItem
  | TaskItem
  | GoalProgressItem
  | AssistantItem
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
  | GoalAgentTransitionItem
  | ModelTransitionItem
  | ThemeTransitionItem
  | PlanEventItem
  | StoppedItem
  | TombstoneItem
  | StepDoneItem;
