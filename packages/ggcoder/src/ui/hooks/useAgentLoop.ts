import { useState, useRef, useCallback, useEffect } from "react";
import {
  agentLoop,
  type AgentEvent,
  type AgentTool,
  type AgentTurnTiming,
  type TransformContextOptions,
} from "@kenkaiiii/gg-agent";
import { ProviderError } from "@kenkaiiii/gg-ai";
import type {
  Message,
  Provider,
  ThinkingLevel,
  TextContent,
  ImageContent,
  VideoContent,
} from "@kenkaiiii/gg-ai";
import {
  buildReviewCoverageMessage,
  withReviewCoverageRequirements,
  type IdealReviewStats,
  type ReviewCoverageTracker,
} from "../../core/ideal-review.js";
import type { LspManager } from "../../core/lsp/manager.js";
import {
  detectTextRepetition,
  ToolCallProgressTracker,
  type LoopBreakStats,
} from "../../core/loop-breaker.js";
import { getClaudeCliUserAgent } from "../../core/claude-code-version.js";
import { resolveSessionTurnToolResultCharLimit } from "../../core/agent-session.js";
import { kimiCodingHeaders, isKimiCodingEndpoint } from "../../core/oauth/kimi.js";
import { log } from "../../core/logger.js";
import { wrapSteeringContent } from "../../core/steering.js";

/** Extract plain text from this run's user input — the verbatim request that
 *  the re-grounding hook re-pins after a compaction. Captured at run start so
 *  it is never the lossy summary compaction leaves behind. */
function userContentText(content: string | (TextContent | ImageContent | VideoContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => "text" in c && typeof c.text === "string")
    .map((c) => c.text)
    .join(" ");
}

/** Rough token estimate from message content (~4 chars per token). */
function estimateTokens(msgs: Message[]): number {
  let chars = 0;
  for (const msg of msgs) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") chars += block.text.length;
        if ("content" in block && typeof block.content === "string") chars += block.content.length;
        if ("args" in block && block.args) chars += JSON.stringify(block.args).length;
        if ("input" in block && block.input) chars += JSON.stringify(block.input).length;
      }
    }
  }
  return Math.round(chars / 4);
}

/**
 * Merge multiple UserContent items into a single one.
 * Text-only items are joined with newlines. Mixed content (text + images)
 * is flattened into a content array preserving all parts.
 */
function mergeUserContent(items: UserContent[]): UserContent {
  if (items.length === 1) return items[0];

  const hasArrayContent = items.some((c) => Array.isArray(c));
  if (!hasArrayContent) {
    // All items are strings — join with newlines
    return (items as string[]).join("\n");
  }

  // Flatten into a single content array
  const parts: (TextContent | ImageContent | VideoContent)[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
    } else {
      parts.push(...item);
    }
  }
  return parts;
}

/** Extract the plain-text portion of a UserContent value (drops images). */
function textFromUserContent(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function shouldRetainThinkingDelta(): boolean {
  return false;
}

function withLspReviewEvidence(
  message: Message,
  files: readonly string[],
  lspManager: LspManager | undefined,
): Message {
  const lowConfidence: string[] = [];
  const missing: string[] = [];
  for (const filePath of files) {
    const outcome = lspManager?.getLatestOutcome(filePath);
    if (outcome?.kind === "low_confidence") lowConfidence.push(filePath);
    else if (outcome?.kind !== "clean" && outcome?.kind !== "diagnostics") missing.push(filePath);
  }
  if (lowConfidence.length === 0 && missing.length === 0) return message;
  const notes = [
    ...(lowConfidence.length > 0
      ? [`Diagnostics are low confidence while indexing: ${lowConfidence.join(", ")}.`]
      : []),
    ...(missing.length > 0
      ? [`Diagnostics evidence is unavailable or missing: ${missing.join(", ")}.`]
      : []),
    "Do not describe those files as compiler-clean without other evidence.",
  ];
  return { role: "user", content: `${String(message.content)}\n\n${notes.join(" ")}` };
}

export interface ActiveToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  startTime: number;
  updates: unknown[];
}

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  tools: AgentTool[];
  webSearch?: boolean;
  maxTokens: number;
  /** Whether the active model supports native image input. */
  supportsImages?: boolean;
  /** Whether the active model supports native video input. */
  supportsVideo?: boolean;
  thinking?: ThinkingLevel;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  projectId?: string;
  /** Resolve fresh credentials before each run (e.g. OAuth token refresh).
   *  When `forceRefresh` is true, bypass cache and fetch a new token (used on 401 retry). */
  resolveCredentials?: (opts?: {
    forceRefresh?: boolean;
  }) => Promise<{ apiKey: string; accountId?: string; projectId?: string }>;
  transformContext?: (
    messages: Message[],
    options: TransformContextOptions,
  ) => Message[] | Promise<Message[]>;
  getIdealReviewMessage?: (stats: IdealReviewStats, touchedFiles: string[]) => Message | null;
  /** Harness-owned successful read/mutation evidence for fail-closed Ideal review. */
  reviewCoverageTracker?: ReviewCoverageTracker;
  /** Detailed diagnostics evidence shown only to the internal review turn. */
  lspManager?: LspManager;
  /** Polled mid-loop when the agent appears stuck (repeated failures / calls /
   *  edits, or degenerate output). Return a user message to break the loop. */
  getLoopBreakMessage?: (stats: LoopBreakStats) => Message | null;
  /** Polled mid-loop after a compaction reduced the context. Return a user
   *  message that re-pins the original request. */
  getRegroundingMessage?: (originalRequest: string) => Message | null;
}

export type ActivityPhase = "waiting" | "thinking" | "generating" | "tools" | "retrying" | "idle";

export interface RetryInfo {
  reason:
    | "overloaded"
    | "rate_limit"
    | "provider_error"
    | "empty_response"
    | "stream_stall"
    | "overflow_compact"
    | "tool_argument_glitch";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export type UserContent = string | (TextContent | ImageContent | VideoContent)[];

export interface StreamSnapshot {
  text: string;
  thinking: string;
  thinkingMs: number;
}

export interface UseAgentLoopReturn {
  run: (userContent: UserContent) => Promise<void>;
  abort: () => void;
  reset: () => void;
  /** Queue a message to be processed after the current run completes.
   *  `text` is the original typed text, retained so it can be restored to the
   *  composer if the run is interrupted before the queue drains. */
  queueMessage: (content: UserContent, text?: string) => void;
  /** Number of messages currently waiting in the queue. */
  queuedCount: number;
  /** Clear all queued messages. */
  clearQueue: () => void;
  /** Pop every queued message, clear the queue, and return the combined
   *  original text (joined with blank lines). Empty string when nothing was
   *  queued. Used to restore unsent input to the composer on interrupt. */
  drainQueuedText: () => string;
  isRunning: boolean;
  streamingText: string;
  streamingThinking: string;
  activeToolCalls: ActiveToolCall[];
  currentTurn: number;
  totalTokens: { input: number; output: number };
  /** Latest turn's input tokens — reflects current context window usage */
  contextUsed: number;
  activityPhase: ActivityPhase;
  retryInfo: RetryInfo | null;
  /** Non-null when the agent stopped due to an unrecoverable stream error (e.g. stall retries exhausted). */
  stallError: string | null;
  elapsedMs: number;
  thinkingMs: number;
  isThinking: boolean;
  streamedTokenEstimate: number;
  /** Raw character count ref — read directly by ActivityIndicator for smooth animation */
  charCountRef: React.RefObject<number>;
  /** Accumulated real tokens from completed turns */
  realTokensAccumRef: React.RefObject<number>;
  /** Run start timestamp ref — for smooth elapsed time computation */
  runStartRef: React.RefObject<number>;
  linesChanged: { added: number; removed: number };
}

export function useAgentLoop(
  messages: React.MutableRefObject<Message[]>,
  options: AgentLoopOptions,
  callbacks?: {
    onComplete?: (newMessages: Message[]) => void;
    onTurnText?: (text: string, thinking: string, thinkingMs: number) => void;
    onToolStart?: (
      toolCallId: string,
      name: string,
      args: Record<string, unknown>,
      stream: StreamSnapshot,
    ) => void;
    onToolUpdate?: (toolCallId: string, update: unknown) => void;
    onToolEnd?: (
      toolCallId: string,
      name: string,
      result: string,
      isError: boolean,
      durationMs: number,
      details?: unknown,
      // Args are included so consumers don't have to look them up via
      // `activeToolCalls` state — by the time onToolEnd fires, that state
      // may be stale (the call has already been pulled from the active
      // list, or React hasn't flushed the update yet). Pass through so
      // tool-result rendering always has the original args available.
      args?: Record<string, unknown>,
    ) => void;
    onServerToolCall?: (id: string, name: string, input: unknown, stream: StreamSnapshot) => void;
    onServerToolResult?: (toolUseId: string, resultType: string, data: unknown) => void;
    onTurnEnd?: (
      turn: number,
      stopReason: string,
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheRead?: number;
        cacheWrite?: number;
      },
      timing: AgentTurnTiming,
    ) => void;
    onDone?: (
      durationMs: number,
      toolsUsed: string[],
      runStats?: { counts: Record<string, number>; tokens: number },
    ) => void;
    onAborted?: () => void;
    /** Called when a queued message starts processing (after the previous run completes). */
    onQueuedStart?: (content: UserContent) => void;
    /** Called when the agent restarts a turn after a stall/overload retry.
     *  The UI should roll back any pending progressive flushes from the
     *  aborted attempt so the retry's regenerated text doesn't duplicate. */
    onRetry?: () => void;
    /** Polled when the agent would otherwise stop. Return a user message to
     *  inject and continue the loop (e.g. "continue with the next plan step"). */
    getFollowUpMessages?: () => Message[] | null;
  },
): UseAgentLoopReturn {
  const onComplete = callbacks?.onComplete;
  const onTurnText = callbacks?.onTurnText;
  const onToolStart = callbacks?.onToolStart;
  const onToolUpdate = callbacks?.onToolUpdate;
  const onToolEnd = callbacks?.onToolEnd;
  const onServerToolCall = callbacks?.onServerToolCall;
  const onServerToolResult = callbacks?.onServerToolResult;
  const onTurnEnd = callbacks?.onTurnEnd;
  const onDone = callbacks?.onDone;
  const onAborted = callbacks?.onAborted;
  const onQueuedStart = callbacks?.onQueuedStart;
  const onRetry = callbacks?.onRetry;
  const getFollowUpMessages = callbacks?.getFollowUpMessages;
  const [isRunning, setIsRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const [contextUsed, setContextUsed] = useState(() => estimateTokens(messages.current));
  const [activityPhase, setActivityPhase] = useState<ActivityPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [thinkingMs, setThinkingMs] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const [streamedTokenEstimate, setStreamedTokenEstimate] = useState(0);
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
  const [stallError, setStallError] = useState<string | null>(null);
  const [linesChanged, setLinesChanged] = useState({ added: 0, removed: 0 });

  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<{ content: UserContent; text: string }[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const activeToolCallsRef = useRef<ActiveToolCall[]>([]);
  const textVisibleRef = useRef("");
  const thinkingBufferRef = useRef("");
  const thinkingVisibleRef = useRef("");
  const runStartRef = useRef(0);
  const toolsUsedRef = useRef<Set<string>>(new Set());
  const toolCountsRef = useRef<Map<string, number>>(new Map());
  const idealReviewStatsRef = useRef<IdealReviewStats>({
    changedLines: 0,
    toolCalls: 0,
    toolFailures: 0,
    turns: 0,
    writeCalls: 0,
    editCalls: 0,
    bashCalls: 0,
  });
  const idealReviewPhaseRef = useRef<"idle" | "reviewing" | "complete">("idle");
  // ── Loop-breaker tracking ──
  const loopProgressTrackerRef = useRef(new ToolCallProgressTracker());
  const fileEditCountsRef = useRef<Map<string, number>>(new Map());
  const consecutiveFailuresRef = useRef(0);
  const repeatedNoProgressCallsRef = useRef(0);
  const loopBreakInjectedRef = useRef(false);
  // ── Re-grounding tracking ──
  const compactionOccurredRef = useRef(false);
  const regroundingInjectedRef = useRef(false);
  // Captured at run start, BEFORE any in-run compaction replaces the first
  // user message with a lossy summary. This is the verbatim ground truth the
  // re-grounding hook re-pins; reading it post-compaction would re-inject the
  // summary itself.
  const originalRequestRef = useRef("");
  const phaseRef = useRef<ActivityPhase>("idle");
  const thinkingStartRef = useRef<number | null>(null);
  const thinkingAccumRef = useRef(0);
  const charCountRef = useRef(0);
  const realTokensAccumRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneCalledRef = useRef(false);
  // Diagnostic: log when streamingThinking first becomes non-empty for a run,
  // so we can measure the React → Ink commit time on top of the flush throttle.
  const thinkingCommitLoggedRef = useRef(false);
  const textCommitLoggedRef = useRef(false);

  useEffect(() => {
    if (!thinkingCommitLoggedRef.current && streamingThinking) {
      thinkingCommitLoggedRef.current = true;
      log("INFO", "ui", "first_thinking_committed", {
        sinceRunStartMs: String(Date.now() - runStartRef.current),
        chars: String(streamingThinking.length),
      });
    }
    if (!streamingThinking) {
      thinkingCommitLoggedRef.current = false;
    }
  }, [streamingThinking]);

  useEffect(() => {
    if (!textCommitLoggedRef.current && streamingText) {
      textCommitLoggedRef.current = true;
      log("INFO", "ui", "first_text_committed", {
        sinceRunStartMs: String(Date.now() - runStartRef.current),
        chars: String(streamingText.length),
      });
    }
    if (!streamingText) {
      textCommitLoggedRef.current = false;
    }
  }, [streamingText]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    // Abort any running agent loop first — this kills in-flight subagent processes
    abortRef.current?.abort();
    setIsRunning(false);
    setCurrentTurn(0);
    setTotalTokens({ input: 0, output: 0 });
    setContextUsed(0);
    setStreamingText("");
    setStreamingThinking("");
    setActiveToolCalls([]);
    setActivityPhase("idle");
    setElapsedMs(0);
    setThinkingMs(0);
    setIsThinking(false);
    setStreamedTokenEstimate(0);
    setRetryInfo(null);
    setStallError(null);
    queueRef.current = [];
    setQueuedCount(0);
  }, []);

  const queueMessage = useCallback((content: UserContent, text?: string) => {
    queueRef.current.push({ content, text: text ?? textFromUserContent(content) });
    setQueuedCount(queueRef.current.length);
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedCount(0);
  }, []);

  const drainQueuedText = useCallback((): string => {
    if (queueRef.current.length === 0) return "";
    const text = queueRef.current
      .map((q) => q.text)
      .filter((t) => t.length > 0)
      .join("\n\n");
    queueRef.current = [];
    setQueuedCount(0);
    return text;
  }, []);

  const run = useCallback(
    async (userContent: UserContent) => {
      /** Run a single user message through the agent loop. Returns true if aborted. */
      const runSingle = async (
        content: UserContent,
        credentialOpts?: { forceRefresh?: boolean },
      ): Promise<boolean> => {
        const ac = new AbortController();
        abortRef.current = ac;
        let wasAborted = false;

        // Throttled streaming text flush — accumulate deltas in refs (zero-cost),
        // only call setState at 100ms intervals to avoid saturating the event
        // loop with React renders during fast token streaming. 100ms (10fps) is
        // imperceptible for prose but cuts streaming render CPU ~49% vs 16ms
        // (bench/RESULTS.md, bench B — the Markdown re-render dominates, so CPU
        // scales with flush count, not delta count). Worst case it adds 100ms
        // to the first visible token — noise next to seconds of provider TTFT.
        let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
        let streamTextDirty = false;
        let streamThinkingDirty = false;
        const STREAM_FLUSH_MS = 100;

        // ── Diagnostic timing markers (perceived-TTFB investigation) ──
        // Track the four points along the path: run start → first thinking
        // delta at the hook → first flush (state set) → first visible state.
        let firstThinkingArrivedMs = -1;
        let firstThinkingFlushedMs = -1;
        let firstTextArrivedMs = -1;
        let firstTextFlushedMs = -1;

        const flushStreamState = () => {
          streamFlushTimer = null;
          if (streamTextDirty) {
            setStreamingText(textVisibleRef.current);
            if (firstTextFlushedMs < 0 && firstTextArrivedMs >= 0) {
              firstTextFlushedMs = Date.now() - runStartRef.current;
              log("INFO", "ui", "first_text_flush", {
                arrivedMs: String(firstTextArrivedMs),
                flushedMs: String(firstTextFlushedMs),
                lagMs: String(firstTextFlushedMs - firstTextArrivedMs),
              });
            }
            streamTextDirty = false;
          }
          if (streamThinkingDirty) {
            setStreamingThinking(thinkingVisibleRef.current);
            if (firstThinkingFlushedMs < 0 && firstThinkingArrivedMs >= 0) {
              firstThinkingFlushedMs = Date.now() - runStartRef.current;
              log("INFO", "ui", "first_thinking_flush", {
                arrivedMs: String(firstThinkingArrivedMs),
                flushedMs: String(firstThinkingFlushedMs),
                lagMs: String(firstThinkingFlushedMs - firstThinkingArrivedMs),
                chars: String(thinkingVisibleRef.current.length),
              });
            }
            streamThinkingDirty = false;
          }
        };

        const scheduleStreamFlush = () => {
          if (streamFlushTimer === null) {
            streamFlushTimer = setTimeout(flushStreamState, STREAM_FLUSH_MS);
          }
        };

        // Reset state
        doneCalledRef.current = false;
        textVisibleRef.current = "";
        thinkingBufferRef.current = "";
        thinkingVisibleRef.current = "";
        runStartRef.current = Date.now();
        log("INFO", "ui", "run_start", {
          provider: options.provider,
          model: options.model,
          thinking: options.thinking ? "on" : "off",
          messages: String(messages.current.length),
        });
        toolsUsedRef.current = new Set();
        toolCountsRef.current = new Map();
        idealReviewStatsRef.current = {
          changedLines: 0,
          toolCalls: 0,
          toolFailures: 0,
          turns: 0,
          writeCalls: 0,
          editCalls: 0,
          bashCalls: 0,
        };
        idealReviewPhaseRef.current = "idle";
        options.reviewCoverageTracker?.reset();
        loopProgressTrackerRef.current.reset();
        fileEditCountsRef.current = new Map();
        consecutiveFailuresRef.current = 0;
        repeatedNoProgressCallsRef.current = 0;
        loopBreakInjectedRef.current = false;
        compactionOccurredRef.current = false;
        regroundingInjectedRef.current = false;
        charCountRef.current = 0;
        realTokensAccumRef.current = 0;
        thinkingAccumRef.current = 0;
        thinkingStartRef.current = null;
        phaseRef.current = "waiting";
        setStreamingText("");
        setStreamingThinking("");
        setActiveToolCalls([]);
        setActivityPhase("waiting");
        setElapsedMs(0);
        setThinkingMs(0);
        setIsThinking(false);
        setStreamedTokenEstimate(0);
        setStallError(null);
        setIsRunning(true);

        // Start elapsed timer (ticks every 1000ms — less frequent to reduce
        // Ink re-renders which cause live-area flickering and viewport snapping)
        if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
        const timerStart = Date.now();
        elapsedTimerRef.current = setInterval(() => {
          const now = Date.now();
          setElapsedMs(now - timerStart);
          // Update live thinking time if currently thinking
          if (thinkingStartRef.current !== null) {
            setThinkingMs(thinkingAccumRef.current + (now - thinkingStartRef.current));
          }
          // Update token estimate
          setStreamedTokenEstimate(
            realTokensAccumRef.current + Math.ceil(charCountRef.current / 4),
          );
        }, 1000);

        /** Freeze thinking time if currently in thinking phase */
        const freezeThinking = () => {
          if (thinkingStartRef.current !== null) {
            thinkingAccumRef.current += Date.now() - thinkingStartRef.current;
            thinkingStartRef.current = null;
            setThinkingMs(thinkingAccumRef.current);
            setIsThinking(false);
          }
        };

        // Push user message
        const userMsg: Message = { role: "user", content: content };
        messages.current.push(userMsg);
        const startIndex = messages.current.length;
        // Capture the verbatim request driving THIS run, before any in-run
        // compaction can replace it with a summary. This is the freshest
        // ground truth — the task actually being executed — not the first
        // message of a long session (which may itself already be a summary).
        originalRequestRef.current = userContentText(content);

        try {
          // Resolve fresh credentials (handles OAuth token refresh)
          let apiKey = options.apiKey;
          let accountId = options.accountId;
          let projectId = options.projectId;
          const credsStart = Date.now();
          if (options.resolveCredentials) {
            const creds = await options.resolveCredentials(credentialOpts);
            apiKey = creds.apiKey;
            accountId = creds.accountId;
            projectId = creds.projectId;
          }
          log("INFO", "ui", "creds_resolved", {
            ms: String(Date.now() - credsStart),
            sinceRunStartMs: String(Date.now() - runStartRef.current),
            resolved: options.resolveCredentials ? "yes" : "no",
          });

          const uaStart = Date.now();
          const userAgent =
            options.provider === "anthropic" ? await getClaudeCliUserAgent() : undefined;
          // Kimi For Coding gates the managed endpoint on coding-agent identity
          // headers; attach them only when the Kimi OAuth token is in use.
          const defaultHeaders =
            options.provider === "moonshot" && isKimiCodingEndpoint(options.baseUrl)
              ? kimiCodingHeaders()
              : undefined;
          if (options.provider === "anthropic") {
            log("INFO", "ui", "useragent_resolved", {
              ms: String(Date.now() - uaStart),
              sinceRunStartMs: String(Date.now() - runStartRef.current),
            });
          }

          log("INFO", "ui", "agent_loop_invoke", {
            sinceRunStartMs: String(Date.now() - runStartRef.current),
          });
          const generator = agentLoop(messages.current, {
            provider: options.provider,
            model: options.model,
            tools: options.tools,
            webSearch: options.webSearch,
            maxTokens: options.maxTokens,
            supportsImages: options.supportsImages,
            supportsVideo: options.supportsVideo,
            thinking: options.thinking,
            apiKey,
            baseUrl: options.baseUrl,
            accountId,
            projectId,
            // Aggregate per-turn budget across parallel tool results — same
            // fan-out guard the AgentSession applies (see agent-session.ts).
            maxTurnToolResultChars: resolveSessionTurnToolResultCharLimit(
              options.model,
              options.provider,
              accountId,
            ),
            signal: ac.signal,
            userAgent,
            defaultHeaders,
            // Wrap transformContext to flag when a compaction actually shrank
            // the context — the re-grounding hook keys off this.
            transformContext: options.transformContext
              ? async (msgs, opts) => {
                  const result = await options.transformContext!(msgs, opts);
                  if (result !== msgs && result.length < msgs.length) {
                    compactionOccurredRef.current = true;
                  }
                  return result;
                }
              : undefined,
            // Drain queued messages as steering — injected between tool calls
            // and before the agent would stop, so the LLM sees user guidance
            // within the same run instead of waiting for a new one. User
            // steering wins; then the loop-breaker; then post-compaction
            // re-grounding — all polled at the same mid-loop boundary.
            getSteeringMessages: () => {
              if (queueRef.current.length > 0) {
                const batch = queueRef.current.splice(0);
                setQueuedCount(0);
                const merged = mergeUserContent(batch.map((q) => q.content));
                // Show the user their verbatim message; send the framed version
                // so the model treats it as concurrent steering, not a fresh
                // request that supersedes the original task.
                onQueuedStart?.(merged);
                return [{ role: "user" as const, content: wrapSteeringContent(merged) }];
              }

              // Loop-breaker: at most once per run, when the agent looks stuck.
              if (!loopBreakInjectedRef.current && options.getLoopBreakMessage) {
                const loopBreakMessage = options.getLoopBreakMessage({
                  consecutiveFailures: consecutiveFailuresRef.current,
                  repeatedNoProgressCalls: repeatedNoProgressCallsRef.current,
                  textRepetitionDetected: detectTextRepetition(textVisibleRef.current),
                });
                if (loopBreakMessage) {
                  loopBreakInjectedRef.current = true;
                  return [loopBreakMessage];
                }
              }

              // Re-grounding: once per compaction event.
              if (
                !regroundingInjectedRef.current &&
                compactionOccurredRef.current &&
                options.getRegroundingMessage
              ) {
                const regroundingMessage = options.getRegroundingMessage(
                  originalRequestRef.current,
                );
                if (regroundingMessage) {
                  regroundingInjectedRef.current = true;
                  return [regroundingMessage];
                }
              }

              return null;
            },
            // Polled when the agent would otherwise stop — used to inject
            // "continue with the next plan step" when an approved plan still
            // has incomplete steps. See App.tsx for the implementation.
            getFollowUpMessages: async () => {
              const followUp = (await getFollowUpMessages?.()) ?? null;
              if (followUp && followUp.length > 0) return followUp;
              const coverageTracker = options.reviewCoverageTracker;
              if (idealReviewPhaseRef.current === "reviewing") {
                const coverage = coverageTracker?.evidence() ?? {
                  expected: [],
                  covered: [],
                  missing: [],
                };
                log("INFO", "ideal", "Ideal review coverage check", {
                  covered: coverage.covered,
                  missing: coverage.missing,
                });
                if (coverage.missing.length > 0) {
                  return [
                    withLspReviewEvidence(
                      buildReviewCoverageMessage(coverage.missing),
                      coverage.expected,
                      options.lspManager,
                    ),
                  ];
                }
                idealReviewPhaseRef.current = "complete";
                return null;
              }
              if (idealReviewPhaseRef.current === "complete" || !options.getIdealReviewMessage)
                return null;
              const idealReviewMessage = options.getIdealReviewMessage(
                { ...idealReviewStatsRef.current },
                [...fileEditCountsRef.current.keys()],
              );
              if (!idealReviewMessage) return null;
              coverageTracker?.start();
              idealReviewPhaseRef.current = "reviewing";
              const coverage = coverageTracker?.evidence() ?? {
                expected: [],
                covered: [],
                missing: [],
              };
              log("INFO", "ideal", "Ideal review coverage started", {
                expected: coverage.expected,
                missing: coverage.missing,
              });
              return [
                withLspReviewEvidence(
                  withReviewCoverageRequirements(idealReviewMessage, coverage.missing),
                  coverage.expected,
                  options.lspManager,
                ),
              ];
            },
            // clearToolUses disabled — causes model to output unsolicited context
            // summaries ("KEY CONTEXT TO REMEMBER") when it sees gaps from stripped
            // tool blocks. Normal client-side compaction handles context management.
          });

          log("INFO", "ui", "iter_start", {
            sinceRunStartMs: String(Date.now() - runStartRef.current),
          });
          for await (const event of generator as AsyncIterable<AgentEvent>) {
            switch (event.type) {
              case "text_delta":
                if (firstTextArrivedMs < 0) {
                  firstTextArrivedMs = Date.now() - runStartRef.current;
                  log("INFO", "ui", "first_text_arrived", {
                    sinceRunStartMs: String(firstTextArrivedMs),
                  });
                }
                textVisibleRef.current += event.text;
                charCountRef.current += event.text.length;
                streamTextDirty = true;
                scheduleStreamFlush();
                if (phaseRef.current !== "generating") {
                  freezeThinking();
                  if (phaseRef.current === "retrying") setRetryInfo(null);
                  phaseRef.current = "generating";
                  setActivityPhase("generating");
                }
                break;

              case "thinking_delta":
                if (!options.thinking) break;

                if (firstThinkingArrivedMs < 0) {
                  firstThinkingArrivedMs = Date.now() - runStartRef.current;
                  log("INFO", "ui", "first_thinking_arrived", {
                    sinceRunStartMs: String(firstThinkingArrivedMs),
                  });
                }
                if (shouldRetainThinkingDelta()) {
                  thinkingBufferRef.current += event.text;
                  thinkingVisibleRef.current += event.text;
                  streamThinkingDirty = true;
                  scheduleStreamFlush();
                }
                charCountRef.current += event.text.length;
                if (phaseRef.current !== "thinking") {
                  thinkingStartRef.current = Date.now();
                  setIsThinking(true);
                  if (phaseRef.current === "retrying") setRetryInfo(null);
                  phaseRef.current = "thinking";
                  setActivityPhase("thinking");
                }
                break;

              case "toolcall_delta":
                // Tool call args being streamed — tick the char counter so the
                // token estimate updates, and switch to "generating" phase so the
                // user sees progress instead of a frozen "waiting" spinner.
                charCountRef.current += event.chars;
                streamTextDirty = true;
                scheduleStreamFlush();
                if (phaseRef.current === "waiting" || phaseRef.current === "thinking") {
                  if (phaseRef.current === "thinking") freezeThinking();
                  phaseRef.current = "generating";
                  setActivityPhase("generating");
                }
                break;

              case "tool_call_start": {
                // Flush any pending throttled text BEFORE the tool call renders.
                // Without this, text accumulated in textVisibleRef since the last
                // 16ms flush won't appear in the UI until after the tool completes,
                // making the assistant's message look cut off.
                if (streamFlushTimer) {
                  clearTimeout(streamFlushTimer);
                  streamFlushTimer = null;
                }
                flushStreamState();

                freezeThinking();
                if (phaseRef.current !== "tools") {
                  phaseRef.current = "tools";
                  setActivityPhase("tools");
                }
                const newTc: ActiveToolCall = {
                  toolCallId: event.toolCallId,
                  name: event.name,
                  args: event.args,
                  startTime: Date.now(),
                  updates: [],
                };
                onToolStart?.(event.toolCallId, event.name, event.args, {
                  text: textVisibleRef.current,
                  thinking: thinkingBufferRef.current,
                  thinkingMs: thinkingAccumRef.current,
                });
                toolsUsedRef.current.add(event.name);
                toolCountsRef.current.set(
                  event.name,
                  (toolCountsRef.current.get(event.name) ?? 0) + 1,
                );
                activeToolCallsRef.current = [...activeToolCallsRef.current, newTc];
                setActiveToolCalls(activeToolCallsRef.current);
                break;
              }

              case "tool_call_update": {
                onToolUpdate?.(event.toolCallId, event.update);
                // Mutate the matching tool call in-place to avoid allocating
                // a new array + new objects on every update event. Over a 5h
                // session with thousands of tool calls this prevents significant
                // GC pressure from spread-copy churn.
                const target = activeToolCallsRef.current.find(
                  (tc) => tc.toolCallId === event.toolCallId,
                );
                if (target) {
                  if (target.updates.length >= 20) {
                    target.updates.shift();
                  }
                  target.updates.push(event.update);
                }
                // Spread once to create a new array reference for React state
                setActiveToolCalls([...activeToolCallsRef.current]);
                break;
              }

              case "tool_call_end": {
                const tc = activeToolCallsRef.current.find(
                  (t) => t.toolCallId === event.toolCallId,
                );
                const toolName = tc?.name ?? "unknown";
                const durationMs = tc ? Date.now() - tc.startTime : 0;
                onToolEnd?.(
                  event.toolCallId,
                  toolName,
                  event.result,
                  event.isError,
                  durationMs,
                  event.details,
                  tc?.args,
                );
                idealReviewStatsRef.current.toolCalls += 1;
                if (event.isError) idealReviewStatsRef.current.toolFailures += 1;
                if (toolName === "write") idealReviewStatsRef.current.writeCalls += 1;
                if (toolName === "edit") idealReviewStatsRef.current.editCalls += 1;
                if (toolName === "bash") idealReviewStatsRef.current.bashCalls += 1;
                // ── Loop-breaker signals ──
                if (event.isError) {
                  consecutiveFailuresRef.current += 1;
                } else {
                  consecutiveFailuresRef.current = 0;
                }
                repeatedNoProgressCallsRef.current = loopProgressTrackerRef.current.record(
                  toolName,
                  tc?.args,
                  event.result,
                  event.isError,
                );
                if (!event.isError && (toolName === "edit" || toolName === "write") && tc?.args) {
                  const filePath = (tc.args as { file_path?: unknown }).file_path;
                  if (typeof filePath === "string") {
                    const next = (fileEditCountsRef.current.get(filePath) ?? 0) + 1;
                    fileEditCountsRef.current.set(filePath, next);
                  }
                }
                // Track lines changed for edit tools
                if (toolName === "edit" && !event.isError) {
                  const diff =
                    (event.details as { diff?: string } | undefined)?.diff ?? event.result;
                  const addedLines = (diff.match(/^\+[^+]/gm) ?? []).length;
                  const removedLines = (diff.match(/^-[^-]/gm) ?? []).length;
                  if (addedLines > 0 || removedLines > 0) {
                    idealReviewStatsRef.current.changedLines += addedLines + removedLines;
                    setLinesChanged((prev) => ({
                      added: prev.added + addedLines,
                      removed: prev.removed + removedLines,
                    }));
                  }
                }
                activeToolCallsRef.current = activeToolCallsRef.current.filter(
                  (t) => t.toolCallId !== event.toolCallId,
                );
                setActiveToolCalls(activeToolCallsRef.current);
                break;
              }

              case "server_tool_call":
                flushStreamState();
                onServerToolCall?.(event.id, event.name, event.input, {
                  text: textVisibleRef.current,
                  thinking: thinkingBufferRef.current,
                  thinkingMs: thinkingAccumRef.current,
                });
                // A server tool (e.g. Anthropic's native web_search) does NOT
                // end the turn — the model keeps streaming text afterwards into
                // the SAME turn. onServerToolCall just pinned the pre-tool text
                // to scrollback, so the buffer must be reset here (mirroring a
                // turn boundary). Without this the post-tool text appends to the
                // already-pinned text, so turn_end re-renders the whole thing
                // (visible duplicate) and the two blocks are concatenated with
                // no separator ("…bundling.Researched the landscape").
                if (streamFlushTimer) {
                  clearTimeout(streamFlushTimer);
                  streamFlushTimer = null;
                }
                textVisibleRef.current = "";
                thinkingBufferRef.current = "";
                thinkingVisibleRef.current = "";
                streamTextDirty = false;
                streamThinkingDirty = false;
                setStreamingText("");
                setStreamingThinking("");
                break;

              case "server_tool_result":
                onServerToolResult?.(event.toolUseId, event.resultType, event.data);
                break;

              case "steering_message":
                // Steering message was injected — UI already notified via
                // onQueuedStart inside getSteeringMessages callback.
                break;

              case "error":
                // Stream error (e.g. stall retries exhausted) — surface to UI
                // so the user sees a clear failure instead of fake completion.
                setStallError(event.error.message);
                break;

              case "retry": {
                // The stream restarts from scratch on retry — the provider
                // will re-emit text from the beginning. Without clearing
                // the accumulated buffers, the retry's deltas append to the
                // aborted attempt's partial text, producing a visible
                // duplicate (e.g. "Now I'll work on this..Now I'll work on this..").
                // EXCEPTION: preserved retries (preservedChars > 0) continue
                // from the partial — the loop kept the streamed text in message
                // history, so the on-screen text must stay and the continuation
                // deltas append to it. Thinking always rolls back (never preserved).
                const preserved = (event.preservedChars ?? 0) > 0;
                if (streamFlushTimer) {
                  clearTimeout(streamFlushTimer);
                  streamFlushTimer = null;
                }
                if (!preserved) {
                  textVisibleRef.current = "";
                  charCountRef.current = 0;
                  streamTextDirty = false;
                  setStreamingText("");
                }
                thinkingBufferRef.current = "";
                thinkingVisibleRef.current = "";
                streamThinkingDirty = false;
                setStreamingThinking("");
                // Let the UI roll back pending progressive flushes from the
                // aborted attempt before the retry's new stream starts.
                if (!preserved) onRetry?.();
                // Hidden retries (silent) don't update the UI — the user
                // only sees retry indicators after silent attempts are exhausted.
                if (!event.silent) {
                  phaseRef.current = "retrying";
                  setActivityPhase("retrying");
                  setStallError(null); // clear any previous error on retry
                  setRetryInfo({
                    reason: event.reason,
                    attempt: event.attempt,
                    maxAttempts: event.maxAttempts,
                    delayMs: event.delayMs,
                  });
                }
                break;
              }

              case "turn_end": {
                // Flush any throttled streaming text before processing turn end
                if (streamFlushTimer) {
                  clearTimeout(streamFlushTimer);
                  streamFlushTimer = null;
                }
                flushStreamState();
                setRetryInfo(null);
                idealReviewStatsRef.current.turns = event.turn;
                onTurnEnd?.(event.turn, event.stopReason, event.usage, event.timing);
                setCurrentTurn(event.turn);
                setTotalTokens((prev) => ({
                  input: prev.input + event.usage.inputTokens,
                  output: prev.output + event.usage.outputTokens,
                }));
                // Total input context = uncached + cache_read + cache_write.
                // Anthropic has separate input/output limits, so only count input.
                // OpenAI/GLM/Moonshot share the context window, so include output.
                const inputContext =
                  event.usage.inputTokens +
                  (event.usage.cacheRead ?? 0) +
                  (event.usage.cacheWrite ?? 0);
                setContextUsed(
                  options.provider === "anthropic"
                    ? inputContext
                    : inputContext + event.usage.outputTokens,
                );
                // Replace char-based estimate with real output tokens
                realTokensAccumRef.current += event.usage.outputTokens;
                charCountRef.current = 0;
                setStreamedTokenEstimate(realTokensAccumRef.current);
                // Reset phase for next turn — the first thinking_delta from
                // the next turn (including the empty-text "reasoning started"
                // signal we forward from response.output_item.added) flips
                // us back to "thinking" on a real provider signal.
                phaseRef.current = "waiting";
                setActivityPhase("waiting");
                if (textVisibleRef.current) {
                  onTurnText?.(
                    textVisibleRef.current,
                    thinkingBufferRef.current,
                    thinkingAccumRef.current,
                  );
                }
                // Reset streaming buffers for next turn
                textVisibleRef.current = "";
                thinkingBufferRef.current = "";
                thinkingVisibleRef.current = "";
                setStreamingText("");
                setStreamingThinking("");
                break;
              }

              case "agent_done":
                // Batch ALL completion state into a single render so Ink
                // processes the live-area change atomically.  Previously
                // isRunning, activityPhase, and onDone landed in separate
                // render batches, causing multiple live-area height changes
                // that confused Ink's cursor math and clipped content.
                setIsRunning(false);
                phaseRef.current = "idle";
                setActivityPhase("idle");
                // Call onDone HERE (not in finally) so its state updates
                // (doneStatus, flushing items to Static) are batched too.
                onDone?.(Date.now() - runStartRef.current, [...toolsUsedRef.current], {
                  counts: Object.fromEntries(toolCountsRef.current),
                  tokens: realTokensAccumRef.current,
                });
                doneCalledRef.current = true;
                break;
            }
          }
        } catch (err) {
          const isAbort =
            err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
          if (!isAbort) {
            throw err;
          }
          wasAborted = true;
        } finally {
          // If the signal was aborted but the loop exited normally (e.g.
          // agent_done fired right before the abort), treat it as aborted so
          // the user sees "Request was stopped." instead of a duration verb.
          if (!wasAborted && ac.signal.aborted) {
            wasAborted = true;
          }
          setIsRunning(false);
          abortRef.current = null;
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
          }
          phaseRef.current = "idle";
          setActivityPhase("idle");

          if (wasAborted) {
            if (textVisibleRef.current) {
              onTurnText?.(
                textVisibleRef.current,
                thinkingBufferRef.current,
                thinkingAccumRef.current,
              );
            }
            textVisibleRef.current = "";
            thinkingBufferRef.current = "";
            thinkingVisibleRef.current = "";
            setStreamingText("");
            setStreamingThinking("");
            onAborted?.();
          } else if (!doneCalledRef.current) {
            // Safety fallback — normally agent_done calls onDone in-band
            const durationMs = Date.now() - runStartRef.current;
            onDone?.(durationMs, [...toolsUsedRef.current], {
              counts: Object.fromEntries(toolCountsRef.current),
              tokens: realTokensAccumRef.current,
            });
          }

          // Notify parent of new messages
          const newMsgs = messages.current.slice(startIndex);
          onComplete?.(newMsgs);
        }
        return wasAborted;
      }; // end runSingle

      // Run the initial message.
      // On 401, force-refresh the OAuth token and retry once — the provider may
      // have revoked the token server-side before the stored expiry.
      try {
        await runSingle(userContent);
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 401 && options.resolveCredentials) {
          // Pop the user message we pushed — runSingle will re-push it
          messages.current.pop();
          await runSingle(userContent, { forceRefresh: true });
        } else {
          throw err;
        }
      }

      // Drain the queue: process follow-up messages that arrived after agent_done.
      // Most queued messages are consumed mid-run via getSteeringMessages, but
      // messages that arrive after the agent finishes (no more tool calls to
      // trigger steering) land here. Batch all remaining into a single run.
      //
      // This drains even when the run was aborted. After an interrupt, the
      // teardown (process kills, stream finish, finally block, React commit of
      // isRunning=false) is async — during that window a reprompt sees
      // isRunning still true and gets queued instead of run. Pre-abort queued
      // messages were already restored to the composer by handleAbort's
      // drainQueuedText (and reset()/abort paths clear the queue), so anything
      // left here arrived *after* the abort and is a fresh user intent. Without
      // this it would be orphaned in the queue forever with no loop to pick it
      // up.
      if (queueRef.current.length > 0) {
        const batch = queueRef.current.splice(0);
        setQueuedCount(0);
        const merged = mergeUserContent(batch.map((q) => q.content));
        // Let React process the onDone state updates before starting next run
        await new Promise((r) => setTimeout(r, 100));
        onQueuedStart?.(merged);
        await runSingle(merged);
      }
    },
    [
      messages,
      options,
      onComplete,
      onTurnText,
      onToolStart,
      onToolUpdate,
      onToolEnd,
      onServerToolCall,
      onServerToolResult,
      onTurnEnd,
      onDone,
      onAborted,
      onQueuedStart,
      getFollowUpMessages,
    ],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, []);

  return {
    run,
    abort,
    reset,
    queueMessage,
    queuedCount,
    clearQueue,
    drainQueuedText,
    isRunning,
    streamingText,
    streamingThinking,
    activeToolCalls,
    currentTurn,
    totalTokens,
    contextUsed,
    activityPhase,
    retryInfo,
    stallError,
    elapsedMs,
    runStartRef,
    thinkingMs,
    isThinking,
    streamedTokenEstimate,
    charCountRef,
    realTokensAccumRef,
    linesChanged,
  };
}
