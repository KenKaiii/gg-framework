import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, Text, Static } from "ink";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { useDoublePress } from "./hooks/useDoublePress.js";
import {
  useTaskBarStore,
  useTaskBarPolling,
  focusTaskBar,
  exitTaskBar,
  expandTaskBar,
  collapseTaskBar,
  navigateTaskBar,
  killTask,
} from "./stores/taskbar-store.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { playNotificationSound } from "../utils/sound.js";
import {
  formatError,
  type Message,
  type Provider,
  type ThinkingLevel,
  type TextContent,
  type ImageContent,
} from "@kenkaiiii/gg-ai";
import { extractImagePaths, type ImageAttachment } from "../utils/image.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { useAgentLoop, type UserContent } from "./hooks/useAgentLoop.js";
import { isEyesActive, journalCount } from "@kenkaiiii/ggcoder-eyes";
import { UserMessage } from "./components/UserMessage.js";
import type { PasteInfo } from "./components/InputArea.js";
import { AssistantMessage } from "./components/AssistantMessage.js";
import { ToolExecution } from "./components/ToolExecution.js";
import { ToolGroupExecution } from "./components/ToolGroupExecution.js";
import { ServerToolExecution } from "./components/ServerToolExecution.js";
import { SubAgentPanel, type SubAgentInfo } from "./components/SubAgentPanel.js";
import { CompactionSpinner, CompactionDone } from "./components/CompactionNotice.js";
import type { SubAgentUpdate, SubAgentDetails } from "../tools/subagent.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { StreamingArea } from "./components/StreamingArea.js";
import { ActivityIndicator } from "./components/ActivityIndicator.js";
import { InputArea } from "./components/InputArea.js";
import { Footer } from "./components/Footer.js";
import {
  GoalStatusBar,
  reconcileGoalStatusEntriesWithRuns,
  removeGoalStatusEntry,
  syncGoalStatusEntries,
  type GoalStatusEntry,
} from "./components/GoalStatusBar.js";
import { Banner } from "./components/Banner.js";
import { PlanOverlay } from "./components/PlanOverlay.js";
import { ModelSelector } from "./components/ModelSelector.js";
import { TaskOverlay } from "./components/TaskOverlay.js";
import { GoalOverlay } from "./components/GoalOverlay.js";
import { PixelOverlay } from "./components/PixelOverlay.js";
import type { PreparedPixelFix } from "../core/pixel-fix.js";
import { SkillsOverlay } from "./components/SkillsOverlay.js";
import { EyesOverlay } from "./components/EyesOverlay.js";
import { ThemeSelector } from "./components/ThemeSelector.js";
import {
  BackgroundTasksBar,
  getFooterStatusLayoutDecision,
} from "./components/BackgroundTasksBar.js";
import type { SlashCommandInfo } from "./components/SlashCommandMenu.js";
import type { ProcessManager } from "../core/process-manager.js";
import { useTheme, useSetTheme, type ThemeName } from "./theme/theme.js";
import { useTerminalTitle } from "./hooks/useTerminalTitle.js";
import { getGitBranch } from "../utils/git.js";
import { getModel, getContextWindow, getMaxThinkingLevel } from "../core/model-registry.js";
import { SessionManager } from "../core/session-manager.js";
import {
  appendMessagesToSession as appendSessionMessages,
  createCompactedSessionCheckpoint,
} from "../core/session-compaction.js";
import { log } from "../core/logger.js";
import {
  getPendingUpdate,
  startPeriodicUpdateCheck,
  stopPeriodicUpdateCheck,
} from "../core/auto-update.js";
import { generateSessionTitle } from "../utils/session-title.js";
import { SettingsManager, type Settings } from "../core/settings-manager.js";
import {
  shouldCompact,
  compact,
  getCompactionReserveTokens,
} from "../core/compaction/compactor.js";
import { estimateConversationTokens } from "../core/compaction/token-estimator.js";
import { PROMPT_COMMANDS, getPromptCommand } from "../core/prompt-commands.js";
import {
  isFirstTimeSetup,
  markSetupAudited,
  getAnnouncedLanguages,
  markLanguagesAnnounced,
} from "../core/setup-history.js";
import { loadCustomCommands, type CustomCommand } from "../core/custom-commands.js";
import { buildSystemPrompt } from "../system-prompt.js";
import {
  detectLanguages,
  LANGUAGE_DISPLAY_NAMES,
  type LanguageId,
} from "../core/language-detector.js";
import { detectVerifyCommands } from "../core/verify-commands.js";
import {
  FOCUSED_REPO_MAP_MAX_CHARS,
  FIRST_TURN_REPO_MAP_MAX_CHARS,
  buildRepoMap,
  createRepoMapCache,
  type RepoMapCache,
  type RepoMapSnapshot,
} from "../core/repomap.js";
import {
  getLatestUserText,
  injectRepoMapContextMessages,
  stripRepoMapContextMessages,
} from "../core/repomap-context.js";
import type { Skill } from "../core/skills.js";
import {
  extractPlanSteps,
  findCompletedMarkers,
  markStepsCompleted,
  segmentDisplayText,
  stripDoneMarkers,
  type PlanStep,
} from "../utils/plan-steps.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import { getMCPServers } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import {
  trimFlushedItems,
  flushOnTurnText,
  flushOnTurnEnd,
  flushOverflow,
} from "./live-item-flush.js";
import {
  appendGoalDecision,
  appendGoalEvidence,
  formatGoalBlockingPrerequisites,
  goalHasBlockingPrerequisites,
  loadGoalRuns,
  reconcileActiveGoalRuns,
  summarizeGoalCounts,
  summarizeGoalCountsFromRuns,
  updateGoalTask,
  upsertGoalRun,
  type GoalRun,
  type GoalTask,
} from "../core/goal-store.js";
import { canCompleteGoalRun, decideGoalNextAction } from "../core/goal-controller.js";
import { runGoalPrerequisiteChecks } from "../core/goal-prerequisites.js";
import { runGoalVerifierCommand } from "../core/goal-verifier.js";
import {
  listGoalWorkers,
  startGoalWorker,
  stopGoalWorker,
  subscribeGoalWorkerCompletions,
  type GoalWorkerCompletion,
} from "../core/goal-worker.js";
import {
  formatGoalVerifierCompletionEvent,
  formatGoalWorkerCompletionEvent,
  isGoalSyntheticEvent,
  parseGoalSyntheticEvent,
} from "./goal-events.js";

/** Where ggcoder bugs should be reported. Surfaced in the guidance line. */
const GGCODER_BUG_REPORT_URL = "github.com/kenkaiiii/gg-framework/issues";

/**
 * Build an ErrorItem from any thrown value. Centralises headline / message /
 * guidance extraction so every error answers the same question for the user:
 *   "Should I retry, or is this a ggcoder bug to report?"
 */
function toErrorItem(err: unknown, id: string, contextPrefix?: string): ErrorItem {
  const f = formatError(err);
  const headline = contextPrefix ? `${contextPrefix} — ${f.headline}` : f.headline;
  // For ggcoder bugs, swap the generic "see /help" guidance for an actual URL
  // so users have a clear place to send the report.
  const guidance =
    f.source === "ggcoder"
      ? `This looks like a ggcoder bug — please send it to the dev at ${GGCODER_BUG_REPORT_URL}.`
      : f.guidance;
  // Mirror every user-visible error into ~/.gg/debug.log so reports can be
  // diagnosed even after the terminal scrollback is gone.
  log("ERROR", "ui-error", headline, {
    source: f.source,
    message: f.message,
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.statusCode != null ? { statusCode: String(f.statusCode) } : {}),
    ...(f.requestId ? { requestId: f.requestId } : {}),
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
  });
  return {
    kind: "error",
    headline,
    message: f.message,
    guidance,
    id,
  };
}

// ── Completed Item Types ───────────────────────────────────

interface UserItem {
  kind: "user";
  text: string;
  imageCount?: number;
  pasteInfo?: PasteInfo;
  id: string;
}

interface TaskItem {
  kind: "task";
  title: string;
  id: string;
}

interface GoalItem {
  kind: "goal";
  title: string;
  workerId?: string;
  id: string;
}

export function routePromptCommandInput(
  input: string,
  promptCommands = PROMPT_COMMANDS,
  customCommands: Pick<CustomCommand, "name" | "prompt">[] = [],
): { cmdName: string; cmdArgs: string; promptText: string; fullPrompt: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(" ");
  const cmdName = parts[0];
  const cmdArgs = parts.slice(1).join(" ").trim();
  const builtinCmd = promptCommands.find((c) => c.name === cmdName || c.aliases.includes(cmdName));
  const customCmd = !builtinCmd ? customCommands.find((c) => c.name === cmdName) : undefined;
  const promptText = builtinCmd?.prompt ?? customCmd?.prompt;
  if (!promptText) return null;
  return {
    cmdName,
    cmdArgs,
    promptText,
    fullPrompt: cmdArgs ? `${promptText}\n\n## User Instructions\n\n${cmdArgs}` : promptText,
  };
}

export function buildUserContentWithAttachments(
  text: string,
  inputImages: ImageAttachment[],
  modelSupportsImages: boolean,
): string | (TextContent | ImageContent)[] {
  if (inputImages.length === 0) return text;

  const parts: (TextContent | ImageContent)[] = [];
  if (text) {
    parts.push({ type: "text", text });
  }

  for (const img of inputImages) {
    if (img.kind === "text") {
      parts.push({
        type: "text",
        text: `<file name="${img.fileName}">\n${img.data}\n</file>`,
      });
    } else if (modelSupportsImages) {
      parts.push({ type: "image", mediaType: img.mediaType, data: img.data });
    } else {
      // GLM models: save image to temp file and instruct model to use vision MCP tool
      const ext = img.mediaType.split("/")[1] ?? "png";
      const tmpPath = `/tmp/ggcoder-img-${Date.now()}.${ext}`;
      try {
        writeFileSync(tmpPath, Buffer.from(img.data, "base64"));
        parts.push({
          type: "text",
          text: `[User attached an image saved at: ${tmpPath} — use the image_analysis tool to view and analyze it]`,
        });
      } catch {
        parts.push({
          type: "text",
          text: `[User attached an image but it could not be saved for analysis]`,
        });
      }
    }
  }

  // If only text parts remain after stripping images, simplify to plain string
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

export interface GoalSummaryRow {
  label: string;
  value: string;
  detail?: string;
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
  workerId?: string;
  status?: string;
  id: string;
}

export type GoalProgressDraft = Omit<GoalProgressItem, "id">;

interface AssistantItem {
  kind: "assistant";
  text: string;
  thinking?: string;
  thinkingMs?: number;
  planMode?: boolean;
  id: string;
}

interface ToolStartItem {
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

interface ToolDoneItem {
  kind: "tool_done";
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
  details?: unknown;
  id: string;
}

interface ErrorItem {
  kind: "error";
  /** Plain-English headline, e.g. "OpenAI returned an error." */
  headline: string;
  /** Detailed message body (clean, no JSON). */
  message: string;
  /** Action line — "Retry, this is an OpenAI issue" / "Report this ggcoder bug …". */
  guidance: string;
  id: string;
}

interface InfoItem {
  kind: "info";
  text: string;
  id: string;
}

interface StylePackItem {
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
interface SetupHintItem {
  kind: "setup_hint";
  id: string;
}

interface UpdateNoticeItem {
  kind: "update_notice";
  text: string;
  id: string;
}

interface QueuedItem {
  kind: "queued";
  text: string;
  imageCount?: number;
  id: string;
}

interface CompactingItem {
  kind: "compacting";
  id: string;
}

interface CompactedItem {
  kind: "compacted";
  originalCount: number;
  newCount: number;
  tokensBefore: number;
  tokensAfter: number;
  id: string;
}

interface DurationItem {
  kind: "duration";
  durationMs: number;
  toolsUsed: string[];
  verb: string;
  id: string;
}

interface BannerItem {
  kind: "banner";
  id: string;
}

interface SubAgentGroupItem {
  kind: "subagent_group";
  agents: SubAgentInfo[];
  aborted?: boolean;
  id: string;
}

interface ServerToolStartItem {
  kind: "server_tool_start";
  serverToolCallId: string;
  name: string;
  input: unknown;
  startedAt: number;
  animateUntil: number;
  id: string;
}

interface ServerToolDoneItem {
  kind: "server_tool_done";
  name: string;
  input: unknown;
  resultType: string;
  data: unknown;
  durationMs: number;
  id: string;
}

interface PlanTransitionItem {
  kind: "plan_transition";
  text: string;
  active: boolean;
  id: string;
}

interface ThinkingTransitionItem {
  kind: "thinking_transition";
  active: boolean;
  id: string;
}

interface ModelTransitionItem {
  kind: "model_transition";
  modelName: string;
  id: string;
}

interface ThemeTransitionItem {
  kind: "theme_transition";
  themeName: string;
  id: string;
}

interface PlanEventItem {
  kind: "plan_event";
  event: "approved" | "rejected" | "dismissed";
  /** Free-form detail (reject feedback, etc.) — quoted in the rendered row. */
  detail?: string;
  id: string;
}

interface StoppedItem {
  kind: "stopped";
  text: string;
  id: string;
}

interface TombstoneItem {
  kind: "tombstone";
  id: string;
}

interface StepDoneItem {
  kind: "step_done";
  stepNum: number;
  description: string;
  id: string;
}

/** Tools that get aggregated into a single compact group when concurrent. */
const AGGREGATABLE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const RUNNING_INDICATOR_ANIMATION_MS = 1_200;

interface ToolGroupTool {
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
  | TaskItem
  | GoalItem
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
  | BannerItem
  | SubAgentGroupItem
  | ToolGroupItem
  | PlanTransitionItem
  | ThinkingTransitionItem
  | ModelTransitionItem
  | ThemeTransitionItem
  | PlanEventItem
  | StoppedItem
  | TombstoneItem
  | StepDoneItem;

/**
 * Cap memory by replacing old items with tiny tombstones. Ink's <Static>
 * tracks rendered items by array length — the array must never shrink, but
 * we can swap out heavy objects for lightweight `{ kind: "tombstone", id }`
 * entries so GC can reclaim the original data.
 */
const MAX_LIVE_HISTORY = 200;
function compactHistory(items: CompletedItem[]): CompletedItem[] {
  if (items.length <= MAX_LIVE_HISTORY) return items;
  const cutoff = items.length - MAX_LIVE_HISTORY;
  const compacted = new Array<CompletedItem>(items.length);
  for (let i = 0; i < cutoff; i++) {
    const it = items[i];
    compacted[i] = it.kind === "tombstone" ? it : { kind: "tombstone", id: it.id };
  }
  for (let i = cutoff; i < items.length; i++) {
    compacted[i] = items[i];
  }
  return compacted;
}

function summarizeGoalCompletion(summary: string): string | undefined {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "[agent_done]");
  const statusLine = lines.find((line) => /^Status:/i.test(line));
  const changedLine = lines.find((line) =>
    /^(Changed|Implemented|Fixed|Added|Key findings|Full verifier)/i.test(line),
  );
  const verificationLine = lines.find((line) => /^(Verification|Verified|Result):/i.test(line));
  return statusLine ?? changedLine ?? verificationLine ?? lines[0];
}

function formatGoalWorkerFinishedTitle(
  taskTitle: string,
  status: GoalWorkerCompletion["status"],
): string {
  return status === "done" ? `Done: ${taskTitle}` : `Failed: ${taskTitle}`;
}

function countGoalTasksByStatus(tasks: readonly GoalTask[], status: GoalTask["status"]): number {
  return tasks.filter((task) => task.status === status).length;
}

function firstText(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function truncateGoalSummary(value: string, maxLength = 90): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function buildGoalSummaryRows(run: GoalRun): GoalSummaryRow[] {
  const rows: GoalSummaryRow[] = [];
  const doneTasks = countGoalTasksByStatus(run.tasks, "done");
  const failedTasks = countGoalTasksByStatus(run.tasks, "failed");
  const blockedTasks = countGoalTasksByStatus(run.tasks, "blocked");
  const taskSuffix = [
    failedTasks > 0 ? `${failedTasks} failed` : undefined,
    blockedTasks > 0 ? `${blockedTasks} blocked` : undefined,
  ].filter((item): item is string => item !== undefined);
  rows.push({
    label: "Tasks",
    value: run.tasks.length > 0 ? `${doneTasks}/${run.tasks.length} done` : "none",
    ...(taskSuffix.length > 0 ? { detail: taskSuffix.join(", ") } : {}),
  });

  const verifierResult = run.verifier?.lastResult;
  const verifierDetail = firstText([verifierResult?.outputPath, run.verifier?.command]);
  rows.push({
    label: "Verifier",
    value: verifierResult?.status ?? (run.verifier?.command ? "ready" : "missing"),
    ...(verifierDetail ? { detail: truncateGoalSummary(verifierDetail) } : {}),
  });

  const latestEvidence = run.evidence.at(-1);
  rows.push({
    label: "Evidence",
    value: `${run.evidence.length} recorded`,
    ...(latestEvidence
      ? { detail: truncateGoalSummary(latestEvidence.path ?? latestEvidence.label) }
      : {}),
  });

  if (run.status === "blocked" || run.status === "paused" || run.blockers.length > 0) {
    rows.push({
      label: run.status === "paused" ? "Paused on" : "Blocked on",
      value: truncateGoalSummary(
        goalHasBlockingPrerequisites(run)
          ? formatGoalBlockingPrerequisites(run)
          : (run.blockers[0] ?? "manual review"),
        110,
      ),
    });
  } else if (run.successCriteria.length > 0) {
    rows.push({
      label: "Criteria",
      value: `${run.successCriteria.length} checked`,
      detail: truncateGoalSummary(run.successCriteria[0] ?? "", 80),
    });
  }

  return rows.slice(0, 4);
}

function goalTerminalProgressId(run: GoalRun): string {
  return `goal-terminal-${run.id}`;
}

function goalTerminalRunIdFromItem(item: CompletedItem): string | undefined {
  if (item.kind !== "goal_progress" || item.phase !== "terminal") return undefined;
  if (!item.id.startsWith("goal-terminal-")) return undefined;
  return item.id.slice("goal-terminal-".length);
}

function goalProgressMatchesDraft(item: GoalProgressItem, draft: GoalProgressDraft): boolean {
  return (
    item.title === draft.title &&
    item.detail === draft.detail &&
    item.status === draft.status &&
    JSON.stringify(item.summaryRows ?? []) === JSON.stringify(draft.summaryRows ?? [])
  );
}

/**
 * Reconcile terminal Goal cards that are already visible in this UI session.
 *
 * This intentionally does not synthesize missing cards from durable GoalRun
 * state. Goal terminal cards are event notifications: they should appear when
 * the terminal event happens in the current UI, not whenever a fresh session
 * polls old Goal runs from the Goal pane. Callers that just observed a terminal
 * event append that card first, then use this helper to tombstone stale older
 * cards for the same run.
 */
export function completedItemsWithDurableGoalTerminalProgress(
  items: readonly CompletedItem[],
  runs: readonly GoalRun[],
): CompletedItem[] {
  const runIds = new Set(runs.map((run) => run.id));
  const terminalByRun = new Map(
    runs
      .map((run) => [run.id, formatGoalTerminalProgress(run)] as const)
      .filter((entry): entry is readonly [string, GoalProgressDraft] => entry[1] !== null),
  );
  if (runIds.size === 0) return items as CompletedItem[];

  let changed = false;
  const reconciled = items.map((item, index): CompletedItem => {
    const runId = goalTerminalRunIdFromItem(item);
    if (!runId || !runIds.has(runId)) return item;

    const draft = terminalByRun.get(runId);
    if (draft && goalProgressMatchesDraft(item as GoalProgressItem, draft)) return item;

    changed = true;
    return { kind: "tombstone", id: `tombstone-${item.id}-${index}` };
  });

  return changed ? reconciled : (items as CompletedItem[]);
}

export function formatGoalTerminalProgress(run: GoalRun): GoalProgressDraft | null {
  switch (run.status) {
    case "passed":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal passed: ${run.title}`,
        detail: "Verifier evidence is recorded; auto-continuation stopped.",
        summaryRows: buildGoalSummaryRows(run),
        status: run.status,
      };
    case "failed":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal failed: ${run.title}`,
        detail: "Auto-continuation stopped. Check Goal tasks for the failing step.",
        summaryRows: buildGoalSummaryRows(run),
        status: run.status,
      };
    case "blocked":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal blocked: ${run.title}`,
        detail: goalHasBlockingPrerequisites(run)
          ? formatGoalBlockingPrerequisites(run)
          : (run.blockers[0] ?? "A prerequisite or missing verifier blocked progress."),
        summaryRows: buildGoalSummaryRows(run),
        status: run.status,
      };
    case "paused":
      return {
        kind: "goal_progress",
        phase: "terminal",
        title: `Goal paused: ${run.title}`,
        detail: run.blockers[0] ?? "Auto-continuation paused.",
        summaryRows: buildGoalSummaryRows(run),
        status: run.status,
      };
    case "draft":
    case "ready":
    case "running":
    case "verifying":
      return null;
  }
}

export type OverlayPaneKind =
  | "model"
  | "tasks"
  | "goal"
  | "skills"
  | "plan"
  | "theme"
  | "eyes"
  | "pixel";

export function shouldHideHistoryForOverlayView(
  isOverlayView: boolean,
  _isAgentRunning: boolean,
): boolean {
  // Overlay panes are standalone full-screen states. Do not render chat Static
  // history behind them, otherwise panes appear below the previous transcript.
  return isOverlayView;
}

export function shouldStabilizeOverlayPaneRerender({
  overlayPane,
  isAgentRunning,
}: {
  overlayPane: OverlayPaneKind | null;
  isAgentRunning: boolean;
}): boolean {
  return isAgentRunning && (overlayPane === "goal" || overlayPane === "plan");
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

export interface ScrollStabilizationDecision {
  /** Keep Ink Static mounted with the same key so terminal scrollback is not rewritten. */
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

// flushOnTurnText, flushOnTurnEnd are imported from ./live-item-flush.ts

/** Check whether an item is still active (running spinner, pending result). */
export function isActiveItem(item: CompletedItem): boolean {
  switch (item.kind) {
    case "tool_start":
    case "server_tool_start":
    case "queued":
    case "compacting":
      return true;
    case "tool_group":
      return (item as ToolGroupItem).tools.some((t) => t.status === "running");
    case "subagent_group":
      return (item as SubAgentGroupItem).agents.some((a) => a.status === "running");
    default:
      return false;
  }
}

/**
 * Partition live items into completed (flushable to Static) and still-active.
 * Completed items precede active ones — we flush the longest contiguous prefix
 * of completed items to keep ordering stable.
 */
function partitionCompleted(items: CompletedItem[]): {
  flushed: CompletedItem[];
  remaining: CompletedItem[];
} {
  // Find the first active item — everything before it is safe to flush
  const firstActiveIdx = items.findIndex(isActiveItem);
  if (firstActiveIdx === -1) {
    // All items are completed
    return { flushed: items, remaining: [] };
  }
  if (firstActiveIdx === 0) {
    return { flushed: [], remaining: items };
  }
  return {
    flushed: items.slice(0, firstActiveIdx),
    remaining: items.slice(firstActiveIdx),
  };
}

// ── Duration summary ─────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function pickDurationVerb(toolsUsed: string[]): string {
  const has = (name: string) => toolsUsed.includes(name);
  const hasAny = (...names: string[]) => names.some(has);
  const writing = has("edit") || has("write");
  const reading = has("read") || has("grep") || has("find") || has("ls");

  // Multi-tool combos (most specific first)
  if (has("subagent") && writing) return "Orchestrated changes for";
  if (has("subagent")) return "Delegated work for";
  if (has("web-fetch") && writing) return "Researched & coded for";
  if (has("web-fetch") && reading) return "Researched for";
  if (has("web-fetch")) return "Fetched the web for";
  if (has("bash") && writing) return "Built & ran for";
  if (has("edit") && has("write")) return "Crafted code for";
  if (has("edit") && has("bash")) return "Refactored & tested for";
  if (has("edit") && reading) return "Refactored for";
  if (has("edit")) return "Refactored for";
  if (has("write") && has("bash")) return "Wrote & ran for";
  if (has("write") && reading) return "Wrote code for";
  if (has("write")) return "Wrote code for";
  if (has("bash") && has("grep")) return "Hacked away for";
  if (has("bash") && reading) return "Ran & investigated for";
  if (has("bash")) return "Executed commands for";
  if (hasAny("tasks", "task-output", "task-stop")) return "Managed tasks for";
  if (has("grep") && has("read")) return "Investigated for";
  if (has("grep") && has("find")) return "Scoured the codebase for";
  if (has("grep")) return "Searched for";
  if (has("read") && has("find")) return "Explored for";
  if (has("read")) return "Studied the code for";
  if (has("find") || has("ls")) return "Browsed files for";

  // No tools used — pure text response
  const phrases = [
    "Pondered for",
    "Thought for",
    "Reasoned for",
    "Mulled it over for",
    "Noodled on it for",
    "Brewed up a response in",
    "Cooked up an answer in",
    "Worked out a reply in",
    "Channeled wisdom for",
    "Conjured a response in",
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

// ── Animated thinking border ────────────────────────────────

const THINKING_BORDER_COLORS = ["#60a5fa", "#818cf8", "#a78bfa", "#818cf8", "#60a5fa"];

// ── Task count helper ───────────────────────────────────────

function getTaskCount(cwd: string): number {
  try {
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    const data = readFileSync(
      join(homedir(), ".gg-tasks", "projects", hash, "tasks.json"),
      "utf-8",
    );
    const tasks = JSON.parse(data) as { status: string }[];
    return tasks.filter((t) => t.status !== "done").length;
  } catch {
    return 0;
  }
}

interface PendingTaskInfo {
  id: string;
  title: string;
  prompt: string;
}

function getNextPendingTask(cwd: string): PendingTaskInfo | null {
  try {
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    const data = readFileSync(
      join(homedir(), ".gg-tasks", "projects", hash, "tasks.json"),
      "utf-8",
    );
    const tasks = JSON.parse(data) as {
      id: string;
      title: string;
      prompt: string;
      text?: string;
      status: string;
    }[];
    const pending = tasks.find((t) => t.status === "pending");
    if (!pending) return null;
    return {
      id: pending.id,
      title: pending.title,
      prompt: pending.prompt || pending.text || pending.title,
    };
  } catch {
    return null;
  }
}

function markTaskInProgress(cwd: string, taskId: string): void {
  try {
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    const filePath = join(homedir(), ".gg-tasks", "projects", hash, "tasks.json");
    const data = readFileSync(filePath, "utf-8");
    const tasks = JSON.parse(data) as { id: string; status: string }[];
    const updated = tasks.map((t) => (t.id === taskId ? { ...t, status: "in-progress" } : t));
    writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  } catch {
    // ignore
  }
}

// ── App Props ──────────────────────────────────────────────

export interface AppProps {
  provider: Provider;
  model: string;
  tools: AgentTool[];
  webSearch?: boolean;
  messages: Message[];
  maxTokens: number;
  thinking?: ThinkingLevel;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  projectId?: string;
  cwd: string;
  version: string;
  showTokenUsage?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<
    string,
    { accessToken: string; accountId?: string; projectId?: string; baseUrl?: string }
  >;
  initialHistory?: CompletedItem[];
  sessionsDir?: string;
  sessionPath?: string;
  processManager?: ProcessManager;
  settingsFile?: string;
  mcpManager?: MCPClientManager;
  authStorage?: AuthStorage;
  planModeRef?: { current: boolean };
  onEnterPlanRef?: { current: (reason?: string) => void };
  onExitPlanRef?: { current: (planPath: string) => Promise<string> };
  skills?: Skill[];
  initialOverlay?: "pixel" | "goal";
  rebuildToolsForCwd?: (cwd: string) => AgentTool[];
  repoMapChangedFilesRef?: { current: Set<string> };
  repoMapReadFilesRef?: { current: Set<string> };
  /**
   * Wired by `renderApp`. Tears down the current Ink instance and renders
   * a fresh one. Patching Ink's internal frame tracking in place is
   * unreliable (the live area drifts on subsequent streaming responses);
   * a full unmount/remount is the only consistent reset.
   *
   * Used by every path that previously did a bare ANSI screen clear:
   * `/clear`, plan accept/reject, overlay open/close, startTask, pixel fix.
   *
   * Runtime state (model, provider, thinking) survives via
   * `onRuntimeStateChange`; conversation/session state survives via
   * `sessionStore` (which App mirrors React state into).
   */
  resetUI?: (options?: {
    messages?: Message[];
    wipeSession?: boolean;
    history?: CompletedItem[];
    approvedPlanPath?: string;
    planSteps?: PlanStep[];
    sessionPath?: string;
    pendingAction?: {
      prompt: string;
      infoText?: string;
      planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
    };
  }) => void;
  /**
   * Wired by `renderApp`. App calls this when the user changes
   * model/provider/thinking at runtime so those choices survive the
   * unmount/remount triggered by resetUI.
   */
  onRuntimeStateChange?: (updates: {
    model?: string;
    provider?: Provider;
    thinking?: ThinkingLevel;
  }) => void;
  /**
   * Wired by `renderApp`. App syncs its React state (messages, history,
   * plan steps, session metadata) to this object via useEffects so a
   * subsequent resetUI() can re-seed the conversation. Without this, every
   * overlay close would lose the chat.
   */
  sessionStore?: {
    messages: Message[];
    history: CompletedItem[];
    liveItems?: CompletedItem[];
    doneStatus?: DoneStatus | null;
    approvedPlanPath?: string;
    planSteps: PlanStep[];
    sessionPath?: string;
    sessionTitle?: string;
    sessionTitleGenerated: boolean;
    overlay?: "model" | "tasks" | "goal" | "skills" | "plan" | "theme" | "eyes" | "pixel" | null;
    planAutoExpand?: boolean;
    pendingAction?: {
      prompt: string;
      infoText?: string;
      planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
    };
    isAgentRunning?: boolean;
    pendingResetUI?: boolean;
    runAllTasks?: boolean;
    runAllPixel?: boolean;
    goalStatusEntries?: GoalStatusEntry[];
  };
}

// ── App Component ──────────────────────────────────────────

export function App(props: AppProps) {
  const theme = useTheme();
  const switchTheme = useSetTheme();
  const { columns, rows, resizeKey } = useTerminalSize();

  // Hoisted before terminal title hook so it can reference them
  const [lastUserMessage, setLastUserMessage] = useState("");
  const [exitPending, setExitPending] = useState(false);
  // Initialize from planModeRef (lives outside React in cli.ts) so plan
  // mode survives /clear's unmount/remount, matching the prior behavior
  // where /clear didn't toggle plan mode off.
  const [planMode, setPlanMode] = useState(props.planModeRef?.current ?? false);
  const planModeLocalRef = useRef(false);
  planModeLocalRef.current = planMode;

  // Terminal title — updated later after agentLoop is created
  // (hoisted here so the hook is always called in the same order)
  const [titleRunning, setTitleRunning] = useState(false);
  const [sessionTitle, setSessionTitle] = useState<string | undefined>(
    () => props.sessionStore?.sessionTitle,
  );
  const sessionTitleGeneratedRef = useRef(props.sessionStore?.sessionTitleGenerated ?? false);
  useTerminalTitle({
    isRunning: titleRunning,
    sessionTitle,
  });

  // Items scrolled into Static (history). For restored sessions, seed the
  // initial array directly — matches how every other Ink chat agent passes
  // messages to <Static> (cat-code, harness, p90-cli, openai-chatgpt, lms,
  // gatsby). Ink's Static (build/components/Static.js) starts with index=0
  // so slice(0) returns the full array regardless of length.
  const [history, setHistory] = useState<CompletedItem[]>(() => {
    // sessionStore wins (lives across remount). Falls back to initialHistory
    // (loaded from a session file at startup), then a fresh banner-only list.
    const stored = props.sessionStore?.history;
    if (stored && stored.length > 0) return stored;
    if (props.initialHistory && props.initialHistory.length > 0) {
      return compactHistory(trimFlushedItems(props.initialHistory));
    }
    return [{ kind: "banner", id: "banner" }];
  });
  // Items from the current/last turn — rendered in the live area so they stay visible.
  // Seed from sessionStore so Goal progress/completion rows and other live output
  // survive pane/overlay/resize remounts before they are flushed to <Static>.
  const [liveItems, setLiveItems] = useState<CompletedItem[]>(
    () => props.sessionStore?.liveItems ?? [],
  );
  // overlay seeded from sessionStore (lives across remount). Falls back to
  // props.initialOverlay (CLI launched with one), then null.
  const [overlay, setOverlay] = useState<
    "model" | "tasks" | "goal" | "skills" | "plan" | "theme" | "eyes" | "pixel" | null
  >(props.sessionStore?.overlay ?? props.initialOverlay ?? null);
  const [taskCount, setTaskCount] = useState(() => getTaskCount(props.cwd));
  const [goalCount, setGoalCount] = useState(0);
  const [goalStatusEntries, setGoalStatusEntries] = useState<GoalStatusEntry[]>(
    props.sessionStore?.goalStatusEntries ?? [],
  );
  const [eyesCount, setEyesCount] = useState<number | undefined>(() =>
    isEyesActive(props.cwd) ? journalCount({ status: "open" }, props.cwd) : undefined,
  );
  const [updatePending, setUpdatePending] = useState<boolean>(
    () => getPendingUpdate(props.version) !== null,
  );
  // Seed from sessionStore so "Run All" chaining survives the resetUI()
  // remount that startTask() triggers between tasks.
  const [runAllTasks, setRunAllTasks] = useState(props.sessionStore?.runAllTasks ?? false);
  const runAllTasksRef = useRef(props.sessionStore?.runAllTasks ?? false);
  const startTaskRef = useRef<(title: string, prompt: string, taskId: string) => void>(() => {});
  const agentRunningRef = useRef(false);
  const runningGoalIdsRef = useRef<Set<string>>(new Set());
  const activeVerifierRunIdsRef = useRef<Set<string>>(new Set());
  const startGoalRunRef = useRef<(run: GoalRun) => void>(() => {});
  const runAllPixelRef = useRef(props.sessionStore?.runAllPixel ?? false);
  const currentPixelFixRef = useRef<PreparedPixelFix | null>(null);
  const startPixelFixRef = useRef<(errorId: string) => void>(() => {});
  const cwdRef = useRef(props.cwd);
  const [displayedCwd, setDisplayedCwd] = useState(props.cwd);
  const [doneStatus, setDoneStatus] = useState<DoneStatus | null>(
    props.sessionStore?.doneStatus ?? null,
  );
  // Suppress "done" status when a plan overlay is about to open
  const planOverlayPendingRef = useRef(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(props.model);
  const [currentProvider, setCurrentProvider] = useState(props.provider);
  const [currentTools, setCurrentTools] = useState(props.tools);
  const currentToolsRef = useRef(props.tools);
  const [thinkingEnabled, setThinkingEnabled] = useState(!!props.thinking);
  const messagesRef = useRef<Message[]>(props.sessionStore?.messages ?? props.messages);
  const repoMapInjectionEnabledRef = useRef(true);
  const repoMapDirtyRef = useRef(true);
  const repoMapMarkdownRef = useRef("");
  const repoMapSnapshotRef = useRef<RepoMapSnapshot | undefined>(undefined);
  const repoMapChangedCountRef = useRef(0);
  const repoMapCacheRef = useRef<RepoMapCache>(createRepoMapCache());
  const [planAutoExpand, setPlanAutoExpand] = useState(props.sessionStore?.planAutoExpand ?? false);
  const approvedPlanPathRef = useRef<string | undefined>(props.sessionStore?.approvedPlanPath);
  const planStepsRef = useRef<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const planModeStateRef = useRef(planMode);
  // Stuck-guard for the plan-continuation follow-up nudge. Tracks how many
  // times we've nudged the agent to continue the same step. Reset whenever a
  // new [DONE:n] marker advances progress (see onTurnText). Caps at 2 nudges
  // so a genuinely stuck agent surfaces instead of looping forever.
  const followUpNudgesRef = useRef<{ step: number; count: number }>({ step: 0, count: 0 });
  // Seed the per-item ID counter so it doesn't collide with IDs already in
  // sessionStore.history (which survives remount). Without this, a remount
  // (resize, overlay toggle, etc.) starts the counter at 0 and new items
  // generate ids "0", "1", "2"… that collide with the same ids from the
  // previous mount, triggering React's duplicate-key warning and causing
  // duplicate/omitted renders.
  const nextIdRef = useRef(
    (() => {
      const items = [
        ...(props.sessionStore?.history ?? props.initialHistory ?? []),
        ...(props.sessionStore?.liveItems ?? []),
      ];
      let max = -1;
      for (const item of items) {
        const n = Number(item.id);
        if (Number.isFinite(n) && n > max) max = n;
      }
      return max + 1;
    })(),
  );
  const sessionManagerRef = useRef(
    props.sessionsDir ? new SessionManager(props.sessionsDir) : null,
  );
  const sessionPathRef = useRef(props.sessionStore?.sessionPath ?? props.sessionPath);
  const persistedIndexRef = useRef(messagesRef.current.length);
  /** Last actual API-reported input token count (from turn_end). */
  const lastActualTokensRef = useRef(0);
  /** Timestamp (ms) when lastActualTokensRef was last updated by turn_end. */
  const lastActualTokensTimestampRef = useRef(0);
  /** Timestamp of last compaction — used for time-based cooldown and staleness detection. */
  const lastCompactionTimeRef = useRef(0);
  /**
   * Languages whose style packs are currently injected into the system prompt.
   * Grown by `maybeInjectLanguagePacks` after `write`/`bash` tool results when
   * the language detector sees new marker files. Reset on `chdir` (pixel-fix).
   * Only grows within a session; we never strip packs once injected (cheaper
   * than invalidating prompt caching, and stale guidance is harmless).
   */
  const injectedLanguagesRef = useRef<Set<LanguageId>>(new Set());
  /**
   * True until the first style-pack badge is pushed. Used to gate the
   * one-time "/setup" hint so users learn the slash command without being
   * spammed on every subsequent pack swap.
   */
  const setupHintShownRef = useRef(false);
  /**
   * Callback that fires `/setup` programmatically. Assigned later in the
   * component once `agentLoop` is in scope. Called from the initial
   * language-detection path when this cwd has never been audited before.
   */
  const triggerAutoSetupRef = useRef<() => Promise<void>>(async () => {});

  const getId = () => `ui-${nextIdRef.current++}`;
  const appendGoalProgress = useCallback((item: GoalProgressDraft) => {
    setLiveItems((prev) => [...prev, { ...item, id: getId() }]);
  }, []);
  const goalNumberForRun = useCallback(
    (runId: string) =>
      Math.max(1, goalStatusEntries.findIndex((entry) => entry.runId === runId) + 1),
    [goalStatusEntries],
  );
  const clearGoalStatusEntry = useCallback(
    (runId: string) => {
      setGoalStatusEntries((prev) => {
        const next = removeGoalStatusEntry(prev, runId);
        if (props.sessionStore) props.sessionStore.goalStatusEntries = next;
        return next;
      });
    },
    [props.sessionStore],
  );
  const upsertGoalStatusEntry = useCallback(
    (entry: GoalStatusEntry) => {
      setGoalStatusEntries((prev) => {
        const next = syncGoalStatusEntries(prev, entry);
        if (props.sessionStore) props.sessionStore.goalStatusEntries = next;
        return next;
      });
    },
    [props.sessionStore],
  );

  // Two-phase flush: items waiting to be moved to Static history after the
  // live area has been cleared and Ink has committed the smaller output.
  const pendingFlushRef = useRef<CompletedItem[]>([]);
  const [flushGeneration, setFlushGeneration] = useState(0);

  /** Queue items for two-phase flush and signal the drain effect. */
  const queueFlush = useCallback(
    (items: CompletedItem[]) => {
      if (items.length === 0) return;
      pendingFlushRef.current = [...pendingFlushRef.current, ...items];
      if (props.sessionStore) {
        const queuedIds = new Set(items.map((item) => item.id));
        props.sessionStore.liveItems = (props.sessionStore.liveItems ?? []).filter(
          (item) => !queuedIds.has(item.id),
        );
      }
      setFlushGeneration((g) => g + 1);
    },
    [props.sessionStore],
  );

  // Mirror runtime state choices (model/provider/thinking) into renderApp's
  // closure so unmount/remount preserves them.
  const onRuntimeStateChange = props.onRuntimeStateChange;
  useEffect(() => {
    onRuntimeStateChange?.({ model: currentModel });
  }, [currentModel, onRuntimeStateChange]);
  useEffect(() => {
    onRuntimeStateChange?.({ provider: currentProvider });
  }, [currentProvider, onRuntimeStateChange]);
  useEffect(() => {
    onRuntimeStateChange?.({
      thinking: thinkingEnabled ? getMaxThinkingLevel(currentModel) : undefined,
    });
  }, [thinkingEnabled, currentModel, onRuntimeStateChange]);

  // Mirror session state into renderApp's closure so resetUI() can re-seed
  // the conversation on remount. Each panel that previously did a bare ANSI
  // screen clear (overlay open/close, plan accept/reject, /clear, startTask)
  // now goes through resetUI; without these mirrors, the chat would vanish.
  const sessionStore = props.sessionStore;
  useEffect(() => {
    if (sessionStore) sessionStore.history = history;
  }, [history, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.liveItems = liveItems;
  }, [liveItems, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.doneStatus = doneStatus;
  }, [doneStatus, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.planSteps = planSteps;
  }, [planSteps, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.sessionTitle = sessionTitle;
  }, [sessionTitle, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.overlay = overlay;
  }, [overlay, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.goalStatusEntries = goalStatusEntries;
  }, [goalStatusEntries, sessionStore]);

  // pendingAction is consumed via a useEffect AFTER agentLoop is created
  // — see below where useAgentLoop is set up.
  const pendingActionConsumedRef = useRef(false);

  // Derive credentials for the current provider
  const currentCreds = props.credentialsByProvider?.[currentProvider];
  const activeApiKey = currentCreds?.accessToken ?? props.apiKey;
  const activeAccountId = currentCreds?.accountId ?? props.accountId;
  const activeProjectId = currentCreds?.projectId ?? props.projectId;
  const activeBaseUrl =
    currentProvider === "gemini" ? undefined : (currentCreds?.baseUrl ?? props.baseUrl);
  const contextWindowOptions = useMemo(
    () => ({ provider: currentProvider, accountId: activeAccountId }),
    [currentProvider, activeAccountId],
  );

  // Load git branch — re-runs whenever the displayed cwd changes (e.g. when
  // a pixel fix moves the agent into a different project root).
  useEffect(() => {
    getGitBranch(displayedCwd).then(setGitBranch);
  }, [displayedCwd]);

  useEffect(() => {
    let cancelled = false;
    const refreshGoalCount = () => {
      void reconcileActiveGoalRuns(props.cwd, {
        isWorkerActive: (workerId) =>
          listGoalWorkers(props.cwd).some(
            (worker) => worker.id === workerId && worker.status === "running",
          ),
      }).then(({ runs }) => {
        const counts = summarizeGoalCountsFromRuns(runs);
        if (cancelled) return;
        setGoalCount(counts.active);
        setHistory((prev) => completedItemsWithDurableGoalTerminalProgress(prev, runs));
        setGoalStatusEntries((prev) => {
          const next = reconcileGoalStatusEntriesWithRuns(prev, runs, {
            isWorkerActive: (workerId, run) =>
              listGoalWorkers(props.cwd).some(
                (worker) =>
                  worker.id === workerId &&
                  worker.goalRunId === run.id &&
                  worker.status === "running",
              ),
            isVerifierActive: (run) => activeVerifierRunIdsRef.current.has(run.id),
          });
          if (props.sessionStore) props.sessionStore.goalStatusEntries = next;
          return next;
        });
      });
    };
    refreshGoalCount();
    const interval = setInterval(refreshGoalCount, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [props.cwd]);

  // Periodic update check during long sessions
  useEffect(() => {
    startPeriodicUpdateCheck(props.version, (msg) => {
      setLiveItems((prev) => [...prev, { kind: "update_notice", text: msg, id: getId() }]);
      setUpdatePending(true);
    });
    return () => stopPeriodicUpdateCheck();
  }, [props.version]);

  // Load custom commands from .gg/commands/
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  const reloadCustomCommands = useCallback(() => {
    loadCustomCommands(props.cwd).then(setCustomCommands);
  }, [props.cwd]);
  useEffect(() => {
    reloadCustomCommands();
  }, [reloadCustomCommands]);

  useEffect(() => {
    currentToolsRef.current = currentTools;
  }, [currentTools]);

  // ── Plan mode wiring ─────────────────────────────────────
  // Sync planModeRef with React state
  useEffect(() => {
    planModeStateRef.current = planMode;
    if (props.planModeRef) {
      props.planModeRef.current = planMode;
    }
  }, [planMode, props.planModeRef]);

  const rebuildSystemPrompt = useCallback(
    async (options?: {
      cwd?: string;
      planMode?: boolean;
      approvedPlanPath?: string;
      clearApprovedPlan?: boolean;
      activeLanguages?: Set<LanguageId>;
      tools?: AgentTool[];
    }): Promise<string> => {
      const approvedPlanPath = options?.clearApprovedPlan
        ? undefined
        : (options?.approvedPlanPath ?? approvedPlanPathRef.current);
      return buildSystemPrompt(
        options?.cwd ?? cwdRef.current,
        props.skills,
        options?.planMode ?? planModeStateRef.current,
        approvedPlanPath,
        (options?.tools ?? currentToolsRef.current).map((tool) => tool.name),
        options?.activeLanguages ?? injectedLanguagesRef.current,
      );
    },
    [props.skills],
  );

  const replaceSystemPrompt = useCallback(
    async (options?: Parameters<typeof rebuildSystemPrompt>[0]): Promise<string> => {
      const newPrompt = await rebuildSystemPrompt(options);
      if (messagesRef.current[0]?.role === "system") {
        messagesRef.current[0] = { role: "system" as const, content: newPrompt };
      }
      return newPrompt;
    },
    [rebuildSystemPrompt],
  );

  /**
   * Unified "apply detection result" pipeline. Called from three sites:
   *   1. Initial mount (existing project at startup).
   *   2. After every `write`/`bash` tool result (reactive to new manifests).
   *   3. Before every user submit (catches external changes between turns,
   *      and ensures non-writing prompts still surface the badge).
   *
   * No-op when no new languages were added vs `injectedLanguagesRef.current`.
   * The set-growth gate keeps this safe to call from every hot path.
   */
  const applyLanguageDetectionRef = useRef<(source: "initial" | "tool" | "input") => Promise<void>>(
    async () => {},
  );
  applyLanguageDetectionRef.current = async (source) => {
    const cwd = cwdRef.current;
    const detected = detectLanguages(cwd);
    const added: LanguageId[] = [];
    for (const id of detected) {
      if (!injectedLanguagesRef.current.has(id)) added.push(id);
    }
    if (added.length === 0) {
      // No new packs to inject. The empty-detection hint + auto-run are
      // first-time-per-cwd only — once the user has been shown the box and
      // /setup has had a chance to run, re-showing on every session is noise.
      // The with-packs path below is gated the same way via
      // getAnnouncedLanguages / markLanguagesAnnounced: badge fires once per
      // (cwd, language) and stays silent on subsequent sessions / /clear.
      if (
        source === "initial" &&
        !setupHintShownRef.current &&
        injectedLanguagesRef.current.size === 0 &&
        isFirstTimeSetup(cwd)
      ) {
        setupHintShownRef.current = true;
        markSetupAudited(cwd);
        log("INFO", "language", `No style packs detected for ${cwd}`, { source });
        setLiveItems((prev) => [...prev, { kind: "setup_hint", id: getId() }]);
        // /setup handles the empty / parent-folder / scratch-dir case via
        // its brand-new-empty-project branch in the prompt template.
        void triggerAutoSetupRef.current();
      }
      return;
    }
    injectedLanguagesRef.current = detected;
    try {
      await replaceSystemPrompt({ cwd, activeLanguages: detected });
      const verifyCmds = detectVerifyCommands(cwd, detected);
      const tag = source === "initial" ? "Initial style packs" : "Style pack(s) loaded";
      log("INFO", "language", `${tag}: ${added.join(", ")}`, {
        source,
        active: [...detected].join(","),
        verify_count: String(verifyCmds.length),
        verify: verifyCmds.map((c) => `${c.language}:${c.label}=${c.command}`).join(" | "),
      });
      // The badge is purely user-facing notification ("hey, this pack just
      // turned on"). The system prompt is already updated above — that's the
      // load-bearing part. We persist the announced set per-cwd so /clear,
      // restart, and new sessions stay quiet for packs the user has seen.
      const alreadyAnnounced = new Set(getAnnouncedLanguages(cwd));
      const toAnnounce = added.filter((id) => !alreadyAnnounced.has(id));
      if (toAnnounce.length > 0) {
        markLanguagesAnnounced(cwd, toAnnounce);
        const showSetupHint = !setupHintShownRef.current;
        setupHintShownRef.current = true;
        setLiveItems((prev) => [
          ...prev,
          { kind: "style_pack", added: toAnnounce, showSetupHint, id: getId() },
        ]);
      }
      // First-time-per-project auto-run. Fires only on the initial mount
      // detection path — not on tool/input triggers — so we don't surprise
      // users mid-session. Persisted across sessions via setup-history.json.
      if (source === "initial" && isFirstTimeSetup(cwd)) {
        markSetupAudited(cwd);
        void triggerAutoSetupRef.current();
      }
    } catch (err) {
      log("WARN", "language", `Detection apply failed (${source}): ${(err as Error).message}`);
    }
  };

  // Initial language detection — runs once on mount so existing projects with
  // marker files (package.json, Cargo.toml, etc.) get their style packs from
  // turn 1, with a visible badge.
  useEffect(() => {
    void applyLanguageDetectionRef.current("initial");
  }, []);

  // Rebuild system prompt when plan mode changes
  useEffect(() => {
    void replaceSystemPrompt({ planMode });
  }, [planMode, replaceSystemPrompt]);

  // Wire onEnterPlan callback ref
  useEffect(() => {
    if (props.onEnterPlanRef) {
      props.onEnterPlanRef.current = (reason?: string) => {
        setPlanMode(true);
        const msg = reason ? `Plan Mode Activated — ${reason}` : "Plan Mode Activated";
        setLiveItems((prev) => [
          ...prev,
          { kind: "plan_transition", text: msg, active: true, id: getId() },
        ]);
      };
    }
  }, [props.onEnterPlanRef]);

  // Wire onExitPlan callback ref
  useEffect(() => {
    if (props.onExitPlanRef) {
      props.onExitPlanRef.current = async (planPath: string) => {
        // Deactivate plan mode, store approved plan path, open pane
        planModeStateRef.current = false;
        setPlanMode(false);
        approvedPlanPathRef.current = planPath;
        await replaceSystemPrompt({ planMode: false, approvedPlanPath: planPath });
        // Use setTimeout to open pane after the current tool execution completes,
        // so the turn can finish and the UI transitions cleanly
        // Flag that the plan overlay is about to open — suppresses the
        // premature "done" status that fires when the agent loop finishes
        planOverlayPendingRef.current = true;
        setTimeout(() => {
          setPlanAutoExpand(true);
          setOverlay("plan");
          // Don't clear planOverlayPendingRef here — keep it true until
          // the user actually approves/rejects the plan. Clearing it on a
          // timer causes a race where agent_done fires after the 300ms
          // timeout but before the user interacts, triggering a premature
          // completion sound.
        }, 300);
        return (
          "Plan submitted. Exiting plan mode.\n" +
          "The plan pane is opening for user review.\n" +
          "Plan saved at: " +
          planPath
        );
      };
    }
  }, [props.onExitPlanRef, replaceSystemPrompt]);

  const appendMessagesToSession = useCallback(
    async (sessionPath: string, messages: readonly Message[], startIndex: number) => {
      const sm = sessionManagerRef.current;
      if (!sm) return;
      await appendSessionMessages(sm, sessionPath, messages, startIndex);
    },
    [],
  );

  const persistCompactedSession = useCallback(
    async (compactedMessages: readonly Message[]): Promise<void> => {
      const sm = sessionManagerRef.current;
      if (!sm) return;
      const session = await createCompactedSessionCheckpoint(sm, {
        cwd: cwdRef.current,
        provider: currentProvider,
        model: currentModel,
        messages: compactedMessages,
      });
      sessionPathRef.current = session.path;
      persistedIndexRef.current = compactedMessages.length;
      if (sessionStore) {
        sessionStore.sessionPath = session.path;
        sessionStore.messages = [...compactedMessages];
      }
      log("INFO", "compaction", "Persisted compacted session checkpoint", { path: session.path });
    },
    [currentModel, currentProvider, sessionStore],
  );

  const persistNewMessages = useCallback(async () => {
    const sp = sessionPathRef.current;
    if (!sp) return;
    const allMsgs = messagesRef.current;
    await appendMessagesToSession(sp, allMsgs, persistedIndexRef.current);
    persistedIndexRef.current = allMsgs.length;
    if (sessionStore) {
      sessionStore.messages = [...allMsgs];
      sessionStore.sessionPath = sp;
    }
  }, [appendMessagesToSession, sessionStore]);

  /**
   * Run the language detector against the current cwd. If the detected set is a
   * strict superset of what's already injected, rebuild the system prompt with
   * the expanded set and swap `messagesRef.current[0]`.
   *
   * Called from `onToolEnd` after `write`/`bash` succeeds — these are the only
   * tools that can introduce new marker files (package.json, Cargo.toml, etc.).
   * Other tool kinds skip detection entirely to avoid wasted filesystem stats.
   *
   * No restart required: the system prompt is mutated in place, same mechanism
   * already used for plan mode + pixel-fix chdir.
   *
   * Stored in a ref so `onToolEnd` (whose useCallback dep array is intentionally
   * empty to keep agent-loop options stable) can call the freshest version.
   */
  const maybeInjectLanguagePacksRef = useRef<(toolName: string, isError: boolean) => Promise<void>>(
    async () => {},
  );
  maybeInjectLanguagePacksRef.current = async (toolName, isError) => {
    if (isError) return;
    if (toolName !== "write" && toolName !== "bash") return;
    await applyLanguageDetectionRef.current("tool");
  };

  // ── Compaction ─────────────────────────────────────────

  // Load settings for auto-compaction
  const settingsRef = useRef<SettingsManager | null>(null);
  useEffect(() => {
    if (props.settingsFile) {
      const sm = new SettingsManager(props.settingsFile);
      sm.load().then(() => {
        settingsRef.current = sm;
      });
    }
  }, [props.settingsFile]);

  const compactionAbortRef = useRef<AbortController | null>(null);

  const compactConversation = useCallback(
    async (messages: Message[], signal?: AbortSignal): Promise<Message[]> => {
      const contextWindow = getContextWindow(currentModel, contextWindowOptions);
      const tokensBefore = estimateConversationTokens(messages);
      const spinId = getId();
      log("INFO", "compaction", `Running compaction`, {
        messages: String(messages.length),
        estimatedTokens: String(tokensBefore),
        contextWindow: String(contextWindow),
      });

      // Show animated spinner
      setLiveItems((prev) => [...prev, { kind: "compacting", id: spinId }]);

      const ownedAbort = signal ? null : new AbortController();
      const compactionSignal = signal ?? ownedAbort?.signal;
      if (ownedAbort) compactionAbortRef.current = ownedAbort;

      try {
        // Resolve fresh credentials for compaction too
        let compactApiKey = activeApiKey;
        let compactAccountId = activeAccountId;
        let compactProjectId = activeProjectId;
        let compactBaseUrl = activeBaseUrl;
        if (props.authStorage) {
          const creds = await props.authStorage.resolveCredentials(currentProvider);
          compactApiKey = creds.accessToken;
          compactAccountId = creds.accountId;
          compactProjectId = creds.projectId;
          compactBaseUrl = creds.baseUrl ?? compactBaseUrl;
        }

        const result = await compact(messages, {
          provider: currentProvider,
          model: currentModel,
          apiKey: compactApiKey,
          accountId: compactAccountId,
          projectId: compactProjectId,
          baseUrl: compactBaseUrl,
          contextWindow,
          signal: compactionSignal,
          approvedPlanPath: approvedPlanPathRef.current,
        });

        if (result.result.compacted) {
          // Replace spinner with completed notice
          setLiveItems((prev) =>
            prev.map((item) =>
              item.id === spinId
                ? ({
                    kind: "compacted",
                    originalCount: result.result.originalCount,
                    newCount: result.result.newCount,
                    tokensBefore: result.result.tokensBeforeEstimate,
                    tokensAfter: result.result.tokensAfterEstimate,
                    id: spinId,
                  } as CompactedItem)
                : item,
            ),
          );
        } else {
          // Nothing was actually compacted — remove spinner silently
          log("INFO", "compaction", `Compaction skipped: ${result.result.reason ?? "unknown"}`);
          setLiveItems((prev) => prev.filter((item) => item.id !== spinId));
        }

        return result.messages;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          compactionSignal?.aborted || msg.includes("aborted") || msg.includes("abort");
        log(
          isAbort ? "WARN" : "ERROR",
          "compaction",
          isAbort ? "Compaction aborted" : `Compaction failed: ${msg}`,
        );
        setLiveItems((prev) =>
          isAbort
            ? prev.filter((item) => item.id !== spinId)
            : prev.map((item) =>
                item.id === spinId ? toErrorItem(err, spinId, "Compaction failed") : item,
              ),
        );
        return messages; // Return unchanged on failure/abort
      } finally {
        if (ownedAbort && compactionAbortRef.current === ownedAbort)
          compactionAbortRef.current = null;
      }
    },
    [
      currentModel,
      currentProvider,
      activeApiKey,
      activeAccountId,
      activeProjectId,
      activeBaseUrl,
      contextWindowOptions,
      props.authStorage,
    ],
  );

  const getRepoMapSignalCount = useCallback((): number => {
    return (
      (props.repoMapChangedFilesRef?.current.size ?? 0) +
      (props.repoMapReadFilesRef?.current.size ?? 0)
    );
  }, [props.repoMapChangedFilesRef, props.repoMapReadFilesRef]);

  const getRepoMapBudget = useCallback((): number => {
    const userTurns = messagesRef.current.filter((message) => message.role === "user").length;
    const readCount = props.repoMapReadFilesRef?.current.size ?? 0;
    if (userTurns <= 1 && readCount === 0) return FIRST_TURN_REPO_MAP_MAX_CHARS;
    if (readCount > 0) return FOCUSED_REPO_MAP_MAX_CHARS;
    return FOCUSED_REPO_MAP_MAX_CHARS + 1000;
  }, [props.repoMapReadFilesRef]);

  const refreshRepoMap = useCallback(
    async (latestUserPrompt?: string): Promise<string> => {
      const rendered = await buildRepoMap({
        cwd: cwdRef.current,
        maxChars: getRepoMapBudget(),
        changedFiles: [...(props.repoMapChangedFilesRef?.current ?? new Set<string>())],
        readFiles: [...(props.repoMapReadFilesRef?.current ?? new Set<string>())],
        focusTerms: latestUserPrompt ? [latestUserPrompt] : [],
        cache: repoMapCacheRef.current,
      });
      repoMapMarkdownRef.current = rendered.markdown;
      repoMapSnapshotRef.current = rendered.snapshot;
      repoMapChangedCountRef.current = getRepoMapSignalCount();
      repoMapDirtyRef.current = false;
      return rendered.markdown;
    },
    [
      getRepoMapBudget,
      getRepoMapSignalCount,
      props.repoMapChangedFilesRef,
      props.repoMapReadFilesRef,
    ],
  );

  const stripRepoMapMessages = useCallback((messages: readonly Message[]): Message[] => {
    return stripRepoMapContextMessages(messages);
  }, []);

  const injectRepoMapContext = useCallback(
    async (messages: Message[]): Promise<Message[]> => {
      if (!repoMapInjectionEnabledRef.current) return stripRepoMapMessages(messages);
      const stripped = stripRepoMapMessages(messages);
      const latestUserPrompt = getLatestUserText(stripped);
      const signalCount = getRepoMapSignalCount();
      if (signalCount !== repoMapChangedCountRef.current) repoMapDirtyRef.current = true;
      if (repoMapDirtyRef.current || !repoMapMarkdownRef.current) {
        await refreshRepoMap(latestUserPrompt);
      }
      if (!repoMapMarkdownRef.current) return stripped;
      return injectRepoMapContextMessages(stripped, repoMapMarkdownRef.current);
    },
    [props.repoMapChangedFilesRef, props.repoMapReadFilesRef, refreshRepoMap, stripRepoMapMessages],
  );

  /**
   * transformContext callback for the agent loop.
   * Called before each LLM call and on context overflow.
   * Compacts persistent chat only, then injects the dynamic repo map transiently.
   */
  const transformContext = useCallback(
    async (messages: Message[], options?: { force?: boolean }): Promise<Message[]> => {
      const stripped = stripRepoMapMessages(messages);
      const settings = settingsRef.current;
      const autoCompact = settings?.get("autoCompact") ?? true;
      const threshold = settings?.get("compactThreshold") ?? 0.8;

      // Force-compact on context overflow regardless of settings
      if (options?.force) {
        const result = await compactConversation(stripped);
        if (result !== stripped) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return injectRepoMapContext(result);
      }

      if (!autoCompact) return injectRepoMapContext(stripped);

      // Time-based cooldown: skip if compaction ran within the last 30 seconds
      if (Date.now() - lastCompactionTimeRef.current < 30_000) {
        log("INFO", "compaction", `Skipping compaction — cooldown active`);
        return injectRepoMapContext(stripped);
      }

      const contextWindow = getContextWindow(currentModel, contextWindowOptions);
      const reserveTokens = getCompactionReserveTokens(props.maxTokens);
      const tokensFresh = lastActualTokensTimestampRef.current > lastCompactionTimeRef.current;
      const actualTokens =
        lastActualTokensRef.current > 0 && tokensFresh ? lastActualTokensRef.current : undefined;
      if (shouldCompact(stripped, contextWindow, threshold, actualTokens, reserveTokens)) {
        const result = await compactConversation(stripped);
        if (result !== stripped) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return injectRepoMapContext(result);
      }
      return injectRepoMapContext(stripped);
    },
    [
      currentModel,
      compactConversation,
      contextWindowOptions,
      injectRepoMapContext,
      persistCompactedSession,
      stripRepoMapMessages,
    ],
  );

  // ── Background task bar state (external store) ──────────
  const {
    bgTasks,
    focused: taskBarFocused,
    expanded: taskBarExpanded,
    selectedIndex: selectedTaskIndex,
  } = useTaskBarStore();
  useTaskBarPolling(props.processManager);

  const handleFocusTaskBar = useCallback(() => focusTaskBar(), []);
  const handleTaskBarExit = useCallback(() => exitTaskBar(), []);
  const handleTaskBarExpand = useCallback(() => expandTaskBar(), []);
  const handleTaskBarCollapse = useCallback(() => collapseTaskBar(), []);
  const handleTaskKill = useCallback(
    (id: string) => {
      if (props.processManager) killTask(props.processManager, id);
    },
    [props.processManager],
  );
  const handleTaskNavigate = useCallback((index: number) => navigateTaskBar(index), []);

  // Resolve fresh OAuth credentials before each agent loop run.
  // Falls back to the static props when authStorage is not available.
  const resolveCredentials = useCallback(
    async (opts?: { forceRefresh?: boolean }) => {
      if (props.authStorage) {
        const creds = await props.authStorage.resolveCredentials(currentProvider, opts);
        return {
          apiKey: creds.accessToken,
          accountId: creds.accountId,
          projectId: creds.projectId,
        };
      }
      return { apiKey: activeApiKey!, accountId: activeAccountId, projectId: activeProjectId };
    },
    [props.authStorage, currentProvider, activeApiKey, activeAccountId, activeProjectId],
  );

  const agentLoop = useAgentLoop(
    messagesRef,
    {
      provider: currentProvider,
      model: currentModel,
      tools: currentTools,
      webSearch: props.webSearch,
      maxTokens: props.maxTokens,
      thinking: thinkingEnabled ? getMaxThinkingLevel(currentModel) : undefined,
      apiKey: activeApiKey,
      baseUrl: activeBaseUrl,
      accountId: activeAccountId,
      projectId: activeProjectId,
      resolveCredentials,
      transformContext,
    },
    {
      onComplete: useCallback(() => {
        messagesRef.current = stripRepoMapMessages(messagesRef.current);
        persistNewMessages();
        // Auto-clear plan progress and approved plan when all steps are completed
        const steps = planStepsRef.current;
        if (steps.length > 0 && steps.every((s) => s.completed)) {
          planStepsRef.current = [];
          setPlanSteps([]);
          approvedPlanPathRef.current = undefined;
          // Rebuild system prompt to remove the completed plan from context
          void replaceSystemPrompt({ clearApprovedPlan: true });
        }

        // Generate session title after the first turn (background, best-effort)
        if (!sessionTitleGeneratedRef.current) {
          sessionTitleGeneratedRef.current = true;
          const msgs = messagesRef.current;
          // Find the first user message and first assistant text
          const userMsg = msgs.find((m) => m.role === "user");
          const assistantMsg = msgs.find((m) => m.role === "assistant");
          const userText =
            typeof userMsg?.content === "string"
              ? userMsg.content
              : Array.isArray(userMsg?.content)
                ? userMsg.content
                    .filter((c): c is { type: "text"; text: string } => c.type === "text")
                    .map((c) => c.text)
                    .join(" ")
                : "";
          const assistantText =
            typeof assistantMsg?.content === "string"
              ? assistantMsg.content
              : Array.isArray(assistantMsg?.content)
                ? assistantMsg.content
                    .filter((c): c is { type: "text"; text: string } => c.type === "text")
                    .map((c) => c.text)
                    .join(" ")
                : "";
          if (userText) {
            generateSessionTitle({
              provider: currentProvider,
              userMessage: userText,
              assistantPreview: assistantText.slice(0, 200),
              apiKey: activeApiKey,
              baseUrl: activeBaseUrl,
              accountId: activeAccountId,
              resolveCredentials,
            }).then(
              (title) => {
                setSessionTitle(title);
                log("INFO", "title", `Session title generated: ${title}`);
              },
              () => {
                // Best-effort — silently ignore failures
              },
            );
          }
        }
      }, [
        persistNewMessages,
        stripRepoMapMessages,
        planMode,
        props.cwd,
        props.skills,
        currentProvider,
        activeApiKey,
        activeAccountId,
        activeBaseUrl,
        resolveCredentials,
      ]),
      onTurnText: useCallback((text: string, thinking: string, thinkingMs: number) => {
        // Track [DONE:n] markers for plan step progress
        if (planStepsRef.current.length > 0) {
          const completed = findCompletedMarkers(text);
          if (completed.size > 0) {
            const updated = markStepsCompleted(planStepsRef.current, completed);
            if (updated !== planStepsRef.current) {
              planStepsRef.current = updated;
              setPlanSteps(updated);
            }
            // Real progress happened — reset the stuck-guard so the next
            // step gets its own fresh nudge budget.
            followUpNudgesRef.current = { step: 0, count: 0 };
          }
        }

        // Flush all completed items from the previous turn to Static history.
        // This keeps liveItems bounded per-turn, preventing Ink's live area from
        // growing unbounded, which makes Ink's live-area re-renders expensive.
        //
        // Items are queued in pendingFlushRef (not sent to setHistory directly)
        // so the Static write happens in a SEPARATE render cycle from the
        // live-area change — avoiding both Ink cursor-math clipping and the
        // brief duplicate that occurred when setHistory was nested inside the
        // setLiveItems updater.
        setLiveItems((prev) => {
          const flushed = flushOnTurnText(prev);
          if (flushed.length > 0) {
            queueFlush(flushed);
          }
          // Split text on [DONE:N] markers so each marker renders inline as
          // a styled "✓ Step N: <description>" item at the position the
          // agent emitted it, instead of vanishing into stripped whitespace.
          // Falls back to a single assistant item containing the
          // marker-stripped text when there are no markers (keeps the
          // common case zero-cost).
          const segments = segmentDisplayText(text, planStepsRef.current);
          const items: CompletedItem[] = [];
          let thinkingAttached = false;
          for (const seg of segments) {
            if (seg.kind === "text") {
              items.push({
                kind: "assistant",
                text: stripDoneMarkers(seg.text),
                // Attach thinking only to the first text segment so we
                // don't render duplicate ThinkingBlocks when a turn
                // contains multiple text chunks split by markers.
                thinking: thinkingAttached ? undefined : thinking,
                thinkingMs: thinkingAttached ? undefined : thinkingMs,
                planMode: planModeLocalRef.current,
                id: getId(),
              });
              thinkingAttached = true;
            } else {
              items.push({
                kind: "step_done",
                stepNum: seg.stepNum,
                description: seg.description,
                id: getId(),
              });
            }
          }
          // No segments at all (text was empty/whitespace, no markers).
          // Still emit an assistant item so a thinking block renders if
          // there was thinking content for this turn.
          if (items.length === 0) {
            items.push({
              kind: "assistant",
              text: "",
              thinking,
              thinkingMs,
              planMode: planModeLocalRef.current,
              id: getId(),
            });
          }
          return items;
        });
      }, []),
      onToolStart: useCallback(
        (toolCallId: string, name: string, args: Record<string, unknown>) => {
          log("INFO", "tool", `Tool call started: ${name}`, { id: toolCallId });
          const startedAt = Date.now();
          const animateUntil = startedAt + RUNNING_INDICATOR_ANIMATION_MS;

          // Flush completed items (assistant text, finished tools) to Static
          // before adding tool UI. Keeping both in the live area makes it tall
          // and causes Ink's cursor math to clip the top.
          setLiveItems((prev) => {
            const { flushed, remaining } = partitionCompleted(prev);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            return remaining;
          });

          if (name === "subagent") {
            // Create or update the sub-agent group item
            const newAgent: SubAgentInfo = {
              toolCallId,
              task: String(args.task ?? ""),
              agentName: String(args.agent ?? "default"),
              status: "running",
              toolUseCount: 0,
              tokenUsage: { input: 0, output: 0 },
            };
            setLiveItems((prev) => {
              const groupIdx = prev.findIndex((item) => item.kind === "subagent_group");
              if (groupIdx !== -1) {
                const group = prev[groupIdx] as SubAgentGroupItem;
                const next = [...prev];
                next[groupIdx] = {
                  ...group,
                  agents: [...group.agents, newAgent],
                };
                return next;
              }
              return [...prev, { kind: "subagent_group", agents: [newAgent], id: getId() }];
            });
          } else if (AGGREGATABLE_TOOLS.has(name)) {
            // Group concurrent read-only tools into a single compact item
            setLiveItems((prev) => {
              // Find an active tool group (has at least one running tool)
              const groupIdx = prev.findIndex(
                (item) =>
                  item.kind === "tool_group" &&
                  (item as ToolGroupItem).tools.some((t) => t.status === "running"),
              );
              if (groupIdx !== -1) {
                const group = prev[groupIdx] as ToolGroupItem;
                const next = [...prev];
                next[groupIdx] = {
                  ...group,
                  tools: [
                    ...group.tools,
                    { toolCallId, name, args, status: "running", animateUntil },
                  ],
                };
                return next;
              }
              return [
                ...prev,
                {
                  kind: "tool_group",
                  tools: [{ toolCallId, name, args, status: "running", animateUntil }],
                  id: getId(),
                },
              ];
            });
          } else {
            setLiveItems((prev) => [
              ...prev,
              { kind: "tool_start", toolCallId, name, args, id: getId(), startedAt, animateUntil },
            ]);
          }
        },
        [],
      ),
      onToolUpdate: useCallback((toolCallId: string, update: unknown) => {
        const u = update as Record<string, unknown>;

        // Bash progress streaming — append output to tool_start item
        if (u.type === "bash_progress") {
          setLiveItems((prev) => {
            const idx = prev.findIndex(
              (item) => item.kind === "tool_start" && item.toolCallId === toolCallId,
            );
            if (idx === -1) return prev;
            const item = prev[idx] as ToolStartItem;
            const next = [...prev];
            next[idx] = {
              ...item,
              progressOutput: (item.progressOutput ?? "") + String(u.output ?? ""),
            };
            return next;
          });
          return;
        }

        // Subagent updates
        setLiveItems((prev) => {
          const groupIdx = prev.findIndex((item) => item.kind === "subagent_group");
          if (groupIdx === -1) return prev;
          const group = prev[groupIdx] as SubAgentGroupItem;
          const agentIdx = group.agents.findIndex((a) => a.toolCallId === toolCallId);
          if (agentIdx === -1) return prev;

          const saUpdate = update as SubAgentUpdate;
          const updatedAgents = [...group.agents];
          updatedAgents[agentIdx] = {
            ...updatedAgents[agentIdx],
            toolUseCount: saUpdate.toolUseCount,
            tokenUsage: { ...saUpdate.tokenUsage },
            currentActivity: saUpdate.currentActivity,
          };

          const next = [...prev];
          next[groupIdx] = { ...group, agents: updatedAgents };
          return next;
        });
      }, []),
      onToolEnd: useCallback(
        (
          toolCallId: string,
          name: string,
          result: string,
          isError: boolean,
          durationMs: number,
          details?: unknown,
        ) => {
          // Language-pack detection — gated on `write`/`bash` inside the
          // helper; cheap to call unconditionally. Fire-and-forget; the next
          // LLM turn picks up the swapped system prompt automatically.
          void maybeInjectLanguagePacksRef.current(name, isError);
          const level = isError ? "ERROR" : "INFO";
          log(level as "INFO" | "ERROR", "tool", `Tool call ended: ${name}`, {
            id: toolCallId,
            duration: `${durationMs}ms`,
            isError: String(isError),
          });
          if (name === "subagent") {
            setLiveItems((prev) => {
              const groupIdx = prev.findIndex((item) => item.kind === "subagent_group");
              if (groupIdx === -1) return prev;
              const group = prev[groupIdx] as SubAgentGroupItem;
              const agentIdx = group.agents.findIndex((a) => a.toolCallId === toolCallId);
              if (agentIdx === -1) return prev;

              const saDetails = details as SubAgentDetails | undefined;
              const updatedAgents = [...group.agents];
              updatedAgents[agentIdx] = {
                ...updatedAgents[agentIdx],
                status: isError ? "error" : "done",
                result,
                durationMs: saDetails?.durationMs ?? durationMs,
                toolUseCount: saDetails?.toolUseCount ?? updatedAgents[agentIdx].toolUseCount,
                tokenUsage: saDetails?.tokenUsage ?? updatedAgents[agentIdx].tokenUsage,
              };

              const next = [...prev];
              next[groupIdx] = { ...group, agents: updatedAgents };

              // Flush completed items to Static to keep the live area small
              const { flushed, remaining } = partitionCompleted(next);
              if (flushed.length > 0) {
                queueFlush(flushed);
              }
              return remaining;
            });
          } else {
            setLiveItems((prev) => {
              // Check if this tool is in a tool_group
              const groupIdx = prev.findIndex(
                (item) =>
                  item.kind === "tool_group" &&
                  (item as ToolGroupItem).tools.some((t) => t.toolCallId === toolCallId),
              );
              let updated: CompletedItem[];
              if (groupIdx !== -1) {
                const group = prev[groupIdx] as ToolGroupItem;
                updated = [...prev];
                updated[groupIdx] = {
                  ...group,
                  tools: group.tools.map((t) =>
                    t.toolCallId === toolCallId
                      ? { ...t, status: "done" as const, result, isError }
                      : t,
                  ),
                };
              } else {
                // Find the matching tool_start and replace it with tool_done
                const startIdx = prev.findIndex(
                  (item) => item.kind === "tool_start" && item.toolCallId === toolCallId,
                );
                if (startIdx !== -1) {
                  const startItem = prev[startIdx] as ToolStartItem;
                  const doneItem: ToolDoneItem = {
                    kind: "tool_done",
                    name,
                    args: startItem.args,
                    result,
                    isError,
                    durationMs,
                    details,
                    id: startItem.id,
                  };
                  updated = [...prev];
                  updated[startIdx] = doneItem;
                } else {
                  // Fallback: just append
                  updated = [
                    ...prev,
                    {
                      kind: "tool_done",
                      name,
                      args: {},
                      result,
                      isError,
                      durationMs,
                      details,
                      id: getId(),
                    },
                  ];
                }
              }

              // Flush completed items to Static to keep the live area small
              const { flushed, remaining } = partitionCompleted(updated);
              if (flushed.length > 0) {
                queueFlush(flushed);
                return remaining;
              }
              // Overflow flush: if live area is still large, flush aggressively
              const overflow = flushOverflow(updated);
              if (overflow.flushed.length > 0) {
                queueFlush(overflow.flushed);
                return overflow.remaining;
              }
              return remaining;
            });
          }
        },
        [],
      ),
      onServerToolCall: useCallback((id: string, name: string, input: unknown) => {
        log("INFO", "server_tool", `Server tool call: ${name}`, { id });
        const startedAt = Date.now();
        const animateUntil = startedAt + RUNNING_INDICATOR_ANIMATION_MS;
        // Flush completed items (including assistant text) to Static before
        // adding server tool UI — same rationale as onToolStart.
        setLiveItems((prev) => {
          const { flushed, remaining } = partitionCompleted(prev);
          if (flushed.length > 0) {
            queueFlush(flushed);
          }
          return [
            ...remaining,
            {
              kind: "server_tool_start",
              serverToolCallId: id,
              name,
              input,
              startedAt,
              animateUntil,
              id: getId(),
            },
          ];
        });
      }, []),
      onServerToolResult: useCallback((toolUseId: string, resultType: string, data: unknown) => {
        log("INFO", "server_tool", `Server tool result`, { toolUseId, resultType });
        setLiveItems((prev) => {
          let updated: CompletedItem[];
          const startIdx = prev.findIndex(
            (item) => item.kind === "server_tool_start" && item.serverToolCallId === toolUseId,
          );
          if (startIdx !== -1) {
            const startItem = prev[startIdx] as ServerToolStartItem;
            const doneItem: ServerToolDoneItem = {
              kind: "server_tool_done",
              name: startItem.name,
              input: startItem.input,
              resultType,
              data,
              durationMs: Date.now() - startItem.startedAt,
              id: startItem.id,
            };
            updated = [...prev];
            updated[startIdx] = doneItem;
          } else {
            updated = [
              ...prev,
              {
                kind: "server_tool_done",
                name: "unknown",
                input: {},
                resultType,
                data,
                durationMs: 0,
                id: getId(),
              },
            ];
          }
          // Flush completed items to Static
          const { flushed, remaining } = partitionCompleted(updated);
          if (flushed.length > 0) {
            queueFlush(flushed);
          }
          return remaining;
        });
      }, []),
      onTurnEnd: useCallback(
        (
          turn: number,
          stopReason: string,
          usage: {
            inputTokens: number;
            outputTokens: number;
            cacheRead?: number;
            cacheWrite?: number;
          },
        ) => {
          log("INFO", "turn", `Turn ${turn} ended`, {
            stopReason,
            inputTokens: String(usage.inputTokens),
            outputTokens: String(usage.outputTokens),
            ...(usage.cacheRead != null && { cacheRead: String(usage.cacheRead) }),
            ...(usage.cacheWrite != null && { cacheWrite: String(usage.cacheWrite) }),
          });
          // Track actual token count for compaction decisions.
          // Anthropic has separate input/output limits — only count input.
          // All other providers share the context window — count both.
          const inputContext = usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          lastActualTokensRef.current =
            currentProvider === "anthropic" ? inputContext : inputContext + usage.outputTokens;
          lastActualTokensTimestampRef.current = Date.now();
          // For tool-only turns (no text), flush completed items to Static so
          // liveItems doesn't grow unbounded across consecutive tool-only turns.
          setLiveItems((prev) => {
            const { flushed, remaining } = flushOnTurnEnd(prev, stopReason);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            return remaining;
          });
        },
        [],
      ),
      onDone: useCallback((durationMs: number, toolsUsed: string[]) => {
        log("INFO", "agent", `Agent done`, {
          duration: `${durationMs}ms`,
          toolsUsed: toolsUsed.join(",") || "none",
        });
        // Don't show "done" status when plan overlay is about to open —
        // the agent loop finished but we're waiting for user plan review
        if (planOverlayPendingRef.current) return;
        setDoneStatus({ durationMs, toolsUsed, verb: pickDurationVerb(toolsUsed) });
        playNotificationSound();
        // Two-phase flush to avoid Ink text clipping.
        // Phase 1 (here): clear the live area so Ink commits a render with
        // the smaller output and updates its internal line counter.
        // Phase 2 (useEffect below): push items to Static history in a
        // separate render cycle so the Static write never coincides with
        // a live-area height change in the same frame.
        setLiveItems((prev) => {
          if (prev.length > 0) queueFlush(prev);
          return [];
        });

        // Run-all: auto-start next pending task after a short delay
        // (allow the two-phase flush to complete first)
        if (runAllTasksRef.current) {
          setTimeout(() => {
            const cwd = cwdRef.current;
            const next = getNextPendingTask(cwd);
            if (next) {
              markTaskInProgress(cwd, next.id);
              startTaskRef.current(next.title, next.prompt, next.id);
            } else {
              setRunAllTasks(false);
              log("INFO", "tasks", "Run-all complete — no more pending tasks");
            }
          }, 500);
        }

        // Goal loop: after the orchestrator handles a worker/verifier event,
        // continue the same Goal automatically until it reaches a terminal state.
        for (const runId of [...runningGoalIdsRef.current]) {
          setTimeout(() => continueGoalRun(runId), 500);
        }

        // Pixel fix: observe branch + commits, patch status, optionally pick
        // up the next open error if run-all is active.
        const pendingFix = currentPixelFixRef.current;
        if (pendingFix) {
          currentPixelFixRef.current = null;
          void (async () => {
            try {
              const { finalizePixelFix } = await import("../core/pixel-fix.js");
              const result = await finalizePixelFix(pendingFix);
              log("INFO", "pixel", `Pixel fix done: ${result.outcome}`, {
                errorId: pendingFix.errorId,
                reason: result.reason,
              });
            } catch (err) {
              log("ERROR", "pixel", `Pixel finalize failed: ${(err as Error).message}`);
            }

            if (runAllPixelRef.current) {
              setTimeout(() => {
                void (async () => {
                  const { fetchPixelEntries } = await import("../core/pixel.js");
                  const data = await fetchPixelEntries();
                  const next = data.entries.find((e) => e.status === "open");
                  if (next) {
                    startPixelFixRef.current(next.errorId);
                  } else {
                    setRunAllPixel(false);
                    log("INFO", "pixel", "Run-all complete — no more open errors");
                  }
                })();
              }, 500);
            }
          })();
        }
      }, []),
      onAborted: useCallback(() => {
        log("WARN", "agent", "Agent run aborted by user");
        setRunAllTasks(false);
        setRunAllPixel(false);
        currentPixelFixRef.current = null;
        setDoneStatus(null);
        setLiveItems((prev) => {
          const next = prev.map((item): CompletedItem => {
            if (item.kind === "subagent_group") return { ...item, aborted: true };
            // Convert running tools to stopped state so spinners stop
            if (item.kind === "tool_start") {
              return {
                kind: "tool_done",
                name: item.name,
                args: item.args,
                result: "Stopped.",
                isError: true,
                durationMs: 0,
                id: item.id,
              };
            }
            if (item.kind === "server_tool_start") {
              return {
                kind: "server_tool_done",
                name: item.name,
                input: item.input,
                resultType: "aborted",
                data: null,
                durationMs: 0,
                id: item.id,
              };
            }
            if (item.kind === "tool_group") {
              const tools = (item as ToolGroupItem).tools.map((t) =>
                t.status === "running"
                  ? { ...t, status: "done" as const, result: "Stopped.", isError: true }
                  : t,
              );
              return { ...item, tools } as ToolGroupItem;
            }
            // Remove compaction spinner (compaction can't complete after abort)
            if (item.kind === "compacting") {
              return { kind: "tombstone", id: item.id };
            }
            return item;
          });
          return [...next, { kind: "stopped", text: "Request was stopped.", id: getId() }];
        });
      }, []),
      onQueuedStart: useCallback((content: UserContent) => {
        // When a queued message starts processing, show it as a UserItem
        // and flush prior items to history. Synthetic system events are hidden
        // from the transcript but still routed through the main agent context.
        const displayText =
          typeof content === "string"
            ? content
            : content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        if (isGoalSyntheticEvent(displayText)) {
          const eventInfo = parseGoalSyntheticEvent(displayText);
          setLiveItems((prev) => {
            if (prev.length > 0) queueFlush(prev);
            return [];
          });
          setDoneStatus(null);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "orchestrator_reviewing",
            title: "Orchestrator reviewing Goal update",
            detail:
              eventInfo?.kind === "worker"
                ? `Worker ${eventInfo.worker ?? "finished"} reported back${eventInfo.task ? ` on ${eventInfo.task}` : ""}. Inspecting Goal state.`
                : `Verifier reported ${eventInfo?.status ?? "status"}. Inspecting evidence and next action.`,
            workerId: eventInfo?.worker,
            status: eventInfo?.status,
          });
          return;
        }
        const imageCount =
          typeof content === "string"
            ? undefined
            : content.filter((c) => c.type === "image").length || undefined;
        setLiveItems((prev) => {
          if (prev.length > 0) queueFlush(prev);
          return [];
        });
        const userItem: UserItem = {
          kind: "user",
          text: displayText,
          imageCount,
          id: getId(),
        };
        setLastUserMessage(displayText);
        setDoneStatus(null);
        setLiveItems([userItem]);
      }, []),
      // Inject a "continue with the next step" follow-up when the agent
      // would otherwise stop mid-plan. The prompt-only instruction wasn't
      // enough — some models (notably Opus) treat each [DONE:n] as a
      // natural completion boundary regardless. The stuck-guard caps
      // nudges per step so a genuinely blocked agent surfaces.
      getFollowUpMessages: useCallback(() => {
        const steps = planStepsRef.current;
        if (steps.length === 0 || !approvedPlanPathRef.current) return null;
        const next = steps.find((s) => !s.completed);
        if (!next) return null;
        const r = followUpNudgesRef.current;
        if (r.step !== next.step) {
          r.step = next.step;
          r.count = 0;
        }
        if (r.count >= 2) return null;
        r.count++;
        return [
          {
            role: "user" as const,
            content:
              `Continue with step ${next.step}: ${next.text}. ` +
              `Emit [DONE:${next.step}] when done, then proceed to step ${next.step + 1} ` +
              `in the same turn. Only stop when every step in \`## Steps\` is complete ` +
              `or you genuinely need user input.`,
          },
        ];
      }, []),
    },
  );

  // First-time-per-project auto-run of /setup. Bound after `agentLoop` is in
  // scope so the ref closure can dispatch to it. Called from the initial
  // language-detection path when `isFirstTimeSetup(cwd)` is true. Pushes a
  // notice item explaining what's happening, then runs the audit prompt.
  triggerAutoSetupRef.current = async () => {
    const setupCmd = getPromptCommand("setup");
    if (!setupCmd) {
      log("WARN", "setup", "Auto-setup skipped — /setup command not found in registry.");
      return;
    }
    log("INFO", "setup", `Auto-running /setup (first session for ${cwdRef.current})`);
    setLiveItems((prev) => [
      ...prev,
      {
        kind: "info",
        text:
          "First time in this project — auto-running /setup to audit hygiene, tooling, and style-pack alignment. " +
          "Press Esc to cancel.",
        id: getId(),
      },
      { kind: "user", text: "/setup", id: getId() },
    ]);
    setLastUserMessage("/setup");
    setDoneStatus(null);
    try {
      await agentLoop.run(setupCmd.prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = msg.includes("aborted") || msg.includes("abort");
      log(isAbort ? "INFO" : "ERROR", "setup", `Auto-setup ended: ${msg}`);
      setLiveItems((prev) => [
        ...prev,
        isAbort
          ? { kind: "stopped", text: "Auto-setup cancelled.", id: getId() }
          : toErrorItem(err, getId()),
      ]);
    }
  };

  // Phase 2 of the two-phase flush: after onDone clears liveItems (phase 1)
  // and Ink renders the smaller live area (updating its internal line
  // counter), this effect pushes the stashed items into Static history.
  // Because the Static write happens in a SEPARATE render cycle from the
  // live-area shrink, Ink's log-update never needs to erase the old tall
  // live area AND write Static content in the same frame — avoiding the
  // cursor-math mismatch that caused text clipping.
  useEffect(() => {
    if (pendingFlushRef.current.length > 0) {
      const items = pendingFlushRef.current;
      pendingFlushRef.current = [];
      setHistory((h) => {
        const next = compactHistory([...h, ...trimFlushedItems(items)]);
        if (sessionStore) sessionStore.history = next;
        return next;
      });
      if (sessionStore) sessionStore.liveItems = liveItems;
    }
  }, [flushGeneration]);

  // Sync terminal title with agent loop state
  useEffect(() => {
    setTitleRunning(agentLoop.isRunning);
  }, [agentLoop.isRunning]);

  // Mirror agent running state into sessionStore so renderApp's resize
  // handler and overlay toggles can skip their unmount/remount while the
  // agent is in flight (unmounting fires useAgentLoop's cleanup which
  // aborts the in-flight request). On the running→idle transition,
  // consume any pendingResetUI flag set during the run by scheduling a
  // deferred resetUI to clean up accumulated log-update drift. The 100ms
  // setTimeout lets onDone's two-phase flush commit to sessionStore.history
  // first, so the chat isn't lost. The cleanup also bails if the user
  // started a new run before the timer fires, to avoid aborting it.
  useEffect(() => {
    if (!sessionStore) return;
    sessionStore.isAgentRunning = agentLoop.isRunning;
    if (!agentLoop.isRunning && sessionStore.pendingResetUI) {
      sessionStore.pendingResetUI = false;
      const timer = setTimeout(() => {
        if (sessionStore.isAgentRunning) return;
        props.resetUI?.();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [agentLoop.isRunning, sessionStore, props.resetUI]);

  // Consume sessionStore.pendingAction once on mount. Set by resetUI options
  // for paths that remount AND immediately drive the agent (plan accept,
  // plan reject, startTask, pixel fix). The action survives the unmount
  // because it lives in renderApp's closure (sessionStore), not React state.
  useEffect(() => {
    if (pendingActionConsumedRef.current) return;
    const action = sessionStore?.pendingAction;
    if (!action) return;
    pendingActionConsumedRef.current = true;
    if (sessionStore) sessionStore.pendingAction = undefined;
    if (action.planEvent) {
      const ev = action.planEvent;
      setLiveItems((prev) => [
        ...prev,
        { kind: "plan_event", event: ev.event, detail: ev.detail, id: getId() },
      ]);
    } else if (action.infoText) {
      setLiveItems((prev) => [
        ...prev,
        { kind: "info", text: action.infoText as string, id: getId() },
      ]);
    }
    setDoneStatus(null);
    void agentLoop.run(action.prompt).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("ERROR", "error", errMsg);
      setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
    });
    // Intentional one-shot: run once on mount, never re-fire on re-render.
  }, []);

  // Refresh eyes badge count when the agent settles (end of a turn) — a turn
  // may have logged new rough/wish/blocked signals. Also covers the case where
  // /eyes was run for the first time (manifest now exists).
  useEffect(() => {
    if (!agentLoop.isRunning) {
      setEyesCount(
        isEyesActive(props.cwd) ? journalCount({ status: "open" }, props.cwd) : undefined,
      );
    }
  }, [agentLoop.isRunning, props.cwd]);

  const handleSubmit = useCallback(
    async (input: string, inputImages: ImageAttachment[] = [], pasteInfo?: PasteInfo) => {
      const trimmed = input.trim();

      if (trimmed.startsWith("/")) {
        log("INFO", "command", `Slash command: ${trimmed}`);
      } else {
        const truncated = trimmed.length > 100 ? trimmed.slice(0, 100) + "..." : trimmed;
        log(
          "INFO",
          "input",
          `User input: ${truncated}${inputImages.length > 0 ? ` (+${inputImages.length} image${inputImages.length > 1 ? "s" : ""})` : ""}`,
        );
        // Re-detect on every user submit — cheap (fs stats only). Catches
        // external changes between turns and ensures non-writing prompts still
        // surface the badge when packs are newly applicable. No-op if the set
        // has not grown.
        await applyLanguageDetectionRef.current("input");
      }

      // Handle /model directly — open inline selector
      if (trimmed === "/model" || trimmed === "/m" || trimmed === "/models") {
        setOverlay("model");
        return;
      }

      // Handle /compact — compact conversation
      if (trimmed === "/compact" || trimmed === "/c") {
        const ac = new AbortController();
        compactionAbortRef.current = ac;
        const compacted = await compactConversation(messagesRef.current, ac.signal);
        if (!ac.signal.aborted && compacted !== messagesRef.current) {
          messagesRef.current = compacted;
          await persistCompactedSession(compacted);
        }
        if (compactionAbortRef.current === ac) compactionAbortRef.current = null;
        return;
      }

      // Handle /quit — exit the agent
      if (trimmed === "/quit" || trimmed === "/q" || trimmed === "/exit") {
        process.exit(0);
      }

      // Handle /clear — tear down the entire Ink instance and rebuild fresh.
      // Avoid direct ANSI terminal clears here; they can erase scrollback.
      // Runtime state (model, provider, thinking) survives via renderApp's
      // closure-held `runtimeState`, mirrored from React state via the
      // useEffects above.
      if (trimmed === "/clear") {
        if (props.resetUI) {
          void (async () => {
            const newPrompt = await rebuildSystemPrompt({ clearApprovedPlan: true });
            props.resetUI?.({
              wipeSession: true,
              messages: [{ role: "system" as const, content: newPrompt }],
            });
          })();
          return;
        }
        // Fallback path (resetUI not wired — e.g. tests). Best-effort: clear
        // React state in place without touching terminal scrollback.
        pendingFlushRef.current = [];
        setHistory([{ kind: "banner", id: "banner" }]);
        setLiveItems([]);
        setDoneStatus(null);
        approvedPlanPathRef.current = undefined;
        planStepsRef.current = [];
        setPlanSteps([]);
        void (async () => {
          const newPrompt = await rebuildSystemPrompt({ clearApprovedPlan: true });
          messagesRef.current = [{ role: "system" as const, content: newPrompt }];
          persistedIndexRef.current = messagesRef.current.length;
        })();
        agentLoop.reset();
        setSessionTitle(undefined);
        sessionTitleGeneratedRef.current = false;
        setLiveItems([{ kind: "info", text: "Session cleared.", id: getId() }]);
        return;
      }

      // Handle /theme — open theme selector overlay
      if (trimmed === "/theme" || trimmed === "/t") {
        setOverlay("theme");
        return;
      }

      // Open the Eyes pane — read-only review of installed probes + open signals.
      // Gated by the ggcoder-eyes manifest: in projects without /eyes set up,
      // there's nothing useful to show.
      if (trimmed === "/eyes-view" || trimmed === "/ev") {
        if (!isEyesActive(props.cwd)) {
          setLiveItems((prev) => [
            ...prev,
            {
              kind: "info",
              text: "Eyes not set up in this project. Run /setup-eyes to get started.",
              id: getId(),
            },
          ]);
          return;
        }
        setOverlay("eyes");
        return;
      }

      // Handle /plan — toggle plan mode
      if (trimmed === "/plan" || trimmed === "/plan on") {
        setPlanMode(true);
        setLiveItems((prev) => [
          ...prev,
          { kind: "plan_transition", text: "Plan Mode Activated", active: true, id: getId() },
        ]);
        return;
      }
      if (trimmed === "/plan off") {
        setPlanMode(false);
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "plan_transition",
            text: "Plan Mode Deactivated",
            active: false,
            id: getId(),
          },
        ]);
        return;
      }

      // Handle /clearplan — dismiss the approved plan
      if (trimmed === "/clearplan") {
        approvedPlanPathRef.current = undefined;
        planStepsRef.current = [];
        setPlanSteps([]);
        // Rebuild system prompt without the plan
        void replaceSystemPrompt({ clearApprovedPlan: true });
        setLiveItems([{ kind: "plan_event", event: "dismissed", id: getId() }]);
        return;
      }

      // Handle /map — show, refresh, or toggle dynamic repo map injection
      if (
        trimmed === "/map" ||
        trimmed === "/map refresh" ||
        trimmed === "/map on" ||
        trimmed === "/map off"
      ) {
        const action = trimmed.slice("/map".length).trim();
        if (action === "on") {
          repoMapInjectionEnabledRef.current = true;
          repoMapDirtyRef.current = true;
          setLiveItems((prev) => [
            ...prev,
            { kind: "info", text: "Dynamic repo map injection is on.", id: getId() },
          ]);
          return;
        }
        if (action === "off") {
          repoMapInjectionEnabledRef.current = false;
          messagesRef.current = stripRepoMapMessages(messagesRef.current);
          setLiveItems((prev) => [
            ...prev,
            {
              kind: "info",
              text: "Dynamic repo map injection is off for this session.",
              id: getId(),
            },
          ]);
          return;
        }
        if (action === "refresh") repoMapDirtyRef.current = true;
        const markdown = await refreshRepoMap(getLatestUserText(messagesRef.current));
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "info",
            text: formatRepoMapCommandOutput(
              repoMapInjectionEnabledRef.current,
              markdown,
              action === "refresh",
            ),
            id: getId(),
          },
        ]);
        return;
      }

      // Handle /goals — open goal pane
      if (trimmed === "/goals") {
        if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
          props.sessionStore.overlay = "goal";
          props.sessionStore.planAutoExpand = false;
          props.resetUI();
        } else {
          if (props.sessionStore) {
            props.sessionStore.overlay = "goal";
            props.sessionStore.planAutoExpand = false;
            if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
          }
          setPlanAutoExpand(false);
          setOverlay("goal");
        }
        return;
      }

      // Handle /plans — open plan pane
      if (trimmed === "/plans") {
        if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
          props.sessionStore.overlay = "plan";
          props.sessionStore.planAutoExpand = false;
          props.resetUI();
        } else {
          if (props.sessionStore) {
            props.sessionStore.overlay = "plan";
            props.sessionStore.planAutoExpand = false;
            if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
          }
          setPlanAutoExpand(false);
          setOverlay("plan");
        }
        return;
      }

      // Handle prompt-template commands (built-in + custom from .gg/commands/)
      const promptCommandRoute = routePromptCommandInput(trimmed, PROMPT_COMMANDS, customCommands);
      if (promptCommandRoute) {
        const { cmdName, cmdArgs, fullPrompt } = promptCommandRoute;
        log(
          "INFO",
          "command",
          `Prompt command: /${cmdName}${cmdArgs ? ` (args: ${cmdArgs})` : ""}`,
        );

        // Move live items into history before starting
        setLiveItems((prev) => {
          if (prev.length > 0) {
            pendingFlushRef.current = [...pendingFlushRef.current, ...prev];
          }
          return [];
        });

        const hasImages = inputImages.length > 0;
        const modelInfo = getModel(currentModel);
        const modelSupportsImages = modelInfo?.supportsImages ?? true;
        const userContent = buildUserContentWithAttachments(
          fullPrompt,
          inputImages,
          modelSupportsImages,
        );

        // Show the typed command as the user message
        const userItem: UserItem = {
          kind: "user",
          text: trimmed,
          imageCount: hasImages ? inputImages.length : undefined,
          id: getId(),
        };
        setLastUserMessage(trimmed);
        setDoneStatus(null);
        setLiveItems([userItem]);

        // Send the full prompt to the agent, with user args appended if provided
        try {
          await agentLoop.run(userContent);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ERROR", "error", msg);
          const isAbort = msg.includes("aborted") || msg.includes("abort");
          setLiveItems((prev) => [
            ...prev,
            isAbort
              ? { kind: "stopped", text: "Request was stopped.", id: getId() }
              : toErrorItem(err, getId()),
          ]);
        }
        // Reload custom commands in case a setup command created new ones
        reloadCustomCommands();
        return;
      }

      // Check slash commands
      if (props.onSlashCommand && input.startsWith("/")) {
        const result = await props.onSlashCommand(input);
        if (result !== null) {
          setLiveItems((prev) => [...prev, { kind: "info", text: result, id: getId() }]);
          return;
        }
      }

      // ── Build user content (shared by normal + queued paths) ──
      const hasImages = inputImages.length > 0;
      const modelInfo = getModel(currentModel);
      const modelSupportsImages = modelInfo?.supportsImages ?? true;
      const userContent = buildUserContentWithAttachments(input, inputImages, modelSupportsImages);

      // ── Queue message if agent is already running ──
      if (agentLoop.isRunning) {
        log(
          "INFO",
          "queue",
          `Queued message: ${trimmed.length > 80 ? trimmed.slice(0, 80) + "..." : trimmed}`,
        );
        agentLoop.queueMessage(userContent);
        let displayText = input;
        if (hasImages) {
          const { cleanText } = await extractImagePaths(input, props.cwd);
          displayText = cleanText;
        }
        const queuedItem: QueuedItem = {
          kind: "queued",
          text: displayText,
          imageCount: hasImages ? inputImages.length : undefined,
          id: getId(),
        };
        setLiveItems((prev) => [...prev, queuedItem]);
        return;
      }

      // Move any remaining live items into history (Static) before starting a
      // new turn. Must go through queueFlush so flushGeneration bumps and the
      // drain effect actually runs — mutating pendingFlushRef directly here
      // stashed items that nothing was signalled to pick up, so they sat in
      // limbo until some unrelated later code path happened to call queueFlush.
      setLiveItems((prev) => {
        if (prev.length > 0) {
          queueFlush(prev);
        }
        return [];
      });

      // Build display text — strip image paths, show badges instead
      let displayText = input;
      if (hasImages) {
        const { cleanText } = await extractImagePaths(input, props.cwd);
        displayText = cleanText;
      }
      const userItem: UserItem = {
        kind: "user",
        text: displayText,
        imageCount: hasImages ? inputImages.length : undefined,
        pasteInfo,
        id: getId(),
      };
      setLastUserMessage(input);
      setDoneStatus(null);
      // Clear stale plan progress if there's no active approved plan
      // (avoids lingering progress from a completed or abandoned plan run)
      if (planStepsRef.current.length > 0 && !approvedPlanPathRef.current) {
        planStepsRef.current = [];
        setPlanSteps([]);
      }
      setLiveItems([userItem]);

      // Run agent
      try {
        await agentLoop.run(userContent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("ERROR", "error", msg);
        const isAbort = msg.includes("aborted") || msg.includes("abort");
        setLiveItems((prev) => [
          ...prev,
          isAbort
            ? { kind: "stopped", text: "Request was stopped.", id: getId() }
            : toErrorItem(err, getId()),
        ]);
      }
    },
    [
      agentLoop,
      props.onSlashCommand,
      compactConversation,
      rebuildSystemPrompt,
      replaceSystemPrompt,
      refreshRepoMap,
      stripRepoMapMessages,
    ],
  );

  const handleDoubleExit = useDoublePress(setExitPending, () => process.exit(0));

  const handleAbort = useCallback(() => {
    if (agentLoop.isRunning) {
      agentLoop.clearQueue();
      agentLoop.abort();
    } else if (compactionAbortRef.current) {
      compactionAbortRef.current.abort();
    } else {
      handleDoubleExit();
    }
  }, [agentLoop, handleDoubleExit]);

  const handleToggleThinking = useCallback(() => {
    setThinkingEnabled((prev) => {
      const next = !prev;
      log("INFO", "thinking", `Thinking ${next ? "enabled" : "disabled"}`);
      setLiveItems((items) => [
        ...items,
        { kind: "thinking_transition", active: next, id: getId() },
      ]);
      if (props.settingsFile) {
        const sm = new SettingsManager(props.settingsFile);
        sm.load().then(() => sm.set("thinkingEnabled", next));
      }
      return next;
    });
  }, [props.settingsFile]);

  const handleModelSelect = useCallback(
    (value: string) => {
      setOverlay(null);
      const colonIdx = value.indexOf(":");
      if (colonIdx === -1) return;
      const newProvider = value.slice(0, colonIdx) as Provider;
      const newModelId = value.slice(colonIdx + 1);
      log("INFO", "model", `Model changed`, { provider: newProvider, model: newModelId });

      const rebuildPromptWithTools = (tools: AgentTool[]) => {
        currentToolsRef.current = tools;
        void replaceSystemPrompt({ tools });
      };

      // Handle provider-specific tool changes when provider changes
      setCurrentProvider((prevProvider) => {
        if (newProvider !== prevProvider) {
          // Add/remove client-side web_search tool based on provider.
          // Anthropic has native server-side web search; all other providers need the client tool.
          setCurrentTools((prev) => {
            const hasWebSearch = prev.some((t) => t.name === "web_search");
            let next = prev;
            if (newProvider === "anthropic" && hasWebSearch) {
              // Switching TO anthropic — remove client-side web_search (server-side handles it)
              next = prev.filter((t) => t.name !== "web_search");
            } else if (newProvider !== "anthropic" && !hasWebSearch) {
              // Switching FROM anthropic — add client-side web_search
              next = [...prev, createWebSearchTool()];
            }
            rebuildPromptWithTools(next);
            return next;
          });

          // Reconnect MCP servers
          if (props.mcpManager) {
            void (async () => {
              // Disconnect old MCP servers
              await props.mcpManager!.dispose();

              // Remove old MCP tools, connect new ones
              let apiKey: string | undefined;
              if (newProvider === "glm" && props.authStorage) {
                try {
                  const glmCreds = await props.authStorage.resolveCredentials("glm");
                  apiKey = glmCreds.accessToken;
                } catch {
                  // GLM not configured — skip Z.AI MCP servers
                }
              } else if (newProvider === "glm") {
                apiKey = props.credentialsByProvider?.["glm"]?.accessToken;
              }
              try {
                const mcpTools = await props.mcpManager!.connectAll(
                  getMCPServers(newProvider, apiKey),
                );
                setCurrentTools((prev) => {
                  const next = [...prev.filter((t) => !t.name.startsWith("mcp__")), ...mcpTools];
                  rebuildPromptWithTools(next);
                  return next;
                });
                log("INFO", "mcp", `MCP servers reconnected for provider ${newProvider}`);
              } catch (err) {
                log(
                  "WARN",
                  "mcp",
                  `MCP reconnection failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                // Still remove old MCP tools even if reconnection fails
                setCurrentTools((prev) => {
                  const next = prev.filter((t) => !t.name.startsWith("mcp__"));
                  rebuildPromptWithTools(next);
                  return next;
                });
              }
            })();
          }
        }
        return newProvider;
      });

      setCurrentModel(newModelId);
      const modelInfo = getModel(newModelId);
      const displayName = modelInfo?.name ?? newModelId;
      setLiveItems((prev) => [
        ...prev,
        { kind: "model_transition", modelName: displayName, id: getId() },
      ]);

      // Persist model selection for next CLI launch
      if (props.settingsFile) {
        const sm = new SettingsManager(props.settingsFile);
        sm.load().then(async () => {
          await sm.set(
            "defaultProvider",
            newProvider as
              | "anthropic"
              | "openai"
              | "glm"
              | "moonshot"
              | "minimax"
              | "xiaomi"
              | "deepseek"
              | "openrouter",
          );
          await sm.set("defaultModel", newModelId);
        });
      }
    },
    [props.settingsFile, props.mcpManager, props.credentialsByProvider, props.authStorage],
  );

  const handleThemeSelect = useCallback(
    (name: ThemeName) => {
      setOverlay(null);
      if (switchTheme) {
        switchTheme(name);
      }
      // Persist to settings
      if (props.settingsFile) {
        const sm = new SettingsManager(props.settingsFile);
        sm.load().then(() => sm.set("theme", name as Settings["theme"]));
      }
      setLiveItems((prev) => [...prev, { kind: "theme_transition", themeName: name, id: getId() }]);
    },
    [switchTheme, props.settingsFile],
  );

  // All available slash commands for the command palette — ordered by how
  // commonly they're used and grouped by purpose; /quit stays dead last.
  const allCommands = useMemo<SlashCommandInfo[]>(() => {
    const promptByName = new Map(PROMPT_COMMANDS.map((c) => [c.name, c]));
    const fromPrompt = (name: string): SlashCommandInfo | null => {
      const c = promptByName.get(name);
      return c ? { name: c.name, aliases: c.aliases, description: c.description } : null;
    };
    const promptOrder = [
      // Project audits / one-shot analysis
      "goal",
      "init",
      "research",
      "scan",
      "verify",
      "expand",
      "bullet-proof",
      "simplify",
      "compare",
      "batch",
      // Setup / installers
      "setup-lint",
      "setup-tests",
      "setup-commit",
      "setup-update",
      "setup-eyes",
      "eyes-improve",
      "setup-skills",
    ];
    const orderedPromptCommands = promptOrder
      .map(fromPrompt)
      .filter((c): c is SlashCommandInfo => c !== null);
    const knownPromptNames = new Set(promptOrder);
    const remainingPromptCommands = PROMPT_COMMANDS.filter(
      (c) => !knownPromptNames.has(c.name),
    ).map((c) => ({ name: c.name, aliases: c.aliases, description: c.description }));

    return [
      // Session actions (most frequent)
      { name: "model", aliases: ["m"], description: "Switch model" },
      { name: "compact", aliases: ["c"], description: "Compact conversation" },
      { name: "clear", aliases: [], description: "Clear session and terminal" },
      { name: "theme", aliases: ["t"], description: "Switch theme" },
      { name: "plans", aliases: [], description: "Open plans pane" },
      ...orderedPromptCommands,
      ...remainingPromptCommands,
      ...customCommands.map((cmd) => ({
        name: cmd.name,
        aliases: [] as string[],
        description: cmd.description,
      })),
      { name: "quit", aliases: ["q", "exit"], description: "Exit the agent" },
    ];
  }, [customCommands]);

  const renderItem = (item: CompletedItem) => {
    switch (item.kind) {
      case "tombstone":
        return null;
      case "banner":
        return (
          <Banner
            key={item.id}
            version={props.version}
            model={currentModel}
            provider={currentProvider}
            cwd={displayedCwd}
            taskCount={taskCount}
            goalCount={goalCount}
          />
        );
      case "user":
        return (
          <UserMessage
            key={item.id}
            text={item.text}
            imageCount={item.imageCount}
            pasteInfo={item.pasteInfo}
          />
        );
      case "task":
        return (
          <Box key={item.id} marginTop={1}>
            <Text wrap="wrap">
              <Text color={theme.success} bold>
                {"▶ "}
              </Text>
              <Text color={theme.textDim}>{"Task: "}</Text>
              <Text color={theme.success}>{item.title}</Text>
            </Text>
          </Box>
        );
      case "goal":
        return (
          <Box key={item.id} marginTop={1}>
            <Text wrap="wrap">
              <Text color={theme.success} bold>
                {"▶ "}
              </Text>
              <Text color={theme.textDim}>{"Goal: "}</Text>
              <Text color={theme.success}>{item.title}</Text>
              {item.workerId ? <Text color={theme.textDim}> · worker {item.workerId}</Text> : null}
            </Text>
          </Box>
        );
      case "goal_progress": {
        const isError =
          item.status === "failed" || item.status === "fail" || item.status === "blocked";
        const color = isError
          ? theme.error
          : item.phase === "worker_finished"
            ? theme.success
            : item.phase === "verifier_finished"
              ? theme.accent
              : item.phase === "orchestrator_reviewing" || item.phase === "orchestrator_working"
                ? theme.secondary
                : item.phase === "continuing"
                  ? theme.warning
                  : item.phase === "verifier_started"
                    ? theme.accent
                    : item.phase === "worker_started"
                      ? theme.primary
                      : item.phase === "terminal"
                        ? theme.success
                        : theme.primary;
        const glyph =
          item.phase === "worker_finished" || item.phase === "verifier_finished"
            ? "✓ "
            : item.phase === "terminal"
              ? item.status === "passed"
                ? "◆ "
                : "! "
              : "↻ ";
        return (
          <Box key={item.id} marginTop={1} flexDirection="column" flexShrink={1}>
            <Text wrap="wrap">
              <Text color={color} bold>
                {glyph}
              </Text>
              <Text color={color} bold>
                {item.title}
              </Text>
              {item.workerId ? <Text color={theme.textDim}> · worker {item.workerId}</Text> : null}
            </Text>
            {item.detail ? (
              <Text color={theme.textDim} wrap="wrap">
                {`  ${item.detail}`}
              </Text>
            ) : null}
            {item.summaryRows && item.summaryRows.length > 0 ? (
              <Box flexDirection="column" marginTop={1} marginLeft={2} flexShrink={1}>
                {item.summaryRows.map((row) => (
                  <Text key={row.label} wrap="truncate">
                    <Text color={theme.textDim}>{row.label.padEnd(10)}</Text>
                    <Text color={theme.text}>{row.value}</Text>
                    {row.detail ? <Text color={theme.textDim}> · {row.detail}</Text> : null}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        );
      }
      case "style_pack": {
        const names = item.added.map((id) => LANGUAGE_DISPLAY_NAMES[id]);
        const headerLabel = item.added.length > 1 ? "STYLE PACKS ACTIVE" : "STYLE PACK ACTIVE";
        return (
          <Box
            key={item.id}
            marginTop={1}
            flexShrink={1}
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.language}
            paddingX={1}
          >
            <Text wrap="wrap">
              <Text color={theme.language} bold>
                {"◆ "}
              </Text>
              <Text color={theme.language} bold>
                {headerLabel}
              </Text>
            </Text>
            <Text color={theme.text} bold wrap="wrap">
              {names.join(", ")}
            </Text>
            {item.showSetupHint && (
              <Box marginTop={1}>
                <Text wrap="wrap">
                  <Text color={theme.textMuted}>{"Tip: run "}</Text>
                  <Text color={theme.language} bold>
                    {"/setup"}
                  </Text>
                  <Text color={theme.textMuted}>
                    {" to audit this project against the active pack(s)"}
                  </Text>
                </Text>
              </Box>
            )}
          </Box>
        );
      }
      case "setup_hint":
        return (
          <Box
            key={item.id}
            marginTop={1}
            flexShrink={1}
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.language}
            paddingX={1}
          >
            <Text wrap="wrap">
              <Text color={theme.language} bold>
                {"◆ "}
              </Text>
              <Text color={theme.language} bold>
                {"NO STYLE PACKS DETECTED"}
              </Text>
            </Text>
            <Text color={theme.textMuted} wrap="wrap">
              {"This directory has no recognized language manifest at its root."}
            </Text>
            <Box marginTop={1}>
              <Text wrap="wrap">
                <Text color={theme.textMuted}>{"Tip: run "}</Text>
                <Text color={theme.language} bold>
                  {"/setup"}
                </Text>
                <Text color={theme.textMuted}>
                  {" to audit project hygiene or bootstrap a new project from scratch"}
                </Text>
              </Text>
            </Box>
          </Box>
        );
      case "assistant":
        return (
          <AssistantMessage
            key={item.id}
            text={item.text}
            thinking={item.thinking}
            thinkingMs={item.thinkingMs}
            planMode={item.planMode}
          />
        );
      case "tool_start":
        return (
          <ToolExecution
            key={item.id}
            status="running"
            name={item.name}
            args={item.args}
            progressOutput={(item as ToolStartItem).progressOutput}
            animateUntil={item.animateUntil}
          />
        );
      case "tool_done":
        return (
          <ToolExecution
            key={item.id}
            status="done"
            name={item.name}
            args={item.args}
            result={item.result}
            isError={item.isError}
            details={item.details}
          />
        );
      case "tool_group":
        return <ToolGroupExecution key={item.id} tools={item.tools} />;
      case "server_tool_start":
        return (
          <ServerToolExecution
            key={item.id}
            status="running"
            name={item.name}
            input={item.input}
            startedAt={item.startedAt}
            animateUntil={item.animateUntil}
          />
        );
      case "server_tool_done":
        return (
          <ServerToolExecution
            key={item.id}
            status="done"
            name={item.name}
            input={item.input}
            durationMs={item.durationMs}
            resultType={item.resultType}
          />
        );
      case "error": {
        const showMessage = item.message && item.message !== item.headline;
        return (
          <Box key={item.id} marginTop={1} flexDirection="column" flexShrink={1}>
            <Text color={theme.error} wrap="wrap">
              {"✗ "}
              {item.headline}
            </Text>
            {showMessage && (
              <Text color={theme.textDim} wrap="wrap">
                {`  ${item.message}`}
              </Text>
            )}
            <Text color={theme.textDim} wrap="wrap">
              {`  → ${item.guidance}`}
            </Text>
          </Box>
        );
      }
      case "info":
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={theme.textDim} wrap="wrap">
              {item.text}
            </Text>
          </Box>
        );
      case "update_notice":
        return (
          <Box
            key={item.id}
            marginTop={1}
            flexShrink={1}
            borderStyle="round"
            borderColor={theme.success}
            paddingX={1}
          >
            <Text color={theme.success} bold wrap="wrap">
              {"✨ "}
              {item.text}
            </Text>
          </Box>
        );
      case "plan_transition":
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={theme.planPrimary} bold wrap="wrap">
              {item.active ? "● " : "● "}
              {item.text}
            </Text>
          </Box>
        );
      case "thinking_transition": {
        const glyphColor = item.active ? THINKING_BORDER_COLORS[0] : theme.textDim;
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={glyphColor} bold>
              {"✻ "}
            </Text>
            <Text color={item.active ? theme.accent : theme.textDim} bold>
              {item.active ? "Thinking ON" : "Thinking OFF"}
            </Text>
          </Box>
        );
      }
      case "model_transition": {
        const glyphColor = THINKING_BORDER_COLORS[0];
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={glyphColor} bold>
              {"▸ "}
            </Text>
            <Text color={theme.textDim}>{"Switched to "}</Text>
            <Text color={theme.primary} bold>
              {item.modelName}
            </Text>
          </Box>
        );
      }
      case "theme_transition": {
        const glyphColor = THINKING_BORDER_COLORS[0];
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={glyphColor} bold>
              {"◐ "}
            </Text>
            <Text color={theme.textDim}>{"Theme switched to "}</Text>
            <Text color={theme.primary} bold>
              {item.themeName}
            </Text>
          </Box>
        );
      }
      case "plan_event": {
        // Plan-domain status changes (approve / reject / dismiss). Uses
        // theme.planPrimary to match the existing plan_transition family,
        // distinct from the model/thinking gradient.
        const label =
          item.event === "approved"
            ? "Plan approved"
            : item.event === "rejected"
              ? "Plan rejected"
              : "Plan dismissed";
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={theme.planPrimary} bold>
              {"○ "}
              {label}
            </Text>
            {item.detail ? <Text color={theme.textDim}>{` — "${item.detail}"`}</Text> : null}
          </Box>
        );
      }
      case "stopped":
        // Cancellation / abort acknowledgement (ESC, auto-setup cancel, etc.).
        // Muted dim treatment — this is an ack, not a state change worth a
        // gradient. Glyph `⊘` reads as "stop" without being alarming.
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={theme.textDim} bold>
              {"⊘ "}
              {item.text}
            </Text>
          </Box>
        );
      case "step_done":
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text wrap="wrap">
              <Text color={theme.success} bold>
                {"✓ "}
              </Text>
              <Text color={theme.success} bold>
                {`Step ${item.stepNum} done`}
              </Text>
              {item.description ? (
                <Text color={theme.textDim}>{` — ${item.description}`}</Text>
              ) : null}
            </Text>
          </Box>
        );
      case "queued":
        return (
          <Box key={item.id} marginTop={1}>
            <Text color={theme.warning} bold>
              {"• "}
            </Text>
            <Text color={theme.textDim}>Queued: </Text>
            <Text color={theme.text} wrap="wrap">
              {item.text}
              {item.imageCount
                ? ` (+${item.imageCount} image${item.imageCount > 1 ? "s" : ""})`
                : ""}
            </Text>
          </Box>
        );
      case "compacting":
        return <CompactionSpinner key={item.id} staticDisplay />;
      case "compacted":
        return (
          <CompactionDone
            key={item.id}
            originalCount={item.originalCount}
            newCount={item.newCount}
            tokensBefore={item.tokensBefore}
            tokensAfter={item.tokensAfter}
          />
        );
      case "duration":
        return (
          <Box key={item.id} marginTop={1}>
            <Text color={theme.textDim}>
              {"✻ "}
              {item.verb} {formatDuration(item.durationMs)}
            </Text>
          </Box>
        );
      case "subagent_group":
        return <SubAgentPanel key={item.id} agents={item.agents} aborted={item.aborted} />;
    }
  };

  // ── Start a task (shared by manual "work on it" and run-all) ──
  const startTask = useCallback(
    (title: string, prompt: string, taskId: string) => {
      setTaskCount(getTaskCount(props.cwd));
      const shortId = taskId.slice(0, 8);
      const completionHint =
        `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
        `tasks({ action: "done", id: "${shortId}" })`;
      const fullPrompt = prompt + completionHint;

      if (props.resetUI && props.sessionStore) {
        // Preserve the current system prompt (may differ from the launch
        // config — e.g. plan mode toggled or skills changed).
        const sysMsg = messagesRef.current[0];
        const newMessages: Message[] =
          sysMsg && sysMsg.role === "system" ? [sysMsg] : messagesRef.current.slice(0, 1);

        const taskItem: TaskItem = { kind: "task", title, id: String(nextIdRef.current++) };
        const sm = sessionManagerRef.current;

        void (async () => {
          let newSessionPath: string | undefined;
          if (sm) {
            try {
              const s = await sm.create(props.cwd, currentProvider, currentModel);
              newSessionPath = s.path;
              log("INFO", "tasks", "New session for task", { path: s.path });
            } catch {
              // session creation is best-effort
            }
          }
          if (props.sessionStore) props.sessionStore.overlay = null;
          props.resetUI?.({
            wipeSession: true,
            messages: newMessages,
            history: [{ kind: "banner", id: "banner" }, taskItem],
            sessionPath: newSessionPath,
            pendingAction: { prompt: fullPrompt },
          });
        })();
        return;
      }

      // Fallback path (resetUI not wired — tests).
      setHistory([{ kind: "banner", id: "banner" }]);
      setLiveItems([]);
      messagesRef.current = messagesRef.current.slice(0, 1);
      agentLoop.reset();
      persistedIndexRef.current = messagesRef.current.length;
      const sm = sessionManagerRef.current;
      if (sm) {
        void sm.create(props.cwd, currentProvider, currentModel).then((s) => {
          sessionPathRef.current = s.path;
          log("INFO", "tasks", "New session for task", { path: s.path });
        });
      }
      const taskItem: TaskItem = { kind: "task", title, id: getId() };
      setLastUserMessage(title);
      setDoneStatus(null);
      setLiveItems([taskItem]);
      void (async () => {
        try {
          await agentLoop.run(fullPrompt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ERROR", "error", msg);
          const isAbort = msg.includes("aborted") || msg.includes("abort");
          setLiveItems((prev) => [
            ...prev,
            isAbort
              ? { kind: "stopped", text: "Request was stopped.", id: getId() }
              : toErrorItem(err, getId()),
          ]);
          setRunAllTasks(false);
        }
      })();
    },
    [props.cwd, props.resetUI, props.sessionStore, agentLoop, currentProvider, currentModel],
  );

  const openOverlay = useCallback(
    (kind: "tasks" | "goal" | "skills" | "plan" | "pixel") => {
      if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
        props.sessionStore.overlay = kind;
        if (kind !== "plan") props.sessionStore.planAutoExpand = false;
        props.resetUI();
      } else {
        if (props.sessionStore) {
          props.sessionStore.overlay = kind;
          if (kind !== "plan") props.sessionStore.planAutoExpand = false;
          if (agentLoop.isRunning && kind !== "goal" && kind !== "plan") {
            props.sessionStore.pendingResetUI = true;
          }
        }
        if (kind !== "plan") setPlanAutoExpand(false);
        setOverlay(kind);
      }
    },
    [agentLoop.isRunning, props],
  );

  const closeOverlay = useCallback(() => {
    if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
      props.sessionStore.overlay = null;
      props.resetUI();
    } else {
      if (props.sessionStore) {
        props.sessionStore.overlay = null;
      }
      setOverlay(null);
    }
  }, [agentLoop.isRunning, overlay, props]);

  const runGoalSyntheticEvent = useCallback(
    (eventText: string) => {
      const eventInfo = parseGoalSyntheticEvent(eventText);
      const detail =
        eventInfo?.kind === "worker"
          ? `Inspecting worker result${eventInfo.task ? ` for ${eventInfo.task}` : ""}.`
          : `Inspecting verifier result${eventInfo?.status ? ` (${eventInfo.status})` : ""}.`;
      if (agentRunningRef.current) {
        appendGoalProgress({
          kind: "goal_progress",
          phase: "orchestrator_reviewing",
          title: "Goal update queued for orchestrator",
          detail: `${detail} It will report back after the current turn.`,
          workerId: eventInfo?.worker,
          status: eventInfo?.status,
        });
        agentLoop.queueMessage(eventText);
        return;
      }
      appendGoalProgress({
        kind: "goal_progress",
        phase: "orchestrator_reviewing",
        title: "Orchestrator reviewing Goal update",
        detail,
        workerId: eventInfo?.worker,
        status: eventInfo?.status,
      });
      setLastUserMessage("");
      setDoneStatus(null);
      void agentLoop.run(eventText).catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [agentLoop, appendGoalProgress],
  );

  const continueGoalRun = useCallback(
    (runId: string) => {
      void (async () => {
        const latestRun = await reconcileActiveGoalRuns(props.cwd, {
          isWorkerActive: (workerId) =>
            listGoalWorkers(props.cwd).some(
              (worker) => worker.id === workerId && worker.status === "running",
            ),
        }).then(({ runs }) => runs.find((item) => item.id === runId) ?? null);
        if (!latestRun) {
          runningGoalIdsRef.current.delete(runId);
          clearGoalStatusEntry(runId);
          return;
        }
        const decision = decideGoalNextAction(latestRun);
        if (decision.kind === "wait") return;
        if (
          decision.kind === "terminal" ||
          decision.kind === "blocked" ||
          decision.kind === "pause"
        ) {
          const status =
            decision.kind === "terminal"
              ? decision.status
              : decision.kind === "blocked"
                ? "blocked"
                : "paused";
          const nextRun = {
            ...latestRun,
            status,
            continueRequestedAt: undefined,
            blockers:
              decision.kind === "blocked" || decision.kind === "pause"
                ? Array.from(new Set([...latestRun.blockers, decision.reason]))
                : latestRun.blockers,
          } as GoalRun;
          await upsertGoalRun(props.cwd, nextRun);
          await appendGoalDecision(props.cwd, latestRun.id, {
            kind: "continuation_stopped",
            reason: decision.reason,
            content: `terminal=${status}`,
          });
          const terminalProgress = formatGoalTerminalProgress(nextRun);
          if (terminalProgress) {
            const item = { ...terminalProgress, id: goalTerminalProgressId(nextRun) };
            setLiveItems((prev) =>
              completedItemsWithDurableGoalTerminalProgress([...prev, item], [nextRun]),
            );
          }
          runningGoalIdsRef.current.delete(runId);
          clearGoalStatusEntry(runId);
          return;
        }
        let runForNextAction = latestRun;
        if (
          latestRun.continueRequestedAt &&
          !listGoalWorkers(props.cwd).some((worker) => worker.status === "running") &&
          activeVerifierRunIdsRef.current.size === 0
        ) {
          await appendGoalDecision(props.cwd, latestRun.id, {
            kind: "continuation_consumed",
            reason: `Continuation request consumed by ${decision.kind}.`,
          });
          runForNextAction = await upsertGoalRun(props.cwd, {
            ...latestRun,
            continueRequestedAt: undefined,
          });
        }
        appendGoalProgress({
          kind: "goal_progress",
          phase: "continuing",
          title: `Choosing next Goal step: ${latestRun.title}`,
          detail:
            "Latest result is recorded; starting the next worker task or verifier automatically.",
          status: latestRun.status,
        });
        upsertGoalStatusEntry({
          runId: latestRun.id,
          label: latestRun.title,
          phase: "orchestrating",
          startedAt: Date.now(),
          detail: "choosing next step",
        });
        startGoalRunRef.current(runForNextAction);
      })().catch((err: unknown) => {
        runningGoalIdsRef.current.delete(runId);
        clearGoalStatusEntry(runId);
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [appendGoalProgress, clearGoalStatusEntry, props.cwd, upsertGoalStatusEntry],
  );

  const handleGoalWorkerComplete = useCallback(
    (run: GoalRun, completion: GoalWorkerCompletion) => {
      const taskTitle =
        run.tasks.find((task) => task.id === completion.worker.goalTaskId)?.title ??
        completion.worker.goalTaskId;
      const eventText = formatGoalWorkerCompletionEvent(run, taskTitle, completion);
      void summarizeGoalCounts(completion.worker.cwd).then((counts) => setGoalCount(counts.active));
      appendGoalProgress({
        kind: "goal_progress",
        phase: "worker_finished",
        title: formatGoalWorkerFinishedTitle(taskTitle, completion.status),
        detail: summarizeGoalCompletion(completion.summary),
        workerId: completion.worker.id,
        status: completion.status,
      });
      upsertGoalStatusEntry({
        runId: run.id,
        label: taskTitle,
        phase: completion.status === "done" ? "reviewing" : "failed",
        startedAt: Date.now(),
        detail: completion.status === "done" ? "reviewing result" : "task failed",
        workerId: completion.worker.id,
        goalNumber: goalNumberForRun(run.id),
      });
      runGoalSyntheticEvent(eventText);
      void (async () => {
        if (listGoalWorkers(completion.worker.cwd).some((worker) => worker.status === "running"))
          return;
        if (activeVerifierRunIdsRef.current.size > 0) return;
        const runs = await loadGoalRuns(completion.worker.cwd);
        const queued = runs.find(
          (item) => item.continueRequestedAt && !goalHasBlockingPrerequisites(item),
        );
        if (queued) setTimeout(() => continueGoalRun(queued.id), 750);
      })().catch((err: unknown) =>
        log("ERROR", "goal", err instanceof Error ? err.message : String(err)),
      );
    },
    [
      appendGoalProgress,
      continueGoalRun,
      goalNumberForRun,
      runGoalSyntheticEvent,
      upsertGoalStatusEntry,
    ],
  );

  useEffect(() => {
    return subscribeGoalWorkerCompletions((completion) => {
      void (async () => {
        const latestRun =
          (await loadGoalRuns(completion.worker.cwd)).find(
            (item) => item.id === completion.worker.goalRunId,
          ) ?? null;
        if (!latestRun) {
          log("WARN", "goal", `Worker completion for unknown Goal ${completion.worker.goalRunId}`);
          return;
        }
        runningGoalIdsRef.current.add(latestRun.id);
        handleGoalWorkerComplete(latestRun, completion);
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    }, props.cwd);
  }, [handleGoalWorkerComplete, props.cwd]);

  const startGoalRun = useCallback(
    (run: GoalRun) => {
      runningGoalIdsRef.current.add(run.id);
      void (async () => {
        const currentRun =
          (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
        const prereqCheck = await runGoalPrerequisiteChecks(props.cwd, currentRun);
        const checkedRun =
          prereqCheck.checkedCount > 0
            ? await upsertGoalRun(props.cwd, {
                ...prereqCheck.run,
                status: goalHasBlockingPrerequisites(prereqCheck.run) ? "blocked" : "ready",
              })
            : currentRun;
        if (goalHasBlockingPrerequisites(checkedRun)) {
          setOverlay(null);
          const detail = formatGoalBlockingPrerequisites(checkedRun);
          await upsertGoalRun(props.cwd, {
            ...checkedRun,
            status: "blocked",
            blockers: Array.from(new Set([...checkedRun.blockers, detail])),
          });
          setGoalCount((await summarizeGoalCounts(props.cwd)).active);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal blocked: ${checkedRun.title}`,
            detail,
            status: "blocked",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          return;
        }

        const decision = decideGoalNextAction(checkedRun);
        await appendGoalDecision(props.cwd, checkedRun.id, decision);
        if (decision.kind === "terminal") {
          const terminalProgress = formatGoalTerminalProgress(checkedRun);
          if (terminalProgress) {
            const item = { ...terminalProgress, id: goalTerminalProgressId(checkedRun) };
            setLiveItems((prev) =>
              completedItemsWithDurableGoalTerminalProgress([...prev, item], [checkedRun]),
            );
          }
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          return;
        }
        if (decision.kind === "wait") {
          appendGoalProgress({
            kind: "goal_progress",
            phase: "worker_started",
            title: decision.workerId
              ? `Goal working: ${checkedRun.title}`
              : `Goal active: ${checkedRun.title}`,
            detail: decision.reason,
            workerId: decision.workerId,
          });
          upsertGoalStatusEntry({
            runId: checkedRun.id,
            label: checkedRun.title,
            phase: decision.workerId ? "worker" : "orchestrating",
            startedAt: Date.now(),
            detail: decision.reason,
            workerId: decision.workerId,
            goalNumber: goalNumberForRun(checkedRun.id),
          });
          return;
        }
        if (decision.kind === "complete") {
          await upsertGoalRun(props.cwd, { ...checkedRun, status: "passed" });
          setGoalCount((await summarizeGoalCounts(props.cwd)).active);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal passed: ${checkedRun.title}`,
            detail: decision.reason,
            status: "passed",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          return;
        }
        if (decision.kind === "run_verifier") {
          await verifyGoalRun(checkedRun);
          return;
        }
        if (decision.kind === "create_task") {
          await updateGoalTask(props.cwd, checkedRun.id, `auto-${Date.now()}`, {
            title: decision.title,
            prompt: decision.prompt,
            status: "pending",
          });
          const latestRun =
            (await loadGoalRuns(props.cwd)).find((item) => item.id === checkedRun.id) ?? checkedRun;
          await upsertGoalRun(props.cwd, { ...latestRun, status: "ready" });
          setTimeout(() => continueGoalRun(checkedRun.id), 250);
          return;
        }
        if (decision.kind === "blocked") {
          await upsertGoalRun(props.cwd, {
            ...checkedRun,
            status: "blocked",
            blockers: [...checkedRun.blockers, decision.reason],
          });
          setGoalCount((await summarizeGoalCounts(props.cwd)).active);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal blocked: ${checkedRun.title}`,
            detail: decision.reason,
            status: "blocked",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          return;
        }
        if (decision.kind === "pause") {
          const runWithBlockedTask =
            (await updateGoalTask(props.cwd, checkedRun.id, decision.task.id, {
              status: "blocked",
              attempts: decision.attempts,
              lastSummary: "Paused after worker attempt limit.",
            })) ?? checkedRun;
          const runWithPauseEvidence =
            (await appendGoalEvidence(props.cwd, checkedRun.id, {
              kind: "summary",
              label: "Goal paused",
              content: decision.reason,
            })) ?? runWithBlockedTask;
          await upsertGoalRun(props.cwd, {
            ...runWithPauseEvidence,
            status: "paused",
            continueRequestedAt: undefined,
            blockers: Array.from(new Set([...runWithPauseEvidence.blockers, decision.reason])),
          });
          setGoalCount((await summarizeGoalCounts(props.cwd)).active);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal paused: ${checkedRun.title}`,
            detail: decision.reason,
            status: "paused",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          return;
        }

        const runWithAttempt =
          (await updateGoalTask(props.cwd, checkedRun.id, decision.task.id, {
            attempts: decision.attempts,
          })) ?? checkedRun;
        const worker = await startGoalWorker({
          cwd: props.cwd,
          provider: currentProvider,
          model: currentModel,
          goalRunId: checkedRun.id,
          goalTaskId: decision.task.id,
          taskTitle: decision.task.title,
          prompt: decision.task.prompt,
        });
        const latestRun =
          (await loadGoalRuns(props.cwd)).find((item) => item.id === checkedRun.id) ??
          runWithAttempt;
        await upsertGoalRun(props.cwd, {
          ...latestRun,
          status: "running",
          activeWorkerId: worker.id,
          continueRequestedAt: undefined,
          tasks: latestRun.tasks.map((item) =>
            item.id === decision.task.id
              ? { ...item, status: "running", workerId: worker.id, attempts: decision.attempts }
              : item,
          ),
        });
        setOverlay(null);
        setGoalCount((await summarizeGoalCounts(props.cwd)).active);
        appendGoalProgress({
          kind: "goal_progress",
          phase: "worker_started",
          title: `Worker started: ${decision.task.title}`,
          detail: "Task is running in the background.",
          workerId: worker.id,
          status: worker.status,
        });
        upsertGoalStatusEntry({
          runId: checkedRun.id,
          label: decision.task.title,
          phase: "worker",
          startedAt: Date.now(),
          detail: "background worker running",
          workerId: worker.id,
          goalNumber: goalNumberForRun(checkedRun.id),
        });
      })().catch((err: unknown) => {
        clearGoalStatusEntry(run.id);
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [
      props.cwd,
      currentProvider,
      currentModel,
      appendGoalProgress,
      clearGoalStatusEntry,
      goalNumberForRun,
      upsertGoalStatusEntry,
    ],
  );

  const verifyGoalRun = useCallback(
    async (run: GoalRun) => {
      if (!run.verifier?.command) {
        await appendGoalEvidence(props.cwd, run.id, {
          kind: "summary",
          label: "Missing verifier",
          content: "No verifier command is configured.",
        });
        await upsertGoalRun(props.cwd, {
          ...run,
          status: "blocked",
          blockers: [...run.blockers, "No verifier command configured."],
        });
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal blocked: ${run.title}`,
          detail: "No verifier command is configured.",
          status: "blocked",
        });
        runningGoalIdsRef.current.delete(run.id);
        clearGoalStatusEntry(run.id);
        return;
      }

      activeVerifierRunIdsRef.current.add(run.id);
      await upsertGoalRun(props.cwd, {
        ...run,
        status: "verifying",
        continueRequestedAt: undefined,
      });
      appendGoalProgress({
        kind: "goal_progress",
        phase: "verifier_started",
        title: `Verifier started: ${run.title}`,
        detail: run.verifier.command,
        status: "verifying",
      });
      const startedAt = Date.now();
      const verifierTimeoutMs = Number(process.env.GG_GOAL_VERIFIER_TIMEOUT_MS ?? 10 * 60 * 1000);
      upsertGoalStatusEntry({
        runId: run.id,
        label: run.title,
        phase: "verifier",
        startedAt,
        detail: run.verifier.command,
        goalNumber: goalNumberForRun(run.id),
      });
      void runGoalVerifierCommand({
        cwd: props.cwd,
        runId: run.id,
        command: run.verifier.command,
        timeoutMs: verifierTimeoutMs,
        now: () => startedAt,
      })
        .then(async ({ verification, failureClass, durationMs }) => {
          activeVerifierRunIdsRef.current.delete(run.id);
          const status = verification.status;
          const summary = verification.summary;
          const outputPath = verification.outputPath;
          const latestRun =
            (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
          const runWithVerifier: GoalRun = {
            ...latestRun,
            verifier: {
              ...latestRun.verifier,
              description: latestRun.verifier?.description ?? "Goal verifier",
              command: run.verifier?.command,
              lastResult: verification,
            },
          };
          const completionCheck = canCompleteGoalRun(runWithVerifier);
          const verifiedRun = await upsertGoalRun(props.cwd, {
            ...runWithVerifier,
            continueRequestedAt:
              status === "pass" && completionCheck.ok ? undefined : latestRun.continueRequestedAt,
            status: status === "pass" && completionCheck.ok ? "passed" : "ready",
          });
          await appendGoalEvidence(props.cwd, run.id, {
            kind: "command",
            label: `Verifier ${status}`,
            content: `${failureClass}: ${summary}`.slice(0, 4000),
            path: outputPath,
          });
          await appendGoalDecision(props.cwd, run.id, {
            kind: `verifier_${status}`,
            reason: `${failureClass}: verifier exited with code ${verification.exitCode ?? 1}.`,
            content: `outputPath=${outputPath ?? ""}; durationMs=${durationMs}`,
          });
          setGoalCount((await summarizeGoalCounts(props.cwd)).active);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "verifier_finished",
            title: `Verifier ${status}: ${run.title}`,
            detail: summarizeGoalCompletion(summary),
            status,
          });
          upsertGoalStatusEntry({
            runId: run.id,
            label: run.title,
            phase: status === "pass" ? "reviewing" : "failed",
            startedAt: Date.now(),
            detail: status === "pass" ? "reviewing verifier evidence" : "verifier failed",
            goalNumber: goalNumberForRun(run.id),
          });
          const eventText = formatGoalVerifierCompletionEvent(
            verifiedRun,
            status === "pass" ? "pass" : "fail",
            run.verifier?.command ?? "",
            verification.exitCode ?? 1,
            summary,
          );
          runGoalSyntheticEvent(eventText);
          const continuationRun = (await loadGoalRuns(props.cwd)).find(
            (item) => item.id === run.id,
          );
          if (continuationRun?.continueRequestedAt || status === "fail") {
            setTimeout(() => continueGoalRun(run.id), 500);
          }
        })
        .catch((err: unknown) => {
          activeVerifierRunIdsRef.current.delete(run.id);
          clearGoalStatusEntry(run.id);
          log("ERROR", "goal", err instanceof Error ? err.message : String(err));
          setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal verifier")]);
        });
    },
    [
      props.cwd,
      appendGoalProgress,
      clearGoalStatusEntry,
      goalNumberForRun,
      runGoalSyntheticEvent,
      upsertGoalStatusEntry,
    ],
  );

  const pauseGoalRun = useCallback(
    (run: GoalRun) => {
      void (async () => {
        runningGoalIdsRef.current.delete(run.id);
        if (run.activeWorkerId) await stopGoalWorker(run.activeWorkerId);
        const latestRun = (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
        await upsertGoalRun(props.cwd, {
          ...latestRun,
          status: "paused",
          activeWorkerId: undefined,
        });
        setGoalCount((await summarizeGoalCounts(props.cwd)).active);
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal paused: ${run.title}`,
          detail: "Auto-continuation stopped until resumed.",
          status: "paused",
        });
        clearGoalStatusEntry(run.id);
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [appendGoalProgress, clearGoalStatusEntry, props.cwd],
  );

  // Keep refs in sync for access from stale closures (onDone)
  startTaskRef.current = startTask;
  startGoalRunRef.current = startGoalRun;
  useEffect(() => {
    runAllTasksRef.current = runAllTasks;
    if (props.sessionStore) props.sessionStore.runAllTasks = runAllTasks;
  }, [runAllTasks, props.sessionStore]);

  useEffect(() => {
    agentRunningRef.current = agentLoop.isRunning;
  }, [agentLoop.isRunning]);

  const startPixelFix = useCallback(
    (errorId: string) => {
      void (async () => {
        try {
          const { preparePixelFix } = await import("../core/pixel-fix.js");
          const prep = await preparePixelFix(errorId);
          currentPixelFixRef.current = prep;

          // Move the agent into the error's project root. Four things must
          // change in lockstep, otherwise the agent (or the chrome around
          // it) shows the wrong project:
          //   1. process.cwd  — for any code reading it directly
          //   2. cwd-bound tools (read/write/bash/grep/…) — baked at creation
          //   3. the system prompt's "Working directory: …" line — the only
          //      place the model itself learns where it is
          //   4. displayedCwd state — Banner + Footer read this for display
          try {
            process.chdir(prep.projectPath);
          } catch (err) {
            log("WARN", "pixel", `chdir failed: ${(err as Error).message}`);
          }
          cwdRef.current = prep.projectPath;
          repoMapDirtyRef.current = true;
          repoMapMarkdownRef.current = "";
          repoMapSnapshotRef.current = undefined;
          repoMapChangedCountRef.current = 0;
          repoMapCacheRef.current = createRepoMapCache();
          props.repoMapChangedFilesRef?.current.clear();
          props.repoMapReadFilesRef?.current.clear();
          setDisplayedCwd(prep.projectPath);
          let toolsForPixelFix = currentToolsRef.current;
          if (props.rebuildToolsForCwd) {
            toolsForPixelFix = props.rebuildToolsForCwd(prep.projectPath);
            currentToolsRef.current = toolsForPixelFix;
            setCurrentTools(toolsForPixelFix);
          }
          // Pixel-fix swaps the project root — reset injected packs so the
          // new project re-detects from scratch on the next tool call. Also
          // reset the setup-hint flag so the new project's first badge re-
          // surfaces the tip (different project, may need the reminder).
          injectedLanguagesRef.current = new Set();
          setupHintShownRef.current = false;
          const detectedForPixelFix = detectLanguages(prep.projectPath);
          injectedLanguagesRef.current = detectedForPixelFix;
          const newSystemPrompt = await rebuildSystemPrompt({
            cwd: prep.projectPath,
            planMode: false,
            clearApprovedPlan: true,
            activeLanguages: detectedForPixelFix,
            tools: toolsForPixelFix,
          });

          // Now that the cwd swap is committed, reset chat. Do not clear the
          // terminal here; terminal clear sequences can erase saved scrollback.
          setHistory([{ kind: "banner", id: "banner" }]);
          setLiveItems([]);
          messagesRef.current = messagesRef.current.slice(0, 1);
          agentLoop.reset();
          persistedIndexRef.current = messagesRef.current.length;
          const sm = sessionManagerRef.current;
          if (sm) {
            void sm.create(prep.projectPath, currentProvider, currentModel).then((s) => {
              sessionPathRef.current = s.path;
              log("INFO", "pixel", "New session for pixel fix", { path: s.path });
            });
          }

          if (messagesRef.current[0]?.role === "system") {
            messagesRef.current[0] = { role: "system", content: newSystemPrompt };
          } else {
            messagesRef.current.unshift({ role: "system", content: newSystemPrompt });
          }

          const title = `Fix ${errorId.slice(0, 12)}… in ${prep.projectName}`;
          const taskItem: TaskItem = { kind: "task", title, id: getId() };
          setLastUserMessage(title);
          setDoneStatus(null);
          setLiveItems([taskItem]);

          await agentLoop.run(prep.prompt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ERROR", "pixel", msg);
          currentPixelFixRef.current = null;
          setRunAllPixel(false);
          setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
        }
      })();
    },
    [props.cwd, agentLoop, currentProvider, currentModel],
  );
  startPixelFixRef.current = startPixelFix;

  // Seed from sessionStore so "Fix All" chaining survives a deferred
  // resetUI() if it fires between pixel fixes (e.g. user toggled a pane).
  const [runAllPixel, setRunAllPixel] = useState(props.sessionStore?.runAllPixel ?? false);
  useEffect(() => {
    runAllPixelRef.current = runAllPixel;
    if (props.sessionStore) props.sessionStore.runAllPixel = runAllPixel;
  }, [runAllPixel, props.sessionStore]);

  const isTaskView = overlay === "tasks";
  const isGoalView = overlay === "goal";
  const isSkillsView = overlay === "skills";
  const isPlanView = overlay === "plan";
  const isEyesView = overlay === "eyes";
  const footerStatusLayout = getFooterStatusLayoutDecision({
    columns,
    backgroundTaskCount: bgTasks.length,
    eyesCount,
    updatePending,
  });
  const isPixelView = overlay === "pixel";
  const isOverlayView =
    isTaskView || isGoalView || isSkillsView || isPlanView || isEyesView || isPixelView;
  const shouldHideHistoryForOverlay = shouldHideHistoryForOverlayView(
    isOverlayView,
    agentLoop.isRunning,
  );
  const stabilizeOverlayPaneRerender = shouldStabilizeOverlayPaneRerender({
    overlayPane: overlay,
    isAgentRunning: agentLoop.isRunning,
  });
  const liveUserItems = liveItems.filter((item): item is UserItem => item.kind === "user");
  const lastLiveUserItem = liveUserItems.at(-1);
  const hasTallLiveUserMessage = Boolean(
    lastLiveUserItem && isTallLiveUserMessage(lastLiveUserItem.text, rows),
  );
  const hasParagraphBreakLiveUserMessageInLiveItem = Boolean(
    lastLiveUserItem && hasParagraphBreakLiveUserMessage(lastLiveUserItem.text),
  );
  const historyWithoutLiveSubmittedPrompt = hasTallLiveUserMessage
    ? history.filter(
        (item) =>
          item.kind !== "user" ||
          item.id !== lastLiveUserItem?.id ||
          item.text !== lastLiveUserItem.text,
      )
    : history;
  const staticItems = shouldHideStaticItemsForOverlayView({
    shouldHideHistoryForOverlay,
    stabilizeOverlayPaneRerender,
  })
    ? []
    : historyWithoutLiveSubmittedPrompt;
  const scrollStabilizationDecision = getScrollStabilizationDecision({
    // There is no portable scroll-position signal from Ink here; treat tall live
    // submitted prompts and prompts with blank-line paragraph breaks as Static
    // preservation triggers so resize/remount churn cannot replay history before
    // assistant output. Paragraph-break prompts remain eligible for auto-follow
    // because they are not necessarily tall enough to imply user scrollback.
    isUserScrolled: false,
    hasNewOutput:
      liveItems.length > 0 || Boolean(agentLoop.streamingText || agentLoop.streamingThinking),
    hasTallLiveUserMessage,
    hasParagraphBreakLiveUserMessage: hasParagraphBreakLiveUserMessageInLiveItem,
  });
  const staticHistoryKey = scrollStabilizationDecision.preserveStatic
    ? getStaticHistoryKey({ resizeKey: 0 })
    : getStaticHistoryKey({ resizeKey });

  return (
    <Box flexDirection="column" width={columns}>
      {/* History — scrolled up, managed by Ink Static. */}
      <Static key={staticHistoryKey} items={staticItems} style={{ width: "100%" }}>
        {(item) => (
          <Box key={item.id} flexDirection="column" paddingRight={1}>
            {renderItem(item)}
          </Box>
        )}
      </Static>

      {isTaskView ? (
        <TaskOverlay
          cwd={props.cwd}
          agentRunning={agentLoop.isRunning}
          onClose={() => {
            if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              if (props.sessionStore) {
                props.sessionStore.overlay = null;
                if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
              }
              setTaskCount(getTaskCount(props.cwd));
              setOverlay(null);
            }
          }}
          onWorkOnTask={(title, prompt, taskId) => {
            setOverlay(null);
            startTask(title, prompt, taskId);
          }}
          onRunAllTasks={() => {
            setOverlay(null);
            setRunAllTasks(true);
            const next = getNextPendingTask(props.cwd);
            if (next) {
              markTaskInProgress(props.cwd, next.id);
              startTask(next.title, next.prompt, next.id);
            }
          }}
        />
      ) : isGoalView ? (
        <GoalOverlay
          cwd={props.cwd}
          agentRunning={agentLoop.isRunning}
          onClose={() => {
            void summarizeGoalCounts(props.cwd).then((counts) => setGoalCount(counts.active));
            closeOverlay();
          }}
          onRunGoal={(run) => {
            setOverlay(null);
            startGoalRun(run);
          }}
          onVerifyGoal={(run) => {
            void verifyGoalRun(run);
          }}
          onPauseGoal={(run) => {
            pauseGoalRun(run);
          }}
        />
      ) : isPixelView ? (
        <PixelOverlay
          version={props.version}
          agentRunning={agentLoop.isRunning}
          onClose={() => {
            if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              if (props.sessionStore) {
                props.sessionStore.overlay = null;
                if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
              }
              setOverlay(null);
            }
          }}
          onFixOne={(entry) => {
            setOverlay(null);
            startPixelFix(entry.errorId);
          }}
          onFixAll={(entries) => {
            const first = entries.find((e) => e.status === "open") ?? entries[0];
            if (!first) return;
            setOverlay(null);
            setRunAllPixel(true);
            startPixelFix(first.errorId);
          }}
        />
      ) : isSkillsView ? (
        <SkillsOverlay
          cwd={props.cwd}
          onClose={() => {
            if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              if (props.sessionStore) {
                props.sessionStore.overlay = null;
                if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
              }
              setOverlay(null);
            }
          }}
        />
      ) : isEyesView ? (
        <EyesOverlay
          cwd={props.cwd}
          onClose={() => {
            if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              if (props.sessionStore) {
                props.sessionStore.overlay = null;
                if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
              }
              setEyesCount(
                isEyesActive(props.cwd) ? journalCount({ status: "open" }, props.cwd) : undefined,
              );
              setOverlay(null);
            }
          }}
          onQueueMessage={(msg) => {
            agentLoop.queueMessage(msg);
          }}
        />
      ) : isPlanView ? (
        <PlanOverlay
          cwd={props.cwd}
          autoExpandNewest={planAutoExpand}
          onClose={() => {
            planOverlayPendingRef.current = false;
            if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
              props.sessionStore.overlay = null;
              props.sessionStore.planAutoExpand = false;
              props.resetUI();
            } else {
              if (props.sessionStore) {
                props.sessionStore.overlay = null;
                props.sessionStore.planAutoExpand = false;
                if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
              }
              setPlanAutoExpand(false);
              setOverlay(null);
            }
          }}
          onApprove={(planPath) => {
            log("INFO", "plan", "Plan approved — transitioning to implementation", {
              planPath,
            });
            planOverlayPendingRef.current = false;

            void (async () => {
              try {
                // Read plan steps for progress tracking — handed to the new
                // mount via sessionStore.planSteps below.
                const planContent = await import("node:fs/promises").then(({ readFile }) =>
                  readFile(planPath, "utf-8"),
                );
                const steps = extractPlanSteps(planContent);

                // Build the new system prompt with the approved plan baked in.
                const newPrompt = await rebuildSystemPrompt({
                  planMode: false,
                  approvedPlanPath: planPath,
                });

                // Create a new session file BEFORE remount so the new tree
                // picks it up via sessionStore.sessionPath.
                let newSessionPath: string | undefined;
                const sm = sessionManagerRef.current;
                if (sm) {
                  const s = await sm.create(props.cwd, currentProvider, currentModel);
                  newSessionPath = s.path;
                }

                if (props.resetUI && props.sessionStore) {
                  // Clear the overlay so the new mount lands on the chat,
                  // not back inside the plan pane.
                  props.sessionStore.overlay = null;
                  props.sessionStore.planAutoExpand = false;
                  props.resetUI({
                    wipeSession: true,
                    messages: [{ role: "system" as const, content: newPrompt }],
                    approvedPlanPath: planPath,
                    planSteps: steps,
                    sessionPath: newSessionPath,
                    pendingAction: {
                      prompt:
                        "The plan has been approved. Implement it now, following each step in order.",
                      planEvent: { event: "approved" },
                    },
                  });
                  return;
                }

                // Fallback path (resetUI not wired — tests). Mutate in place.
                approvedPlanPathRef.current = planPath;
                planStepsRef.current = steps;
                setPlanSteps(steps);
                setHistory([{ kind: "banner", id: "banner" }]);
                setLiveItems([]);
                setPlanAutoExpand(false);
                setOverlay(null);
                messagesRef.current = [{ role: "system" as const, content: newPrompt }];
                agentLoop.reset();
                persistedIndexRef.current = messagesRef.current.length;
                if (newSessionPath) sessionPathRef.current = newSessionPath;
                setLiveItems([
                  {
                    kind: "info",
                    text: "Plan approved — starting fresh session for implementation",
                    id: getId(),
                  },
                ]);
                setDoneStatus(null);
                await agentLoop.run(
                  "The plan has been approved. Implement it now, following each step in order.",
                );
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log("ERROR", "error", errMsg);
                setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
              }
            })();
          }}
          onReject={(planPath, feedback) => {
            planOverlayPendingRef.current = false;
            const rejectionMsg =
              `The plan at ${planPath} was rejected.\n\nFeedback: ${feedback}\n\n` +
              `Please revise the plan based on this feedback.`;
            if (props.resetUI && props.sessionStore) {
              props.sessionStore.overlay = null;
              props.sessionStore.planAutoExpand = false;
              // No wipeSession — keep history, messages, plan mode etc. The
              // agent picks up the rejection mid-conversation.
              props.resetUI({
                pendingAction: {
                  prompt: rejectionMsg,
                  planEvent: { event: "rejected", detail: feedback },
                },
              });
              return;
            }
            setPlanAutoExpand(false);
            setOverlay(null);
            setDoneStatus(null);
            setLiveItems((prev) => [
              ...prev,
              { kind: "info", text: `Plan rejected — "${feedback}"`, id: getId() },
            ]);
            void agentLoop.run(rejectionMsg).catch((err: unknown) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              log("ERROR", "error", errMsg);
              setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
            });
          }}
        />
      ) : (
        <>
          {/* Content area */}
          <Box flexDirection="column" flexGrow={1} paddingRight={1}>
            {liveItems.map((item) => renderItem(item))}
            <StreamingArea
              isRunning={agentLoop.isRunning}
              streamingText={agentLoop.streamingText}
              streamingThinking={agentLoop.streamingThinking}
              thinkingMs={agentLoop.thinkingMs}
              planMode={planMode}
            />
          </Box>

          {/* Pinned status line — keep the border geometry stable across
              phase transitions, but avoid color animation while the agent is
              working. Repainting the live area on every decorative tick makes
              terminal scrollback snap back to the bottom. */}
          {agentLoop.isRunning && agentLoop.activityPhase !== "idle" ? (
            <Box
              marginTop={1}
              borderStyle="round"
              borderColor={
                agentLoop.activityPhase === "thinking" ? THINKING_BORDER_COLORS[0] : "transparent"
              }
              paddingLeft={1}
              paddingRight={1}
              width={columns}
            >
              <ActivityIndicator
                phase={agentLoop.activityPhase}
                elapsedMs={agentLoop.elapsedMs}
                runStartRef={agentLoop.runStartRef}
                thinkingMs={agentLoop.thinkingMs}
                isThinking={agentLoop.isThinking}
                thinkingEnabled={thinkingEnabled}
                tokenEstimate={agentLoop.streamedTokenEstimate}
                charCountRef={agentLoop.charCountRef}
                realTokensAccumRef={agentLoop.realTokensAccumRef}
                userMessage={lastUserMessage}
                activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
                planMode={planMode}
                retryInfo={agentLoop.retryInfo}
                planDone={planSteps.filter((s) => s.completed).length}
                planTotal={planSteps.length}
                staticDisplay
              />
            </Box>
          ) : agentLoop.stallError ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.warning}>
                {"⚠ API provider stream interrupted — retries exhausted."}
              </Text>
              <Text color={theme.textDim}>
                {"  Your conversation is preserved. Send a message to continue."}
              </Text>
            </Box>
          ) : (
            doneStatus &&
            !agentLoop.isRunning && (
              <Box marginTop={1}>
                <Text color={theme.success}>
                  {"✻ "}
                  {doneStatus.verb} {formatDuration(doneStatus.durationMs)}
                </Text>
              </Box>
            )
          )}

          {/* Queue indicator */}
          {agentLoop.queuedCount > 0 && (
            <Box marginTop={1}>
              <Text color={theme.warning} bold>
                {"• "}
              </Text>
              <Text color={theme.textDim}>
                {agentLoop.queuedCount} message{agentLoop.queuedCount > 1 ? "s" : ""} queued
              </Text>
            </Box>
          )}

          {/* Input + Footer */}
          <InputArea
            onSubmit={handleSubmit}
            onAbort={handleAbort}
            disabled={agentLoop.isRunning}
            isActive={!taskBarFocused && !overlay}
            onDownAtEnd={handleFocusTaskBar}
            onShiftTab={handleToggleThinking}
            onToggleTasks={() => {
              // Just flip the overlay state — Ink's log-update handles the
              // live-area transition (chat input → TaskOverlay) natively, and
              // the chat history above stays in scrollback. When the overlay
              // closes, the history is still there (banner included).
              openOverlay("tasks");
            }}
            onToggleGoal={() => {
              openOverlay("goal");
            }}
            onToggleSkills={() => {
              openOverlay("skills");
            }}
            onTogglePixel={() => {
              openOverlay("pixel");
            }}
            onTogglePlanMode={() => {
              const next = !planMode;
              setPlanMode(next);
              log("INFO", "plan", `Plan mode ${next ? "enabled" : "disabled"}`);
              setLiveItems((items) => [
                ...items,
                {
                  kind: "plan_transition",
                  text: next ? "Plan Mode Activated" : "Plan Mode Deactivated",
                  active: next,
                  id: getId(),
                },
              ]);
            }}
            cwd={props.cwd}
            commands={allCommands}
            eyesCount={eyesCount}
          />
          {overlay === "model" ? (
            <ModelSelector
              onSelect={handleModelSelect}
              onCancel={() => setOverlay(null)}
              loggedInProviders={props.loggedInProviders ?? [currentProvider]}
              currentModel={currentModel}
              currentProvider={currentProvider}
            />
          ) : overlay === "theme" ? (
            <ThemeSelector
              onSelect={handleThemeSelect}
              onCancel={() => setOverlay(null)}
              currentTheme={theme.name}
            />
          ) : (
            <>
              <Footer
                model={currentModel}
                tokensIn={agentLoop.contextUsed}
                contextWindowOptions={contextWindowOptions}
                cwd={displayedCwd}
                gitBranch={gitBranch}
                thinkingLevel={thinkingEnabled ? getMaxThinkingLevel(currentModel) : undefined}
                planMode={planMode}
                exitPending={exitPending}
              />
              {!exitPending && <GoalStatusBar entries={goalStatusEntries} />}
            </>
          )}
          {/* Status row — background tasks, eyes call-to-action, and the
              update-ready indicator all share a single line. Order is
              intentional: active work (bg tasks) first, actionable signals
              (eyes) next, ambient hint (update ready) last. */}
          {(footerStatusLayout.hasBackgroundTasks ||
            footerStatusLayout.hasEyesSignals ||
            footerStatusLayout.hasUpdateNotice) && (
            <Box flexDirection={footerStatusLayout.stack ? "column" : "row"} width={columns}>
              {footerStatusLayout.hasBackgroundTasks && (
                <BackgroundTasksBar
                  tasks={bgTasks}
                  focused={taskBarFocused}
                  expanded={taskBarExpanded}
                  selectedIndex={selectedTaskIndex}
                  onExpand={handleTaskBarExpand}
                  onCollapse={handleTaskBarCollapse}
                  onKill={handleTaskKill}
                  onExit={handleTaskBarExit}
                  onNavigate={handleTaskNavigate}
                  compact={footerStatusLayout.compactBackgroundTasks}
                />
              )}
              {footerStatusLayout.hasEyesSignals && (
                <Box
                  paddingLeft={footerStatusLayout.stack || bgTasks.length === 0 ? 1 : 2}
                  paddingRight={1}
                >
                  <Text color={theme.accent} bold wrap="truncate">
                    {`${eyesCount} eyes signal${eyesCount === 1 ? "" : "s"} · Run /eyes-improve to enhance GG Coder`}
                  </Text>
                </Box>
              )}
              {footerStatusLayout.hasUpdateNotice && (
                <Box
                  paddingLeft={
                    footerStatusLayout.stack ||
                    (!footerStatusLayout.hasBackgroundTasks && !footerStatusLayout.hasEyesSignals)
                      ? 1
                      : 2
                  }
                  paddingRight={1}
                >
                  <Text color={theme.success} bold wrap="truncate">
                    ✨ Update ready · restart to apply
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

function formatRepoMapCommandOutput(
  enabled: boolean,
  markdown: string,
  refreshed: boolean,
): string {
  const status = enabled ? "on" : "off";
  const prefix = refreshed
    ? `Dynamic repo map refreshed · injection: ${status}`
    : `Dynamic repo map · injection: ${status}`;
  return `${prefix}\n\n${markdown}`;
}
