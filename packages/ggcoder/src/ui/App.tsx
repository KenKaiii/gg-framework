import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, useStdout } from "ink";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { useChatLayoutMeasurements } from "./hooks/useChatLayoutMeasurements.js";
import { useTaskPickerController } from "./hooks/useTaskPickerController.js";
import { useModeState } from "./hooks/useModeState.js";
import { useSessionPersistence } from "./hooks/useSessionPersistence.js";
import { useContextCompaction } from "./hooks/useContextCompaction.js";
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
import { playNotificationSound } from "../utils/sound.js";
import {
  type Message,
  type Provider,
  type ThinkingLevel,
  type TextContent,
} from "@kenkaiiii/gg-ai";
import { downscaleForPreview, extractMediaPaths, type ImageAttachment } from "../utils/image.js";
import type { AgentTool, AgentTurnTiming } from "@kenkaiiii/gg-agent";
import {
  buildSubAgentCompletionFollowUp,
  type SubAgentManager,
  type SubAgentSnapshot,
} from "../core/subagent-manager.js";
import { useAgentLoop, type StreamSnapshot, type UserContent } from "./hooks/useAgentLoop.js";
import { useTranscriptHistory } from "./hooks/useTranscriptHistory.js";
import type { PasteInfo } from "./components/InputArea.js";
import type { SubAgentInfo } from "./components/SubAgentPanel.js";
import type { SubAgentUpdate, SubAgentDetails } from "../tools/subagent.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { ChatScreen } from "./components/ChatScreen.js";
import type { LiveToolEntry } from "./components/LiveToolPanel.js";
import { LIVE_TOOL_PANEL_ROWS } from "./components/LiveToolPanel.js";
import { FullScreenOverlayRouter } from "./components/FullScreenOverlayRouter.js";
import { SessionSummaryDisplay } from "./components/SessionSummary.js";
import type { SlashCommandInfo } from "./components/SlashCommandMenu.js";
import type { ProcessManager } from "../core/process-manager.js";
import { useTheme, useSetTheme, type ThemeName } from "./theme/theme.js";
import { useTerminalTitle } from "./hooks/useTerminalTitle.js";
import { getGitBranch } from "../utils/git.js";
import { getAuthStorageKeys, getModel, getVideoByteLimit } from "../core/model-registry.js";
import { SessionManager, type TurnMetricPayload } from "../core/session-manager.js";
import { log } from "../core/logger.js";
import {
  getPendingUpdate,
  startPeriodicUpdateCheck,
  stopPeriodicUpdateCheck,
} from "../core/auto-update.js";
import { SettingsManager, type Settings } from "../core/settings-manager.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { getAnnouncedLanguages, markLanguagesAnnounced } from "../core/setup-history.js";
import { loadCustomCommands, type CustomCommand } from "../core/custom-commands.js";
import { detectLanguages, type LanguageId } from "../core/language-detector.js";
import { detectVerifyCommands } from "../core/verify-commands.js";
import type { Skill } from "../core/skills.js";
import type { CheckpointInfo, CheckpointStore, RestoreMode } from "../core/checkpoint-store.js";
import { RewindOverlay } from "./components/RewindOverlay.js";
import {
  extractPlanSteps,
  findCompletedMarkers,
  markStepsCompleted,
  rebasePlanSteps,
  segmentDisplayText,
  stripDoneMarkers,
  type PlanStep,
} from "../utils/plan-steps.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import { getAllMcpServers } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import {
  trimFlushedItems,
  flushOnTurnText,
  flushOnTurnEnd,
  flushOverflow,
  splitOversizedPinnedItems,
} from "./live-item-flush.js";
import {
  splitAssistantStreamingText,
  estimateRenderedRows,
} from "./utils/assistant-stream-split.js";
import { getNextPendingTask, markTaskInProgress } from "../core/tasks-store.js";
import type { TerminalHistoryPrinter } from "./terminal-history.js";
import { buildUserContentWithAttachments } from "./prompt-routing.js";
import { submitPromptCommand } from "./submit-prompt-command.js";
import { handleUiSlashCommand } from "./submit-slash-commands.js";
import {
  buildIdealReviewMessage,
  evaluateIdealReview,
  detectTestDrift,
  type ReviewCoverageTracker,
} from "../core/ideal-review.js";
import type { LspManager } from "../core/lsp/manager.js";
import { buildLoopBreakMessage, evaluateLoopBreak } from "../core/loop-breaker.js";
import { buildRegroundingMessage } from "../core/regrounding.js";
import { getNextThinkingLevel, isThinkingLevelSupported } from "./thinking-level.js";
import {
  getDoneFlushDecision,
  shouldTopSpaceAfterPrintedAgentBoundary,
  shouldTopSpaceStreamingAssistant,
  type DoneStatus,
} from "./layout-decisions.js";
import { isTranscriptSpacingItem } from "./transcript/spacing.js";
import { buildTranscriptLines } from "./transcript/transcript-lines.js";
import { useTranscriptScroll } from "./hooks/useTranscriptScroll.js";
import { scrollTranscriptByLines } from "./stores/transcript-scroll-store.js";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import { formatDuration } from "./duration-format.js";
import { pickDurationVerb } from "./duration-summary.js";
import { toErrorItem } from "./error-item.js";
import {
  addLinesChanged,
  buildSessionSummary,
  createSessionStats,
  recordServerToolCall,
  recordToolEnd,
  recordTurnEnd,
  type SessionStats,
} from "./session-summary.js";
import {
  compactHistory,
  getNextGeneratedItemId,
  isActiveItem,
  isSameAssistantText,
  normalizeAssistantText,
  partitionCompleted,
  pinStreamingTextBeforeToolBoundary,
  removeItemsWithIds,
  uniqueItemsById,
} from "./item-helpers.js";
import type {
  CompletedItem,
  ImagePreview,
  QueuedItem,
  SessionSummaryItem,
  ServerToolDoneItem,
  ServerToolStartItem,
  SubAgentGroupItem,
  TaskItem,
  ToolDoneItem,
  ToolGroupItem,
  ToolStartItem,
  UserItem,
} from "./app-items.js";

export type { CompletedItem, ToolGroupItem } from "./app-items.js";
import {
  IDEAL_HOOK_NOTICE_TEXT,
  LOOP_BREAK_NOTICE_TEXT,
  REGROUNDING_NOTICE_TEXT,
  TRUNCATED_CONTINUING_NOTICE_TEXT,
  TRUNCATED_INCOMPLETE_NOTICE_TEXT,
  TRUNCATED_PROVIDER_ERROR_NOTICE_TEXT,
  TRUNCATED_REFUSAL_NOTICE_TEXT,
  lastVisibleTranscriptItem,
} from "./app-items.js";
export type { DoneStatus } from "./layout-decisions.js";
export { buildUserContentWithAttachments, routePromptCommandInput } from "./prompt-routing.js";
export { getNextThinkingLevel } from "./thinking-level.js";
export {
  getChatControlsLayoutDecision,
  getDoneFlushDecision,
  getScrollStabilizationDecision,
  getStaticHistoryKey,
  hasParagraphBreakLiveUserMessage,
  isTallLiveUserMessage,
  shouldHideHistoryForOverlayView,
  shouldHideStaticItemsForOverlayView,
  shouldStabilizeOverlayPaneRerender,
  shouldTopSpaceAfterPrintedAgentBoundary,
  shouldTopSpaceAssistantAfterToolBoundary,
  shouldTopSpaceStreamingAssistant,
} from "./layout-decisions.js";
export {
  getNextGeneratedItemId,
  isActiveItem,
  partitionCompleted,
  pinStreamingTextBeforeToolBoundary,
} from "./item-helpers.js";

/** Tools that get aggregated into a single compact group when possible. */
const AGGREGATABLE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "mcp__kencode-search__searchCode",
  "mcp__kencode-search__referenceSources",
  "mcp__kencode-search__discoverRepos",
]);

const RUNNING_INDICATOR_ANIMATION_MS = 1_200;

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
  idealReviewEnabled?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<
    string,
    { accessToken: string; accountId?: string; projectId?: string; baseUrl?: string }
  >;
  initialHistory?: CompletedItem[];
  sessionsDir?: string;
  sessionPath?: string;
  sessionId?: string;
  processManager?: ProcessManager;
  subAgentManager?: SubAgentManager;
  lspManager?: LspManager;
  reviewCoverageTracker?: ReviewCoverageTracker;
  settingsFile?: string;
  mcpManager?: MCPClientManager;
  authStorage?: AuthStorage;
  planModeRef?: { current: boolean };
  skills?: Skill[];
  /** Per-session file checkpoint store backing the /rewind command. */
  checkpointStore?: CheckpointStore;
  /** Rebuild the `read` tool for a model (reuses the read tracker). Used on
   *  model switch so the tool's video capability tracks the active model. */
  rebuildReadTool?: (model: string) => AgentTool;
  connectInitialMcpTools?: () => Promise<AgentTool[]>;
  planCallbacks?: {
    onEnterPlan?: (reason?: string) => void | Promise<void>;
    onExitPlan?: (planPath: string) => Promise<string>;
  };
  terminalHistoryPrinter?: TerminalHistoryPrinter;
  /**
   * Wired by `renderApp`. Queues raw bytes through the patched Ink
   * `insertBeforeFrame` so finalized transcript rows are folded atomically
   * into the next frame write (erase old frame + scrollback bytes + new frame
   * in one synchronized write). This is what keeps the footer pinned when
   * flushed rows leave the live frame. Falls back to a raw stdout write when
   * the patched API is unavailable.
   */
  enqueueHistoryWrite?: (data: string) => void;
  /**
   * Wired by `renderApp`. Enables/disables the patched Ink bottom-anchor pad
   * creation. On while the agent runs (footer must not jump as the tool panel
   * and status rows churn); off at idle so symmetric UI shrink (slash menu
   * close, input collapse) lets the footer return up without leaving pads.
   */
  setFrameAnchorActive?: (active: boolean) => void;
  /**
   * When true, the UI runs in the alternate-screen fullscreen viewport: the
   * transcript is rendered inside Ink as a bounded, app-scrolled region above a
   * pinned controls region, and nothing is written to native scrollback. This
   * is what keeps the footer a truly fixed bottom region. Defaults off (legacy
   * scrollback path) for non-TTY / CI / print modes.
   */
  fullscreen?: boolean;
  /**
   * Wired by `renderApp`. Tears down the current Ink instance and renders
   * a fresh one. Patching Ink's internal frame tracking in place is
   * unreliable (the live area drifts on subsequent streaming responses);
   * a full unmount/remount is the only consistent reset.
   *
   * Used by every path that previously did a bare ANSI screen clear:
   * `/clear`, plan accept/reject, overlay open/close.
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
    turnMetrics?: TurnMetricPayload[];
    liveItems?: CompletedItem[];
    doneStatus?: DoneStatus | null;
    approvedPlanPath?: string;
    planSteps: PlanStep[];
    sessionPath?: string;
    sessionId?: string;
    overlay?: "model" | "skills" | "plan" | "theme" | null;
    planAutoExpand?: boolean;
    pendingAction?: {
      prompt: string;
      infoText?: string;
      planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
    };
    isAgentRunning?: boolean;
    pendingResetUI?: boolean;
    runAllTasks?: boolean;
    planMode?: boolean;
    sessionStats?: SessionStats;
    idealReviewEnabled?: boolean;
  };
}

// ── App Component ──────────────────────────────────────────

/**
 * Extract inline image previews carried on a tool result's `details` payload.
 * Image-producing tools (e.g. screenshot) attach `{ imagePreviews: [...] }` so
 * the terminal-history printer can render the captured pixels inline.
 */
function extractToolImagePreviews(details: unknown): ImagePreview[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const previews = (details as { imagePreviews?: unknown }).imagePreviews;
  if (!Array.isArray(previews)) return undefined;
  const valid = previews.filter(
    (p): p is ImagePreview =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as ImagePreview).base64 === "string" &&
      typeof (p as ImagePreview).mediaType === "string",
  );
  return valid.length > 0 ? valid : undefined;
}

export function App(props: AppProps) {
  const theme = useTheme();
  const switchTheme = useSetTheme();
  const { write: writeStdout } = useStdout();
  const { columns, rows } = useTerminalSize();
  // Layout snapshot readable from agent-event callbacks (whose deps must stay
  // stable). `liveAreaRows` is filled in by an effect after the chat layout is
  // measured further down; 0 means "not measured yet" and disables the
  // oversized-item flush below.
  const liveLayoutRef = useRef({ columns, liveAreaRows: 0 });

  const [lastUserMessage, setLastUserMessage] = useState("");
  // Bumped on every prompt submit; the fullscreen transcript scroll controller
  // watches this to snap back to the bottom so the newest output is visible.
  const [scrollResetToken, setScrollResetToken] = useState(0);
  const [exitPending, setExitPending] = useState(false);
  const [quittingSummary, setQuittingSummary] = useState<SessionSummaryItem["summary"] | null>(
    null,
  );
  // Native terminal title keeps the active project visible outside the app frame.
  const [titleRunning, setTitleRunning] = useState(false);

  // Completed transcript rows are kept as durable session data but are no longer
  // rendered through Ink history. They are serialized once into real terminal
  // scrollback via terminalHistoryPrinter, while Ink owns only live rows and
  // controls. This avoids Static/log-update replay drift on resize/remount.
  const [history, setHistory] = useState<CompletedItem[]>(() => {
    const stored = props.sessionStore?.history;
    if (stored && stored.length > 0) return stored;
    if (props.initialHistory && props.initialHistory.length > 0) {
      return compactHistory(trimFlushedItems(props.initialHistory));
    }
    return [{ kind: "banner", id: "banner" }];
  });
  // Items from the current/last turn — rendered in the live area so they stay visible.
  // Seed from sessionStore so live output
  // survives pane/overlay/resize remounts before it is finalized.
  const [liveItems, setLiveItems] = useState<CompletedItem[]>(() => {
    const restoredLiveItems = uniqueItemsById(props.sessionStore?.liveItems ?? []);
    const restoredHistoryIds = new Set(history.map((item) => item.id));
    return removeItemsWithIds(restoredLiveItems, restoredHistoryIds);
  });
  useEffect(() => {
    if (!props.subAgentManager) return;
    return props.subAgentManager.subscribe((snapshot: SubAgentSnapshot) => {
      const status: SubAgentInfo["status"] =
        snapshot.state === "starting" || snapshot.state === "running"
          ? "running"
          : snapshot.state === "completed" || (snapshot.state === "closed" && !snapshot.error)
            ? "done"
            : snapshot.state === "interrupted"
              ? "aborted"
              : "error";
      const agent: SubAgentInfo = {
        toolCallId: snapshot.agent_id,
        task: snapshot.task_name,
        agentName: "async",
        status,
        toolUseCount: snapshot.tool_use_count,
        tokenUsage: { ...snapshot.token_usage },
        currentActivity: snapshot.current_activity,
        result: snapshot.output ?? snapshot.error,
        durationMs: snapshot.elapsed_ms,
      };
      setLiveItems((previous) => {
        const containingGroupIndex = previous.findIndex(
          (item) =>
            item.kind === "subagent_group" &&
            item.agents.some((existing) => existing.toolCallId === snapshot.agent_id),
        );
        const activeAsyncGroupIndex = previous.findIndex(
          (item) =>
            item.kind === "subagent_group" &&
            item.agents.some(
              (existing) => existing.agentName === "async" && existing.status === "running",
            ),
        );
        const groupIndex = containingGroupIndex >= 0 ? containingGroupIndex : activeAsyncGroupIndex;
        if (groupIndex === -1) {
          return [...previous, { kind: "subagent_group", agents: [agent], id: getId() }];
        }
        const group = previous[groupIndex] as SubAgentGroupItem;
        const agentIndex = group.agents.findIndex((item) => item.toolCallId === snapshot.agent_id);
        const agents = [...group.agents];
        if (agentIndex === -1) agents.push(agent);
        else agents[agentIndex] = agent;
        const next = [...previous];
        next[groupIndex] = { ...group, agents };
        return next;
      });
    });
  }, [props.subAgentManager]);
  // Rolling feed of recent tool actions for the pinned LiveToolPanel. Kept
  // separate from `liveItems` (the scrollback record) so tool calls mutate in
  // place above the activity bar instead of spamming the transcript.
  const [liveToolFeed, setLiveToolFeed] = useState<LiveToolEntry[]>([]);
  // overlay seeded from sessionStore (lives across remount), then null.
  const [overlay, setOverlay] = useState<"model" | "skills" | "plan" | "theme" | null>(
    props.sessionStore?.overlay ?? null,
  );
  const [updatePending, setUpdatePending] = useState<boolean>(
    () => getPendingUpdate(props.version) !== null,
  );
  // Signal that pushes text into the InputArea composer (e.g. restoring queued
  // messages after an interrupt). Bumping `nonce` triggers the injection even
  // when the text is identical to a prior restore.
  const [composerInject, setComposerInject] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  const agentRunningRef = useRef(false);
  const [runAllTasks, setRunAllTasks] = useState(props.sessionStore?.runAllTasks ?? false);
  const runAllTasksRef = useRef(props.sessionStore?.runAllTasks ?? false);
  const startTaskRef = useRef<(title: string, prompt: string, taskId: string) => void>(() => {});
  const cwdRef = useRef(props.cwd);
  // The project root is fixed for the session's lifetime, so this never changes.
  const displayedCwd = props.cwd;
  // /rewind overlay: holds the checkpoint list while the picker is open.
  const [rewindCheckpoints, setRewindCheckpoints] = useState<CheckpointInfo[] | null>(null);
  // Monotonic user-turn counter keying per-turn checkpoints.
  const rewindTurnRef = useRef(0);
  const taskPicker = useTaskPickerController({
    displayedCwd,
    onStartTask: (title, prompt, taskId) => startTaskRef.current(title, prompt, taskId),
    onRunAllTasksChange: setRunAllTasks,
  });
  const [doneStatus, setDoneStatus] = useState<DoneStatus | null>(
    props.sessionStore?.doneStatus ?? null,
  );
  // Suppress "done" status when a plan overlay is about to open
  const planOverlayPendingRef = useRef(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useTerminalTitle({ isRunning: titleRunning, cwd: displayedCwd, gitBranch });
  const [currentModel, setCurrentModel] = useState(props.model);
  const [currentProvider, setCurrentProvider] = useState(props.provider);
  const currentProviderRef = useRef(props.provider);
  const currentModelRef = useRef(props.model);
  const [currentTools, setCurrentTools] = useState(props.tools);
  const currentToolsRef = useRef(props.tools);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>(props.thinking);
  const thinkingLevelRef = useRef<ThinkingLevel | undefined>(props.thinking);
  currentModelRef.current = currentModel;
  thinkingLevelRef.current = thinkingLevel;
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const messagesRef = useRef<Message[]>(props.sessionStore?.messages ?? props.messages);
  const [planAutoExpand, setPlanAutoExpand] = useState(props.sessionStore?.planAutoExpand ?? false);
  const approvedPlanPathRef = useRef<string | undefined>(props.sessionStore?.approvedPlanPath);
  const planStepsRef = useRef<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  // Stuck-guard for the plan-continuation follow-up nudge. Tracks how many
  // times we've nudged the agent to continue the same step. Reset whenever a
  // new [DONE:n] marker advances progress (see onTurnText). Caps at 2 nudges
  // so a genuinely stuck agent surfaces instead of looping forever.
  const followUpNudgesRef = useRef<{ step: number; count: number }>({ step: 0, count: 0 });
  // Seed the per-item ID counter so it doesn't collide with IDs already in
  // sessionStore.history (which survives remount). Without this, a remount
  // (resize, overlay toggle, task pane open, etc.) starts the counter at 0
  // and new items generate ids "ui-0", "ui-1", "ui-2"… that collide with
  // the same ids from the previous mount, triggering React's duplicate-key
  // warning and causing duplicate/omitted renders.
  const nextIdRef = useRef(
    getNextGeneratedItemId([
      ...(props.sessionStore?.history ?? props.initialHistory ?? []),
      ...(props.sessionStore?.liveItems ?? []),
    ]),
  );
  const sessionManagerRef = useRef(
    props.sessionsDir ? new SessionManager(props.sessionsDir) : null,
  );
  const sessionPathRef = useRef(props.sessionStore?.sessionPath ?? props.sessionPath);
  const persistedIndexRef = useRef(messagesRef.current.length);
  const turnMetricsRef = useRef<TurnMetricPayload[]>(props.sessionStore?.turnMetrics ?? []);
  const sessionStatsRef = useRef(
    props.sessionStore?.sessionStats ??
      createSessionStats({ sessionId: props.sessionStore?.sessionId ?? props.sessionId }),
  );
  const [idealReviewEnabled, setIdealReviewEnabled] = useState(
    props.sessionStore?.idealReviewEnabled ?? props.idealReviewEnabled ?? true,
  );
  const idealReviewEnabledRef = useRef(idealReviewEnabled);
  /**
   * Languages whose style packs are currently injected into the system prompt.
   * Grown by `maybeInjectLanguagePacks` after `write`/`bash` tool results when
   * the language detector sees new marker files.
   * Only grows within a session; we never strip packs once injected (cheaper
   * than invalidating prompt caching, and stale guidance is harmless).
   */
  const injectedLanguagesRef = useRef<Set<LanguageId>>(new Set());
  const getId = () => `ui-${nextIdRef.current++}`;

  // Session persistence failures (e.g. ENOSPC disk-full) must not crash the
  // live session — SessionManager swallows them and reports here once per
  // error code so the user gets a visible warning instead of a process crash.
  useEffect(() => {
    const manager = sessionManagerRef.current;
    if (!manager) return;
    manager.onPersistError = (error) => {
      const detail =
        error?.code === "ENOSPC"
          ? "Disk is full — session transcript can no longer be saved. Free up space to resume saving."
          : `Session transcript could not be saved (${error?.code ?? "unknown error"}). The session continues, but new messages won't persist.`;
      setLiveItems((prev) => [...prev, { kind: "info", text: `⚠ ${detail}`, id: getId() }]);
    };
    return () => {
      manager.onPersistError = undefined;
    };
  }, []);

  useEffect(() => {
    idealReviewEnabledRef.current = idealReviewEnabled;
    if (props.sessionStore) props.sessionStore.idealReviewEnabled = idealReviewEnabled;
  }, [idealReviewEnabled, props.sessionStore]);

  const sessionStore = props.sessionStore;

  const { planMode, rebuildSystemPrompt, replaceSystemPrompt, setPlanModeAndPrompt } = useModeState(
    {
      initialPlanMode: props.sessionStore?.planMode ?? props.planModeRef?.current ?? false,
      skills: props.skills,
      planModeRef: props.planModeRef,
      sessionStore: props.sessionStore,
      cwdRef,
      currentToolsRef,
      providerRef: currentProviderRef,
      modelRef: currentModelRef,
      thinkingLevelRef,
      approvedPlanPathRef,
      injectedLanguagesRef,
      messagesRef,
    },
  );

  const {
    pendingHistoryFlushRef,
    streamedAssistantFlushRef,
    queueFlush,
    finalizeSubmittedUserItem,
    clearPendingHistory,
  } = useTranscriptHistory({
    // In fullscreen alt-screen mode the transcript renders inside Ink (the
    // viewport), so we must NOT write completed rows to native scrollback —
    // doing so would scroll the live frame. Dropping the printer keeps history
    // accumulating in React state (still flushed + persisted) without any
    // stdout writes. The legacy scrollback path keeps the printer.
    terminalHistoryPrinter: props.fullscreen ? undefined : props.terminalHistoryPrinter,
    // Atomic scrollback enqueue — only meaningful on the legacy scrollback
    // path (fullscreen drops the printer entirely, so nothing is written).
    enqueueStdout: props.fullscreen ? undefined : props.enqueueHistoryWrite,
    terminalHistoryContext: {
      theme,
      columns,
      version: props.version,
      model: currentModel,
      provider: currentProvider,
      cwd: displayedCwd,
    },
    writeStdout,
    sessionStore,
    history,
    setHistory,
    setLiveItems,
  });

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
    if (thinkingLevel && !isThinkingLevelSupported(currentProvider, currentModel, thinkingLevel)) {
      setThinkingLevel(getNextThinkingLevel(currentProvider, currentModel, undefined));
    }
  }, [currentProvider, currentModel, thinkingLevel]);

  useEffect(() => {
    onRuntimeStateChange?.({
      thinking: thinkingLevel,
    });
  }, [thinkingLevel, onRuntimeStateChange]);

  // Mirror session state into renderApp's closure so resetUI() can re-seed
  // the conversation on remount. Each panel that previously did a bare ANSI
  // screen clear (overlay open/close, plan accept/reject, /clear)
  // now goes through resetUI; without these mirrors, the chat would vanish.
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
    if (sessionStore) sessionStore.history = history;
  }, [history, sessionStore]);
  useEffect(() => {
    if (!sessionStore) return;
    const historyIds = new Set(historyRef.current.map((item) => item.id));
    sessionStore.liveItems = removeItemsWithIds(uniqueItemsById(liveItems), historyIds);
  }, [liveItems, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.doneStatus = doneStatus;
  }, [doneStatus, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.planSteps = planSteps;
  }, [planSteps, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.overlay = overlay;
  }, [overlay, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.planMode = planMode;
  }, [planMode, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.sessionStats = sessionStatsRef.current;
  }, [sessionStore]);

  // pendingAction is consumed via a useEffect AFTER agentLoop is created
  // — see below where useAgentLoop is set up.
  const pendingActionConsumedRef = useRef(false);

  // Derive credentials for the current provider + model. Almost always keyed
  // by provider id, but a model can prefer one storage key and fall back to
  // another (e.g. Xiaomi's mimo-v2.5-pro-ultraspeed is API-Credits-only,
  // while mimo-v2.5-pro prefers the Token Plan but falls back to API Credits
  // when only that's configured) — see getAuthStorageKeys().
  const currentCreds = getAuthStorageKeys(currentProvider, currentModel)
    .map((key) => props.credentialsByProvider?.[key])
    .find((c) => c !== undefined);
  const activeApiKey = currentCreds?.accessToken ?? props.apiKey;
  const activeAccountId = currentCreds ? currentCreds.accountId : props.accountId;
  const activeProjectId = currentCreds ? currentCreds.projectId : props.projectId;
  const activeBaseUrl =
    currentProvider === "gemini" ? undefined : currentCreds ? currentCreds.baseUrl : props.baseUrl;
  const contextWindowOptions = useMemo(
    () => ({ provider: currentProvider, accountId: activeAccountId }),
    [currentProvider, activeAccountId],
  );

  // Load git branch — re-runs whenever the displayed cwd changes.
  useEffect(() => {
    getGitBranch(displayedCwd).then(setGitBranch);
  }, [displayedCwd]);

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

  useEffect(() => {
    if (!props.connectInitialMcpTools) return;
    let cancelled = false;
    void props
      .connectInitialMcpTools()
      .then((mcpTools) => {
        if (cancelled || mcpTools.length === 0) return;
        setCurrentTools((prev) => {
          const next = [...prev.filter((tool) => !tool.name.startsWith("mcp__")), ...mcpTools];
          currentToolsRef.current = next;
          void replaceSystemPrompt({ tools: next });
          return next;
        });
      })
      .catch((err: unknown) => {
        log(
          "WARN",
          "mcp",
          `MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [props.connectInitialMcpTools, replaceSystemPrompt]);

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
      // No new packs to inject. The with-packs path below is gated via
      // getAnnouncedLanguages / markLanguagesAnnounced: badge fires once per
      // (cwd, language) and stays silent on subsequent sessions / /clear.
      if (source === "initial" && injectedLanguagesRef.current.size === 0) {
        log("INFO", "language", `No style packs detected for ${cwd}`, { source });
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
        setLiveItems((prev) => [...prev, { kind: "style_pack", added: toAnnounce, id: getId() }]);
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

  const rebindSubagentsAfterCompaction = useCallback(
    (sessionId: string) =>
      props.subAgentManager?.rebindParentSession(sessionId) ?? Promise.resolve(),
    [props.subAgentManager],
  );
  const { persistCompactedSession, persistNewMessages } = useSessionPersistence({
    sessionManagerRef,
    sessionPathRef,
    sessionStatsRef,
    persistedIndexRef,
    messagesRef,
    turnMetricsRef,
    cwdRef,
    currentProvider,
    currentModel,
    sessionStore,
    onCompactedSession: rebindSubagentsAfterCompaction,
  });

  /**
   * Run the language detector against the current cwd. If the detected set is a
   * strict superset of what's already injected, rebuild the system prompt with
   * the expanded set and swap `messagesRef.current[0]`.
   *
   * Called from `onToolEnd` after `write`/`bash` succeeds — these are the only
   * tools that can introduce new marker files (package.json, Cargo.toml, etc.).
   * Other tool kinds skip detection entirely to avoid wasted filesystem stats.
   *
   * No restart required: the system prompt is mutated in place.
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

  const { compactionAbortRef, compactConversation, transformContext, recordProviderUsage } =
    useContextCompaction({
      currentModel,
      currentProvider,
      authStorage: props.authStorage,
      contextWindowOptions,
      activeApiKey,
      activeAccountId,
      activeProjectId,
      activeBaseUrl,
      setLiveItems,
      getId,
      approvedPlanPathRef,
      settingsRef,
      messagesRef,
      persistCompactedSession,
    });

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
        const creds = await props.authStorage.resolveCredentials(currentProvider, {
          ...opts,
          storageKeys: getAuthStorageKeys(currentProvider, currentModel),
        });
        return {
          apiKey: creds.accessToken,
          accountId: creds.accountId,
          projectId: creds.projectId,
        };
      }
      return { apiKey: activeApiKey!, accountId: activeAccountId, projectId: activeProjectId };
    },
    [
      props.authStorage,
      currentProvider,
      currentModel,
      activeApiKey,
      activeAccountId,
      activeProjectId,
    ],
  );

  const agentLoop = useAgentLoop(
    messagesRef,
    {
      provider: currentProvider,
      model: currentModel,
      tools: currentTools,
      webSearch: props.webSearch,
      maxTokens: props.maxTokens,
      supportsImages: getModel(currentModel)?.supportsImages ?? true,
      supportsVideo: getModel(currentModel)?.supportsVideo ?? false,
      thinking: thinkingLevel,
      apiKey: activeApiKey,
      baseUrl: activeBaseUrl,
      accountId: activeAccountId,
      projectId: activeProjectId,
      resolveCredentials,
      transformContext,
      lspManager: props.lspManager,
      reviewCoverageTracker: props.reviewCoverageTracker,
      getIdealReviewMessage: (stats, touchedFiles) => {
        if (!idealReviewEnabledRef.current) return null;
        const decision = evaluateIdealReview(stats);
        // Test drift fires the review even when the volume score is too low to
        // trigger on its own \u2014 a stale sibling test is invisible to typecheck.
        const driftedFiles = detectTestDrift(touchedFiles, process.cwd()).slice(0, 5);
        if (!decision.shouldReview && driftedFiles.length === 0) return null;
        log("INFO", "ideal", "Injecting ideal review before final response", {
          score: String(decision.score),
          reasons: decision.reasons.join(", "),
          testDrift: driftedFiles.join(", "),
        });
        setLiveItems((prev) => [
          ...prev,
          { kind: "ideal_hook", text: IDEAL_HOOK_NOTICE_TEXT, tone: "review", id: getId() },
        ]);
        return buildIdealReviewMessage(decision.reasons, driftedFiles);
      },
      getLoopBreakMessage: (stats, stage) => {
        if (!idealReviewEnabledRef.current) return null;
        const decision = evaluateLoopBreak(stats);
        if (!decision.shouldBreak) return null;
        log("INFO", "loop-break", "Injecting loop-break nudge", {
          stage: String(stage),
          reasons: decision.reasons.join(", "),
        });
        setLiveItems((prev) => [
          ...prev,
          { kind: "ideal_hook", text: LOOP_BREAK_NOTICE_TEXT, tone: "warning", id: getId() },
        ]);
        return buildLoopBreakMessage(decision.reasons, stage === 2);
      },
      getRegroundingMessage: (originalRequest) => {
        if (!idealReviewEnabledRef.current) return null;
        log("INFO", "reground", "Injecting re-grounding after compaction", {});
        setLiveItems((prev) => [
          ...prev,
          { kind: "ideal_hook", text: REGROUNDING_NOTICE_TEXT, tone: "info", id: getId() },
        ]);
        return buildRegroundingMessage(originalRequest);
      },
    },
    {
      onComplete: useCallback(() => {
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
      }, [persistNewMessages, props.cwd, props.skills]),
      onTurnText: useCallback(
        (text: string, thinking: string, thinkingMs: number) => {
          const hadStreamedAssistantFlush = streamedAssistantFlushRef.current.flushedChars > 0;
          const unflushedAssistantText = text.slice(streamedAssistantFlushRef.current.flushedChars);

          // Track [DONE:n] markers for plan step progress
          if (planStepsRef.current.length > 0) {
            const completed = findCompletedMarkers(text);
            if (completed.size > 0) {
              const planPath = approvedPlanPathRef.current;
              // The agent can rewrite/expand the approved plan mid-run, so the
              // snapshot captured at approval goes stale (wrong total, and new
              // [DONE:n] markers match nothing). Re-extract from the live plan
              // file and re-base onto it before applying markers. The file read
              // is async; apply markers inside the same async step to avoid a
              // race with the snapshot. Fall back to the in-memory snapshot if
              // there is no plan path or the read fails.
              const applyMarkers = (base: PlanStep[]): void => {
                const updated = markStepsCompleted(base, completed);
                if (updated !== planStepsRef.current) {
                  planStepsRef.current = updated;
                  setPlanSteps(updated);
                }
              };
              if (planPath) {
                void import("node:fs/promises")
                  .then(({ readFile }) => readFile(planPath, "utf-8"))
                  .then((planContent) => {
                    const fresh = extractPlanSteps(planContent);
                    applyMarkers(rebasePlanSteps(planStepsRef.current, fresh));
                  })
                  .catch(() => applyMarkers(planStepsRef.current));
              } else {
                applyMarkers(planStepsRef.current);
              }
              // Real progress happened — reset the stuck-guard so the next
              // step gets its own fresh nudge budget.
              followUpNudgesRef.current = { step: 0, count: 0 };
            }
          }

          // Flush completed rows from the previous turn to finalized terminal
          // history. Ink keeps only the active turn, preventing live-area growth
          // and avoiding Static/log-update replay during resize/remount churn.
          setLiveItems((prev) => {
            const flushed = flushOnTurnText(prev);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            // Split text on [DONE:N] markers so each marker renders inline as
            // a styled "✓ Step N: <description>" item at the position the
            // agent emitted it, instead of vanishing into stripped whitespace.
            const segments = segmentDisplayText(unflushedAssistantText, planStepsRef.current);
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
                  continuation: hadStreamedAssistantFlush,
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
            // Still persist an assistant item so a thinking block renders in
            // terminal history if there was thinking content for this turn.
            if (items.length === 0) {
              items.push({
                kind: "assistant",
                text: "",
                thinking,
                thinkingMs,
                id: getId(),
              });
            }
            const assistantItems = prev.filter((item) => item.kind === "assistant");
            const newAssistantText = normalizeAssistantText(unflushedAssistantText);
            const duplicatePinnedText =
              newAssistantText.length > 0 &&
              [...assistantItems, ...pendingHistoryFlushRef.current, ...historyRef.current].some(
                (item) => isSameAssistantText(item, newAssistantText),
              );
            const nextItems = duplicatePinnedText
              ? items.filter((item) => !isSameAssistantText(item, newAssistantText))
              : items;
            const flushablePrev = prev.filter((item) => item.kind !== "assistant");
            if (flushablePrev.length > 0) queueFlush(flushablePrev);
            // Finalized items taller than the live area can't stay pinned:
            // streaming-time clamping no longer applies, so Ink would only
            // paint the frame's bottom rows and the top of the response (e.g.
            // a table header) would be invisible until the next turn's flush.
            // The check is cumulative over the WHOLE pinned set (previously
            // pinned assistant items + this turn's, which [DONE:N]
            // segmentation can split into several): flush the leading prefix
            // so the remaining suffix fits, preserving transcript order. Return
            // only that suffix immediately; otherwise the just-flushed prefix
            // keeps the live-area clamp engaged for one stale frame, reserving
            // blank rows above a short final response.
            const pinned = [...assistantItems, ...nextItems];
            const layout = liveLayoutRef.current;
            const oversizedSplit = splitOversizedPinnedItems(
              pinned,
              (itemText) => estimateRenderedRows(itemText, layout.columns),
              layout.liveAreaRows,
            );
            if (oversizedSplit.flushed.length > 0) {
              queueFlush(oversizedSplit.flushed);
            }
            streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
            return oversizedSplit.remaining;
          });
        },
        [queueFlush],
      ),
      onToolStart: useCallback(
        (
          toolCallId: string,
          name: string,
          args: Record<string, unknown>,
          stream: StreamSnapshot,
        ) => {
          log("INFO", "tool", `Tool call started: ${name}`, { id: toolCallId });
          const startedAt = Date.now();
          const animateUntil = startedAt + RUNNING_INDICATOR_ANIMATION_MS;

          // Feed the pinned LiveToolPanel. Keep a small tail (panel shows the
          // last few rows) so memory stays bounded across long sessions.
          setLiveToolFeed((prev) =>
            [...prev, { id: toolCallId, name, args, status: "running" as const }].slice(
              -(LIVE_TOOL_PANEL_ROWS * 2),
            ),
          );

          const appendToolStart = (prev: CompletedItem[]): CompletedItem[] => {
            const visible = pinStreamingTextBeforeToolBoundary({
              items: prev,
              visibleStreamingText: stream.text,
              thinking: stream.thinking,
              thinkingMs: stream.thinkingMs,
              makeId: getId,
            });
            const { flushed, remaining } = partitionCompleted(visible);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            return remaining;
          };

          if (name === "spawn_agent") {
            // The manager lifecycle creates the keyed row; the spawn acknowledgement is not completion.
            setLiveItems(appendToolStart);
          } else if (name === "subagent") {
            setLiveItems(appendToolStart);
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
            setLiveItems((prev) => {
              const reusableGroupIdx = prev.findIndex(
                (item) =>
                  item.kind === "tool_group" &&
                  (item as ToolGroupItem).tools.every(
                    (tool) => tool.name === name && !tool.isError,
                  ),
              );
              const prior = reusableGroupIdx === -1 ? [] : prev.slice(0, reusableGroupIdx);
              if (reusableGroupIdx !== -1 && prior.every((item) => !isActiveItem(item))) {
                const flushablePrior = prior.filter((item) => item.kind !== "assistant");
                if (flushablePrior.length > 0) queueFlush(flushablePrior);
                const pinnedPrior = prior.filter((item) => item.kind === "assistant");
                const candidates = prev.slice(reusableGroupIdx);
                const group = candidates[0] as ToolGroupItem;
                return [
                  ...pinnedPrior,
                  {
                    ...group,
                    tools: [
                      ...group.tools,
                      { toolCallId, name, args, status: "running", animateUntil },
                    ],
                  },
                  ...candidates.slice(1),
                ];
              }
              const remaining = appendToolStart(prev);
              return [
                ...remaining,
                {
                  kind: "tool_group",
                  tools: [{ toolCallId, name, args, status: "running", animateUntil }],
                  id: getId(),
                },
              ];
            });
          } else {
            setLiveItems((prev) => [
              ...appendToolStart(prev),
              { kind: "tool_start", toolCallId, name, args, id: getId(), startedAt, animateUntil },
            ]);
          }
        },
        [queueFlush],
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
          recordToolEnd(sessionStatsRef.current, name, isError, durationMs);
          setLiveToolFeed((prev) =>
            prev.map((entry) =>
              entry.id === toolCallId
                ? { ...entry, status: "done" as const, isError, result, details }
                : entry,
            ),
          );
          if (name === "edit" && !isError) {
            const diff = (details as { diff?: string } | undefined)?.diff ?? result;
            addLinesChanged(sessionStatsRef.current, {
              added: (diff.match(/^\+[^+]/gm) ?? []).length,
              removed: (diff.match(/^-[^-]/gm) ?? []).length,
            });
          }
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

              // Flush completed items to finalized history to keep the live area small
              const { flushed, remaining } = partitionCompleted(next);
              if (flushed.length > 0) {
                queueFlush(flushed);
              }
              return remaining;
            });
          } else {
            setLiveItems((prev) => {
              if (name === "enter_plan") {
                const updated = prev
                  .filter((item) => !(item.kind === "tool_start" && item.toolCallId === toolCallId))
                  .map((item) =>
                    item.kind === "plan_transition" && item.active
                      ? { ...item, active: false }
                      : item,
                  );
                const { flushed, remaining } = partitionCompleted(updated);
                if (flushed.length > 0) {
                  queueFlush(flushed);
                  return remaining;
                }
                return updated;
              }
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
                    imagePreviews: extractToolImagePreviews(details),
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
                      imagePreviews: extractToolImagePreviews(details),
                      id: getId(),
                    },
                  ];
                }
              }

              // Flush completed items to finalized history to keep the live area small
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
      onServerToolCall: useCallback(
        (id: string, name: string, input: unknown, stream: StreamSnapshot) => {
          recordServerToolCall(sessionStatsRef.current);
          log("INFO", "server_tool", `Server tool call: ${name}`, { id });
          const startedAt = Date.now();
          const animateUntil = startedAt + RUNNING_INDICATOR_ANIMATION_MS;
          // Feed the pinned LiveToolPanel so provider-side tools (Anthropic's
          // native web_search) appear in the same rolling window as client
          // tools. `input` carries the tool args (e.g. { query }) the row reads.
          setLiveToolFeed((prev) =>
            [
              ...prev,
              {
                id,
                name,
                args: (input ?? {}) as Record<string, unknown>,
                status: "running" as const,
              },
            ].slice(-(LIVE_TOOL_PANEL_ROWS * 2)),
          );
          // Flush completed items (including assistant text) before adding server
          // tool UI — same rationale as onToolStart.
          setLiveItems((prev) => {
            const visible = pinStreamingTextBeforeToolBoundary({
              items: prev,
              visibleStreamingText: stream.text,
              thinking: stream.thinking,
              thinkingMs: stream.thinkingMs,
              makeId: getId,
            });
            const { flushed, remaining } = partitionCompleted(visible);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            // The pre-tool text was just pinned; the hook resets its streaming
            // buffer at this same boundary. Reset the progressive-flush offset
            // so post-tool text is measured from zero (stale flushedChars would
            // otherwise slice into the fresh, shorter buffer).
            streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
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
        },
        [queueFlush],
      ),
      onServerToolResult: useCallback(
        (toolUseId: string, resultType: string, data: unknown) => {
          log("INFO", "server_tool", `Server tool result`, { toolUseId, resultType });
          // Mark the panel entry done. Aborts never reach here (handled in
          // onAborted), so a result that arrives is always a normal completion.
          setLiveToolFeed((prev) =>
            prev.map((entry) =>
              entry.id === toolUseId ? { ...entry, status: "done" as const } : entry,
            ),
          );
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
            // Flush completed items to finalized history
            const { flushed, remaining } = partitionCompleted(updated);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            return remaining;
          });
        },
        [queueFlush],
      ),
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
          timing: AgentTurnTiming,
        ) => {
          recordProviderUsage(usage, messagesRef.current);
          recordTurnEnd(sessionStatsRef.current, usage);
          const metric: TurnMetricPayload = {
            version: 1,
            turn,
            provider: currentProvider,
            model: currentModel,
            stopReason,
            usage: { ...usage },
            timing: { ...timing },
            cost: {
              status: "unavailable",
              reason: "No authoritative effective-dated provider pricing is available",
            },
          };
          turnMetricsRef.current.push(metric);
          if (sessionStore) sessionStore.turnMetrics = [...turnMetricsRef.current];
          const metricSessionPath = sessionPathRef.current;
          const metricManager = sessionManagerRef.current;
          if (metricSessionPath && metricManager) {
            void metricManager.appendTurnMetric(metricSessionPath, metric);
          }
          log("INFO", "turn", `Turn ${turn} ended`, {
            stopReason,
            inputTokens: String(usage.inputTokens),
            outputTokens: String(usage.outputTokens),
            ...(usage.cacheRead != null && { cacheRead: String(usage.cacheRead) }),
            ...(usage.cacheWrite != null && { cacheWrite: String(usage.cacheWrite) }),
            providerDurationMs: String(timing.providerDurationMs),
            ...(timing.ttftMs != null && { ttftMs: String(timing.ttftMs) }),
          });
          // For tool-only turns (no text), flush completed items to finalized
          // history so liveItems doesn't grow unbounded across consecutive turns.
          setLiveItems((prev) => {
            const { flushed, remaining } = flushOnTurnEnd(prev, stopReason);
            if (flushed.length > 0) {
              queueFlush(flushed);
            }
            return remaining;
          });
        },
        [currentModel, currentProvider, queueFlush, recordProviderUsage, sessionStore],
      ),
      onDone: useCallback(
        (
          durationMs: number,
          toolsUsed: string[],
          runStats?: { counts: Record<string, number>; tokens: number },
        ) => {
          log("INFO", "agent", `Agent done`, {
            duration: `${durationMs}ms`,
            toolsUsed: toolsUsed.join(",") || "none",
          });
          const doneDecision = getDoneFlushDecision({
            planOverlayPending: planOverlayPendingRef.current,
          });
          // Don't show "done" status when the plan review pane is about to open —
          // the agent loop finished but we're waiting for user approval/review.
          // Still flush live transcript rows before the pane remounts; otherwise
          // setup output remains in ephemeral liveItems and appears to vanish.
          if (doneDecision.showDoneStatus) {
            setDoneStatus({
              durationMs,
              toolsUsed,
              verb: pickDurationVerb(toolsUsed),
              counts: runStats?.counts,
              tokens: runStats?.tokens,
            });
            playNotificationSound();
          }
          // Keep the final assistant response mounted in the live frame after a
          // normal chat turn finishes. Moving a large final response to terminal
          // history at this moment writes many scrollback rows while the footer is
          // still mounted, which visibly pushes the input/footer upward. The final
          // response is flushed on the next submit before the new prompt is shown.
          // Non-chat overlay transitions still flush so setup/plan output
          // does not vanish during remounts.
          if (doneDecision.flushLiveItems && !doneDecision.showDoneStatus) {
            setLiveItems((prev) => {
              if (prev.length > 0) queueFlush(prev);
              return [];
            });
          }

          // Run-all: auto-start next pending task after a short delay.
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
        },
        [],
      ),
      onAborted: useCallback(() => {
        log("WARN", "agent", "Agent run aborted by user");
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
      onQueuedStart: useCallback(
        (content: UserContent) => {
          // When a queued message starts processing, show it as a UserItem
          // and flush prior items to history.
          const displayText =
            typeof content === "string"
              ? content
              : content
                  .filter((c): c is TextContent => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");
          const imageCount =
            typeof content === "string"
              ? undefined
              : content.filter((c) => c.type === "image").length || undefined;
          const videoCount =
            typeof content === "string"
              ? undefined
              : content.filter((c) => c.type === "video").length || undefined;
          const userItem: UserItem = {
            kind: "user",
            text: displayText,
            imageCount,
            videoCount,
            id: getId(),
          };
          setLastUserMessage(displayText);
          setDoneStatus(null);
          finalizeSubmittedUserItem(userItem);
        },
        [finalizeSubmittedUserItem],
      ),
      // Inject a "continue with the next step" follow-up when the agent
      // would otherwise stop mid-plan. The prompt-only instruction wasn't
      // enough — some models (notably Opus) treat each [DONE:n] as a
      // natural completion boundary regardless. The stuck-guard caps
      // nudges per step so a genuinely blocked agent surfaces.
      getFollowUpMessages: useCallback(() => {
        const childCompletionFollowUp = buildSubAgentCompletionFollowUp(props.subAgentManager);
        if (childCompletionFollowUp) return childCompletionFollowUp;
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
      }, [props.subAgentManager]),
      onRetry: useCallback(() => {
        // Roll back any pending progressive flushes from the aborted attempt.
        // Without this, a stall retry regenerates the preamble and the old
        // flushed paragraph + the new one both end up in terminal history.
        pendingHistoryFlushRef.current = pendingHistoryFlushRef.current.filter(
          (item) => item.kind !== "assistant",
        );
        streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
      }, []),
      onTruncated: useCallback(
        (reason: "max_tokens" | "refusal" | "provider_error", continued: boolean) => {
          const text =
            reason === "max_tokens"
              ? continued
                ? TRUNCATED_CONTINUING_NOTICE_TEXT
                : TRUNCATED_INCOMPLETE_NOTICE_TEXT
              : reason === "refusal"
                ? TRUNCATED_REFUSAL_NOTICE_TEXT
                : TRUNCATED_PROVIDER_ERROR_NOTICE_TEXT;
          setLiveItems((prev) => [
            ...prev,
            { kind: "ideal_hook", text, tone: "warning", id: getId() },
          ]);
        },
        [],
      ),
    },
  );

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

  // Bottom-anchor gating: pad creation on while the agent runs, off at idle.
  // The idle transition is delayed 500ms so the finalization commits (done
  // status swap, live-item clear, deferred flushes) all land while the anchor
  // still protects them; only then does idle UI (slash menu open/close, input
  // grow/shrink) regain natural symmetric footer movement.
  const setFrameAnchorActive = props.setFrameAnchorActive;
  useEffect(() => {
    if (!setFrameAnchorActive) return;
    if (agentLoop.isRunning) {
      setFrameAnchorActive(true);
      return;
    }
    const timer = setTimeout(() => setFrameAnchorActive(false), 500);
    return () => clearTimeout(timer);
  }, [agentLoop.isRunning, setFrameAnchorActive]);

  const showSessionSummaryAndExit = useCallback(() => {
    const summary = buildSessionSummary({
      stats: sessionStatsRef.current,
      provider: currentProvider,
      model: currentModel,
      cwd: displayedCwd,
      footer: sessionStatsRef.current.sessionId
        ? `To resume this session: ggcoder --resume ${sessionStatsRef.current.sessionId}`
        : undefined,
    });
    setDoneStatus(null);
    setExitPending(false);
    setOverlay(null);
    setLiveItems([]);
    setQuittingSummary(summary);
    writeStdout("\x1b[2J\x1b[3J\x1b[H");
    setTimeout(() => process.exit(0), 150);
  }, [currentModel, currentProvider, displayedCwd, writeStdout]);

  // Consume pending post-remount work once on mount. Set by resetUI options
  // for paths that remount AND immediately drive work (plan accept/reject,
  // pixel fix, plan accept/reject). The work survives the unmount because
  // it lives in renderApp's closure (sessionStore), not React state.
  useEffect(() => {
    if (pendingActionConsumedRef.current) return;
    const action = sessionStore?.pendingAction;
    if (!action) return;
    pendingActionConsumedRef.current = true;
    if (sessionStore) {
      sessionStore.pendingAction = undefined;
    }
    setDoneStatus(null);
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
    void agentLoop.run(action.prompt).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("ERROR", "error", errMsg);
      if (agentLoop.isRunning) {
        agentLoop.reset();
      }
      setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
    });
    // Intentional one-shot: run once on mount, never re-fire on re-render.
  }, []);

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

      if (trimmed === "/ideal-on" || trimmed === "/ideal-off") {
        const next = trimmed === "/ideal-on";
        setIdealReviewEnabled(next);
        if (props.settingsFile) {
          const sm = new SettingsManager(props.settingsFile);
          await sm.load();
          await sm.set("idealReviewEnabled", next);
        }
        setLiveItems((prev) => [
          ...prev,
          {
            kind: "info",
            text: next
              ? "Ideal review enabled. Use /ideal-off to disable it."
              : "Ideal review disabled. Use /ideal-on to enable it.",
            id: getId(),
          },
        ]);
        return;
      }

      // /rewind — open the checkpoint picker (needs React state + the store).
      if (trimmed === "/rewind") {
        const store = props.checkpointStore;
        if (!store) {
          setLiveItems((prev) => [
            ...prev,
            { kind: "info", text: "Checkpoints are not available in this session.", id: getId() },
          ]);
          return;
        }
        const cps = await store.listCheckpoints();
        if (cps.length === 0) {
          setLiveItems((prev) => [
            ...prev,
            {
              kind: "info",
              text: "No checkpoints yet \u2014 edit a file through ggcoder first.",
              id: getId(),
            },
          ]);
          return;
        }
        setRewindCheckpoints(cps);
        return;
      }

      if (
        await handleUiSlashCommand(trimmed, {
          openModelSelector: () => setOverlay("model"),
          compactConversation: async () => {
            const ac = new AbortController();
            compactionAbortRef.current = ac;
            const compacted = await compactConversation(messagesRef.current, ac.signal);
            if (!ac.signal.aborted && compacted !== messagesRef.current) {
              messagesRef.current = compacted;
              await persistCompactedSession(compacted);
            }
            if (compactionAbortRef.current === ac) compactionAbortRef.current = null;
          },
          quit: showSessionSummaryAndExit,
          clearSession: () => {
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
            clearPendingHistory();
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
            setLiveItems([{ kind: "info", text: "Session cleared.", id: getId() }]);
          },
          openThemeSelector: () => setOverlay("theme"),
          toggleMarkdown: () => {
            setRenderMarkdown((prev) => {
              const next = !prev;
              setLiveItems([
                {
                  kind: "info",
                  text: next ? "Rendered markdown mode." : "Raw markdown mode.",
                  id: getId(),
                },
              ]);
              return next;
            });
          },
          clearApprovedPlan: () => {
            approvedPlanPathRef.current = undefined;
            planStepsRef.current = [];
            setPlanSteps([]);
            void replaceSystemPrompt({ clearApprovedPlan: true });
            setLiveItems([{ kind: "plan_event", event: "dismissed", id: getId() }]);
          },
        })
      ) {
        return;
      }

      if (
        await submitPromptCommand({
          trimmed,
          inputImages,
          currentModel,
          customCommands,
          setLastUserMessage,
          setDoneStatus,
          finalizeSubmittedUserItem,
          runAgent: (content) => agentLoop.run(content),
          setLiveItems,
          getId,
          reloadCustomCommands,
        })
      ) {
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
      const imageCount = inputImages.filter((img) => img.kind === "image").length;
      const videoCount = inputImages.filter((img) => img.kind === "video").length;
      const modelInfo = getModel(currentModel);
      const modelSupportsImages = modelInfo?.supportsImages ?? true;
      const modelSupportsVideo = modelInfo?.supportsVideo ?? false;
      const userContent = buildUserContentWithAttachments(
        input,
        inputImages,
        modelSupportsImages,
        modelSupportsVideo,
      );

      // ── Queue message if agent is already running ──
      if (agentLoop.isRunning) {
        log(
          "INFO",
          "queue",
          `Queued message: ${trimmed.length > 80 ? trimmed.slice(0, 80) + "..." : trimmed}`,
        );
        agentLoop.queueMessage(userContent, input);
        let displayText = input;
        if (hasImages) {
          const { cleanText } = await extractMediaPaths(input, props.cwd);
          displayText = cleanText;
        }
        const queuedItem: QueuedItem = {
          kind: "queued",
          text: displayText,
          imageCount: imageCount > 0 ? imageCount : undefined,
          videoCount: videoCount > 0 ? videoCount : undefined,
          id: getId(),
        };
        setLiveItems((prev) => [...prev, queuedItem]);
        return;
      }

      // Build display text — strip image/video paths, show badges instead
      let displayText = input;
      if (hasImages) {
        const { cleanText } = await extractMediaPaths(input, props.cwd);
        displayText = cleanText;
      }
      let imagePreviews: ImagePreview[] | undefined;
      if (hasImages) {
        const built = await Promise.all(
          inputImages
            .filter((img) => img.kind === "image")
            .map(async (img): Promise<ImagePreview> => {
              const downscaled = await downscaleForPreview(Buffer.from(img.data, "base64"));
              return { base64: downscaled.toString("base64"), mediaType: img.mediaType };
            }),
        );
        imagePreviews = built.length > 0 ? built : undefined;
      }
      const userItem: UserItem = {
        kind: "user",
        text: displayText,
        imageCount: imageCount > 0 ? imageCount : undefined,
        videoCount: videoCount > 0 ? videoCount : undefined,
        imagePreviews,
        pasteInfo,
        id: getId(),
      };
      setLastUserMessage(input);
      setScrollResetToken((token) => token + 1);
      setDoneStatus(null);
      // Clear stale plan progress if there's no active approved plan
      // (avoids lingering progress from a completed or abandoned plan run)
      if (planStepsRef.current.length > 0 && !approvedPlanPathRef.current) {
        planStepsRef.current = [];
        setPlanSteps([]);
      }
      finalizeSubmittedUserItem(userItem, liveItems);

      // Open a per-turn checkpoint capturing the conversation position right
      // before this exchange, so /rewind can restore pre-turn code/chat state.
      if (props.checkpointStore) {
        rewindTurnRef.current += 1;
        await props.checkpointStore
          .openCheckpoint({
            turnIndex: rewindTurnRef.current,
            messageIndex: messagesRef.current.length,
          })
          .catch(() => {});
      }

      // Run agent
      try {
        await agentLoop.run(userContent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("ERROR", "error", msg);
        const isAbort = msg.includes("aborted") || msg.includes("abort");
        // If the agent loop threw but left isRunning in a stale true state
        // (can happen when the finally block hasn't been processed by React
        // yet), reset it so the user isn't deadlocked with a non-working UI.
        if (agentLoop.isRunning) {
          agentLoop.reset();
        }
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
      compactConversation,
      currentModel,
      finalizeSubmittedUserItem,
      liveItems,
      props.cwd,
      props.onSlashCommand,
      props.resetUI,
      props.sessionStore,
      rebuildSystemPrompt,
      showSessionSummaryAndExit,
      reloadCustomCommands,
      replaceSystemPrompt,
    ],
  );

  const handleDoubleExit = useDoublePress(setExitPending, showSessionSummaryAndExit);

  const handleAbort = useCallback(() => {
    if (agentLoop.isRunning) {
      // Restore any unsent queued messages to the composer instead of dropping
      // them, so an interrupt never silently discards what the user typed.
      const queuedText = agentLoop.drainQueuedText();
      if (queuedText) {
        setLiveItems((prev) => prev.filter((item) => item.kind !== "queued"));
        setComposerInject({ text: queuedText, nonce: nextIdRef.current++ });
      }
      agentLoop.abort();
      void props.subAgentManager?.interruptAll();
    } else if (
      props.subAgentManager
        ?.list()
        .some((agent) => agent.state === "starting" || agent.state === "running")
    ) {
      void props.subAgentManager.interruptAll();
    } else if (compactionAbortRef.current) {
      compactionAbortRef.current.abort();
    } else {
      handleDoubleExit();
    }
  }, [agentLoop, handleDoubleExit, props.subAgentManager, setLiveItems]);

  const handleToggleThinking = useCallback(() => {
    setThinkingLevel((prev) => {
      const next = getNextThinkingLevel(currentProvider, currentModel, prev);
      log("INFO", "thinking", next ? `Thinking ${next}` : "Thinking disabled");
      if (props.settingsFile) {
        const sm = new SettingsManager(props.settingsFile);
        void sm.load().then(async () => {
          await sm.set("thinkingEnabled", !!next);
          if (next) await sm.set("thinkingLevel", next);
        });
      }
      return next;
    });
  }, [currentProvider, currentModel, props.settingsFile]);

  const handleModelSelect = useCallback(
    (value: string) => {
      setOverlay(null);
      const colonIdx = value.indexOf(":");
      if (colonIdx === -1) return;
      const newProvider = value.slice(0, colonIdx) as Provider;
      const newModelId = value.slice(colonIdx + 1);
      log("INFO", "model", `Model changed`, { provider: newProvider, model: newModelId });
      // Keep the ref in sync before any prompt rebuild so the identity (Claude
      // Code vs GG Coder) reflects the newly selected provider immediately.
      currentProviderRef.current = newProvider;

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

          // Reconnect MCP servers ONLY when the resolved server set actually
          // changes. GLM is the only provider with a different set (Z.AI
          // servers), so a switch that doesn't involve GLM on either side
          // keeps the identical set — tearing down a live stdio child (e.g.
          // kencode-search) and re-spawning `npx` there only risks a failed
          // re-spawn that would silently drop the tools.
          const glmInvolved = newProvider === "glm" || prevProvider === "glm";
          if (props.mcpManager && glmInvolved) {
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
                // Use getAllMcpServers so user-configured servers (from
                // ~/.gg/mcp.json and ./.gg/mcp.json) survive the reconnect —
                // getMCPServers returns provider defaults only.
                const servers = await getAllMcpServers(newProvider, apiKey, props.cwd);
                const mcpTools = await props.mcpManager!.connectAll(servers);
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

      // The `read` tool's video capability (its description + native-video
      // execute path) is baked in at creation from the model's `maxVideoBytes`.
      // Switching to/from a video-capable model (e.g. text-only MiMo-V2.5-Pro →
      // omnimodal MiMo-V2.5) must rebuild it, or the tool keeps telling the model
      // it can't watch video. Rebuild reuses the read tracker, so read-before-edit
      // history survives. Provider-change rebuilds the prompt above; this covers
      // same-provider model switches too.
      setCurrentModel((prevModel) => {
        if (
          props.rebuildReadTool &&
          getVideoByteLimit(prevModel) !== getVideoByteLimit(newModelId)
        ) {
          const newReadTool = props.rebuildReadTool(newModelId);
          setCurrentTools((prev) => {
            const next = prev.map((tool) => (tool.name === "read" ? newReadTool : tool));
            currentToolsRef.current = next;
            void replaceSystemPrompt({ tools: next });
            return next;
          });
        }
        return newModelId;
      });
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
              | "openrouter"
              | "sakana"
              | "xai",
          );
          await sm.set("defaultModel", newModelId);
        });
      }
    },
    [
      props.settingsFile,
      props.mcpManager,
      props.credentialsByProvider,
      props.authStorage,
      props.rebuildReadTool,
      replaceSystemPrompt,
    ],
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
      return c
        ? {
            name: c.name,
            aliases: c.aliases,
            description: c.description,
            sectionTitle: "workflows",
          }
        : null;
    };
    const promptOrder = [
      // Project audits / one-shot analysis
      "init",
      "expand",
      "bullet-proof",
      "compare",
      // Setup / installers
      "setup-commit",
      "setup-skills",
    ];
    const orderedPromptCommands = promptOrder
      .map(fromPrompt)
      .filter((c): c is SlashCommandInfo => c !== null);
    const knownPromptNames = new Set(promptOrder);
    const remainingPromptCommands = PROMPT_COMMANDS.filter(
      (c) => !knownPromptNames.has(c.name),
    ).map((c) => ({
      name: c.name,
      aliases: c.aliases,
      description: c.description,
      sectionTitle: "workflows",
    }));

    return [
      // Session actions (most frequent)
      { name: "model", aliases: ["m"], description: "Switch model", sectionTitle: "built-in" },
      { name: "compact", aliases: ["c"], description: "Compact context", sectionTitle: "built-in" },
      { name: "clear", aliases: [], description: "Clear session", sectionTitle: "built-in" },
      { name: "theme", aliases: ["t"], description: "Switch theme", sectionTitle: "built-in" },
      {
        name: idealReviewEnabled ? "ideal-off" : "ideal-on",
        aliases: [],
        description: idealReviewEnabled
          ? "Disable pre-final ideal review"
          : "Enable pre-final ideal review",
        sectionTitle: "built-in",
      },
      {
        name: "rewind",
        aliases: [],
        description: "Restore files/conversation to a checkpoint",
        sectionTitle: "built-in",
      },
      ...orderedPromptCommands,
      ...remainingPromptCommands,
      ...customCommands.map((cmd) => ({
        name: cmd.name,
        aliases: [] as string[],
        description: cmd.description,
        sectionTitle: "custom",
      })),
      {
        name: "quit",
        aliases: ["q", "exit"],
        description: "Exit ggcoder",
        sectionTitle: "built-in",
      },
    ];
  }, [customCommands, idealReviewEnabled]);

  const renderItem = (item: CompletedItem, index: number, items: CompletedItem[]) =>
    renderTranscriptItem({
      item,
      index,
      items,
      pendingHistoryFlushLastItem:
        index === 0 ? lastVisibleTranscriptItem(pendingHistoryFlushRef.current) : undefined,
      historyLastItem: index === 0 ? lastVisibleTranscriptItem(history) : undefined,
      version: props.version,
      currentModel,
      currentProvider,
      displayedCwd,
      columns,
      theme,
      renderMarkdown,
      measuredLiveAreaRows,
    });

  const openOverlay = useCallback(
    (kind: "skills" | "plan") => {
      if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
        props.sessionStore.overlay = kind;
        if (kind !== "plan") props.sessionStore.planAutoExpand = false;
        props.resetUI();
      } else {
        if (props.sessionStore) {
          props.sessionStore.overlay = kind;
          if (kind !== "plan") props.sessionStore.planAutoExpand = false;
          if (agentLoop.isRunning && kind !== "plan") {
            props.sessionStore.pendingResetUI = true;
          }
        }
        if (kind !== "plan") setPlanAutoExpand(false);
        setOverlay(kind);
      }
    },
    [agentLoop.isRunning, props],
  );

  useEffect(() => {
    runAllTasksRef.current = runAllTasks;
    if (props.sessionStore) props.sessionStore.runAllTasks = runAllTasks;
  }, [runAllTasks, props.sessionStore]);

  useEffect(() => {
    agentRunningRef.current = agentLoop.isRunning;
  }, [agentLoop.isRunning]);

  // Starts a single task: opens a fresh session + chat and runs the task
  // prompt through the agent loop. Wired into startTaskRef so both the task
  // picker (Enter = start one, r = run all) and the run-all auto-advance in
  // onDone can invoke it from stale closures.
  const startTask = useCallback(
    (title: string, prompt: string, taskId: string) => {
      const taskCwd = cwdRef.current;
      const shortId = taskId.slice(0, 8);
      const completionHint =
        `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
        `tasks({ action: "done", id: "${shortId}" })`;
      const fullPrompt = prompt + completionHint;

      if (props.resetUI && props.sessionStore) {
        const sysMsg = messagesRef.current[0];
        const newMessages: Message[] =
          sysMsg && sysMsg.role === "system" ? [sysMsg] : messagesRef.current.slice(0, 1);
        const taskItem: TaskItem = { kind: "task", title, id: getId() };
        const sm = sessionManagerRef.current;

        void (async () => {
          let newSessionPath: string | undefined;
          if (sm) {
            try {
              const session = await sm.create(taskCwd, currentProvider, currentModel);
              newSessionPath = session.path;
              sessionStatsRef.current.sessionId = session.id;
              if (props.sessionStore) props.sessionStore.sessionId = session.id;
              await props.subAgentManager?.resetParentSession(session.id);
              log("INFO", "tasks", "New session for task", { path: session.path });
            } catch {
              // Session creation is best-effort.
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

      clearPendingHistory();
      setHistory([{ kind: "banner", id: "banner" }]);
      setLiveItems([]);
      messagesRef.current = messagesRef.current.slice(0, 1);
      agentLoop.reset();
      persistedIndexRef.current = messagesRef.current.length;
      const sm = sessionManagerRef.current;
      const taskItem: TaskItem = { kind: "task", title, id: getId() };
      setLastUserMessage(title);
      setDoneStatus(null);
      setLiveItems([taskItem]);
      void (async () => {
        try {
          if (sm) {
            const session = await sm.create(taskCwd, currentProvider, currentModel);
            sessionPathRef.current = session.path;
            sessionStatsRef.current.sessionId = session.id;
            await props.subAgentManager?.resetParentSession(session.id);
            log("INFO", "tasks", "New session for task", { path: session.path });
          }
          await agentLoop.run(fullPrompt);
        } catch (err) {
          if (agentLoop.isRunning) agentLoop.reset();
          setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
        }
      })();
    },
    [agentLoop, currentModel, currentProvider, props],
  );
  // Keep the ref in sync so stale closures (task picker, onDone run-all) can
  // start a task without being recreated each render.
  startTaskRef.current = startTask;

  // Reset the live tool feed at the start of each run so the pinned panel only
  // ever reflects the current turn's activity, not the previous one's.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (agentLoop.isRunning && !wasRunningRef.current) {
      setLiveToolFeed([]);
    }
    wasRunningRef.current = agentLoop.isRunning;
  }, [agentLoop.isRunning]);

  const isSkillsView = overlay === "skills";
  const isPlanView = overlay === "plan";
  const {
    footerStatusLayout,
    activityVisible,
    stallStatusVisible,
    statusSlotVisible,
    mainControlsRef,
    measuredLiveAreaRows,
    viewportRows,
  } = useChatLayoutMeasurements({
    rows,
    columns,
    backgroundTaskCount: bgTasks.length,
    updatePending,
    agentRunning: agentLoop.isRunning,
    activityPhase: agentLoop.activityPhase,
    stallError: agentLoop.stallError,
    doneStatus,
    currentModel,
    contextUsed: agentLoop.contextUsed,
    contextWindowOptions,
    displayedCwd,
    gitBranch,
    thinkingLevel,
    exitPending,
    taskBarExpanded,
    liveToolFeedCount: liveToolFeed.length,
  });
  useEffect(() => {
    liveLayoutRef.current = { columns, liveAreaRows: measuredLiveAreaRows };
  }, [columns, measuredLiveAreaRows]);
  const hasLiveAssistantItem = liveItems.some((item) => item.kind === "assistant");
  const rawVisibleStreamingText = hasLiveAssistantItem ? "" : agentLoop.streamingText;
  // The live text is sliced by the COMMITTED `flushedChars` only. When the
  // flush effect below queues a paragraph, queueFlush enqueues the rendered
  // bytes through the patched Ink `insertBeforeFrame` (passive — no terminal
  // write) and the generation bump re-renders with the advanced flushedChars;
  // that commit's single frame write is `erase tall frame + paragraph bytes +
  // shorter frame`, so no frame ever shows the paragraph in both scrollback
  // and the live region, and the footer never bounces.
  const alreadyFlushedChars = streamedAssistantFlushRef.current.flushedChars;
  // Retry-safety gate: don't commit streamed paragraphs to permanent scrollback
  // while the text is still small enough to live entirely in the live region.
  // A silent stall-retry (agent-loop.ts) restarts the LLM call from scratch and
  // regenerates the opening text — reworded, so the byte-identical dedup can't
  // catch it. Anything already printed to scrollback can't be un-written, so the
  // regen appends as a second ⏺ bullet that paraphrases the first. Keeping short
  // streamed text live (it clears via setStreamingText("") on retry) closes that
  // hole. We only start flushing once the unflushed text would overflow the live
  // area — the original anti-jump purpose, which only matters for long responses
  // that are far less likely to be a stalled preamble. Once flushing has begun
  // for this turn (alreadyFlushedChars > 0) we keep flushing every boundary so
  // committed continuation paragraphs stay consistent with the live tail.
  const unflushedStreamingRows = rawVisibleStreamingText
    ? estimateRenderedRows(rawVisibleStreamingText.slice(alreadyFlushedChars), columns)
    : 0;
  const shouldFlushStreamedText =
    alreadyFlushedChars > 0 || unflushedStreamingRows > measuredLiveAreaRows;
  useEffect(() => {
    if (!rawVisibleStreamingText) {
      streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
      return;
    }
    if (rawVisibleStreamingText === streamedAssistantFlushRef.current.text) return;
    if (!shouldFlushStreamedText) {
      streamedAssistantFlushRef.current = {
        ...streamedAssistantFlushRef.current,
        text: rawVisibleStreamingText,
      };
      return;
    }
    const alreadyFlushed = streamedAssistantFlushRef.current.flushedChars;
    const unflushedText = rawVisibleStreamingText.slice(alreadyFlushed);
    const split = splitAssistantStreamingText(unflushedText);
    if (split.flushedText.length > 0) {
      queueFlush([
        {
          kind: "assistant",
          text: stripDoneMarkers(split.flushedText),
          continuation: streamedAssistantFlushRef.current.flushedChars > 0,
          id: getId(),
        },
      ]);
      streamedAssistantFlushRef.current = {
        flushedChars: alreadyFlushed + split.flushedText.length,
        text: rawVisibleStreamingText,
      };
      return;
    }
    streamedAssistantFlushRef.current = {
      ...streamedAssistantFlushRef.current,
      text: rawVisibleStreamingText,
    };
  }, [rawVisibleStreamingText, shouldFlushStreamedText, queueFlush]);
  const visibleStreamingText = stripDoneMarkers(rawVisibleStreamingText.slice(alreadyFlushedChars));
  const lastLiveItem = liveItems.at(-1);
  // For spacing decisions, the previous row is the last item that actually
  // RENDERS. Panel-replaced tool items (now shown only in the LiveToolPanel)
  // render null, so counting them as the boundary inserts a blank separator
  // above the streamed response with nothing visible above it.
  const lastVisibleLiveItem = lastVisibleTranscriptItem(liveItems);
  const lastPendingHistoryItem = pendingHistoryFlushRef.current.at(-1);
  const lastHistoryItem = history.at(-1);
  // Spacing variants: flushed tool rows render null (LiveToolPanel owns them), so
  // the streamed/first-live boundary must look past them to the last row that
  // actually printed — otherwise a tool→assistant separator leaves a phantom gap.
  const lastVisiblePendingHistoryItem = lastVisibleTranscriptItem(pendingHistoryFlushRef.current);
  const lastVisibleHistoryItem = lastVisibleTranscriptItem(history);
  const previousTranscriptItem = lastPendingHistoryItem ?? lastHistoryItem;
  const isAwaitingAssistantAfterUser =
    agentLoop.isRunning &&
    !hasLiveAssistantItem &&
    visibleStreamingText.trim().length === 0 &&
    (lastLiveItem?.kind === "user" || (!lastLiveItem && previousTranscriptItem?.kind === "user"));
  const shouldReserveStreamingSpacing =
    agentLoop.isRunning &&
    !hasLiveAssistantItem &&
    (visibleStreamingText.trim().length > 0 ||
      liveItems.some(isTranscriptSpacingItem) ||
      isAwaitingAssistantAfterUser);
  const shouldTopSpaceStreamingText = shouldTopSpaceStreamingAssistant({
    visibleStreamingText,
    lastLiveItem: lastVisibleLiveItem,
    lastPendingHistoryItem: lastVisiblePendingHistoryItem,
    lastHistoryItem: lastVisibleHistoryItem,
  });
  // When earlier paragraphs of THIS response were already flushed to scrollback
  // mid-stream, the live remainder is the next paragraph — re-insert the blank
  // line that separated them so the live tail lines up with the flushed history.
  const streamingContinuesFlushed = alreadyFlushedChars > 0;

  // ── Fullscreen alt-screen transcript ───────────────────
  // Flatten history + live items + in-flight streaming into the flat ANSI line
  // buffer the viewport renders. Reuses the same serializer the legacy
  // scrollback printer used, so the transcript looks identical. Only computed
  // when fullscreen is active (the legacy path renders items through Ink).
  const transcriptContext = useMemo(
    () => ({
      theme,
      columns,
      version: props.version,
      model: currentModel,
      provider: currentProvider,
      cwd: displayedCwd,
    }),
    [theme, columns, props.version, currentModel, currentProvider, displayedCwd],
  );
  const transcriptLines = useMemo(() => {
    if (!props.fullscreen) return [];
    const items: CompletedItem[] = [...history, ...uniqueItemsById(liveItems)];
    const hasStreaming = visibleStreamingText.length > 0 || agentLoop.streamingThinking.length > 0;
    if (hasStreaming) {
      items.push({
        kind: "assistant",
        text: visibleStreamingText,
        thinking: agentLoop.streamingThinking,
        thinkingMs: agentLoop.thinkingMs,
        continuation: streamingContinuesFlushed,
        id: "__streaming__",
      });
    }
    return buildTranscriptLines(items, transcriptContext);
  }, [
    props.fullscreen,
    history,
    liveItems,
    visibleStreamingText,
    agentLoop.streamingThinking,
    agentLoop.thinkingMs,
    streamingContinuesFlushed,
    transcriptContext,
  ]);
  // Keyboard + bounds controller. The offset itself lives in the external
  // transcript-scroll store; the viewport subscribes to it directly so scroll
  // re-renders only the viewport, not this whole component.
  useTranscriptScroll({
    totalLines: transcriptLines.length,
    viewportRows,
    active: !!props.fullscreen && !overlay && !taskBarFocused,
    resetToken: scrollResetToken,
  });

  // Mid-run bottom-anchor gap reclaim. While the agent runs, the patched ink
  // anchor converts every live-frame SHRINK into pad debt — blank rows emitted
  // above the frame so the footer never jumps up during tool/status churn.
  // Growth normally consumes those pads, but when a shrink is NOT followed by
  // growth the pads linger on screen as a blank gap between the flushed
  // scrollback transcript and the live frame — the whitespace users see.
  //
  // This is ONE mechanism with many triggers, and this single effect covers
  // them ALL by construction: every debt-creating event mutates one of the
  // dependencies below, so the debounce re-arms on each and fires once the
  // frame finally settles. Sources include:
  //   • the submit boundary — the prior turn flushes + the live frame clears
  //     (setLiveItems([])) and the open slash menu closes (controls shrink),
  //     all before the new turn streams a single token (measuredLiveAreaRows +
  //     liveItems change);
  //   • a finishing tool batch — panel rows collapse (liveToolFeed / liveItems);
  //   • status-slot swaps and oversized-item flushes mid-stream;
  //   • a long quiet thinking stretch after any of the above (no growth comes).
  // Previously this debt was only reclaimed at idle (run end), so the gap
  // "fixed itself" only once the turn landed in history.
  //
  // Once the live frame has been visually stable for a beat, pulse the anchor
  // off→on: the off transition reclaims the pad debt via the backfill repaint
  // (footer stays bottom-pinned, the gap fills with the transcript tail) and
  // the immediate on transition restores pad protection for the next burst of
  // churn. Both calls are synchronous so no unpadded frame renders between, and
  // it is a cheap no-op when there is no debt (the off transition early-returns
  // when pad debt is zero). Skipped in fullscreen, which owns the whole screen
  // and never pads. The delay trails React's commit + ink's render throttle
  // (~33ms) and the insertBeforeFrame fallback (100ms) so the compensated
  // flush has fully rendered before we measure-and-reclaim, while staying short
  // enough that a stranded gap never lingers long enough to read as a bug.
  useEffect(() => {
    if (props.fullscreen) return;
    if (!setFrameAnchorActive) return;
    if (!agentLoop.isRunning) return;
    const timer = setTimeout(() => {
      setFrameAnchorActive(false);
      setFrameAnchorActive(true);
    }, 250);
    return () => clearTimeout(timer);
  }, [
    props.fullscreen,
    setFrameAnchorActive,
    agentLoop.isRunning,
    agentLoop.activityPhase,
    liveItems,
    visibleStreamingText,
    liveToolFeed,
    measuredLiveAreaRows,
  ]);

  const visibleQueuedCount = liveItems.filter((item) => item.kind === "queued").length;
  const hiddenQueuedCount = Math.max(0, agentLoop.queuedCount - visibleQueuedCount);
  const shouldTopSpaceQueueIndicator =
    hiddenQueuedCount > 0 &&
    shouldTopSpaceAfterPrintedAgentBoundary({
      currentKind: "queued",
      previousLiveItem: lastLiveItem,
      lastPendingHistoryItem,
      lastHistoryItem,
    });

  const handleRewindCancel = useCallback(() => setRewindCheckpoints(null), []);

  const handleRewindRestore = useCallback(
    (id: string, mode: RestoreMode) => {
      const store = props.checkpointStore;
      setRewindCheckpoints(null);
      if (!store) return;
      void (async () => {
        try {
          const result = await store.restore(id, mode);
          const turnNum = id.replace(/^cp-0*/, "") || id;
          const detailParts: string[] = [];
          if (mode === "code" || mode === "both") {
            detailParts.push(
              `${result.filesRestored} file${result.filesRestored === 1 ? "" : "s"} restored`,
            );
          }
          if (mode === "conversation" || mode === "both") detailParts.push("conversation rewound");
          const infoText = `Rewound to checkpoint #${turnNum} (${detailParts.join(", ")}).`;

          if (mode === "conversation" || mode === "both") {
            const truncated = messagesRef.current.slice(0, Math.max(1, result.messageIndex));
            messagesRef.current = truncated;
            persistedIndexRef.current = truncated.length;
            agentLoop.reset();
            // Remount in lockstep so the banner + confirmation re-render cleanly
            // after the conversation context is truncated (CLAUDE.md pattern).
            if (props.resetUI) {
              props.resetUI({
                wipeSession: true,
                messages: truncated,
                history: [
                  { kind: "banner", id: "banner" },
                  { kind: "info", text: infoText, id: getId() },
                ],
              });
              return;
            }
          }
          setLiveItems((prev) => [...prev, { kind: "info", text: infoText, id: getId() }]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setLiveItems((prev) => [
            ...prev,
            { kind: "info", text: `Rewind failed: ${msg}`, id: getId() },
          ]);
        }
      })();
    },
    [props.checkpointStore, props.resetUI, agentLoop, messagesRef, persistedIndexRef],
  );

  const handleCloseRemountableOverlay = () => {
    if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
      props.sessionStore.overlay = null;
      props.resetUI();
      return;
    }
    if (props.sessionStore) {
      props.sessionStore.overlay = null;
      if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
    }
    setOverlay(null);
  };

  const handleEnterPlanMode = useCallback(
    async (reason?: string): Promise<void> => {
      await setPlanModeAndPrompt(true);
      setLiveItems((prev) => [
        ...prev,
        { kind: "plan_transition", text: reason ?? "", id: getId(), active: true },
      ]);
    },
    [setPlanModeAndPrompt],
  );

  const handleExitPlanMode = useCallback(
    async (_planPath: string): Promise<string> => {
      await setPlanModeAndPrompt(false);
      planOverlayPendingRef.current = true;
      setPlanAutoExpand(true);
      if (props.sessionStore) {
        props.sessionStore.overlay = "plan";
        props.sessionStore.planAutoExpand = true;
      }
      setOverlay("plan");
      return "Plan submitted for user review. Wait for the user to approve, reject, or dismiss it before implementing.";
    },
    [props.sessionStore, setPlanModeAndPrompt],
  );

  useEffect(() => {
    if (!props.planCallbacks) return;
    props.planCallbacks.onEnterPlan = handleEnterPlanMode;
    props.planCallbacks.onExitPlan = handleExitPlanMode;
  }, [handleEnterPlanMode, handleExitPlanMode, props.planCallbacks]);

  const handleClosePlanOverlay = () => {
    planOverlayPendingRef.current = false;
    if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
      props.sessionStore.overlay = null;
      props.sessionStore.planAutoExpand = false;
      props.resetUI();
      return;
    }
    if (props.sessionStore) {
      props.sessionStore.overlay = null;
      props.sessionStore.planAutoExpand = false;
      if (agentLoop.isRunning) props.sessionStore.pendingResetUI = true;
    }
    setPlanAutoExpand(false);
    setOverlay(null);
  };

  const handleApprovePlan = (planPath: string) => {
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
          approvedPlanPath: planPath,
        });

        // Create a new session file BEFORE remount so the new tree
        // picks it up via sessionStore.sessionPath.
        let newSessionPath: string | undefined;
        const sm = sessionManagerRef.current;
        if (sm) {
          const s = await sm.create(props.cwd, currentProvider, currentModel);
          newSessionPath = s.path;
          sessionStatsRef.current.sessionId = s.id;
          if (props.sessionStore) props.sessionStore.sessionId = s.id;
          await props.subAgentManager?.resetParentSession(s.id);
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
              prompt: "The plan has been approved. Implement it now, following each step in order.",
              planEvent: { event: "approved" },
            },
          });
          return;
        }

        // Fallback path (resetUI not wired — tests). Mutate in place.
        approvedPlanPathRef.current = planPath;
        planStepsRef.current = steps;
        setPlanSteps(steps);
        clearPendingHistory();
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
  };

  const handleRejectPlan = (planPath: string, feedback: string) => {
    planOverlayPendingRef.current = false;
    const rejectionMsg =
      `The plan at ${planPath} was rejected.\n\nFeedback: ${feedback}\n\n` +
      `Please revise the plan based on this feedback.`;
    if (props.resetUI && props.sessionStore) {
      props.sessionStore.overlay = null;
      props.sessionStore.planAutoExpand = false;
      // No wipeSession — keep history and messages so the agent picks
      // up the rejection mid-conversation.
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
      if (agentLoop.isRunning) {
        agentLoop.reset();
      }
      setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
    });
  };

  const handleToggleTasks = () => {
    taskPicker.toggle();
  };

  const fullScreenOverlay = isSkillsView ? "skills" : isPlanView ? "plan" : null;

  if (quittingSummary) {
    return (
      <Box flexDirection="column" width={columns} flexShrink={0} flexGrow={0}>
        <SessionSummaryDisplay summary={quittingSummary} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} flexShrink={0} flexGrow={0}>
      {rewindCheckpoints ? (
        <RewindOverlay
          checkpoints={rewindCheckpoints}
          onRestore={handleRewindRestore}
          onCancel={handleRewindCancel}
        />
      ) : fullScreenOverlay ? (
        <FullScreenOverlayRouter
          overlay={fullScreenOverlay}
          cwd={props.cwd}
          planAutoExpand={planAutoExpand}
          onCloseSkills={handleCloseRemountableOverlay}
          onClosePlan={handleClosePlanOverlay}
          onApprovePlan={handleApprovePlan}
          onRejectPlan={handleRejectPlan}
        />
      ) : (
        <ChatScreen
          columns={columns}
          liveItems={uniqueItemsById(liveItems)}
          renderItem={renderItem}
          isRunning={agentLoop.isRunning}
          visibleStreamingText={visibleStreamingText}
          streamingThinking={agentLoop.streamingThinking}
          thinkingMs={agentLoop.thinkingMs}
          reserveStreamingSpacing={shouldReserveStreamingSpacing}
          renderMarkdown={renderMarkdown}
          measuredLiveAreaRows={measuredLiveAreaRows}
          fullscreen={props.fullscreen}
          rows={rows}
          transcriptLines={transcriptLines}
          viewportRows={viewportRows}
          assistantMarginTop={shouldTopSpaceStreamingText || streamingContinuesFlushed ? 1 : 0}
          streamingContinuation={streamingContinuesFlushed}
          controlsRef={mainControlsRef}
          hiddenQueuedCount={hiddenQueuedCount}
          queueIndicatorMarginTop={shouldTopSpaceQueueIndicator ? 2 : 1}
          theme={theme}
          statusSlotVisible={statusSlotVisible}
          activityVisible={activityVisible}
          stallStatusVisible={stallStatusVisible}
          liveToolFeed={liveToolFeed}
          doneStatus={doneStatus}
          activityPhase={agentLoop.activityPhase}
          elapsedMs={agentLoop.elapsedMs}
          runStartRef={agentLoop.runStartRef}
          isThinking={agentLoop.isThinking}
          thinkingLevel={thinkingLevel}
          tokenEstimate={agentLoop.streamedTokenEstimate}
          charCountRef={agentLoop.charCountRef}
          realTokensAccumRef={agentLoop.realTokensAccumRef}
          lastUserMessage={lastUserMessage}
          activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
          retryInfo={agentLoop.retryInfo}
          planDone={planSteps.filter((s) => s.completed).length}
          planTotal={planSteps.length}
          formatDuration={formatDuration}
          inputControls={{
            onSubmit: handleSubmit,
            onAbort: handleAbort,
            injectText: composerInject,
            inputActive: !taskBarFocused && !overlay,
            onDownAtEnd: handleFocusTaskBar,
            onShiftTab: handleToggleThinking,
            onToggleTasks: handleToggleTasks,
            onToggleSkills: () => openOverlay("skills"),
            onToggleMarkdown: () => setRenderMarkdown((prev) => !prev),
            cwd: props.cwd,
            commands: allCommands,
            mouseScroll: props.fullscreen,
            onScroll: scrollTranscriptByLines,
          }}
          taskPicker={{
            open: taskPicker.open,
            tasks: taskPicker.tasks,
            onClose: taskPicker.close,
            onStart: taskPicker.start,
            onRunAll: taskPicker.runAll,
            onDelete: taskPicker.deleteTask,
          }}
          overlay={overlay}
          onModelSelect={handleModelSelect}
          onModelCancel={() => setOverlay(null)}
          loggedInProviders={props.loggedInProviders ?? [currentProvider]}
          currentModel={currentModel}
          currentProvider={currentProvider}
          onThemeSelect={handleThemeSelect}
          onThemeCancel={() => setOverlay(null)}
          currentTheme={theme.name}
          contextUsed={agentLoop.contextUsed}
          contextWindowOptions={contextWindowOptions}
          displayedCwd={displayedCwd}
          gitBranch={gitBranch}
          planMode={planMode}
          exitPending={exitPending}
          footerStatusLayout={footerStatusLayout}
          backgroundTasks={bgTasks}
          taskBarFocused={taskBarFocused}
          taskBarExpanded={taskBarExpanded}
          selectedTaskIndex={selectedTaskIndex}
          onTaskBarExpand={handleTaskBarExpand}
          onTaskBarCollapse={handleTaskBarCollapse}
          onTaskKill={handleTaskKill}
          onTaskBarExit={handleTaskBarExit}
          onTaskNavigate={handleTaskNavigate}
        />
      )}
    </Box>
  );
}
