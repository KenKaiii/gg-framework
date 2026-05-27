import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, Text, useStdout, type DOMElement } from "ink";
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
import { playNotificationSound } from "../utils/sound.js";
import {
  type Message,
  type Provider,
  type ThinkingLevel,
  type TextContent,
} from "@kenkaiiii/gg-ai";
import { extractImagePaths, type ImageAttachment } from "../utils/image.js";
import { buildGoalReferenceContext } from "../core/goal-references.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { useAgentLoop, type StreamSnapshot, type UserContent } from "./hooks/useAgentLoop.js";
import { useTranscriptHistory } from "./hooks/useTranscriptHistory.js";
import type { PasteInfo } from "./components/InputArea.js";
import type { SubAgentInfo } from "./components/SubAgentPanel.js";
import type { SubAgentUpdate, SubAgentDetails } from "../tools/subagent.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { StreamingArea } from "./components/StreamingArea.js";
import { ActivityIndicator } from "./components/ActivityIndicator.js";
import { InputArea } from "./components/InputArea.js";
import { Footer, doesFooterFitOnOneLine } from "./components/Footer.js";
import {
  GoalStatusBar,
  reconcileGoalStatusEntriesWithRuns,
  removeGoalStatusEntry,
  syncGoalStatusEntries,
  type GoalStatusEntry,
} from "./components/GoalStatusBar.js";
import { PlanOverlay } from "./components/PlanOverlay.js";
import { ModelSelector } from "./components/ModelSelector.js";
import { PixelOverlay } from "./components/PixelOverlay.js";
import type { PreparedPixelFix } from "../core/pixel-fix.js";
import { SkillsOverlay } from "./components/SkillsOverlay.js";
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
import { getModel, getContextWindow } from "../core/model-registry.js";
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
import { detectLanguages, type LanguageId } from "../core/language-detector.js";
import { detectVerifyCommands } from "../core/verify-commands.js";
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
import { splitAssistantStreamingText } from "./utils/assistant-stream-split.js";
import {
  appendGoalDecision,
  appendGoalEvidence,
  formatGoalBlockingPrerequisites,
  goalHasBlockingPrerequisites,
  loadGoalRuns,
  loadGoalRunsSync,
  reconcileActiveGoalRuns,
  saveGoalRuns,
  updateGoalTask,
  upsertGoalRun,
  type GoalReference,
  type GoalRun,
} from "../core/goal-store.js";
import {
  getNextPendingTask,
  loadTasksSync,
  markTaskInProgress,
  saveTasksSync,
  type TaskRecord,
} from "../core/tasks-store.js";
import { canCompleteGoalRun, decideGoalNextAction } from "../core/goal-controller.js";
import { runGoalPrerequisiteChecks } from "../core/goal-prerequisites.js";
import { runGoalVerifierCommand } from "../core/goal-verifier.js";
import { checkGoalWorktreeIntegration, isGoalWorktreeDirtyError } from "../core/goal-worktree.js";
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
import type { GoalMode } from "../core/runtime-mode.js";
import type { TerminalHistoryPrinter } from "./terminal-history.js";
import {
  buildUserContentWithAttachments,
  isGoalPromptCommandName,
  routePromptCommandInput,
  runGoalPromptSetupSequence,
} from "./prompt-routing.js";
import { getNextThinkingLevel, isThinkingLevelSupported } from "./thinking-level.js";
import {
  appendGoalProgressDraft,
  completedItemsWithDurableGoalTerminalProgress,
  formatGoalTerminalProgress,
  formatGoalWorkerFinishedTitle,
  getGoalContinuationChoiceKey,
  goalTerminalProgressId,
  routeGoalSyntheticEvent,
  summarizeGoalCompletion,
} from "./goal-progress.js";
import {
  getChatControlsLayoutDecision,
  getDoneFlushDecision,
  getGoalSetupPaneTransitionAfterRun,
  MIN_LIVE_AREA_ROWS,
  nextGoalModeAfterAgentDone,
  shouldTopSpaceAfterPrintedAgentBoundary,
  shouldTopSpaceStreamingAssistant,
  type DoneStatus,
} from "./layout-decisions.js";
import { isTranscriptSpacingItem } from "./transcript/spacing.js";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import { formatDuration } from "./duration-format.js";
import { pickDurationVerb } from "./duration-summary.js";
import { toErrorItem } from "./error-item.js";
import {
  buildGoalDirtyWorktreePauseRun,
  buildGoalDirtyWorktreeUserPrompt,
  buildGoalTaskPromptWithReferences,
  buildGoalUserPauseRun,
  goalDirtyWorktreeInfoText,
  goalRunNeedsExplicitContinuationAfterWorker,
  goalTaskProgress,
  shouldKeepGoalRunTrackedAfterDecision,
  shouldRunGoalTaskInMainCheckout,
} from "./goal-run-helpers.js";
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
  CompactedItem,
  GoalItem,
  GoalProgressDraft,
  QueuedItem,
  TaskItem,
  ServerToolDoneItem,
  ServerToolStartItem,
  SubAgentGroupItem,
  ToolDoneItem,
  ToolGroupItem,
  ToolStartItem,
  UserItem,
} from "./app-items.js";

export type {
  CompletedItem,
  GoalProgressDraft,
  GoalProgressItem,
  ToolGroupItem,
} from "./app-items.js";
export type { DoneStatus } from "./layout-decisions.js";
export {
  buildGoalSetupPromptFromPlanner,
  buildUserContentWithAttachments,
  collectAssistantTextSince,
  isGoalPromptCommandName,
  routePromptCommandInput,
  runGoalPromptSetupSequence,
} from "./prompt-routing.js";
export { getNextThinkingLevel } from "./thinking-level.js";
export {
  appendGoalProgressDraft,
  completedItemsWithDurableGoalTerminalProgress,
  formatGoalTerminalProgress,
  getGoalContinuationChoiceKey,
  routeGoalSyntheticEvent,
  truncateGoalProgressText,
} from "./goal-progress.js";
export {
  getChatControlsLayoutDecision,
  getDoneFlushDecision,
  getGoalActivationPaneTransition,
  getGoalSetupFinishedPaneTransition,
  getGoalSetupPaneTransitionAfterRun,
  getScrollStabilizationDecision,
  getStaticHistoryKey,
  hasParagraphBreakLiveUserMessage,
  isTallLiveUserMessage,
  nextGoalModeAfterAgentDone,
  shouldHideHistoryForOverlayView,
  shouldHideStaticItemsForOverlayView,
  shouldResetUIForGoalSetupPaneTransition,
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
export {
  buildGoalDirtyWorktreePauseRun,
  buildGoalDirtyWorktreeUserPrompt,
  buildGoalUserPauseRun,
  goalDirtyWorktreeInfoText,
  goalRunNeedsExplicitContinuationAfterWorker,
  shouldKeepGoalRunTrackedAfterDecision,
  shouldRunGoalTaskInMainCheckout,
} from "./goal-run-helpers.js";

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
  goalModeRef?: { current: GoalMode };
  skills?: Skill[];
  initialOverlay?: "pixel" | "goal";
  rebuildToolsForCwd?: (cwd: string) => AgentTool[];
  goalReferencesRef?: { current: readonly GoalReference[] | undefined };
  connectInitialMcpTools?: () => Promise<AgentTool[]>;
  terminalHistoryPrinter?: TerminalHistoryPrinter;
  /**
   * Wired by `renderApp`. Tears down the current Ink instance and renders
   * a fresh one. Patching Ink's internal frame tracking in place is
   * unreliable (the live area drifts on subsequent streaming responses);
   * a full unmount/remount is the only consistent reset.
   *
   * Used by every path that previously did a bare ANSI screen clear:
   * `/clear`, plan accept/reject, overlay open/close, pixel fix.
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
    overlay?: "model" | "goal" | "skills" | "plan" | "theme" | "pixel" | null;
    planAutoExpand?: boolean;
    goalAutoExpand?: boolean;
    pendingAction?: {
      prompt: string;
      infoText?: string;
      planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
    };
    pendingGoalRun?: GoalRun;
    isAgentRunning?: boolean;
    pendingResetUI?: boolean;
    runAllTasks?: boolean;
    runAllPixel?: boolean;
    goalStatusEntries?: GoalStatusEntry[];
    goalMode?: GoalMode;
  };
}

// ── App Component ──────────────────────────────────────────

export function App(props: AppProps) {
  const theme = useTheme();
  const switchTheme = useSetTheme();
  const { write: writeStdout } = useStdout();
  const { columns, rows } = useTerminalSize();

  // Hoisted before terminal title hook so it can reference them
  const [lastUserMessage, setLastUserMessage] = useState("");
  const [exitPending, setExitPending] = useState(false);
  const [goalMode, setGoalMode] = useState<GoalMode>(
    props.sessionStore?.goalMode ?? props.goalModeRef?.current ?? "off",
  );
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
  // Seed from sessionStore so Goal progress/completion rows and other live output
  // survive pane/overlay/resize remounts before they are finalized.
  const [liveItems, setLiveItems] = useState<CompletedItem[]>(() => {
    const restoredLiveItems = uniqueItemsById(props.sessionStore?.liveItems ?? []);
    const restoredHistoryIds = new Set(history.map((item) => item.id));
    return removeItemsWithIds(restoredLiveItems, restoredHistoryIds);
  });
  // overlay seeded from sessionStore (lives across remount). Falls back to
  // props.initialOverlay (CLI launched with one), then null.
  const [overlay, setOverlay] = useState<
    "model" | "goal" | "skills" | "plan" | "theme" | "pixel" | null
  >(props.sessionStore?.overlay ?? props.initialOverlay ?? null);
  const [goalStatusEntries, setGoalStatusEntries] = useState<GoalStatusEntry[]>(
    props.sessionStore?.goalStatusEntries ?? [],
  );
  const [updatePending, setUpdatePending] = useState<boolean>(
    () => getPendingUpdate(props.version) !== null,
  );
  const agentRunningRef = useRef(false);
  const runningGoalIdsRef = useRef<Set<string>>(new Set());
  const activeVerifierRunIdsRef = useRef<Set<string>>(new Set());
  const queuedGoalSyntheticEventsRef = useRef(0);
  const goalContinuationFlightsRef = useRef<Set<string>>(new Set());
  const goalContinuationRecentChoicesRef = useRef<Map<string, number>>(new Map());
  const startGoalRunRef = useRef<(run: GoalRun) => void>(() => {});
  const [runAllTasks, setRunAllTasks] = useState(props.sessionStore?.runAllTasks ?? false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [taskPickerTasks, setTaskPickerTasks] = useState<TaskRecord[]>(() =>
    loadTasksSync(props.cwd),
  );
  const [goalPickerOpen, setGoalPickerOpen] = useState(false);
  const [goalPickerGoals, setGoalPickerGoals] = useState<GoalRun[]>(() =>
    loadGoalRunsSync(props.cwd),
  );
  const runAllTasksRef = useRef(props.sessionStore?.runAllTasks ?? false);
  const startTaskRef = useRef<(title: string, prompt: string, taskId: string) => void>(() => {});
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
  const goalSetupPanePendingRef = useRef(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(props.model);
  const [currentProvider, setCurrentProvider] = useState(props.provider);
  const [currentTools, setCurrentTools] = useState(props.tools);
  const currentToolsRef = useRef(props.tools);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>(props.thinking);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const messagesRef = useRef<Message[]>(props.sessionStore?.messages ?? props.messages);
  const [planAutoExpand, setPlanAutoExpand] = useState(props.sessionStore?.planAutoExpand ?? false);
  const [goalAutoExpand, setGoalAutoExpand] = useState(props.sessionStore?.goalAutoExpand ?? false);
  const goalAutoExpandRef = useRef(props.sessionStore?.goalAutoExpand ?? false);
  const approvedPlanPathRef = useRef<string | undefined>(props.sessionStore?.approvedPlanPath);
  const planStepsRef = useRef<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const goalModeStateRef = useRef<GoalMode>(goalMode);
  // Stuck-guard for the plan-continuation follow-up nudge. Tracks how many
  // times we've nudged the agent to continue the same step. Reset whenever a
  // new [DONE:n] marker advances progress (see onTurnText). Caps at 2 nudges
  // so a genuinely stuck agent surfaces instead of looping forever.
  const followUpNudgesRef = useRef<{ step: number; count: number }>({ step: 0, count: 0 });
  // Seed the per-item ID counter so it doesn't collide with IDs already in
  // sessionStore.history (which survives remount). Without this, a remount
  // (resize, overlay toggle, goal pane open, etc.) starts the counter at 0
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
  const appendGoalAgentTransition = useCallback((text: string) => {
    setLiveItems((prev) => [...prev, { kind: "goal_agent_transition", text, id: getId() }]);
  }, []);
  const appendGoalProgress = useCallback((item: GoalProgressDraft) => {
    setLiveItems((prev) => appendGoalProgressDraft(prev, item, getId));
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

  const sessionStore = props.sessionStore;

  const { pendingHistoryFlushRef, streamedAssistantFlushRef, printHistoryItems, queueFlush } =
    useTranscriptHistory({
      terminalHistoryPrinter: props.terminalHistoryPrinter,
      terminalHistoryContext: {
        theme,
        columns,
        version: props.version,
        model: currentModel,
        provider: currentProvider,
        cwd: displayedCwd,
      },
      writeStdout,
      sessionPathRef,
      sessionManagerRef,
      sessionStore,
      setHistory,
      setLiveItems,
    });

  const finalizeSubmittedUserItem = useCallback(
    (item: UserItem) => {
      streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
      setLiveItems((prev) => {
        if (prev.length > 0) queueFlush(prev);
        queueFlush([item]);
        return [];
      });
    },
    [queueFlush],
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
    if (thinkingLevel && !isThinkingLevelSupported(currentProvider, currentModel, thinkingLevel)) {
      setThinkingLevel(getNextThinkingLevel(currentProvider, currentModel, undefined));
    }
  }, [currentProvider, currentModel, thinkingLevel]);

  useEffect(() => {
    onRuntimeStateChange?.({
      thinking: thinkingLevel,
    });
  }, [thinkingLevel, onRuntimeStateChange]);

  useEffect(() => {
    printHistoryItems(history);
  }, [history, printHistoryItems]);

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
    if (sessionStore) sessionStore.sessionTitle = sessionTitle;
  }, [sessionTitle, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.overlay = overlay;
  }, [overlay, sessionStore]);
  useEffect(() => {
    goalAutoExpandRef.current = goalAutoExpand;
    if (sessionStore) sessionStore.goalAutoExpand = goalAutoExpand;
  }, [goalAutoExpand, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.goalStatusEntries = goalStatusEntries;
  }, [goalStatusEntries, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.goalMode = goalMode;
  }, [goalMode, sessionStore]);

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
        if (cancelled) return;
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

  // ── Runtime mode wiring ──────────────────────────────────
  // Sync runtime mode refs with React state.
  useEffect(() => {
    goalModeStateRef.current = goalMode;
    if (props.goalModeRef) {
      props.goalModeRef.current = goalMode;
    }
  }, [goalMode, props.goalModeRef]);

  const setActiveGoalReferences = useCallback(
    (references: readonly GoalReference[] | undefined): void => {
      if (props.goalReferencesRef) props.goalReferencesRef.current = references;
    },
    [props.goalReferencesRef],
  );

  const rebuildSystemPrompt = useCallback(
    async (options?: {
      cwd?: string;
      approvedPlanPath?: string;
      clearApprovedPlan?: boolean;
      activeLanguages?: Set<LanguageId>;
      tools?: AgentTool[];
      goalMode?: GoalMode;
    }): Promise<string> => {
      const approvedPlanPath = options?.clearApprovedPlan
        ? undefined
        : (options?.approvedPlanPath ?? approvedPlanPathRef.current);
      return buildSystemPrompt(
        options?.cwd ?? cwdRef.current,
        props.skills,
        false,
        approvedPlanPath,
        (options?.tools ?? currentToolsRef.current).map((tool) => tool.name),
        options?.activeLanguages ?? injectedLanguagesRef.current,
        options?.goalMode ?? goalModeStateRef.current,
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

  const setGoalModeAndPrompt = useCallback(
    async (
      nextMode: GoalMode,
      options?: Omit<NonNullable<Parameters<typeof rebuildSystemPrompt>[0]>, "goalMode">,
    ): Promise<void> => {
      goalModeStateRef.current = nextMode;
      if (props.goalModeRef) props.goalModeRef.current = nextMode;
      if (props.sessionStore) props.sessionStore.goalMode = nextMode;
      setGoalMode(nextMode);
      await replaceSystemPrompt({ ...options, goalMode: nextMode });
    },
    [props.goalModeRef, props.sessionStore, replaceSystemPrompt],
  );

  const clearGoalModeIfIdle = useCallback((): void => {
    setTimeout(() => {
      if (goalModeStateRef.current === "off") return;
      if (runningGoalIdsRef.current.size > 0) return;
      if (activeVerifierRunIdsRef.current.size > 0) return;
      if (queuedGoalSyntheticEventsRef.current > 0) return;
      void setGoalModeAndPrompt("off");
    }, 0);
  }, [setGoalModeAndPrompt]);

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
   * used for pixel-fix chdir.
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

  /**
   * transformContext callback for the agent loop.
   * Called before each LLM call and on context overflow.
   */
  const transformContext = useCallback(
    async (messages: Message[], options?: { force?: boolean }): Promise<Message[]> => {
      const settings = settingsRef.current;
      const autoCompact = settings?.get("autoCompact") ?? true;
      const threshold = settings?.get("compactThreshold") ?? 0.8;

      // Force-compact on context overflow regardless of settings
      if (options?.force) {
        const result = await compactConversation(messages);
        if (result !== messages) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return result;
      }

      if (!autoCompact) return messages;

      // Time-based cooldown: skip if compaction ran within the last 30 seconds
      if (Date.now() - lastCompactionTimeRef.current < 30_000) {
        log("INFO", "compaction", `Skipping compaction — cooldown active`);
        return messages;
      }

      const contextWindow = getContextWindow(currentModel, contextWindowOptions);
      const reserveTokens = getCompactionReserveTokens(props.maxTokens);
      const tokensFresh = lastActualTokensTimestampRef.current > lastCompactionTimeRef.current;
      const actualTokens =
        lastActualTokensRef.current > 0 && tokensFresh ? lastActualTokensRef.current : undefined;
      if (shouldCompact(messages, contextWindow, threshold, actualTokens, reserveTokens)) {
        const result = await compactConversation(messages);
        if (result !== messages) {
          messagesRef.current = result;
          await persistCompactedSession(result);
        }
        lastCompactionTimeRef.current = Date.now();
        return result;
      }
      return messages;
    },
    [currentModel, compactConversation, contextWindowOptions, persistCompactedSession],
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
      thinking: thinkingLevel,
      apiKey: activeApiKey,
      baseUrl: activeBaseUrl,
      accountId: activeAccountId,
      projectId: activeProjectId,
      resolveCredentials,
      transformContext,
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
        props.cwd,
        props.skills,
        currentProvider,
        activeApiKey,
        activeAccountId,
        activeBaseUrl,
        resolveCredentials,
      ]),
      onTurnText: useCallback(
        (text: string, thinking: string, thinkingMs: number) => {
          if (goalModeStateRef.current === "planner") {
            return;
          }

          const hadStreamedAssistantFlush = streamedAssistantFlushRef.current.flushedChars > 0;
          const unflushedAssistantText = text.slice(streamedAssistantFlushRef.current.flushedChars);

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
            streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
            return [...assistantItems, ...nextItems];
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

          if (name === "subagent") {
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
          log("INFO", "server_tool", `Server tool call: ${name}`, { id });
          const startedAt = Date.now();
          const animateUntil = startedAt + RUNNING_INDICATOR_ANIMATION_MS;
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
        [queueFlush],
      ),
      onDone: useCallback(
        (durationMs: number, toolsUsed: string[]) => {
          log("INFO", "agent", `Agent done`, {
            duration: `${durationMs}ms`,
            toolsUsed: toolsUsed.join(",") || "none",
          });
          const doneDecision = getDoneFlushDecision({
            planOverlayPending: planOverlayPendingRef.current,
            goalMode: goalModeStateRef.current,
            goalAutoExpand: goalAutoExpandRef.current,
          });
          // Don't show "done" status when plan/goal review panes are about to open —
          // the agent loop finished but we're waiting for user approval/review.
          // Still flush live transcript rows before the pane remounts; otherwise
          // setup output remains in ephemeral liveItems and appears to vanish.
          if (doneDecision.showDoneStatus) {
            setDoneStatus({ durationMs, toolsUsed, verb: pickDurationVerb(toolsUsed) });
            playNotificationSound();
          }
          // Finalize rows now; the sink writes them outside Ink and then the
          // live area is cleared, so there is no Static/live repaint race.
          if (doneDecision.flushLiveItems) {
            setLiveItems((prev) => {
              if (prev.length > 0) queueFlush(prev);
              return [];
            });
          }

          const nextGoalMode = nextGoalModeAfterAgentDone({
            currentMode: goalModeStateRef.current,
            runningGoalIds: runningGoalIdsRef.current.size,
            queuedSyntheticEvents: queuedGoalSyntheticEventsRef.current,
            activeContinuationFlights: goalContinuationFlightsRef.current.size,
          });
          if (nextGoalMode !== goalModeStateRef.current) {
            void setGoalModeAndPrompt(nextGoalMode);
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
        },
        [setGoalModeAndPrompt],
      ),
      onAborted: useCallback(() => {
        log("WARN", "agent", "Agent run aborted by user");
        setRunAllPixel(false);
        currentPixelFixRef.current = null;
        queuedGoalSyntheticEventsRef.current = 0;
        goalSetupPanePendingRef.current = false;
        setActiveGoalReferences(undefined);
        if (goalModeStateRef.current !== "off") void setGoalModeAndPrompt("off");
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
      }, [setActiveGoalReferences, setGoalModeAndPrompt]),
      onQueuedStart: useCallback(
        (content: UserContent) => {
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
            queuedGoalSyntheticEventsRef.current = Math.max(
              0,
              queuedGoalSyntheticEventsRef.current - 1,
            );
            void setGoalModeAndPrompt("coordinator");
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
          const userItem: UserItem = {
            kind: "user",
            text: displayText,
            imageCount,
            id: getId(),
          };
          setLastUserMessage(displayText);
          setDoneStatus(null);
          finalizeSubmittedUserItem(userItem);
        },
        [appendGoalProgress, finalizeSubmittedUserItem, setGoalModeAndPrompt],
      ),
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

  // Consume pending post-remount work once on mount. Set by resetUI options
  // for paths that remount AND immediately drive work (plan accept/reject,
  // pixel fix, Goal approval). The work survives the unmount because
  // it lives in renderApp's closure (sessionStore), not React state.
  useEffect(() => {
    if (pendingActionConsumedRef.current) return;
    const action = sessionStore?.pendingAction;
    const pendingGoalRun = sessionStore?.pendingGoalRun;
    if (!action && !pendingGoalRun) return;
    pendingActionConsumedRef.current = true;
    if (sessionStore) {
      sessionStore.pendingAction = undefined;
      sessionStore.pendingGoalRun = undefined;
    }
    setDoneStatus(null);
    if (pendingGoalRun) {
      startGoalRunRef.current(pendingGoalRun);
      return;
    }
    if (!action) return;
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
        pendingHistoryFlushRef.current = [];
        props.terminalHistoryPrinter?.clear();
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

      // Handle /markdown — Gemini-style rendered/raw markdown toggle
      if (trimmed === "/markdown" || trimmed === "/md") {
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

      // Handle /goals — open the input-area goal picker.
      if (trimmed === "/goals") {
        setGoalPickerGoals(loadGoalRunsSync(displayedCwd));
        setTaskPickerOpen(false);
        setGoalPickerOpen(true);
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

        const hasImages = inputImages.length > 0;
        const isGoalSetupCommand = isGoalPromptCommandName(cmdName);
        let promptForAgent = fullPrompt;
        if (isGoalSetupCommand) {
          const referenceContext = await buildGoalReferenceContext({
            cwd: props.cwd,
            originalGoalPrompt: fullPrompt,
            attachments: inputImages,
          });
          setActiveGoalReferences(referenceContext.references);
          promptForAgent = referenceContext.promptSection
            ? `${fullPrompt}\n\n${referenceContext.promptSection}`
            : fullPrompt;
        }
        const modelInfo = getModel(currentModel);
        const modelSupportsImages = modelInfo?.supportsImages ?? true;
        const userContent = buildUserContentWithAttachments(
          promptForAgent,
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
        finalizeSubmittedUserItem(userItem);

        // Send the full prompt to the agent, with user args appended if provided
        try {
          if (isGoalSetupCommand) {
            goalSetupPanePendingRef.current = true;
            await runGoalPromptSetupSequence({
              userContent,
              fullPrompt: promptForAgent,
              messagesRef,
              setGoalModeAndPrompt,
              runAgent: (content) => agentLoop.run(content),
              onStage: appendGoalAgentTransition,
            });
          } else {
            await agentLoop.run(userContent);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ERROR", "error", msg);
          const isAbort = msg.includes("aborted") || msg.includes("abort");
          if (isGoalSetupCommand) goalSetupPanePendingRef.current = false;
          setLiveItems((prev) => [
            ...prev,
            isAbort
              ? { kind: "stopped", text: "Request was stopped.", id: getId() }
              : toErrorItem(err, getId()),
          ]);
        } finally {
          if (isGoalSetupCommand) {
            setActiveGoalReferences(undefined);
            const paneTransition = getGoalSetupPaneTransitionAfterRun({
              isGoalSetupCommand,
              setupPanePending: goalSetupPanePendingRef.current,
            });
            goalSetupPanePendingRef.current = false;
            if (goalModeStateRef.current !== "off") {
              await setGoalModeAndPrompt("off");
            }
            if (paneTransition) {
              goalAutoExpandRef.current = false;
              setGoalAutoExpand(false);
              setPlanAutoExpand(false);
              setGoalPickerGoals(loadGoalRunsSync(displayedCwd));
              setGoalPickerOpen(true);
            }
          }
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
      finalizeSubmittedUserItem(userItem);

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
      appendGoalAgentTransition,
      compactConversation,
      currentModel,
      finalizeSubmittedUserItem,
      props.cwd,
      props.onSlashCommand,
      props.resetUI,
      props.sessionStore,
      rebuildSystemPrompt,
      reloadCustomCommands,
      replaceSystemPrompt,
      setActiveGoalReferences,
      setGoalModeAndPrompt,
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
      "goal",
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
  }, [customCommands]);

  const renderItem = (item: CompletedItem, index: number, items: CompletedItem[]) =>
    renderTranscriptItem({
      item,
      index,
      items,
      pendingHistoryFlushLastItem: pendingHistoryFlushRef.current.at(-1),
      historyLastItem: history.at(-1),
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
    (kind: "goal" | "skills" | "plan" | "pixel") => {
      if (props.resetUI && props.sessionStore && !agentLoop.isRunning) {
        props.sessionStore.overlay = kind;
        if (kind !== "plan") props.sessionStore.planAutoExpand = false;
        if (kind !== "goal") props.sessionStore.goalAutoExpand = false;
        props.resetUI();
      } else {
        if (props.sessionStore) {
          props.sessionStore.overlay = kind;
          if (kind !== "plan") props.sessionStore.planAutoExpand = false;
          if (kind !== "goal") props.sessionStore.goalAutoExpand = false;
          if (agentLoop.isRunning && kind !== "goal" && kind !== "plan") {
            props.sessionStore.pendingResetUI = true;
          }
        }
        if (kind !== "plan") setPlanAutoExpand(false);
        if (kind !== "goal") setGoalAutoExpand(false);
        setOverlay(kind);
      }
    },
    [agentLoop.isRunning, props],
  );

  const runGoalSyntheticEvent = useCallback(
    (eventText: string) => {
      const eventInfo = parseGoalSyntheticEvent(eventText);
      const detail =
        eventInfo?.kind === "worker"
          ? `Inspecting worker result${eventInfo.task ? ` for ${eventInfo.task}` : ""}.`
          : `Inspecting verifier result${eventInfo?.status ? ` (${eventInfo.status})` : ""}.`;
      const route = routeGoalSyntheticEvent({
        agentRunning: agentRunningRef.current,
        queuedSyntheticEvents: queuedGoalSyntheticEventsRef.current,
      });
      if (route.action === "queue") {
        queuedGoalSyntheticEventsRef.current = route.nextQueuedSyntheticEvents;
        void setGoalModeAndPrompt(route.nextGoalMode);
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
      void (async () => {
        await setGoalModeAndPrompt("coordinator");
        await agentLoop.run(eventText);
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
        clearGoalModeIfIdle();
      });
    },
    [agentLoop, appendGoalProgress, clearGoalModeIfIdle, setGoalModeAndPrompt],
  );

  const continueGoalRun = useCallback(
    (runId: string) => {
      if (goalContinuationFlightsRef.current.has(runId)) return;
      goalContinuationFlightsRef.current.add(runId);
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
          clearGoalModeIfIdle();
          return;
        }
        const decision = decideGoalNextAction(latestRun);
        if (!shouldKeepGoalRunTrackedAfterDecision(decision)) {
          runningGoalIdsRef.current.delete(runId);
          clearGoalModeIfIdle();
        }
        if (decision.kind === "wait") return;
        const choiceKey = getGoalContinuationChoiceKey({ runId: latestRun.id, decision });
        const now = Date.now();
        const recentChoiceAt = goalContinuationRecentChoicesRef.current.get(choiceKey);
        if (recentChoiceAt !== undefined && now - recentChoiceAt < 5000) return;
        goalContinuationRecentChoicesRef.current.set(choiceKey, now);
        if (goalContinuationRecentChoicesRef.current.size > 100) {
          for (const [key, startedAt] of goalContinuationRecentChoicesRef.current) {
            if (now - startedAt > 60_000) goalContinuationRecentChoicesRef.current.delete(key);
          }
        }
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
          clearGoalModeIfIdle();
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
      })()
        .catch((err: unknown) => {
          runningGoalIdsRef.current.delete(runId);
          clearGoalStatusEntry(runId);
          log("ERROR", "goal", err instanceof Error ? err.message : String(err));
          setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
        })
        .finally(() => {
          goalContinuationFlightsRef.current.delete(runId);
          clearGoalModeIfIdle();
        });
    },
    [
      appendGoalProgress,
      clearGoalModeIfIdle,
      clearGoalStatusEntry,
      props.cwd,
      upsertGoalStatusEntry,
    ],
  );

  const handleGoalWorkerComplete = useCallback(
    (run: GoalRun, completion: GoalWorkerCompletion) => {
      const taskTitle =
        run.tasks.find((task) => task.id === completion.worker.goalTaskId)?.title ??
        completion.worker.goalTaskId;
      const eventText = formatGoalWorkerCompletionEvent(run, taskTitle, completion);
      appendGoalProgress({
        kind: "goal_progress",
        phase: "worker_finished",
        title: formatGoalWorkerFinishedTitle(taskTitle, completion.status),
        detail: summarizeGoalCompletion(completion.summary),
        workerId: completion.worker.id,
        status: completion.status,
      });
      const taskProgress = goalTaskProgress(
        run,
        run.tasks.find((task) => task.id === completion.worker.goalTaskId),
      );
      upsertGoalStatusEntry({
        runId: run.id,
        label: run.title,
        phase: completion.status === "done" ? "reviewing" : "failed",
        startedAt: Date.now(),
        detail: completion.status === "done" ? "reviewing result" : "task failed",
        workerId: completion.worker.id,
        goalNumber: goalNumberForRun(run.id),
        ...taskProgress,
      });
      runGoalSyntheticEvent(eventText);
      void (async () => {
        if (
          listGoalWorkers(completion.worker.projectPath).some(
            (worker) => worker.status === "running",
          )
        )
          return;
        if (activeVerifierRunIdsRef.current.size > 0) return;
        const runs = await loadGoalRuns(completion.worker.projectPath);
        const queued = runs.find((item) => goalRunNeedsExplicitContinuationAfterWorker(item));
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
          (await loadGoalRuns(completion.worker.projectPath)).find(
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
      upsertGoalStatusEntry({
        runId: run.id,
        label: run.title,
        phase: "orchestrating",
        startedAt: Date.now(),
        detail: "choosing next step",
        goalNumber: goalNumberForRun(run.id),
      });
      void (async () => {
        await setGoalModeAndPrompt("coordinator");
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
          const detail = formatGoalBlockingPrerequisites(checkedRun);
          await upsertGoalRun(props.cwd, {
            ...checkedRun,
            status: "blocked",
            blockers: Array.from(new Set([...checkedRun.blockers, detail])),
          });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal blocked: ${checkedRun.title}`,
            detail,
            status: "blocked",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
          return;
        }

        const decision = decideGoalNextAction(checkedRun);
        await appendGoalDecision(props.cwd, checkedRun.id, decision);
        if (!shouldKeepGoalRunTrackedAfterDecision(decision)) {
          runningGoalIdsRef.current.delete(checkedRun.id);
        }
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
          clearGoalModeIfIdle();
          return;
        }
        if (decision.kind === "wait") {
          appendGoalProgress({
            kind: "goal_progress",
            phase: "worker_started",
            title: decision.workerId
              ? `Goal working: ${checkedRun.title}`
              : `Goal needs orchestration: ${checkedRun.title}`,
            detail: decision.workerId
              ? decision.reason
              : `${decision.reason} Asking the orchestrator to unblock or revise the Goal plan.`,
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
          if (!decision.workerId) {
            const eventText =
              `Goal continuation is waiting with no active worker for Goal ${checkedRun.id} (${checkedRun.title}).\n` +
              `Reason: ${decision.reason}\n\n` +
              `Inspect the durable Goal state with the goals tool, resolve blocked dependencies by creating or updating concrete worker tasks, and then continue the Goal. If no local/free action can proceed, record an explicit blocker with exact user instructions. Do not stop after only explaining the state.`;
            setLastUserMessage("");
            setDoneStatus(null);
            await agentLoop.run(eventText);
          }
          return;
        }
        if (decision.kind === "complete") {
          await upsertGoalRun(props.cwd, { ...checkedRun, status: "passed" });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal passed: ${checkedRun.title}`,
            detail: decision.reason,
            status: "passed",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
          return;
        }
        if (decision.kind === "run_verifier") {
          await verifyGoalRun(checkedRun);
          return;
        }
        if (decision.kind === "create_task") {
          const latestRunBeforeCreate =
            (await loadGoalRuns(props.cwd)).find((item) => item.id === checkedRun.id) ?? checkedRun;
          const existingSameTitleTask = latestRunBeforeCreate.tasks.find(
            (item) => item.title === decision.title,
          );
          if (existingSameTitleTask) {
            const runWithExistingTask = await upsertGoalRun(props.cwd, {
              ...latestRunBeforeCreate,
              status: "ready",
            });
            appendGoalProgress({
              kind: "goal_progress",
              phase: "continuing",
              title: `Goal task already exists: ${decision.title}`,
              detail: "Reusing the existing Goal task instead of creating a duplicate.",
              status: "ready",
            });
            startGoalRunRef.current(runWithExistingTask);
            return;
          }
          await updateGoalTask(props.cwd, checkedRun.id, `auto-${Date.now()}`, {
            title: decision.title,
            prompt: decision.prompt,
            status: "pending",
          });
          const latestRun =
            (await loadGoalRuns(props.cwd)).find((item) => item.id === checkedRun.id) ?? checkedRun;
          const runWithTask = await upsertGoalRun(props.cwd, { ...latestRun, status: "ready" });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "continuing",
            title: `Goal task created: ${decision.title}`,
            detail: "Starting the new Goal task now.",
            status: "ready",
          });
          startGoalRunRef.current(runWithTask);
          return;
        }
        if (decision.kind === "blocked") {
          await upsertGoalRun(props.cwd, {
            ...checkedRun,
            status: "blocked",
            blockers: [...checkedRun.blockers, decision.reason],
          });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal blocked: ${checkedRun.title}`,
            detail: decision.reason,
            status: "blocked",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
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
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal paused: ${checkedRun.title}`,
            detail: decision.reason,
            status: "paused",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
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
          thinkingLevel,
          goalRunId: checkedRun.id,
          goalTaskId: decision.task.id,
          taskTitle: decision.task.title,
          prompt: buildGoalTaskPromptWithReferences(checkedRun, decision.task.prompt),
          isolateWorktree: shouldRunGoalTaskInMainCheckout(decision.task.title) ? false : undefined,
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
          label: checkedRun.title,
          phase: "worker",
          startedAt: Date.now(),
          detail: "background worker running",
          workerId: worker.id,
          goalNumber: goalNumberForRun(checkedRun.id),
          ...goalTaskProgress(checkedRun, decision.task),
        });
      })().catch(async (err: unknown) => {
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        if (isGoalWorktreeDirtyError(err)) {
          const latestRun =
            (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
          const pausedRun = await upsertGoalRun(
            props.cwd,
            buildGoalDirtyWorktreePauseRun(latestRun, err),
          );
          runningGoalIdsRef.current.delete(pausedRun.id);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal paused: ${pausedRun.title}`,
            detail:
              "Working tree has uncommitted changes; waiting for the user to choose commit, stash, or pause.",
            status: "paused",
          });
          setLiveItems((prev) => [
            ...prev,
            { kind: "info", text: goalDirtyWorktreeInfoText(), id: getId() },
          ]);
          void agentLoop.run(buildGoalDirtyWorktreeUserPrompt(err)).catch((agentErr: unknown) => {
            log("ERROR", "goal", agentErr instanceof Error ? agentErr.message : String(agentErr));
            setLiveItems((prev) => [...prev, toErrorItem(agentErr, getId(), "Goal")]);
          });
          return;
        }
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [
      props.cwd,
      currentProvider,
      currentModel,
      thinkingLevel,
      agentLoop,
      appendGoalProgress,
      clearGoalModeIfIdle,
      clearGoalStatusEntry,
      goalNumberForRun,
      setGoalModeAndPrompt,
      upsertGoalStatusEntry,
    ],
  );

  const verifyGoalRun = useCallback(
    async (run: GoalRun) => {
      await setGoalModeAndPrompt("coordinator");
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
        clearGoalModeIfIdle();
        return;
      }

      const integration = await checkGoalWorktreeIntegration(props.cwd, run);
      if (!integration.ok) {
        const runWithEvidence =
          (await appendGoalEvidence(props.cwd, run.id, {
            kind: "summary",
            label: "Goal worktree integration required",
            content: integration.summary,
          })) ?? run;
        await upsertGoalRun(props.cwd, {
          ...runWithEvidence,
          status: "blocked",
          blockers: Array.from(new Set([...runWithEvidence.blockers, integration.summary])),
        });
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal blocked before verifier: ${run.title}`,
          detail: integration.summary,
          status: "blocked",
        });
        runningGoalIdsRef.current.delete(run.id);
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
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
        cwd: run.verifier.cwd ?? props.cwd,
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
              ...(run.verifier?.cwd ? { cwd: run.verifier.cwd } : {}),
              lastResult: verification,
            },
            ...(status === "pass"
              ? {
                  completionAudit: {
                    status: "unknown" as const,
                    summary: "Final completion audit pending for latest verifier result.",
                    checkedAt: verification.checkedAt,
                    verifierCheckedAt: verification.checkedAt,
                    ...(verification.outputPath ? { outputPath: verification.outputPath } : {}),
                  },
                }
              : {}),
          };
          const completionCheck = canCompleteGoalRun(runWithVerifier);
          const verifiedRun = await upsertGoalRun(props.cwd, {
            ...runWithVerifier,
            continueRequestedAt: latestRun.continueRequestedAt,
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
            content: `outputPath=${outputPath ?? ""}; cwd=${run.verifier?.cwd ?? props.cwd}; durationMs=${durationMs}`,
          });
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
          if (continuationRun?.continueRequestedAt || status === "fail" || status === "pass") {
            setTimeout(() => continueGoalRun(run.id), 500);
          }
        })
        .catch((err: unknown) => {
          activeVerifierRunIdsRef.current.delete(run.id);
          clearGoalStatusEntry(run.id);
          clearGoalModeIfIdle();
          log("ERROR", "goal", err instanceof Error ? err.message : String(err));
          setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal verifier")]);
        });
    },
    [
      props.cwd,
      appendGoalProgress,
      clearGoalModeIfIdle,
      clearGoalStatusEntry,
      goalNumberForRun,
      runGoalSyntheticEvent,
      setGoalModeAndPrompt,
      upsertGoalStatusEntry,
    ],
  );

  const pauseGoalRun = useCallback(
    (run: GoalRun) => {
      void (async () => {
        runningGoalIdsRef.current.delete(run.id);
        if (run.activeWorkerId) await stopGoalWorker(run.activeWorkerId);
        const latestRun = (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
        await upsertGoalRun(props.cwd, buildGoalUserPauseRun(latestRun));
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal paused: ${run.title}`,
          detail: "Auto-continuation stopped until resumed.",
          status: "paused",
        });
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [appendGoalProgress, clearGoalModeIfIdle, clearGoalStatusEntry, props.cwd],
  );

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

      pendingHistoryFlushRef.current = [];
      props.terminalHistoryPrinter?.clear();
      setHistory([{ kind: "banner", id: "banner" }]);
      setLiveItems([]);
      messagesRef.current = messagesRef.current.slice(0, 1);
      agentLoop.reset();
      persistedIndexRef.current = messagesRef.current.length;
      const sm = sessionManagerRef.current;
      if (sm) {
        void sm.create(taskCwd, currentProvider, currentModel).then((session) => {
          sessionPathRef.current = session.path;
          log("INFO", "tasks", "New session for task", { path: session.path });
        });
      }
      const taskItem: TaskItem = { kind: "task", title, id: getId() };
      setLastUserMessage(title);
      setDoneStatus(null);
      setLiveItems([taskItem]);
      void agentLoop.run(fullPrompt).catch((err: unknown) => {
        setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
      });
    },
    [agentLoop, currentModel, currentProvider, props],
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
            clearApprovedPlan: true,
            activeLanguages: detectedForPixelFix,
            tools: toolsForPixelFix,
          });

          // Now that the cwd swap is committed, reset chat. Do not clear the
          // terminal here; terminal clear sequences can erase saved scrollback.
          pendingHistoryFlushRef.current = [];
          props.terminalHistoryPrinter?.clear();
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
          const goalItem: GoalItem = { kind: "goal", title, id: getId() };
          setLastUserMessage(title);
          setDoneStatus(null);
          setLiveItems([goalItem]);

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

  const isSkillsView = overlay === "skills";
  const isPlanView = overlay === "plan";
  const footerStatusLayout = getFooterStatusLayoutDecision({
    columns,
    backgroundTaskCount: bgTasks.length,
    updatePending,
  });
  const activityVisible = agentLoop.isRunning && agentLoop.activityPhase !== "idle";
  const stallStatusVisible = !activityVisible && !!agentLoop.stallError;
  const doneStatusVisible =
    !activityVisible && !stallStatusVisible && !!doneStatus && !agentLoop.isRunning;
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
    tokensIn: agentLoop.contextUsed,
    contextWindowOptions,
    cwd: displayedCwd,
    gitBranch,
    thinkingLevel,
    goalMode,
  });
  const chatControlsLayout = getChatControlsLayoutDecision({
    rows,
    columns,
    agentRunning: agentLoop.isRunning,
    activityVisible,
    doneStatusVisible,
    stallStatusVisible,
    exitPending,
    footerStatusLayout,
    taskBarExpanded,
    goalStatusEntryCount: goalStatusEntries.length,
    footerFitsOnOneLine,
  });
  const stableControlsRows = controlsHeight > 0 ? controlsHeight : chatControlsLayout.controlsRows;
  const measuredLiveAreaRows = Math.max(MIN_LIVE_AREA_ROWS, rows - stableControlsRows - 1);
  const isPixelView = overlay === "pixel";
  const hasLiveAssistantItem = liveItems.some((item) => item.kind === "assistant");
  const rawVisibleStreamingText =
    goalModeStateRef.current === "planner" || hasLiveAssistantItem ? "" : agentLoop.streamingText;
  useEffect(() => {
    if (!rawVisibleStreamingText) {
      streamedAssistantFlushRef.current = { flushedChars: 0, text: "" };
      return;
    }
    if (rawVisibleStreamingText === streamedAssistantFlushRef.current.text) return;
    const alreadyFlushed = streamedAssistantFlushRef.current.flushedChars;
    const unflushedText = rawVisibleStreamingText.slice(alreadyFlushed);
    const split = splitAssistantStreamingText(unflushedText);
    if (split.flushedText.length > 0) {
      queueFlush([
        {
          kind: "assistant",
          text: split.flushedText,
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
  }, [rawVisibleStreamingText, queueFlush]);
  const visibleStreamingText = rawVisibleStreamingText.slice(
    streamedAssistantFlushRef.current.flushedChars,
  );
  const shouldReserveStreamingSpacing =
    agentLoop.isRunning &&
    !hasLiveAssistantItem &&
    (visibleStreamingText.trim().length > 0 || liveItems.some(isTranscriptSpacingItem));
  const lastLiveItem = liveItems.at(-1);
  const lastPendingHistoryItem = pendingHistoryFlushRef.current.at(-1);
  const lastHistoryItem = history.at(-1);
  const shouldTopSpaceStreamingText = shouldTopSpaceStreamingAssistant({
    visibleStreamingText,
    lastLiveItem,
    lastPendingHistoryItem,
    lastHistoryItem,
  });
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

  return (
    <Box flexDirection="column" width={columns} flexShrink={0} flexGrow={0}>
      {isPixelView ? (
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
                pendingHistoryFlushRef.current = [];
                props.terminalHistoryPrinter?.clear();
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
              setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
            });
          }}
        />
      ) : (
        <Box flexDirection="column" width={columns} flexShrink={0} flexGrow={0}>
          {/* MainContent */}
          <Box flexDirection="column" flexGrow={0} flexShrink={1} overflowY="hidden">
            {uniqueItemsById(liveItems).map((item, index, items) => renderItem(item, index, items))}
            <StreamingArea
              isRunning={agentLoop.isRunning}
              streamingText={visibleStreamingText}
              streamingThinking={agentLoop.streamingThinking}
              thinkingMs={agentLoop.thinkingMs}
              reserveSpacing={shouldReserveStreamingSpacing}
              renderMarkdown={renderMarkdown}
              availableTerminalHeight={measuredLiveAreaRows}
              assistantMarginTop={shouldTopSpaceStreamingText ? 1 : 0}
              continuation={streamedAssistantFlushRef.current.flushedChars > 0}
            />
          </Box>

          <Box ref={mainControlsRef} flexDirection="column" flexShrink={0} flexGrow={0}>
            {/* Queue indicator */}
            {hiddenQueuedCount > 0 && (
              <Box
                flexDirection="row"
                paddingLeft={1}
                marginTop={shouldTopSpaceQueueIndicator ? 2 : 1}
                flexShrink={0}
              >
                <Box width={2} flexShrink={0}>
                  <Text color={theme.warning} bold>
                    {"• "}
                  </Text>
                </Box>
                <Text color={theme.textDim}>
                  {hiddenQueuedCount} message{hiddenQueuedCount > 1 ? "s" : ""} queued
                </Text>
              </Box>
            )}

            {/* Input + Footer */}
            <Box flexDirection="column" width={columns}>
              <Box
                borderStyle="single"
                borderTop
                borderBottom={false}
                borderLeft={false}
                borderRight={false}
                borderColor={theme.textDim}
                width={columns}
                height={0}
              />
              <Box paddingLeft={1} paddingRight={1} width={columns}>
                {statusSlotVisible ? (
                  activityVisible ? (
                    <ActivityIndicator
                      phase={agentLoop.activityPhase}
                      elapsedMs={agentLoop.elapsedMs}
                      runStartRef={agentLoop.runStartRef}
                      thinkingMs={agentLoop.thinkingMs}
                      isThinking={agentLoop.isThinking}
                      thinkingEnabled={!!thinkingLevel}
                      tokenEstimate={agentLoop.streamedTokenEstimate}
                      charCountRef={agentLoop.charCountRef}
                      realTokensAccumRef={agentLoop.realTokensAccumRef}
                      userMessage={lastUserMessage}
                      activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
                      retryInfo={agentLoop.retryInfo}
                      planDone={planSteps.filter((s) => s.completed).length}
                      planTotal={planSteps.length}
                      staticDisplay
                    />
                  ) : stallStatusVisible ? (
                    <Text color={theme.warning} wrap="truncate">
                      {
                        "⚠ API provider stream interrupted — retries exhausted. Your conversation is preserved."
                      }
                    </Text>
                  ) : doneStatus ? (
                    <Text color={theme.success}>
                      {"✻ "}
                      {doneStatus.verb} {formatDuration(doneStatus.durationMs)}
                    </Text>
                  ) : (
                    <Text>
                      <Text color={theme.commandColor}>{"⠿ "}</Text>
                      <Text color={theme.textDim}>{"Ready to go.."}</Text>
                      {!renderMarkdown && (
                        <Text color={theme.warning}>{" · raw markdown mode"}</Text>
                      )}
                    </Text>
                  )
                ) : (
                  <Text>
                    <Text color={theme.commandColor}>{"⠿ "}</Text>
                    <Text color={theme.textDim}>{"Ready to go.."}</Text>
                  </Text>
                )}
              </Box>
            </Box>
            <InputArea
              onSubmit={handleSubmit}
              onAbort={handleAbort}
              disabled={agentLoop.isRunning}
              isActive={!taskBarFocused && !overlay}
              onDownAtEnd={handleFocusTaskBar}
              onShiftTab={handleToggleThinking}
              onToggleTasks={() => {
                setGoalPickerOpen(false);
                setTaskPickerTasks(loadTasksSync(displayedCwd));
                setTaskPickerOpen((open) => !open);
              }}
              taskPickerOpen={taskPickerOpen}
              tasks={taskPickerTasks}
              onCloseTaskPicker={() => setTaskPickerOpen(false)}
              onStartTask={(task) => {
                setTaskPickerOpen(false);
                markTaskInProgress(displayedCwd, task.id);
                setTaskPickerTasks(loadTasksSync(displayedCwd));
                startTask(task.title, task.prompt, task.id);
              }}
              onRunAllTasks={(task) => {
                setTaskPickerOpen(false);
                setRunAllTasks(true);
                const selected = task
                  ? {
                      id: task.id,
                      title: task.title,
                      prompt: task.prompt || task.text || task.title,
                    }
                  : getNextPendingTask(displayedCwd);
                if (selected) {
                  markTaskInProgress(displayedCwd, selected.id);
                  setTaskPickerTasks(loadTasksSync(displayedCwd));
                  startTask(selected.title, selected.prompt, selected.id);
                }
              }}
              onDeleteTask={(task) => {
                const nextTasks = loadTasksSync(displayedCwd).filter(
                  (candidate) => candidate.id !== task.id,
                );
                saveTasksSync(displayedCwd, nextTasks);
                setTaskPickerTasks(nextTasks);
              }}
              goalPickerOpen={goalPickerOpen}
              goals={goalPickerGoals}
              onCloseGoalPicker={() => setGoalPickerOpen(false)}
              onRunGoal={(run) => {
                setGoalPickerOpen(false);
                setDoneStatus(null);
                appendGoalProgress({
                  kind: "goal_progress",
                  phase: "continuing",
                  title: `Goal run requested: ${run.title}`,
                  detail: "Enter pressed in Ctrl+G; starting the Goal orchestrator.",
                  status: run.status,
                });
                log("INFO", "goal", `Goal run requested from Ctrl+G: ${run.title}`, { id: run.id });
                void (async () => {
                  const latestRun =
                    (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
                  const requestedAt = new Date().toISOString();
                  const runWithContinuation = await upsertGoalRun(props.cwd, {
                    ...latestRun,
                    status:
                      latestRun.status === "running" || latestRun.status === "verifying"
                        ? latestRun.status
                        : "ready",
                    continueRequestedAt: requestedAt,
                    blockers: goalHasBlockingPrerequisites(latestRun) ? latestRun.blockers : [],
                    evidence: [
                      ...latestRun.evidence,
                      {
                        id: `goal-rerun-${requestedAt}`,
                        kind: "summary" as const,
                        label: "Goal rerun requested",
                        content:
                          "Continuation requested from Ctrl+G; the orchestrator will choose the next eligible Goal action.",
                        createdAt: requestedAt,
                      },
                    ],
                  });
                  startGoalRun(runWithContinuation);
                })().catch((err: unknown) => {
                  log("ERROR", "goal", err instanceof Error ? err.message : String(err));
                  setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
                });
              }}
              onDeleteGoal={(run) => {
                setGoalPickerOpen(false);
                runningGoalIdsRef.current.delete(run.id);
                void (async () => {
                  const latestRun =
                    (await loadGoalRuns(props.cwd)).find((item) => item.id === run.id) ?? run;
                  if (latestRun.activeWorkerId) await stopGoalWorker(latestRun.activeWorkerId);
                  const nextGoals = (await loadGoalRuns(props.cwd)).filter(
                    (candidate) => candidate.id !== run.id,
                  );
                  await saveGoalRuns(props.cwd, nextGoals);
                  setGoalPickerGoals(nextGoals);
                  clearGoalStatusEntry(run.id);
                  clearGoalModeIfIdle();
                })().catch((err: unknown) => {
                  log("ERROR", "goal", err instanceof Error ? err.message : String(err));
                  setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
                });
              }}
              onPauseGoal={(run) => {
                setGoalPickerOpen(false);
                pauseGoalRun(run);
              }}
              onToggleGoal={() => {
                setTaskPickerOpen(false);
                setGoalPickerGoals(loadGoalRunsSync(props.cwd));
                setGoalPickerOpen((open) => !open);
              }}
              onToggleSkills={() => {
                openOverlay("skills");
              }}
              onTogglePixel={() => {
                openOverlay("pixel");
              }}
              onToggleMarkdown={() => {
                setRenderMarkdown((prev) => !prev);
              }}
              cwd={props.cwd}
              commands={allCommands}
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
                  thinkingLevel={thinkingLevel}
                  goalMode={goalMode}
                  exitPending={exitPending}
                  renderMarkdown={renderMarkdown}
                />
                {!exitPending && <GoalStatusBar entries={goalStatusEntries} />}
              </>
            )}
            {/* Status row — background tasks and the update-ready indicator share
                a single line. Order is intentional: active work first, ambient
                hints last. */}
            {(footerStatusLayout.hasBackgroundTasks || footerStatusLayout.hasUpdateNotice) && (
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
                {footerStatusLayout.hasUpdateNotice && (
                  <Box
                    paddingLeft={
                      footerStatusLayout.stack || !footerStatusLayout.hasBackgroundTasks ? 1 : 2
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
          </Box>
        </Box>
      )}
    </Box>
  );
}
