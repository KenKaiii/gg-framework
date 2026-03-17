import { useState, useRef, useCallback, useEffect } from "react";
import { agentLoop, type AgentEvent, type AgentTool } from "@kenkaiiii/gg-agent";
import type { Message, Provider, ThinkingLevel, TextContent, ImageContent } from "@kenkaiiii/gg-ai";

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
  const parts: (TextContent | ImageContent)[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
    } else {
      parts.push(...item);
    }
  }
  return parts;
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
  thinking?: ThinkingLevel;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  /** Resolve fresh credentials before each run (e.g. OAuth token refresh). */
  resolveCredentials?: () => Promise<{ apiKey: string; accountId?: string }>;
  transformContext?: (
    messages: Message[],
    options?: { force?: boolean },
  ) => Message[] | Promise<Message[]>;
}

export type ActivityPhase = "waiting" | "thinking" | "generating" | "tools" | "idle";

export type UserContent = string | (TextContent | ImageContent)[];

export interface UseAgentLoopReturn {
  run: (userContent: UserContent) => Promise<void>;
  abort: () => void;
  reset: () => void;
  /** Queue a message to be processed after the current run completes. */
  queueMessage: (content: UserContent) => void;
  /** Number of messages currently waiting in the queue. */
  queuedCount: number;
  /** Clear all queued messages. */
  clearQueue: () => void;
  isRunning: boolean;
  streamingText: string;
  streamingThinking: string;
  activeToolCalls: ActiveToolCall[];
  currentTurn: number;
  totalTokens: { input: number; output: number };
  /** Latest turn's input tokens — reflects current context window usage */
  contextUsed: number;
  activityPhase: ActivityPhase;
  elapsedMs: number;
  thinkingMs: number;
  isThinking: boolean;
  streamedTokenEstimate: number;
}

export function useAgentLoop(
  messages: React.MutableRefObject<Message[]>,
  options: AgentLoopOptions,
  callbacks?: {
    onComplete?: (newMessages: Message[]) => void;
    onTurnText?: (text: string, thinking: string, thinkingMs: number) => void;
    onToolStart?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
    onToolUpdate?: (toolCallId: string, update: unknown) => void;
    onToolEnd?: (
      toolCallId: string,
      name: string,
      result: string,
      isError: boolean,
      durationMs: number,
      details?: unknown,
    ) => void;
    onServerToolCall?: (id: string, name: string, input: unknown) => void;
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
    ) => void;
    onDone?: (durationMs: number, toolsUsed: string[]) => void;
    onAborted?: () => void;
    /** Called when a queued message starts processing (after the previous run completes). */
    onQueuedStart?: (content: UserContent) => void;
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

  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<UserContent[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const activeToolCallsRef = useRef<ActiveToolCall[]>([]);
  const textPendingRef = useRef("");
  const textVisibleRef = useRef("");
  const thinkingBufferRef = useRef("");
  const thinkingPendingRef = useRef("");
  const thinkingVisibleRef = useRef("");
  const thinkingRevealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runStartRef = useRef(0);
  const toolsUsedRef = useRef<Set<string>>(new Set());
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef = useRef<ActivityPhase>("idle");
  const thinkingStartRef = useRef<number | null>(null);
  const thinkingAccumRef = useRef(0);
  const charCountRef = useRef(0);
  const realTokensAccumRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneCalledRef = useRef(false);

  const stopReveal = useCallback(() => {
    if (revealTimerRef.current) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  const emptyTicksRef = useRef(0);

  const startReveal = useCallback(() => {
    if (revealTimerRef.current) return;
    emptyTicksRef.current = 0;
    revealTimerRef.current = setInterval(() => {
      const pending = textPendingRef.current;
      if (pending.length === 0) {
        // Auto-stop after 3 empty ticks to avoid unnecessary re-renders
        emptyTicksRef.current++;
        if (emptyTicksRef.current >= 3) {
          stopReveal();
        }
        return;
      }
      emptyTicksRef.current = 0;

      // Adaptive speed: continuous interpolation prevents jarring speed
      // jumps at tier boundaries. Clamped to [12, 180] chars/tick at
      // 33ms (~30fps) to balance smoothness vs catch-up speed.
      const buffered = pending.length;
      const charsPerTick = Math.max(12, Math.min(180, Math.ceil(buffered * 0.35)));

      // Snap to a word boundary when possible so partial words don't
      // flash on screen. Look back up to 20 chars for a natural break.
      let endIndex = Math.min(charsPerTick, buffered);
      if (endIndex < buffered) {
        const breakChars = " \n.,;:`')]}>";
        for (let i = endIndex; i >= Math.max(1, endIndex - 20); i--) {
          if (breakChars.includes(pending[i])) {
            endIndex = i + 1;
            break;
          }
        }
      }

      const reveal = pending.slice(0, endIndex);
      textPendingRef.current = pending.slice(endIndex);
      textVisibleRef.current += reveal;
      setStreamingText(textVisibleRef.current);
    }, 33);
  }, [stopReveal]);

  // ── Thinking reveal (throttled like text reveal) ──────────
  // Without this, every thinking_delta event triggers setStreamingThinking
  // immediately, causing rapid live-area height changes as text wraps to
  // new lines — which makes Ink's cursor math misalign and the viewport jump.
  const thinkingEmptyTicksRef = useRef(0);

  const stopThinkingReveal = useCallback(() => {
    if (thinkingRevealTimerRef.current) {
      clearInterval(thinkingRevealTimerRef.current);
      thinkingRevealTimerRef.current = null;
    }
  }, []);

  const startThinkingReveal = useCallback(() => {
    if (thinkingRevealTimerRef.current) return;
    thinkingEmptyTicksRef.current = 0;
    thinkingRevealTimerRef.current = setInterval(() => {
      const pending = thinkingPendingRef.current;
      if (pending.length === 0) {
        thinkingEmptyTicksRef.current++;
        if (thinkingEmptyTicksRef.current >= 3) {
          stopThinkingReveal();
        }
        return;
      }
      thinkingEmptyTicksRef.current = 0;

      // Larger chunks than text reveal — thinking text is dimmed/secondary
      // so smooth animation matters less than keeping re-renders low.
      const buffered = pending.length;
      const charsPerTick = Math.max(20, Math.min(300, Math.ceil(buffered * 0.4)));

      let endIndex = Math.min(charsPerTick, buffered);
      if (endIndex < buffered) {
        const breakChars = " \n.,;:`')]}>";
        for (let i = endIndex; i >= Math.max(1, endIndex - 20); i--) {
          if (breakChars.includes(pending[i])) {
            endIndex = i + 1;
            break;
          }
        }
      }

      const reveal = pending.slice(0, endIndex);
      thinkingPendingRef.current = pending.slice(endIndex);
      thinkingVisibleRef.current += reveal;
      setStreamingThinking(thinkingVisibleRef.current);
    }, 33);
  }, [stopThinkingReveal]);

  const flushAllText = useCallback(() => {
    stopReveal();
    stopThinkingReveal();
    if (textPendingRef.current.length > 0) {
      textVisibleRef.current += textPendingRef.current;
      textPendingRef.current = "";
    }
    if (thinkingPendingRef.current.length > 0) {
      thinkingVisibleRef.current += thinkingPendingRef.current;
      thinkingPendingRef.current = "";
    }
    setStreamingText(textVisibleRef.current);
    setStreamingThinking(thinkingVisibleRef.current);
  }, [stopReveal, stopThinkingReveal]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
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
    queueRef.current = [];
    setQueuedCount(0);
  }, []);

  const queueMessage = useCallback((content: UserContent) => {
    queueRef.current.push(content);
    setQueuedCount(queueRef.current.length);
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedCount(0);
  }, []);

  const run = useCallback(
    async (userContent: UserContent) => {
      /** Run a single user message through the agent loop. Returns true if aborted. */
      const runSingle = async (content: UserContent): Promise<boolean> => {
        const ac = new AbortController();
        abortRef.current = ac;
        let wasAborted = false;

        // Reset state
        doneCalledRef.current = false;
        textPendingRef.current = "";
        textVisibleRef.current = "";
        thinkingBufferRef.current = "";
        thinkingPendingRef.current = "";
        thinkingVisibleRef.current = "";
        runStartRef.current = Date.now();
        toolsUsedRef.current = new Set();
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

        try {
          // Resolve fresh credentials (handles OAuth token refresh)
          let apiKey = options.apiKey;
          let accountId = options.accountId;
          if (options.resolveCredentials) {
            const creds = await options.resolveCredentials();
            apiKey = creds.apiKey;
            accountId = creds.accountId;
          }

          const generator = agentLoop(messages.current, {
            provider: options.provider,
            model: options.model,
            tools: options.tools,
            webSearch: options.webSearch,
            maxTokens: options.maxTokens,
            thinking: options.thinking,
            apiKey,
            baseUrl: options.baseUrl,
            accountId,
            signal: ac.signal,
            transformContext: options.transformContext,
            // Drain queued messages as steering — injected between tool calls
            // and before the agent would stop, so the LLM sees user guidance
            // within the same run instead of waiting for a new one.
            getSteeringMessages: () => {
              if (queueRef.current.length === 0) return null;
              const batch = queueRef.current.splice(0);
              setQueuedCount(0);
              const merged = mergeUserContent(batch);
              onQueuedStart?.(merged);
              return [{ role: "user" as const, content: merged }];
            },
          });

          for await (const event of generator as AsyncIterable<AgentEvent>) {
            switch (event.type) {
              case "text_delta":
                textPendingRef.current += event.text;
                charCountRef.current += event.text.length;
                startReveal();
                if (phaseRef.current !== "generating") {
                  freezeThinking();
                  phaseRef.current = "generating";
                  setActivityPhase("generating");
                }
                break;

              case "thinking_delta":
                thinkingBufferRef.current += event.text;
                thinkingPendingRef.current += event.text;
                charCountRef.current += event.text.length;
                startThinkingReveal();
                if (phaseRef.current !== "thinking") {
                  thinkingStartRef.current = Date.now();
                  setIsThinking(true);
                  phaseRef.current = "thinking";
                  setActivityPhase("thinking");
                }
                break;

              case "tool_call_start": {
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
                onToolStart?.(event.toolCallId, event.name, event.args);
                toolsUsedRef.current.add(event.name);
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
                );
                activeToolCallsRef.current = activeToolCallsRef.current.filter(
                  (t) => t.toolCallId !== event.toolCallId,
                );
                setActiveToolCalls(activeToolCallsRef.current);
                break;
              }

              case "server_tool_call":
                onServerToolCall?.(event.id, event.name, event.input);
                break;

              case "server_tool_result":
                onServerToolResult?.(event.toolUseId, event.resultType, event.data);
                break;

              case "steering_message":
                // Steering message was injected — UI already notified via
                // onQueuedStart inside getSteeringMessages callback.
                break;

              case "turn_end":
                onTurnEnd?.(event.turn, event.stopReason, event.usage);
                setCurrentTurn(event.turn);
                setTotalTokens((prev) => ({
                  input: prev.input + event.usage.inputTokens,
                  output: prev.output + event.usage.outputTokens,
                }));
                // Latest turn's input tokens = current context window fill
                // With prompt caching, input_tokens only counts non-cached tokens.
                // Total context = input + cache_read + cache_write.
                setContextUsed(
                  event.usage.inputTokens +
                    (event.usage.cacheRead ?? 0) +
                    (event.usage.cacheWrite ?? 0),
                );
                // Replace char-based estimate with real output tokens
                realTokensAccumRef.current += event.usage.outputTokens;
                charCountRef.current = 0;
                setStreamedTokenEstimate(realTokensAccumRef.current);
                // Reset phase for next turn
                phaseRef.current = "waiting";
                setActivityPhase("waiting");
                // Flush all pending text before completing turn
                flushAllText();
                if (textVisibleRef.current) {
                  onTurnText?.(
                    textVisibleRef.current,
                    thinkingBufferRef.current,
                    thinkingAccumRef.current,
                  );
                }
                // Reset streaming buffers for next turn
                textPendingRef.current = "";
                textVisibleRef.current = "";
                thinkingBufferRef.current = "";
                thinkingPendingRef.current = "";
                thinkingVisibleRef.current = "";
                setStreamingText("");
                setStreamingThinking("");
                break;

              case "agent_done":
                flushAllText();
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
                onDone?.(Date.now() - runStartRef.current, [...toolsUsedRef.current]);
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
          setIsRunning(false);
          abortRef.current = null;
          stopReveal();
          stopThinkingReveal();
          if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
          }
          phaseRef.current = "idle";
          setActivityPhase("idle");

          if (wasAborted) {
            // Flush any visible streaming text so onAborted (which adds
            // "Request was stopped.") lands AFTER the agent's partial text
            // in liveItems — not above it.
            flushAllText();
            if (textVisibleRef.current) {
              onTurnText?.(
                textVisibleRef.current,
                thinkingBufferRef.current,
                thinkingAccumRef.current,
              );
            }
            textPendingRef.current = "";
            textVisibleRef.current = "";
            thinkingBufferRef.current = "";
            thinkingPendingRef.current = "";
            thinkingVisibleRef.current = "";
            setStreamingText("");
            setStreamingThinking("");
            onAborted?.();
          } else if (!doneCalledRef.current) {
            // Safety fallback — normally agent_done calls onDone in-band
            const durationMs = Date.now() - runStartRef.current;
            onDone?.(durationMs, [...toolsUsedRef.current]);
          }

          // Notify parent of new messages
          const newMsgs = messages.current.slice(startIndex);
          onComplete?.(newMsgs);
        }
        return wasAborted;
      }; // end runSingle

      // Run the initial message
      const aborted = await runSingle(userContent);

      // Drain the queue: process follow-up messages that arrived after agent_done.
      // Most queued messages are consumed mid-run via getSteeringMessages, but
      // messages that arrive after the agent finishes (no more tool calls to
      // trigger steering) land here. Batch all remaining into a single run.
      if (!aborted && queueRef.current.length > 0) {
        const batch = queueRef.current.splice(0);
        setQueuedCount(0);
        const merged = mergeUserContent(batch);
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
      startReveal,
      stopReveal,
      startThinkingReveal,
      stopThinkingReveal,
      flushAllText,
    ],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopReveal();
      stopThinkingReveal();
      abortRef.current?.abort();
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [stopReveal, stopThinkingReveal]);

  return {
    run,
    abort,
    reset,
    queueMessage,
    queuedCount,
    clearQueue,
    isRunning,
    streamingText,
    streamingThinking,
    activeToolCalls,
    currentTurn,
    totalTokens,
    contextUsed,
    activityPhase,
    elapsedMs,
    thinkingMs,
    isThinking,
    streamedTokenEstimate,
  };
}
