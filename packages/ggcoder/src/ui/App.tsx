import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, Text, Static, useStdout } from "ink";
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
import crypto, { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { playNotificationSound } from "../utils/sound.js";
import type { Message, Provider, ThinkingLevel, TextContent, ImageContent } from "@kenkaiiii/gg-ai";
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
import { Banner } from "./components/Banner.js";
import { PlanOverlay } from "./components/PlanOverlay.js";
import { ModelSelector } from "./components/ModelSelector.js";
import { TaskOverlay } from "./components/TaskOverlay.js";
import { PixelOverlay } from "./components/PixelOverlay.js";
import type { PreparedPixelFix } from "../core/pixel-fix.js";
import { SkillsOverlay } from "./components/SkillsOverlay.js";
import { EyesOverlay } from "./components/EyesOverlay.js";
import { ThemeSelector } from "./components/ThemeSelector.js";
import { BackgroundTasksBar } from "./components/BackgroundTasksBar.js";
import type { SlashCommandInfo } from "./components/SlashCommandMenu.js";
import type { ProcessManager } from "../core/process-manager.js";
import { useTheme, useSetTheme, type ThemeName } from "./theme/theme.js";
import {
  useAnimationTick,
  useAnimationActive,
  deriveFrame,
} from "./components/AnimationContext.js";
import { useTerminalTitle } from "./hooks/useTerminalTitle.js";
import { getGitBranch } from "../utils/git.js";
import { getModel, getContextWindow } from "../core/model-registry.js";
import { SessionManager, type MessageEntry } from "../core/session-manager.js";
import { log } from "../core/logger.js";
import {
  getPendingUpdate,
  startPeriodicUpdateCheck,
  stopPeriodicUpdateCheck,
} from "../core/auto-update.js";
import { generateSessionTitle } from "../utils/session-title.js";
import { SettingsManager, type Settings } from "../core/settings-manager.js";
import { shouldCompact, compact } from "../core/compaction/compactor.js";
import { estimateConversationTokens } from "../core/compaction/token-estimator.js";
import { PROMPT_COMMANDS, getPromptCommand } from "../core/prompt-commands.js";
import { loadCustomCommands, type CustomCommand } from "../core/custom-commands.js";
import { buildSystemPrompt } from "../system-prompt.js";
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
import { Buddy } from "./buddy/Buddy.js";

// ── Provider Error Hints ──────────────────────────────────

/** Detect provider-side errors and return a user-facing hint. */
function getProviderErrorHint(message: string): string | null {
  const lower = message.toLowerCase();
  if (lower.includes("overloaded") || lower.includes("engine_overloaded")) {
    return "This is a provider-side issue — their servers are under heavy load. Try again in a moment.";
  }
  if (
    lower.includes("insufficient balance") ||
    lower.includes("no resource package") ||
    lower.includes("quota exceeded") ||
    lower.includes("recharge")
  ) {
    return "The provider reports a billing or quota issue. Check your account balance or resource package.";
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return "You've hit the provider's rate limit. Wait a moment before retrying.";
  }
  if (lower.includes("502") || lower.includes("bad gateway")) {
    return "The provider returned a server error. This is not a ggcoder issue — try again shortly.";
  }
  if (lower.includes("503") || lower.includes("service unavailable")) {
    return "The provider's service is temporarily unavailable. Try again in a moment.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "The request to the provider timed out. Their servers may be slow — try again.";
  }
  if (lower.includes("500") && lower.includes("internal server error")) {
    return "The provider experienced an internal error. This is not a ggcoder issue.";
  }
  if (
    lower.includes("does not recognize the requested model") ||
    (lower.includes("model") &&
      (lower.includes("not exist") || lower.includes("not found") || lower.includes("no access")))
  ) {
    return "Use /model to switch to a different model, or check that your account has access to the requested model.";
  }
  return null;
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
  message: string;
  id: string;
}

interface InfoItem {
  kind: "info";
  text: string;
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

interface ToolGroupTool {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
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
  | AssistantItem
  | ToolStartItem
  | ToolDoneItem
  | ServerToolStartItem
  | ServerToolDoneItem
  | ErrorItem
  | InfoItem
  | UpdateNoticeItem
  | QueuedItem
  | CompactingItem
  | CompactedItem
  | DurationItem
  | BannerItem
  | SubAgentGroupItem
  | ToolGroupItem
  | PlanTransitionItem
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

// flushOnTurnText, flushOnTurnEnd are imported from ./live-item-flush.ts

/** Check whether an item is still active (running spinner, pending result). */
function isActiveItem(item: CompletedItem): boolean {
  switch (item.kind) {
    case "tool_start":
    case "server_tool_start":
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
  cwd: string;
  version: string;
  showThinking?: boolean;
  showTokenUsage?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<
    string,
    { accessToken: string; accountId?: string; baseUrl?: string }
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
  initialOverlay?: "pixel";
  rebuildToolsForCwd?: (cwd: string) => AgentTool[];
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
    pendingAction?: { prompt: string; infoText?: string };
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
    approvedPlanPath?: string;
    planSteps: PlanStep[];
    sessionPath?: string;
    sessionTitle?: string;
    sessionTitleGenerated: boolean;
    overlay?: "model" | "tasks" | "skills" | "plan" | "theme" | "eyes" | "pixel" | null;
    planAutoExpand?: boolean;
    runAllTasks?: boolean;
    runAllPixel?: boolean;
    pendingAction?: { prompt: string; infoText?: string };
  };
}

// ── App Component ──────────────────────────────────────────

export function App(props: AppProps) {
  const theme = useTheme();
  const switchTheme = useSetTheme();
  const { stdout } = useStdout();
  const { columns, resizeKey } = useTerminalSize();

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
  // Items from the current/last turn — rendered in the live area so they stay visible
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  // overlay seeded from sessionStore (lives across remount). Falls back to
  // props.initialOverlay (CLI launched with one), then null.
  const [overlay, setOverlay] = useState<
    "model" | "tasks" | "skills" | "plan" | "theme" | "eyes" | "pixel" | null
  >(props.sessionStore?.overlay ?? props.initialOverlay ?? null);
  const [taskCount, setTaskCount] = useState(() => getTaskCount(props.cwd));
  const [eyesCount, setEyesCount] = useState<number | undefined>(() =>
    isEyesActive(props.cwd) ? journalCount({ status: "open" }, props.cwd) : undefined,
  );
  const [updatePending, setUpdatePending] = useState<boolean>(
    () => getPendingUpdate(props.version) !== null,
  );
  // runAllTasks must survive the unmount/remount that startTask triggers
  // for each task (wipeSession: true gives every task a fresh session).
  // Seed from sessionStore so the chain keeps going after task #1.
  const [runAllTasks, setRunAllTasks] = useState(props.sessionStore?.runAllTasks ?? false);
  const runAllTasksRef = useRef(props.sessionStore?.runAllTasks ?? false);
  const startTaskRef = useRef<(title: string, prompt: string, taskId: string) => void>(() => {});
  const runAllPixelRef = useRef(props.sessionStore?.runAllPixel ?? false);
  const currentPixelFixRef = useRef<PreparedPixelFix | null>(null);
  const startPixelFixRef = useRef<(errorId: string) => void>(() => {});
  const cwdRef = useRef(props.cwd);
  const [displayedCwd, setDisplayedCwd] = useState(props.cwd);
  const [staticKey, setStaticKey] = useState(0);
  const [doneStatus, setDoneStatus] = useState<{
    durationMs: number;
    toolsUsed: string[];
    verb: string;
  } | null>(null);
  // Suppress "done" status when a plan overlay is about to open
  const planOverlayPendingRef = useRef(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(props.model);
  const [currentProvider, setCurrentProvider] = useState(props.provider);
  const [currentTools, setCurrentTools] = useState(props.tools);
  const [thinkingEnabled, setThinkingEnabled] = useState(!!props.thinking);
  const messagesRef = useRef<Message[]>(props.sessionStore?.messages ?? props.messages);
  const [planAutoExpand, setPlanAutoExpand] = useState(props.sessionStore?.planAutoExpand ?? false);
  const approvedPlanPathRef = useRef<string | undefined>(props.sessionStore?.approvedPlanPath);
  const planStepsRef = useRef<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>(props.sessionStore?.planSteps ?? []);
  const nextIdRef = useRef(0);
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

  const getId = () => String(nextIdRef.current++);

  // Two-phase flush: items waiting to be moved to Static history after the
  // live area has been cleared and Ink has committed the smaller output.
  const pendingFlushRef = useRef<CompletedItem[]>([]);
  const [flushGeneration, setFlushGeneration] = useState(0);

  /** Queue items for two-phase flush and signal the drain effect. */
  const queueFlush = useCallback((items: CompletedItem[]) => {
    if (items.length === 0) return;
    pendingFlushRef.current = [...pendingFlushRef.current, ...items];
    setFlushGeneration((g) => g + 1);
  }, []);

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
      thinking: thinkingEnabled ? (props.thinking ?? "medium") : undefined,
    });
  }, [thinkingEnabled, props.thinking, onRuntimeStateChange]);

  // Mirror session state into renderApp's closure so resetUI() can re-seed
  // the conversation on remount. Each panel that previously did a bare ANSI
  // screen clear (overlay open/close, plan accept/reject, /clear, startTask)
  // now goes through resetUI; without these mirrors, the chat would vanish.
  const sessionStore = props.sessionStore;
  useEffect(() => {
    if (sessionStore) sessionStore.history = history;
  }, [history, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.planSteps = planSteps;
  }, [planSteps, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.sessionTitle = sessionTitle;
  }, [sessionTitle, sessionStore]);
  useEffect(() => {
    if (sessionStore) sessionStore.overlay = overlay;
  }, [overlay, sessionStore]);

  // pendingAction is consumed via a useEffect AFTER agentLoop is created
  // — see below where useAgentLoop is set up.
  const pendingActionConsumedRef = useRef(false);

  // Derive credentials for the current provider
  const currentCreds = props.credentialsByProvider?.[currentProvider];
  const activeApiKey = currentCreds?.accessToken ?? props.apiKey;
  const activeAccountId = currentCreds?.accountId ?? props.accountId;
  const activeBaseUrl = currentCreds?.baseUrl ?? props.baseUrl;

  // Load git branch — re-runs whenever the displayed cwd changes (e.g. when
  // a pixel fix moves the agent into a different project root).
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

  // ── Plan mode wiring ─────────────────────────────────────
  // Sync planModeRef with React state
  useEffect(() => {
    if (props.planModeRef) {
      props.planModeRef.current = planMode;
    }
  }, [planMode, props.planModeRef]);

  // Rebuild system prompt when plan mode changes
  useEffect(() => {
    void (async () => {
      const newPrompt = await buildSystemPrompt(
        props.cwd,
        props.skills,
        planMode,
        approvedPlanPathRef.current,
      );
      if (messagesRef.current[0]?.role === "system") {
        messagesRef.current[0] = {
          role: "system" as const,
          content: newPrompt,
        };
      }
    })();
  }, [planMode, props.cwd, props.skills]);

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
        setPlanMode(false);
        approvedPlanPathRef.current = planPath;
        // Use setTimeout to open pane after the current tool execution completes,
        // so the turn can finish and the UI transitions cleanly
        // Flag that the plan overlay is about to open — suppresses the
        // premature "done" status that fires when the agent loop finishes
        planOverlayPendingRef.current = true;
        setTimeout(() => {
          // NOTE: this is the one open-overlay path that does NOT remount via
          // resetUI. It runs while the agent is still mid-turn (after the
          // exit_plan tool returned but before onDone fires), and unmounting
          // here would kill the in-flight agent stream. Keep the bare ANSI
          // clear; the drift bug is tolerable across just the agent's
          // wrap-up turn, and onApprove/onReject both remount cleanly via
          // resetUI when the user resolves the plan.
          stdout?.write("\x1b[2J\x1b[3J\x1b[H");
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
  }, [props.onExitPlanRef, stdout]);

  const persistNewMessages = useCallback(async () => {
    const sm = sessionManagerRef.current;
    const sp = sessionPathRef.current;
    if (!sm || !sp) return;
    const allMsgs = messagesRef.current;
    for (let i = persistedIndexRef.current; i < allMsgs.length; i++) {
      const msg = allMsgs[i];
      if (msg.role === "system") continue;
      const entry: MessageEntry = {
        type: "message",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        message: msg,
      };
      await sm.appendEntry(sp, entry);
    }
    persistedIndexRef.current = allMsgs.length;
  }, []);

  // ── Compaction ─────────────────────────────────────────

  // Load settings for auto-compaction + buddy
  const settingsRef = useRef<SettingsManager | null>(null);
  const [buddyEnabled, setBuddyEnabled] = useState(false);
  useEffect(() => {
    if (props.settingsFile) {
      const sm = new SettingsManager(props.settingsFile);
      sm.load().then(() => {
        settingsRef.current = sm;
        setBuddyEnabled(sm.get("buddyEnabled") ?? false);
      });
    }
  }, [props.settingsFile]);

  const compactConversation = useCallback(
    async (messages: Message[]): Promise<Message[]> => {
      const contextWindow = getContextWindow(currentModel);
      const tokensBefore = estimateConversationTokens(messages);
      const spinId = getId();
      log("INFO", "compaction", `Running compaction`, {
        messages: String(messages.length),
        estimatedTokens: String(tokensBefore),
        contextWindow: String(contextWindow),
      });

      // Show animated spinner
      setLiveItems((prev) => [...prev, { kind: "compacting", id: spinId }]);

      try {
        // Resolve fresh credentials for compaction too
        let compactApiKey = activeApiKey;
        if (props.authStorage) {
          const creds = await props.authStorage.resolveCredentials(currentProvider);
          compactApiKey = creds.accessToken;
        }

        const result = await compact(messages, {
          provider: currentProvider,
          model: currentModel,
          apiKey: compactApiKey,
          contextWindow,
          signal: undefined,
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
        log("ERROR", "compaction", `Compaction failed: ${msg}`);
        // Replace spinner with error
        setLiveItems((prev) =>
          prev.map((item) =>
            item.id === spinId
              ? ({ kind: "error", message: `Compaction failed: ${msg}`, id: spinId } as ErrorItem)
              : item,
          ),
        );
        return messages; // Return unchanged on failure
      }
    },
    [currentModel, currentProvider, activeApiKey],
  );

  /**
   * transformContext callback for the agent loop.
   * Called before each LLM call and on context overflow.
   * Checks if auto-compaction is needed and runs it.
   *
   * Uses actual API-reported token counts (from previous turn_end) when
   * available, falling back to the character-based estimate. A 30-second
   * cooldown prevents repeated compaction — matching the pattern used by
   * Mysti, openclaw, and other real-world agent frameworks.
   */
  const transformContext = useCallback(
    async (messages: Message[], options?: { force?: boolean }): Promise<Message[]> => {
      const settings = settingsRef.current;
      const autoCompact = settings?.get("autoCompact") ?? true;
      const threshold = settings?.get("compactThreshold") ?? 0.8;

      // Force-compact on context overflow regardless of settings
      if (options?.force) {
        const result = await compactConversation(messages);
        lastCompactionTimeRef.current = Date.now();
        return result;
      }

      if (!autoCompact) return messages;

      // Time-based cooldown: skip if compaction ran within the last 30 seconds
      if (Date.now() - lastCompactionTimeRef.current < 30_000) {
        log("INFO", "compaction", `Skipping compaction — cooldown active`);
        return messages;
      }

      const contextWindow = getContextWindow(currentModel);
      // Reserve = max output budget + ~5K headroom for system prompt + tool
      // schemas. Otherwise the API rejects requests where the prompt fits the
      // window but leaves no room for the response (e.g. Codex Mini at 200K
      // ctx / 100K out — pre-turn estimate may say 160K but a 100K reasoning
      // response then overflows).
      const modelInfo = getModel(currentModel);
      const reserveTokens = (modelInfo?.maxOutputTokens ?? 0) + 5_000;
      // Prefer actual API-reported tokens over char-based estimate, but only
      // when the token count was recorded AFTER the most recent compaction.
      // A count from before compaction is stale — it reflects the old context
      // size and would trigger compaction again immediately for no reason.
      const tokensFresh = lastActualTokensTimestampRef.current > lastCompactionTimeRef.current;
      const actualTokens =
        lastActualTokensRef.current > 0 && tokensFresh ? lastActualTokensRef.current : undefined;
      if (shouldCompact(messages, contextWindow, threshold, actualTokens, reserveTokens)) {
        const before = messages.length;
        const result = await compactConversation(messages);
        lastCompactionTimeRef.current = Date.now();
        // If compaction was a no-op (e.g. too few middle messages to summarize),
        // return the original reference so the agent loop doesn't replace messages.
        if (result.length === before) return messages;
        return result;
      }
      return messages;
    },
    [currentModel, compactConversation],
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
        return { apiKey: creds.accessToken, accountId: creds.accountId };
      }
      return { apiKey: activeApiKey!, accountId: activeAccountId };
    },
    [props.authStorage, currentProvider, activeApiKey, activeAccountId],
  );

  const agentLoop = useAgentLoop(
    messagesRef,
    {
      provider: currentProvider,
      model: currentModel,
      tools: currentTools,
      webSearch: props.webSearch,
      maxTokens: props.maxTokens,
      thinking: thinkingEnabled ? (props.thinking ?? "medium") : undefined,
      apiKey: activeApiKey,
      baseUrl: activeBaseUrl,
      accountId: activeAccountId,
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
          void (async () => {
            const newPrompt = await buildSystemPrompt(props.cwd, props.skills, planMode, undefined);
            if (messagesRef.current[0]?.role === "system") {
              messagesRef.current[0] = { role: "system" as const, content: newPrompt };
            }
          })();
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
                  tools: [...group.tools, { toolCallId, name, args, status: "running" }],
                };
                return next;
              }
              return [
                ...prev,
                {
                  kind: "tool_group",
                  tools: [{ toolCallId, name, args, status: "running" }],
                  id: getId(),
                },
              ];
            });
          } else {
            setLiveItems((prev) => [
              ...prev,
              { kind: "tool_start", toolCallId, name, args, id: getId() },
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
              startedAt: Date.now(),
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
          return [...next, { kind: "info", text: "Request was stopped.", id: getId() }];
        });
      }, []),
      onQueuedStart: useCallback((content: UserContent) => {
        // When a queued message starts processing, show it as a UserItem
        // and flush prior items to history
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
    },
  );

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
      setHistory((h) => compactHistory([...h, ...trimFlushedItems(items)]));
    }
  }, [flushGeneration]);

  // Sync terminal title with agent loop state
  useEffect(() => {
    setTitleRunning(agentLoop.isRunning);
  }, [agentLoop.isRunning]);

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
    if (action.infoText) {
      setLiveItems((prev) => [
        ...prev,
        { kind: "info", text: action.infoText as string, id: getId() },
      ]);
    }
    setDoneStatus(null);
    void agentLoop.run(action.prompt).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log("ERROR", "error", errMsg);
      setLiveItems((prev) => [...prev, { kind: "error", message: errMsg, id: getId() }]);
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

  // Animated thinking border — derived from global animation tick
  useAnimationActive();
  const animTick = useAnimationTick();
  const thinkingBorderFrame =
    agentLoop.activityPhase === "thinking"
      ? deriveFrame(animTick, 1000, THINKING_BORDER_COLORS.length)
      : 0;

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
      }

      // Handle /model directly — open inline selector
      if (trimmed === "/model" || trimmed === "/m") {
        setOverlay("model");
        return;
      }

      // Handle /compact — compact conversation
      if (trimmed === "/compact" || trimmed === "/c") {
        const compacted = await compactConversation(messagesRef.current);
        if (compacted !== messagesRef.current) {
          messagesRef.current = compacted;
          persistedIndexRef.current = 0; // Re-persist after compaction
        }
        return;
      }

      // Handle /quit — exit the agent
      if (trimmed === "/quit" || trimmed === "/q" || trimmed === "/exit") {
        process.exit(0);
      }

      // Handle /clear — tear down the entire Ink instance and rebuild fresh.
      // Patching Ink's internal frame tracking in place (log-update reset,
      // lastOutput cleared, fullStaticOutput dropped, staticKey bump) all
      // looked correct for one frame but left the live area drifting on
      // subsequent streaming responses — Ink's cursor math depends on
      // terminal-state assumptions that ANSI clearing breaks. The reliable
      // fix is unmount + render again. Runtime state (model, provider,
      // thinking) survives via renderApp's closure-held `runtimeState`,
      // mirrored from React state via the useEffects above.
      if (trimmed === "/clear") {
        if (props.resetUI) {
          void (async () => {
            const newPrompt = await buildSystemPrompt(props.cwd, props.skills, planMode, undefined);
            props.resetUI?.({
              wipeSession: true,
              messages: [{ role: "system" as const, content: newPrompt }],
            });
          })();
          return;
        }
        // Fallback path (resetUI not wired — e.g. tests). Best-effort: clear
        // React state in place. The Ink-internal drift bug remains here.
        stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        pendingFlushRef.current = [];
        setHistory([{ kind: "banner", id: "banner" }]);
        setLiveItems([]);
        setDoneStatus(null);
        approvedPlanPathRef.current = undefined;
        planStepsRef.current = [];
        setPlanSteps([]);
        void (async () => {
          const newPrompt = await buildSystemPrompt(props.cwd, props.skills, planMode, undefined);
          messagesRef.current = [{ role: "system" as const, content: newPrompt }];
          persistedIndexRef.current = messagesRef.current.length;
        })();
        agentLoop.reset();
        setSessionTitle(undefined);
        sessionTitleGeneratedRef.current = false;
        setStaticKey((k) => k + 1);
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
        void (async () => {
          const newPrompt = await buildSystemPrompt(props.cwd, props.skills, planMode, undefined);
          if (messagesRef.current[0]?.role === "system") {
            messagesRef.current[0] = { role: "system" as const, content: newPrompt };
          }
        })();
        setLiveItems([{ kind: "info", text: "Approved plan dismissed.", id: getId() }]);
        return;
      }

      // Handle /buddy — toggle companion
      if (trimmed === "/buddy") {
        const next = !buddyEnabled;
        setBuddyEnabled(next);
        if (settingsRef.current) {
          settingsRef.current.set("buddyEnabled", next);
        }
        setLiveItems((items) => [
          ...items,
          {
            kind: "info" as const,
            text: next
              ? "Buddy enabled! Your companion will appear near the prompt."
              : "Buddy disabled.",
            id: getId(),
          },
        ]);
        return;
      }

      // Handle /plans — open plan pane
      if (trimmed === "/plans") {
        if (props.resetUI && props.sessionStore) {
          props.sessionStore.overlay = "plan";
          props.sessionStore.planAutoExpand = false;
          props.resetUI();
        } else {
          stdout?.write("\x1b[2J\x1b[3J\x1b[H");
          setPlanAutoExpand(false);
          setOverlay("plan");
        }
        return;
      }

      // Handle prompt-template commands (built-in + custom from .gg/commands/)
      if (trimmed.startsWith("/")) {
        const parts = trimmed.slice(1).split(" ");
        const cmdName = parts[0];
        const cmdArgs = parts.slice(1).join(" ").trim();
        const builtinCmd = getPromptCommand(cmdName);
        const customCmd = !builtinCmd ? customCommands.find((c) => c.name === cmdName) : undefined;
        const promptText = builtinCmd?.prompt ?? customCmd?.prompt;

        if (promptText) {
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

          // Show the command name as the user message
          const userItem: UserItem = { kind: "user", text: trimmed, id: getId() };
          setLastUserMessage(trimmed);
          setDoneStatus(null);
          setLiveItems([userItem]);

          // Send the full prompt to the agent, with user args appended if provided
          const fullPrompt = cmdArgs
            ? `${promptText}\n\n## User Instructions\n\n${cmdArgs}`
            : promptText;
          try {
            await agentLoop.run(fullPrompt);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log("ERROR", "error", msg);
            const isAbort = msg.includes("aborted") || msg.includes("abort");
            setLiveItems((prev) => [
              ...prev,
              isAbort
                ? { kind: "info", text: "Request was stopped.", id: getId() }
                : { kind: "error", message: msg, id: getId() },
            ]);
          }
          // Reload custom commands in case a setup command created new ones
          reloadCustomCommands();
          return;
        }
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
      let userContent: string | (TextContent | ImageContent)[];
      if (hasImages) {
        const parts: (TextContent | ImageContent)[] = [];
        if (trimmed) {
          parts.push({ type: "text", text: trimmed });
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
        userContent = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
      } else {
        userContent = input;
      }

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
            ? { kind: "info", text: "Request was stopped.", id: getId() }
            : { kind: "error", message: msg, id: getId() },
        ]);
      }
    },
    [agentLoop, props.onSlashCommand, compactConversation],
  );

  const handleDoubleExit = useDoublePress(setExitPending, () => process.exit(0));

  const handleAbort = useCallback(() => {
    if (agentLoop.isRunning) {
      agentLoop.clearQueue();
      agentLoop.abort();
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
        { kind: "info", text: `Thinking ${next ? "on" : "off"}`, id: getId() },
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

      // Handle provider-specific tool changes when provider changes
      setCurrentProvider((prevProvider) => {
        if (newProvider !== prevProvider) {
          // Add/remove client-side web_search tool based on provider.
          // Anthropic has native server-side web search; all other providers need the client tool.
          setCurrentTools((prev) => {
            const hasWebSearch = prev.some((t) => t.name === "web_search");
            if (newProvider === "anthropic" && hasWebSearch) {
              // Switching TO anthropic — remove client-side web_search (server-side handles it)
              return prev.filter((t) => t.name !== "web_search");
            } else if (newProvider !== "anthropic" && !hasWebSearch) {
              // Switching FROM anthropic — add client-side web_search
              return [...prev, createWebSearchTool()];
            }
            return prev;
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
                setCurrentTools((prev) => [
                  ...prev.filter((t) => !t.name.startsWith("mcp__")),
                  ...mcpTools,
                ]);
                log("INFO", "mcp", `MCP servers reconnected for provider ${newProvider}`);
              } catch (err) {
                log(
                  "WARN",
                  "mcp",
                  `MCP reconnection failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                // Still remove old MCP tools even if reconnection fails
                setCurrentTools((prev) => prev.filter((t) => !t.name.startsWith("mcp__")));
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
        { kind: "info", text: `Switched to ${displayName}`, id: getId() },
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
      setLiveItems((prev) => [
        ...prev,
        { kind: "info", text: `Theme switched to: ${name}`, id: getId() },
      ]);
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
      "init",
      "research",
      "scan",
      "verify",
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
      case "assistant":
        return (
          <AssistantMessage
            key={item.id}
            text={item.text}
            thinking={item.thinking}
            thinkingMs={item.thinkingMs}
            showThinking={props.showThinking}
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
        const providerHint = getProviderErrorHint(item.message);
        return (
          <Box key={item.id} marginTop={1} flexDirection="column" flexShrink={1}>
            <Text color={theme.error} wrap="wrap">
              {"✗ "}
              {item.message}
            </Text>
            {providerHint && (
              <Text color={theme.textDim} wrap="wrap">
                {"  Hint: "}
                {providerHint}
              </Text>
            )}
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
            <Text color={theme.accent} bold>
              {"⏳ Queued: "}
            </Text>
            <Text color={theme.text} wrap="wrap">
              {item.text}
              {item.imageCount
                ? ` (+${item.imageCount} image${item.imageCount > 1 ? "s" : ""})`
                : ""}
            </Text>
          </Box>
        );
      case "compacting":
        return <CompactionSpinner key={item.id} />;
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
      stdout?.write("\x1b[2J\x1b[3J\x1b[H");
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
              ? { kind: "info", text: "Request was stopped.", id: getId() }
              : { kind: "error", message: msg, id: getId() },
          ]);
          setRunAllTasks(false);
        }
      })();
    },
    [
      props.cwd,
      props.resetUI,
      props.sessionStore,
      stdout,
      agentLoop,
      currentProvider,
      currentModel,
    ],
  );

  // Keep refs in sync for access from stale closures (onDone)
  startTaskRef.current = startTask;
  useEffect(() => {
    runAllTasksRef.current = runAllTasks;
    if (props.sessionStore) props.sessionStore.runAllTasks = runAllTasks;
  }, [runAllTasks, props.sessionStore]);

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
          if (props.rebuildToolsForCwd) {
            setCurrentTools(props.rebuildToolsForCwd(prep.projectPath));
          }
          const newSystemPrompt = await buildSystemPrompt(
            prep.projectPath,
            props.skills,
            false,
            undefined,
          );

          // Now that the cwd swap is committed, reset chat. Doing this BEFORE
          // the chdir would print a banner with the old cwd, then bumping
          // staticKey would print a second banner with the new cwd — leaving
          // two banners stacked in the scrollback.
          stdout?.write("\x1b[2J\x1b[3J\x1b[H");
          setHistory([{ kind: "banner", id: "banner" }]);
          setLiveItems([]);
          setStaticKey((k) => k + 1);
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
          setLiveItems((prev) => [...prev, { kind: "error", message: msg, id: getId() }]);
        }
      })();
    },
    [props.cwd, stdout, agentLoop, currentProvider, currentModel],
  );
  startPixelFixRef.current = startPixelFix;

  // See runAllTasks above — same persistence story for pixel run-all.
  const [runAllPixel, setRunAllPixel] = useState(props.sessionStore?.runAllPixel ?? false);
  useEffect(() => {
    runAllPixelRef.current = runAllPixel;
    if (props.sessionStore) props.sessionStore.runAllPixel = runAllPixel;
  }, [runAllPixel, props.sessionStore]);

  const isTaskView = overlay === "tasks";
  const isSkillsView = overlay === "skills";
  const isPlanView = overlay === "plan";
  const isEyesView = overlay === "eyes";
  const isPixelView = overlay === "pixel";
  const isOverlayView = isTaskView || isSkillsView || isPlanView || isEyesView || isPixelView;

  return (
    <Box flexDirection="column" width={columns}>
      {/* History — scrolled up, managed by Ink Static. */}
      <Static
        key={`${resizeKey}-${staticKey}`}
        items={isOverlayView ? [] : history}
        style={{ width: "100%" }}
      >
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
            if (props.resetUI && props.sessionStore) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setTaskCount(getTaskCount(props.cwd));
              setStaticKey((k) => k + 1);
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
      ) : isPixelView ? (
        <PixelOverlay
          version={props.version}
          agentRunning={agentLoop.isRunning}
          onClose={() => {
            if (props.resetUI && props.sessionStore) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setStaticKey((k) => k + 1);
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
            if (props.resetUI && props.sessionStore) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setStaticKey((k) => k + 1);
              setOverlay(null);
            }
          }}
        />
      ) : isEyesView ? (
        <EyesOverlay
          cwd={props.cwd}
          onClose={() => {
            if (props.resetUI && props.sessionStore) {
              props.sessionStore.overlay = null;
              props.resetUI();
            } else {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setEyesCount(
                isEyesActive(props.cwd) ? journalCount({ status: "open" }, props.cwd) : undefined,
              );
              setStaticKey((k) => k + 1);
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
            if (props.resetUI && props.sessionStore) {
              props.sessionStore.overlay = null;
              props.sessionStore.planAutoExpand = false;
              props.resetUI();
            } else {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setStaticKey((k) => k + 1);
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
                const newPrompt = await buildSystemPrompt(props.cwd, props.skills, false, planPath);

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
                      infoText: "Plan approved — starting fresh session for implementation",
                    },
                  });
                  return;
                }

                // Fallback path (resetUI not wired — tests). Mutate in place.
                approvedPlanPathRef.current = planPath;
                planStepsRef.current = steps;
                setPlanSteps(steps);
                stdout?.write("\x1b[2J\x1b[3J\x1b[H");
                setHistory([{ kind: "banner", id: "banner" }]);
                setLiveItems([]);
                setStaticKey((k) => k + 1);
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
                setLiveItems((prev) => [...prev, { kind: "error", message: errMsg, id: getId() }]);
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
                  infoText: `Plan rejected — "${feedback}"`,
                },
              });
              return;
            }
            stdout?.write("\x1b[2J\x1b[3J\x1b[H");
            setStaticKey((k) => k + 1);
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
              setLiveItems((prev) => [...prev, { kind: "error", message: errMsg, id: getId() }]);
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
              showThinking={props.showThinking}
              thinkingMs={agentLoop.thinkingMs}
              planMode={planMode}
            />
          </Box>

          {/* Pinned status line — always use "round" border but make it
              transparent when not thinking, so the Box height stays constant
              across phase transitions and Ink's cursor math stays aligned. */}
          {agentLoop.isRunning && agentLoop.activityPhase !== "idle" ? (
            <Box
              marginTop={1}
              borderStyle="round"
              borderColor={
                agentLoop.activityPhase === "thinking"
                  ? THINKING_BORDER_COLORS[thinkingBorderFrame]
                  : "transparent"
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
                tokenEstimate={agentLoop.streamedTokenEstimate}
                charCountRef={agentLoop.charCountRef}
                realTokensAccumRef={agentLoop.realTokensAccumRef}
                userMessage={lastUserMessage}
                activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
                planMode={planMode}
                retryInfo={agentLoop.retryInfo}
                planDone={planSteps.filter((s) => s.completed).length}
                planTotal={planSteps.length}
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
              <Text color={theme.accent}>
                {"⏳ "}
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
              if (props.resetUI && props.sessionStore) {
                props.sessionStore.overlay = "tasks";
                props.resetUI();
              } else {
                stdout?.write("\x1b[2J\x1b[3J\x1b[H");
                setOverlay("tasks");
              }
            }}
            onToggleSkills={() => {
              if (props.resetUI && props.sessionStore) {
                props.sessionStore.overlay = "skills";
                props.resetUI();
              } else {
                stdout?.write("\x1b[2J\x1b[3J\x1b[H");
                setOverlay("skills");
              }
            }}
            onTogglePixel={() => {
              if (props.resetUI && props.sessionStore) {
                props.sessionStore.overlay = "pixel";
                props.resetUI();
              } else {
                stdout?.write("\x1b[2J\x1b[3J\x1b[H");
                setOverlay("pixel");
              }
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
            <Footer
              model={currentModel}
              tokensIn={agentLoop.contextUsed}
              cwd={displayedCwd}
              gitBranch={gitBranch}
              thinkingEnabled={thinkingEnabled}
              planMode={planMode}
              exitPending={exitPending}
            />
          )}
          {/* Buddy companion */}
          {buddyEnabled && <Buddy phase={agentLoop.activityPhase} />}
          {/* Status row — background tasks, eyes call-to-action, and the
              update-ready indicator all share a single line. Order is
              intentional: active work (bg tasks) first, actionable signals
              (eyes) next, ambient hint (update ready) last. */}
          {(bgTasks.length > 0 || (eyesCount !== undefined && eyesCount > 0) || updatePending) && (
            <Box>
              {bgTasks.length > 0 && (
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
                />
              )}
              {eyesCount !== undefined && eyesCount > 0 && (
                <Box paddingLeft={bgTasks.length > 0 ? 2 : 1} paddingRight={1}>
                  <Text color={theme.accent} bold>
                    {`${eyesCount} eyes signal${eyesCount === 1 ? "" : "s"} · Run /eyes-improve to enhance GG Coder`}
                  </Text>
                </Box>
              )}
              {updatePending && (
                <Box
                  paddingLeft={
                    bgTasks.length > 0 || (eyesCount !== undefined && eyesCount > 0) ? 2 : 1
                  }
                  paddingRight={1}
                >
                  <Text color={theme.success} bold>
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
