import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, Text, Static, useStdout } from "ink";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import crypto, { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { playNotificationSound } from "../utils/sound.js";
import type { Message, Provider, ThinkingLevel, TextContent, ImageContent } from "@kenkaiiii/gg-ai";
import { extractImagePaths, type ImageAttachment } from "../utils/image.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { useAgentLoop, type ActivityPhase, type UserContent } from "./hooks/useAgentLoop.js";
import { UserMessage } from "./components/UserMessage.js";
import type { PasteInfo } from "./components/InputArea.js";
import { AssistantMessage } from "./components/AssistantMessage.js";
import { ToolExecution } from "./components/ToolExecution.js";
import { ToolGroupExecution } from "./components/ToolGroupExecution.js";
import { ServerToolExecution } from "./components/ServerToolExecution.js";
import { SubAgentPanel, type SubAgentInfo } from "./components/SubAgentPanel.js";
import { CompactionSpinner, CompactionDone } from "./components/CompactionNotice.js";
import type { SubAgentUpdate, SubAgentDetails } from "../tools/subagent.js";
import { StreamingArea } from "./components/StreamingArea.js";
import { ActivityIndicator } from "./components/ActivityIndicator.js";
import { InputArea } from "./components/InputArea.js";
import { Footer } from "./components/Footer.js";
import { Banner } from "./components/Banner.js";
import { PlanOverlay } from "./components/PlanOverlay.js";
import { ModelSelector } from "./components/ModelSelector.js";
import { TaskOverlay } from "./components/TaskOverlay.js";
import { SkillsOverlay } from "./components/SkillsOverlay.js";
import { BackgroundTasksBar } from "./components/BackgroundTasksBar.js";
import type { SlashCommandInfo } from "./components/SlashCommandMenu.js";
import type { ProcessManager, BackgroundProcess } from "../core/process-manager.js";
import { useTheme } from "./theme/theme.js";
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
import { SettingsManager } from "../core/settings-manager.js";
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
  stripDoneMarkers,
  type PlanStep,
} from "../utils/plan-steps.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import { getMCPServers } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import { trimFlushedItems, flushOnTurnText, flushOnTurnEnd } from "./live-item-flush.js";

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
  id: string;
}

interface ToolStartItem {
  kind: "tool_start";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  id: string;
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
  | QueuedItem
  | CompactingItem
  | CompactedItem
  | DurationItem
  | BannerItem
  | SubAgentGroupItem
  | ToolGroupItem
  | PlanTransitionItem
  | TombstoneItem;

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
  credentialsByProvider?: Record<string, { accessToken: string; accountId?: string }>;
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
}

// ── App Component ──────────────────────────────────────────

export function App(props: AppProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const { columns, resizeKey } = useTerminalSize();

  // Hoisted before terminal title hook so it can reference them
  const [lastUserMessage, setLastUserMessage] = useState("");
  const [planMode, setPlanMode] = useState(false);

  // Terminal title — updated later after agentLoop is created
  // (hoisted here so the hook is always called in the same order)
  const [titlePhase, setTitlePhase] = useState<ActivityPhase>("idle");
  const [titleRunning, setTitleRunning] = useState(false);
  const [titleToolNames, setTitleToolNames] = useState<string[]>([]);
  useTerminalTitle({
    phase: titlePhase,
    isRunning: titleRunning,
    userMessage: lastUserMessage,
    activeToolNames: titleToolNames,
    planMode,
  });

  // Items scrolled into Static (history).  For restored sessions, skip the
  // banner and add restored items via useEffect so Ink's <Static> treats them
  // as incremental additions (large initial arrays can race with Static's
  // internal useLayoutEffect and get dropped before being flushed).
  const isRestoredSession = props.initialHistory && props.initialHistory.length > 0;
  const [history, setHistory] = useState<CompletedItem[]>(
    isRestoredSession ? [] : [{ kind: "banner", id: "banner" }],
  );
  const restoredRef = useRef(false);
  useEffect(() => {
    if (isRestoredSession && !restoredRef.current) {
      restoredRef.current = true;
      setHistory((prev) => compactHistory([...prev, ...trimFlushedItems(props.initialHistory!)]));
    }
  }, [isRestoredSession, props.initialHistory]);
  // Items from the current/last turn — rendered in the live area so they stay visible
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  const [overlay, setOverlay] = useState<"model" | "tasks" | "skills" | "plan" | null>(null);
  const [taskCount, setTaskCount] = useState(() => getTaskCount(props.cwd));
  const [runAllTasks, setRunAllTasks] = useState(false);
  const runAllTasksRef = useRef(false);
  const startTaskRef = useRef<(title: string, prompt: string, taskId: string) => void>(() => {});
  const cwdRef = useRef(props.cwd);
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
  const messagesRef = useRef<Message[]>(props.messages);
  const [planAutoExpand, setPlanAutoExpand] = useState(false);
  const approvedPlanPathRef = useRef<string | undefined>(undefined);
  const planStepsRef = useRef<PlanStep[]>([]);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const nextIdRef = useRef(0);
  const sessionManagerRef = useRef(
    props.sessionsDir ? new SessionManager(props.sessionsDir) : null,
  );
  const sessionPathRef = useRef(props.sessionPath);
  const persistedIndexRef = useRef(messagesRef.current.length);
  /** Last actual API-reported input token count (from turn_end). */
  const lastActualTokensRef = useRef(0);
  /** Timestamp of last compaction — used for time-based cooldown. */
  const lastCompactionTimeRef = useRef(0);

  const getId = () => String(nextIdRef.current++);

  // Two-phase flush: items waiting to be moved to Static history after the
  // live area has been cleared and Ink has committed the smaller output.
  const pendingFlushRef = useRef<CompletedItem[]>([]);

  // Derive credentials for the current provider
  const currentCreds = props.credentialsByProvider?.[currentProvider];
  const activeApiKey = currentCreds?.accessToken ?? props.apiKey;
  const activeAccountId = currentCreds?.accountId ?? props.accountId;

  // Load git branch
  useEffect(() => {
    getGitBranch(props.cwd).then(setGitBranch);
  }, [props.cwd]);

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
          stdout?.write("\x1b[2J\x1b[3J\x1b[H");
          setPlanAutoExpand(true);
          setOverlay("plan");
          planOverlayPendingRef.current = false;
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
        lastActualTokensRef.current = 0; // Reset stale pre-compaction count
        return result;
      }

      if (!autoCompact) return messages;

      // Time-based cooldown: skip if compaction ran within the last 30 seconds
      if (Date.now() - lastCompactionTimeRef.current < 30_000) {
        log("INFO", "compaction", `Skipping compaction — cooldown active`);
        return messages;
      }

      const contextWindow = getContextWindow(currentModel);
      // Prefer actual API-reported tokens over char-based estimate
      const actualTokens =
        lastActualTokensRef.current > 0 ? lastActualTokensRef.current : undefined;
      if (shouldCompact(messages, contextWindow, threshold, actualTokens)) {
        const result = await compactConversation(messages);
        lastCompactionTimeRef.current = Date.now();
        lastActualTokensRef.current = 0; // Reset stale pre-compaction count
        return result;
      }
      return messages;
    },
    [currentModel, compactConversation],
  );

  // ── Background task bar state ───────────────────────────
  const [bgTasks, setBgTasks] = useState<BackgroundProcess[]>([]);
  const [taskBarFocused, setTaskBarFocused] = useState(false);
  const [taskBarExpanded, setTaskBarExpanded] = useState(false);
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);

  // Poll ProcessManager every 2s for running tasks
  useEffect(() => {
    if (!props.processManager) return;
    const pm = props.processManager;
    const poll = () => {
      const running = pm.list().filter((p) => p.exitCode === null);
      setBgTasks(running);
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [props.processManager]);

  // Auto-exit task panel when all tasks gone
  useEffect(() => {
    if (bgTasks.length === 0) {
      setTaskBarFocused(false);
      setTaskBarExpanded(false);
    }
    // Clamp selected index
    const maxIdx = Math.min(bgTasks.length, 5) - 1;
    if (selectedTaskIndex > maxIdx && maxIdx >= 0) {
      setSelectedTaskIndex(maxIdx);
    }
  }, [bgTasks.length, selectedTaskIndex]);

  const handleFocusTaskBar = useCallback(() => {
    if (bgTasks.length > 0) {
      setTaskBarFocused(true);
    }
  }, [bgTasks.length]);

  const handleTaskBarExit = useCallback(() => {
    setTaskBarFocused(false);
    setTaskBarExpanded(false);
  }, []);

  const handleTaskBarExpand = useCallback(() => {
    setTaskBarExpanded(true);
    setSelectedTaskIndex(0);
  }, []);

  const handleTaskBarCollapse = useCallback(() => {
    setTaskBarExpanded(false);
  }, []);

  const handleTaskKill = useCallback(
    (id: string) => {
      props.processManager?.stop(id);
    },
    [props.processManager],
  );

  const handleTaskNavigate = useCallback((index: number) => {
    setSelectedTaskIndex(index);
  }, []);

  // Resolve fresh OAuth credentials before each agent loop run.
  // Falls back to the static props when authStorage is not available.
  const resolveCredentials = useCallback(async () => {
    if (props.authStorage) {
      const creds = await props.authStorage.resolveCredentials(currentProvider);
      return { apiKey: creds.accessToken, accountId: creds.accountId };
    }
    return { apiKey: activeApiKey!, accountId: activeAccountId };
  }, [props.authStorage, currentProvider, activeApiKey, activeAccountId]);

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
      baseUrl: props.baseUrl,
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
      }, [persistNewMessages, planMode, props.cwd, props.skills]),
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
        setLiveItems((prev) => {
          const flushed = flushOnTurnText(prev);
          if (flushed.length > 0) {
            setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
          }
          const displayText = planStepsRef.current.length > 0 ? stripDoneMarkers(text) : text;
          return [{ kind: "assistant", text: displayText, thinking, thinkingMs, id: getId() }];
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
              setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
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
                setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
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
                setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
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
            setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
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
            setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
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
          // Track actual token count for compaction decisions
          lastActualTokensRef.current =
            usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          // For tool-only turns (no text), flush completed items to Static so
          // liveItems doesn't grow unbounded across consecutive tool-only turns.
          setLiveItems((prev) => {
            const { flushed, remaining } = flushOnTurnEnd(prev, stopReason);
            if (flushed.length > 0) {
              setHistory((h) => compactHistory([...h, ...trimFlushedItems(flushed)]));
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
          if (prev.length > 0) {
            pendingFlushRef.current = prev;
          }
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
      }, []),
      onAborted: useCallback(() => {
        log("WARN", "agent", "Agent run aborted by user");
        setRunAllTasks(false);
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
          if (prev.length > 0) {
            setHistory((h) => compactHistory([...h, ...trimFlushedItems(prev)]));
          }
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
  });

  // Sync terminal title with agent loop state
  const activeToolNamesKey = agentLoop.activeToolCalls.map((tc) => tc.name).join(",");
  useEffect(() => {
    setTitlePhase(agentLoop.activityPhase);
    setTitleRunning(agentLoop.isRunning);
    setTitleToolNames(agentLoop.activeToolCalls.map((tc) => tc.name));
  }, [agentLoop.activityPhase, agentLoop.isRunning, activeToolNamesKey]);

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

      // Handle /clear — reset session and clear terminal
      if (trimmed === "/clear") {
        // Clear terminal screen + scrollback — needed because Ink's <Static>
        // writes directly to stdout and can't be removed by clearing React state
        stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        setHistory([{ kind: "banner", id: "banner" }]);
        setLiveItems([]);
        setDoneStatus(null);
        approvedPlanPathRef.current = undefined;
        planStepsRef.current = [];
        setPlanSteps([]);
        // Rebuild system prompt without the approved plan
        void (async () => {
          const newPrompt = await buildSystemPrompt(props.cwd, props.skills, planMode, undefined);
          messagesRef.current = [{ role: "system" as const, content: newPrompt }];
        })();
        agentLoop.reset();
        setLiveItems([{ kind: "info", text: "Session cleared.", id: getId() }]);
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

      // Handle /plans — open plan pane
      if (trimmed === "/plans") {
        stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        setPlanAutoExpand(false);
        setOverlay("plan");
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
              setHistory((h) => compactHistory([...h, ...trimFlushedItems(prev)]));
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

      // Move any remaining live items into history (Static) before starting new turn
      setLiveItems((prev) => {
        if (prev.length > 0) {
          setHistory((h) => compactHistory([...h, ...trimFlushedItems(prev)]));
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

  const handleAbort = useCallback(() => {
    if (agentLoop.isRunning) {
      agentLoop.clearQueue();
      agentLoop.abort();
    } else {
      process.exit(0);
    }
  }, [agentLoop]);

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

      // Reconnect MCP servers when provider changes
      setCurrentProvider((prevProvider) => {
        if (newProvider !== prevProvider && props.mcpManager) {
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
            newProvider as "anthropic" | "openai" | "glm" | "moonshot",
          );
          await sm.set("defaultModel", newModelId);
        });
      }
    },
    [props.settingsFile, props.mcpManager, props.credentialsByProvider, props.authStorage],
  );

  // All available slash commands for the command palette
  const allCommands = useMemo<SlashCommandInfo[]>(
    () => [
      { name: "model", aliases: ["m"], description: "Switch model" },
      { name: "compact", aliases: ["c"], description: "Compact conversation" },
      { name: "clear", aliases: [], description: "Clear session and terminal" },
      { name: "quit", aliases: ["q", "exit"], description: "Exit the agent" },
      { name: "plan", aliases: [], description: "Toggle plan mode (on/off)" },
      { name: "plans", aliases: [], description: "Open plans pane" },
      ...PROMPT_COMMANDS.map((cmd) => ({
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
      })),
      ...customCommands.map((cmd) => ({
        name: cmd.name,
        aliases: [] as string[],
        description: cmd.description,
      })),
    ],
    [customCommands],
  );

  const renderItem = (item: CompletedItem) => {
    switch (item.kind) {
      case "tombstone":
        return null;
      case "banner":
        return (
          <Banner
            key={item.id}
            version={props.version}
            model={props.model}
            provider={props.provider}
            cwd={props.cwd}
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
          />
        );
      case "tool_start":
        return <ToolExecution key={item.id} status="running" name={item.name} args={item.args} />;
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
      case "plan_transition":
        return (
          <Box key={item.id} marginTop={1} flexShrink={1}>
            <Text color={theme.planPrimary} bold wrap="wrap">
              {item.active ? "⊞ " : "⊟ "}
              {item.text}
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
      // Reset to a fresh session before sending the task
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

      // Inject completion instruction so the agent marks the task done
      const shortId = taskId.slice(0, 8);
      const completionHint =
        `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
        `tasks({ action: "done", id: "${shortId}" })`;
      const fullPrompt = prompt + completionHint;

      // Show the short title in the TUI, but send the full prompt to the agent
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
          // Stop run-all if a task errors
          setRunAllTasks(false);
        }
      })();
    },
    [props.cwd, stdout, agentLoop, currentProvider, currentModel],
  );

  // Keep refs in sync for access from stale closures (onDone)
  startTaskRef.current = startTask;
  useEffect(() => {
    runAllTasksRef.current = runAllTasks;
  }, [runAllTasks]);

  const isTaskView = overlay === "tasks";
  const isSkillsView = overlay === "skills";
  const isPlanView = overlay === "plan";
  const isOverlayView = isTaskView || isSkillsView || isPlanView;

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
            stdout?.write("\x1b[2J\x1b[3J\x1b[H");
            setTaskCount(getTaskCount(props.cwd));
            setStaticKey((k) => k + 1);
            setOverlay(null);
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
      ) : isSkillsView ? (
        <SkillsOverlay
          cwd={props.cwd}
          onClose={() => {
            stdout?.write("\x1b[2J\x1b[3J\x1b[H");
            setStaticKey((k) => k + 1);
            setOverlay(null);
          }}
        />
      ) : isPlanView ? (
        <PlanOverlay
          cwd={props.cwd}
          autoExpandNewest={planAutoExpand}
          onClose={() => {
            stdout?.write("\x1b[2J\x1b[3J\x1b[H");
            setStaticKey((k) => k + 1);
            setPlanAutoExpand(false);
            setOverlay(null);
          }}
          onApprove={(planPath) => {
            // Store approved plan path — will be injected into the new system prompt
            approvedPlanPathRef.current = planPath;

            // Extract plan steps for progress tracking
            void import("node:fs/promises").then(({ readFile }) =>
              readFile(planPath, "utf-8").then((content) => {
                const steps = extractPlanSteps(content);
                planStepsRef.current = steps;
                setPlanSteps(steps);
              }),
            );

            // Clear session for a fresh context focused on the plan
            stdout?.write("\x1b[2J\x1b[3J\x1b[H");
            setHistory([{ kind: "banner", id: "banner" }]);
            setLiveItems([]);
            setStaticKey((k) => k + 1);
            setPlanAutoExpand(false);
            setOverlay(null);

            // Rebuild system prompt with the approved plan, then reset the session
            void (async () => {
              const newPrompt = await buildSystemPrompt(props.cwd, props.skills, false, planPath);
              messagesRef.current = [{ role: "system" as const, content: newPrompt }];
              agentLoop.reset();
              persistedIndexRef.current = messagesRef.current.length;

              // Create a new session file
              const sm = sessionManagerRef.current;
              if (sm) {
                const s = await sm.create(props.cwd, currentProvider, currentModel);
                sessionPathRef.current = s.path;
              }

              // Start implementation with a clean context
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
            })();
          }}
          onReject={(planPath, feedback) => {
            stdout?.write("\x1b[2J\x1b[3J\x1b[H");
            setStaticKey((k) => k + 1);
            setPlanAutoExpand(false);
            setOverlay(null);
            setDoneStatus(null);
            // Send rejection + feedback to the agent
            const msg =
              `The plan at ${planPath} was rejected.\n\nFeedback: ${feedback}\n\n` +
              `Please revise the plan based on this feedback.`;
            setLiveItems((prev) => [
              ...prev,
              { kind: "info", text: `Plan rejected — "${feedback}"`, id: getId() },
            ]);
            void agentLoop.run(msg);
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
                thinkingMs={agentLoop.thinkingMs}
                isThinking={agentLoop.isThinking}
                tokenEstimate={agentLoop.streamedTokenEstimate}
                userMessage={lastUserMessage}
                activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
                planMode={planMode}
                retryInfo={agentLoop.retryInfo}
                planDone={planSteps.filter((s) => s.completed).length}
                planTotal={planSteps.length}
              />
            </Box>
          ) : (
            doneStatus && (
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
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setOverlay("tasks");
            }}
            onToggleSkills={() => {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setOverlay("skills");
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
          />
          {overlay === "model" ? (
            <ModelSelector
              onSelect={handleModelSelect}
              onCancel={() => setOverlay(null)}
              loggedInProviders={props.loggedInProviders ?? [currentProvider]}
              currentModel={currentModel}
              currentProvider={currentProvider}
            />
          ) : (
            <Footer
              model={currentModel}
              tokensIn={agentLoop.contextUsed}
              cwd={props.cwd}
              gitBranch={gitBranch}
              thinkingEnabled={thinkingEnabled}
              planMode={planMode}
            />
          )}
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
        </>
      )}
    </Box>
  );
}
