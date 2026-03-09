import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Box, Text, Static, useStdout } from "ink";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import crypto, { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { playNotificationSound } from "../utils/sound.js";
import type {
  Message,
  Provider,
  ServerToolDefinition,
  ThinkingLevel,
  TextContent,
  ImageContent,
} from "@kenkaiiii/gg-ai";
import { extractImagePaths, type ImageAttachment } from "../utils/image.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { useAgentLoop, type ActivityPhase } from "./hooks/useAgentLoop.js";
import { UserMessage } from "./components/UserMessage.js";
import { AssistantMessage } from "./components/AssistantMessage.js";
import { ToolExecution } from "./components/ToolExecution.js";
import { ServerToolExecution } from "./components/ServerToolExecution.js";
import { SubAgentPanel, type SubAgentInfo } from "./components/SubAgentPanel.js";
import { CompactionSpinner, CompactionDone } from "./components/CompactionNotice.js";
import type { SubAgentUpdate, SubAgentDetails } from "../tools/subagent.js";
import { StreamingArea } from "./components/StreamingArea.js";
import { ActivityIndicator } from "./components/ActivityIndicator.js";
import { InputArea } from "./components/InputArea.js";
import { Footer } from "./components/Footer.js";
import { Banner } from "./components/Banner.js";
import { ModelSelector } from "./components/ModelSelector.js";
import { TaskOverlay } from "./components/TaskOverlay.js";
import { BackgroundTasksBar } from "./components/BackgroundTasksBar.js";
import type { SlashCommandInfo } from "./components/SlashCommandMenu.js";
import type { ProcessManager, BackgroundProcess } from "../core/process-manager.js";
import { useTheme } from "./theme/theme.js";
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
import { pruneHistory, flushOnTurnText, flushOnTurnEnd } from "./live-item-flush.js";

// ── Completed Item Types ───────────────────────────────────

interface UserItem {
  kind: "user";
  text: string;
  imageCount?: number;
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
  id: string;
}

interface ServerToolDoneItem {
  kind: "server_tool_done";
  name: string;
  input: unknown;
  resultType: string;
  data: unknown;
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
  | CompactingItem
  | CompactedItem
  | DurationItem
  | BannerItem
  | SubAgentGroupItem;

// pruneHistory, flushOnTurnText, flushOnTurnEnd, MAX_HISTORY_ITEMS
// are imported from ./live-item-flush.ts

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
  serverTools?: ServerToolDefinition[];
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
}

// ── App Component ──────────────────────────────────────────

export function App(props: AppProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const { resizeKey } = useTerminalSize();

  // Terminal title — updated later after agentLoop is created
  // (hoisted here so the hook is always called in the same order)
  const [titlePhase, setTitlePhase] = useState<ActivityPhase>("idle");
  const [titleRunning, setTitleRunning] = useState(false);
  useTerminalTitle(titlePhase, titleRunning);

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
      setHistory((prev) => pruneHistory([...prev, ...props.initialHistory!]));
    }
  }, [isRestoredSession, props.initialHistory]);
  // Items from the current/last turn — rendered in the live area so they stay visible
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  const [overlay, setOverlay] = useState<"model" | "tasks" | null>(null);
  const [taskCount, setTaskCount] = useState(() => getTaskCount(props.cwd));
  const [runAllTasks, setRunAllTasks] = useState(false);
  const runAllTasksRef = useRef(false);
  const startTaskRef = useRef<(title: string, prompt: string, taskId: string) => void>(() => {});
  const cwdRef = useRef(props.cwd);
  const [staticKey, setStaticKey] = useState(0);
  const [lastUserMessage, setLastUserMessage] = useState("");
  const [doneStatus, setDoneStatus] = useState<{
    durationMs: number;
    toolsUsed: string[];
    verb: string;
  } | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(props.model);
  const [currentProvider, setCurrentProvider] = useState(props.provider);
  const [thinkingEnabled, setThinkingEnabled] = useState(!!props.thinking);
  const messagesRef = useRef<Message[]>(props.messages);
  const nextIdRef = useRef(0);
  const sessionManagerRef = useRef(
    props.sessionsDir ? new SessionManager(props.sessionsDir) : null,
  );
  const sessionPathRef = useRef(props.sessionPath);
  const persistedIndexRef = useRef(messagesRef.current.length);

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
        const result = await compact(messages, {
          provider: currentProvider,
          model: currentModel,
          apiKey: activeApiKey,
          contextWindow,
          signal: undefined,
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
   */
  const transformContext = useCallback(
    async (messages: Message[]): Promise<Message[]> => {
      const settings = settingsRef.current;
      const autoCompact = settings?.get("autoCompact") ?? true;
      const threshold = settings?.get("compactThreshold") ?? 0.8;

      if (!autoCompact) return messages;

      const contextWindow = getContextWindow(currentModel);
      if (shouldCompact(messages, contextWindow, threshold)) {
        return compactConversation(messages);
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

  const agentLoop = useAgentLoop(
    messagesRef,
    {
      provider: currentProvider,
      model: currentModel,
      tools: props.tools,
      serverTools: props.serverTools,
      maxTokens: props.maxTokens,
      thinking: thinkingEnabled ? (props.thinking ?? "medium") : undefined,
      apiKey: activeApiKey,
      baseUrl: props.baseUrl,
      accountId: activeAccountId,
      transformContext,
    },
    {
      onComplete: useCallback(() => {
        persistNewMessages();
      }, [persistNewMessages]),
      onTurnText: useCallback((text: string, thinking: string, thinkingMs: number) => {
        // Flush all completed items from the previous turn to Static history.
        // This keeps liveItems bounded per-turn, preventing Ink's live area from
        // growing unbounded, which makes Ink's live-area re-renders expensive.
        setLiveItems((prev) => {
          const flushed = flushOnTurnText(prev);
          if (flushed.length > 0) {
            setHistory((h) => pruneHistory([...h, ...flushed]));
          }
          return [{ kind: "assistant", text, thinking, thinkingMs, id: getId() }];
        });
      }, []),
      onToolStart: useCallback(
        (toolCallId: string, name: string, args: Record<string, unknown>) => {
          log("INFO", "tool", `Tool call started: ${name}`, { id: toolCallId });
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
              return next;
            });
          } else {
            setLiveItems((prev) => {
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
                  id: startItem.id,
                };
                const next = [...prev];
                next[startIdx] = doneItem;
                return next;
              }
              // Fallback: just append
              return [
                ...prev,
                { kind: "tool_done", name, args: {}, result, isError, durationMs, id: getId() },
              ];
            });
          }
        },
        [],
      ),
      onServerToolCall: useCallback((id: string, name: string, input: unknown) => {
        log("INFO", "server_tool", `Server tool call: ${name}`, { id });
        setLiveItems((prev) => [
          ...prev,
          { kind: "server_tool_start", serverToolCallId: id, name, input, id: getId() },
        ]);
      }, []),
      onServerToolResult: useCallback((toolUseId: string, resultType: string, data: unknown) => {
        log("INFO", "server_tool", `Server tool result`, { toolUseId, resultType });
        setLiveItems((prev) => {
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
              id: startItem.id,
            };
            const next = [...prev];
            next[startIdx] = doneItem;
            return next;
          }
          return [
            ...prev,
            { kind: "server_tool_done", name: "unknown", input: {}, resultType, data, id: getId() },
          ];
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
          // For tool-only turns (no text), flush completed items to Static so
          // liveItems doesn't grow unbounded across consecutive tool-only turns.
          setLiveItems((prev) => {
            const { flushed, remaining } = flushOnTurnEnd(prev, stopReason);
            if (flushed.length > 0) {
              setHistory((h) => pruneHistory([...h, ...flushed]));
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
        setLiveItems((prev) => {
          const next = prev.map((item) =>
            item.kind === "subagent_group" ? { ...item, aborted: true } : item,
          );
          return [...next, { kind: "info", text: "Request was stopped.", id: getId() }];
        });
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
      setHistory((h) => pruneHistory([...h, ...items]));
    }
  });

  // Sync terminal title with agent loop state
  useEffect(() => {
    setTitlePhase(agentLoop.activityPhase);
    setTitleRunning(agentLoop.isRunning);
  }, [agentLoop.activityPhase, agentLoop.isRunning]);

  // Animated thinking border
  const [thinkingBorderFrame, setThinkingBorderFrame] = useState(0);
  useEffect(() => {
    if (agentLoop.activityPhase !== "thinking") return;
    const timer = setInterval(() => {
      setThinkingBorderFrame((f) => (f + 1) % THINKING_BORDER_COLORS.length);
    }, 1000);
    return () => clearInterval(timer);
  }, [agentLoop.activityPhase]);

  // Success flash on turn completion
  const [doneFlash, setDoneFlash] = useState(false);
  useEffect(() => {
    if (doneStatus) {
      setDoneFlash(true);
      const timer = setTimeout(() => setDoneFlash(false), 600);
      return () => clearTimeout(timer);
    }
  }, [doneStatus]);

  const handleSubmit = useCallback(
    async (input: string, inputImages: ImageAttachment[] = []) => {
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
        messagesRef.current = messagesRef.current.slice(0, 1); // keep system prompt
        agentLoop.reset();
        setLiveItems([{ kind: "info", text: "Session cleared.", id: getId() }]);
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
              setHistory((h) => pruneHistory([...h, ...prev]));
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

      // Move any remaining live items into history (Static) before starting new turn
      setLiveItems((prev) => {
        if (prev.length > 0) {
          setHistory((h) => pruneHistory([...h, ...prev]));
        }
        return [];
      });

      // Build display text — strip image paths, show badges instead
      const hasImages = inputImages.length > 0;
      let displayText = input;
      if (hasImages) {
        const { cleanText } = await extractImagePaths(input, props.cwd);
        displayText = cleanText;
      }
      const userItem: UserItem = {
        kind: "user",
        text: displayText,
        imageCount: hasImages ? inputImages.length : undefined,
        id: getId(),
      };
      setLastUserMessage(input);
      setDoneStatus(null);
      setLiveItems([userItem]);

      // Build user content — plain string or content array with images
      let userContent: string | (TextContent | ImageContent)[];
      if (hasImages) {
        const parts: (TextContent | ImageContent)[] = [];
        if (trimmed) {
          parts.push({ type: "text", text: trimmed });
        }
        for (const img of inputImages) {
          parts.push({ type: "image", mediaType: img.mediaType, data: img.data });
        }
        userContent = parts;
      } else {
        userContent = input;
      }

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
      setCurrentProvider(newProvider);
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
          await sm.set("defaultProvider", newProvider);
          await sm.set("defaultModel", newModelId);
        });
      }
    },
    [props.settingsFile],
  );

  // All available slash commands for the command palette
  const allCommands = useMemo<SlashCommandInfo[]>(
    () => [
      { name: "model", aliases: ["m"], description: "Switch model" },
      { name: "compact", aliases: ["c"], description: "Compact conversation" },
      { name: "clear", aliases: [], description: "Clear session and terminal" },
      { name: "quit", aliases: ["q", "exit"], description: "Exit the agent" },
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
        return <UserMessage key={item.id} text={item.text} imageCount={item.imageCount} />;
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
          />
        );
      case "server_tool_start":
        return (
          <ServerToolExecution key={item.id} status="running" name={item.name} input={item.input} />
        );
      case "server_tool_done":
        return (
          <ServerToolExecution
            key={item.id}
            status="done"
            name={item.name}
            input={item.input}
            resultType={item.resultType}
            data={item.data}
          />
        );
      case "error":
        return (
          <Box key={item.id} marginTop={1}>
            <Text color={theme.error}>{"✗ "}</Text>
            <Text color={theme.error}>{item.message}</Text>
          </Box>
        );
      case "info":
        return (
          <Box key={item.id} marginTop={1}>
            <Text color={theme.textDim}>{item.text}</Text>
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

  return (
    <Box flexDirection="column">
      {/* History — scrolled up, managed by Ink Static. */}
      <Static
        key={`${resizeKey}-${staticKey}`}
        items={isTaskView ? [] : history}
        style={{ width: "100%" }}
      >
        {(item) => renderItem(item)}
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
            />
          </Box>

          {/* Pinned status line */}
          {agentLoop.isRunning && agentLoop.activityPhase !== "idle" ? (
            <Box
              marginTop={1}
              borderStyle={agentLoop.activityPhase === "thinking" ? "round" : undefined}
              borderColor={
                agentLoop.activityPhase === "thinking"
                  ? THINKING_BORDER_COLORS[thinkingBorderFrame]
                  : undefined
              }
              paddingLeft={agentLoop.activityPhase === "thinking" ? 1 : 0}
              paddingRight={agentLoop.activityPhase === "thinking" ? 1 : 0}
            >
              <ActivityIndicator
                phase={agentLoop.activityPhase}
                elapsedMs={agentLoop.elapsedMs}
                thinkingMs={agentLoop.thinkingMs}
                isThinking={agentLoop.isThinking}
                tokenEstimate={agentLoop.streamedTokenEstimate}
                userMessage={lastUserMessage}
                activeToolNames={agentLoop.activeToolCalls.map((tc) => tc.name)}
              />
            </Box>
          ) : (
            doneStatus && (
              <Box marginTop={1}>
                <Text color={doneFlash ? theme.success : theme.textDim}>
                  {"✻ "}
                  {doneStatus.verb} {formatDuration(doneStatus.durationMs)}
                </Text>
              </Box>
            )
          )}

          {/* Input + Footer */}
          <InputArea
            onSubmit={handleSubmit}
            onAbort={handleAbort}
            disabled={agentLoop.isRunning}
            isActive={!taskBarFocused}
            onDownAtEnd={handleFocusTaskBar}
            onShiftTab={handleToggleThinking}
            onToggleTasks={() => {
              stdout?.write("\x1b[2J\x1b[3J\x1b[H");
              setOverlay("tasks");
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
