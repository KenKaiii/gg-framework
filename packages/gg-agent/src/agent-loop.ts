import { ZodError, prettifyError } from "zod";
import {
  stream,
  EventStream,
  type Message,
  type ToolCall,
  type ToolResult,
  type ToolResultContent,
  type Usage,
  type ContentPart,
  type AssistantMessage,
  isHardBillingMessage,
} from "@kenkaiiii/gg-ai";
import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  AgentTool,
  ToolContext,
  ToolExecuteResult,
  StructuredToolResult,
} from "./types.js";

const DEFAULT_MAX_TURNS = 300;

/**
 * Lightweight stream diagnostic callback. When set, the agent loop calls this
 * at every phase boundary with timing and state info. This lets the hosting
 * app (ggcoder, come-alive, etc.) log stall diagnostics without the agent
 * package needing fs/process dependencies.
 */
export type StreamDiagnosticFn = (phase: string, data?: Record<string, unknown>) => void;

/** Global diagnostic hook — set by the hosting app before calling agentLoop. */
let _diagFn: StreamDiagnosticFn | null = null;

/** Register a diagnostic callback for stream stall tracing. */
export function setStreamDiagnostic(fn: StreamDiagnosticFn | null): void {
  _diagFn = fn;
}

function diag(phase: string, data?: Record<string, unknown>): void {
  _diagFn?.(phase, data);
}

/**
 * Detect abort errors — user-initiated cancellation or AbortSignal.
 * These should be caught and handled gracefully, not re-thrown.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("aborted") || msg.includes("abort");
}

/**
 * Detect context window overflow errors from LLM providers.
 *
 * Patterns drawn from observed errors across Anthropic, OpenAI, OpenAI Codex,
 * Bedrock, Ollama, and OpenAI-compatible Chinese providers (GLM, Kimi, MiniMax).
 */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // 402 is always credit/payment exhaustion — never a context overflow. Guards
  // against e.g. OpenRouter's 402 "requires more credits, or fewer max_tokens...
  // you requested up to N tokens" being misread as overflow and triggering
  // futile compaction retries.
  const overflowStatus = (err as Error & { statusCode?: unknown }).statusCode;
  if (overflowStatus === 402) return false;
  if (isBillingError(err)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("prompt is too long") ||
    msg.includes("prompt too long") ||
    msg.includes("input is too long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("context_window_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("exceeds model context window") ||
    msg.includes("exceeds the context window") ||
    msg.includes("content_too_large") ||
    msg.includes("request_too_large") ||
    msg.includes("reduce the length") ||
    msg.includes("please shorten") ||
    (msg.includes("token") && msg.includes("exceed"))
  );
}

export interface ContextOverflowDetails {
  observedTokens?: number;
  observedLimit?: number;
}

function parseOverflowNumber(value: string): number {
  return Number(value.replace(/[,_\s]/g, ""));
}

/** Extract provider-reported token counts from common context overflow messages. */
export function extractContextOverflowDetails(err: unknown): ContextOverflowDetails {
  if (!(err instanceof Error)) return {};
  const text = err.message;
  const patterns: Array<{ regex: RegExp; tokensGroup: number; limitGroup: number }> = [
    // Anthropic/OpenAI-compatible: "203456 tokens > 200000 maximum"
    {
      regex: /([\d,_.\s]+)\s*tokens?\s*>\s*([\d,_.\s]+)\s*(?:maximum|max|limit)?/i,
      tokensGroup: 1,
      limitGroup: 2,
    },
    // OpenAI: "maximum context length is 128000 tokens ... resulted in 130000 tokens"
    {
      regex:
        /maximum context length is\s*([\d,_.\s]+)\s*tokens?[\s\S]*?resulted in\s*([\d,_.\s]+)\s*tokens?/i,
      tokensGroup: 2,
      limitGroup: 1,
    },
    // Generic: "130000 input tokens exceeds 128000 token limit"
    {
      regex:
        /([\d,_.\s]+)\s*(?:input\s*)?tokens?[\s\S]{0,80}?exceeds?[\s\S]{0,80}?([\d,_.\s]+)\s*(?:token\s*)?(?:limit|maximum|max)/i,
      tokensGroup: 1,
      limitGroup: 2,
    },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const observedTokens = parseOverflowNumber(match[pattern.tokensGroup] ?? "");
    const observedLimit = parseOverflowNumber(match[pattern.limitGroup] ?? "");
    return {
      ...(Number.isFinite(observedTokens) && observedTokens > 0 ? { observedTokens } : {}),
      ...(Number.isFinite(observedLimit) && observedLimit > 0 ? { observedLimit } : {}),
    };
  }

  return {};
}

/**
 * Detect billing/quota errors — these should NOT be retried.
 * GLM returns HTTP 429 with "Insufficient balance" for quota exhaustion.
 */
export function isBillingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // HTTP 402 (Payment Required) is always a hard credit/payment stop across our
  // provider set (DeepSeek, OpenRouter, ...). Never retriable.
  const statusCode = (err as Error & { statusCode?: unknown }).statusCode;
  if (statusCode === 402) return true;
  // Shared marker list (single source of truth in @kenkaiiii/gg-ai) so the
  // provider boundary and this classifier can't drift apart.
  return isHardBillingMessage(err.message);
}

/**
 * Detect subscription/plan usage-window exhaustion (e.g. an Anthropic OAuth
 * plan running out of usage). Unlike a transient per-minute 429, this does NOT
 * clear with a quick retry — the user must wait for the window to reset — so the
 * loop surfaces it immediately instead of retrying for minutes. Matches the
 * canonical message gg-ai stamps onto the provider error.
 */
export function isUsageLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /usage limit reached/i.test(err.message);
}

/**
 * Read a provider-stated reset time off the error and convert it to a delay in
 * milliseconds from now. Providers like Gemini return a short `retryDelay` for a
 * transient per-minute throttle, which gg-ai stamps onto the ProviderError as
 * `resetsAt` (unix seconds). Returns undefined when absent or already elapsed.
 */
export function serverResetDelayMs(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const resetsAt = (err as Error & { resetsAt?: unknown }).resetsAt;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  const delayMs = resetsAt * 1000 - Date.now();
  return delayMs > 0 ? delayMs : undefined;
}

/**
 * Detect overloaded/rate-limit errors from LLM providers.
 * HTTP 429 (rate limit) or 529/503 (overloaded).
 * Excludes billing/quota errors which won't resolve with a retry.
 */
/**
 * Detect tool pairing errors — orphaned tool_use or tool_result blocks.
 * These are 400 errors that can be recovered by repairing the message history.
 */
export function isToolPairingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    (msg.includes("tool_use") && msg.includes("tool_result")) ||
    msg.includes("unexpected `tool_use_id`") ||
    msg.includes("tool_use ids found without") ||
    // Moonshot/OpenAI-compatible: "tool call id <id> is not found"
    (msg.includes("tool call id") && msg.includes("is not found"))
  );
}

/**
 * Detect Anthropic's thinking-block integrity errors. These 400s fire when a
 * signed `thinking`/`redacted_thinking` block in the latest assistant message
 * can't be validated — typically a partial/invalid signature from an
 * interrupted stream, or a block whose position shifted. Recoverable once by
 * stripping thinking blocks from the message history and re-sending.
 */
export function isThinkingBlockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (!msg.includes("thinking")) return false;
  return (
    msg.includes("cannot be modified") ||
    msg.includes("must remain as they were") ||
    (msg.includes("signature") && msg.includes("invalid")) ||
    // "Expected `thinking` or `redacted_thinking`, but found `text`"
    (msg.includes("expected") && msg.includes("but found"))
  );
}

/**
 * Distinguish rate-limit (HTTP 429), server-side overload (HTTP 529), and
 * transient provider 5xx/API failures. Returns null for errors that should not
 * enter the retry bucket. All kinds use the same backoff schedule, but the UI
 * shows different copy and the log line records the true cause.
 */
export function classifyOverload(
  err: unknown,
): "rate_limit" | "overloaded" | "provider_error" | null {
  if (!(err instanceof Error)) return null;
  if (isBillingError(err)) return null;
  // Usage-window exhaustion is not retriable — keep it out of the backoff bucket.
  if (isUsageLimitError(err)) return null;
  const msg = err.message.toLowerCase();
  const errorWithStatus = err as Error & { statusCode?: unknown };
  const statusCode =
    typeof errorWithStatus.statusCode === "number" ? errorWithStatus.statusCode : undefined;
  // 402 is billing/credits — never retry, never treat as overload.
  if (statusCode === 402) return null;
  if (
    statusCode === 429 ||
    msg.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429")
  ) {
    return "rate_limit";
  }
  if (statusCode === 529 || msg.includes("overloaded") || msg.includes("529")) {
    return "overloaded";
  }
  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    msg.includes("api_error") ||
    msg.includes("server_error") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout")
  ) {
    return "provider_error";
  }
  return null;
}

export function isOverloaded(err: unknown): boolean {
  return classifyOverload(err) !== null;
}

/**
 * Detect malformed-stream errors — the SDK's SSE decoder threw a JSON parse
 * error mid-stream, typically because a chunk was truncated or corrupted by
 * an intermediary (CDN, proxy).  Same class of transport failure as a stall:
 * replaying the request — and ideally flipping to non-streaming — recovers.
 */
export function isMalformedStream(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "SyntaxError") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.name === "SyntaxError") return true;
  const msg = err.message;
  // V8 JSON.parse error messages: "Expected ... in JSON at position N"
  // and "Unexpected token ... in JSON at position N"
  return /\bin JSON at position \d+/i.test(msg);
}

/**
 * Detect socket-level transport failures — the remote peer (or an
 * intermediary) closed the TCP connection mid-stream before the response
 * finished.  Surfaces as `TypeError: terminated` from undici/fetch, or as
 * `ECONNRESET` / `socket hang up` / `UND_ERR_SOCKET` from the underlying
 * Node http layer.  Undici nests the real cause one or more levels deep,
 * so we walk the `.cause` chain.  Same recovery as a stall: replay the
 * request, optionally as non-streaming.
 */
export function isTransportFailure(err: unknown): boolean {
  const codes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_RESPONSE_STATUS_CODE",
    "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  ]);
  const messages = [
    /^terminated$/i,
    /\bother side closed\b/i,
    /\bsocket hang up\b/i,
    /\bfetch failed\b/i,
    /\bbody timeout error\b/i,
    /\bsse stream disconnected\b/i,
    /\bfailed to reconnect sse stream\b/i,
  ];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && codes.has(e.code)) return true;
    if (typeof e.message === "string") {
      for (const re of messages) if (re.test(e.message)) return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Promise-returning sleep that rejects with AbortError if `signal` fires.
 * Used by retry backoffs so ESC/Ctrl+C cancel immediately instead of having
 * to wait out the full delay (up to 30s per overload retry × 10 retries).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* agentLoop(
  messages: Message[],
  options: AgentOptions,
): AsyncGenerator<AgentEvent, AgentResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxContinuations = options.maxContinuations ?? 5;
  const toolMap = new Map<string, AgentTool>((options.tools ?? []).map((t) => [t.name, t]));

  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let turn = 0;
  let firstTurn = true;
  let consecutivePauses = 0;
  let toolPairingRepaired = false;
  let thinkingBlocksStripped = false;
  let overloadRetries = 0;
  let emptyResponseRetries = 0;
  let stallRetries = 0;
  let overflowCompactionAttempts = 0;
  let toolResultTruncationAttempted = false;
  const invalidToolArgumentCounts = new Map<string, number>();
  // Non-streaming fallback mode. After repeated stream stalls, flip to a
  // plain non-streaming request/response -- often survives broken SSE
  // connections (transient CDN / proxy issues) that streaming retries cannot.
  let useNonStreamingFallback = false;
  const MAX_OVERLOAD_RETRIES = 10;
  const MAX_EMPTY_RESPONSE_RETRIES = 2;
  const MAX_STALL_RETRIES = 5;
  const MAX_OVERFLOW_COMPACTIONS = 2;
  // After this many streaming stalls in a row, switch to non-streaming mode
  // for the remaining stall retries. Keeps the first two retries fast (the
  // cheap "transient glitch" case) before paying for a full response round-trip.
  const STALL_RETRIES_BEFORE_NON_STREAMING = 2;
  const STALL_DELAY_MS = 1_000; // Brief pause before retry -- just enough to avoid tight loops
  const OVERLOAD_BASE_DELAY_MS = 2_000;
  const OVERLOAD_MAX_DELAY_MS = 30_000;
  const STREAM_FIRST_EVENT_TIMEOUT_MS = 45_000; // 45s to get first event (Opus thinks long)
  // 90s of true API silence between events once streaming starts. This measures
  // only time the *API* was quiet -- the timer is armed after we finish yielding
  // each event downstream, so slow UI/consumer render time is excluded (see the
  // resetIdleTimer() call after the yield, below). 30s here previously caused
  // false aborts on large `write`/`edit` tool-call streams when the Ink UI lagged
  // tens of seconds behind. 90s matches Claude Code's default idle watchdog.
  const STREAM_IDLE_TIMEOUT_MS = 90_000; // 90s of API silence between events
  // Anthropic models can pause 10-20s mid-stream while computing the next chunk
  // (e.g. generating tool call args for a large write).  10s was too aggressive
  // and caused false "stream stalled" errors, especially in plan mode.
  const STREAM_HARD_TIMEOUT_MS = 90_000; // 90s absolute cap before output starts
  // Once output events (text_delta) are actively streaming, extend the hard
  // timeout -- long responses (plan mode, detailed explanations) can legitimately
  // take 2-3+ minutes while events flow continuously.
  const STREAM_OUTPUT_HARD_TIMEOUT_MS = 300_000; // 5min hard cap once output is flowing
  // Reasoning models (MiMo) can pause 3-5 minutes between thinking and output
  // generation.  Once we've seen thinking events, extend timeouts significantly.
  const STREAM_THINKING_IDLE_TIMEOUT_MS = 300_000; // 5min idle after thinking
  const STREAM_THINKING_HARD_TIMEOUT_MS = 600_000; // 10min hard cap with thinking
  // Non-streaming mode has no per-event idle -- the entire response arrives in
  // one HTTP round-trip. Use a single generous hard cap instead. This matches
  // Claude Code's v2.1.110/111 behaviour: cap non-streaming retries so API
  // unreachability doesn't cause multi-minute hangs, but not so aggressively
  // that slow-but-healthy backends get killed.
  const NON_STREAMING_HARD_TIMEOUT_MS = 300_000; // 5min for full non-streaming response
  // Runaway tool-call circuit breaker. When a model glitches mid-tool-call it
  // can emit tens of thousands of toolcall_delta events without ever closing,
  // burning the entire stall-retry budget (~25 min) on what is clearly a
  // non-recoverable model error. Cap accumulated arg chars and event count;
  // exceeding either is a hard, non-retriable failure. Thresholds are generous
  // enough to allow legitimate large file writes through `write`.
  const MAX_TOOLCALL_DELTA_CHARS = 1_000_000; // 1 MB of accumulated tool-call args
  const MAX_TOOLCALL_DELTA_EVENTS = 20_000; // 20k delta events in one stream

  try {
    while (turn < maxTurns) {
      options.signal?.throwIfAborted();
      turn++;

      // Estimate message payload size for diagnostics
      let msgChars = 0;
      for (const m of messages) {
        if (typeof m.content === "string") msgChars += m.content.length;
        else if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if ("text" in p && typeof p.text === "string") msgChars += p.text.length;
            if ("content" in p && typeof p.content === "string") msgChars += p.content.length;
          }
        }
      }
      diag("turn_start", {
        turn,
        messages: messages.length,
        chars: msgChars,
        provider: options.provider,
        model: options.model,
      });

      // ── Initial steering poll: catch messages queued before the first LLM call ──
      if (firstTurn && options.getSteeringMessages) {
        const steering = await options.getSteeringMessages();
        if (steering && steering.length > 0) {
          for (const msg of steering) {
            yield { type: "steering_message" as const, content: msg.content };
            messages.push(msg);
          }
        }
      }
      firstTurn = false;

      // ── Mid-loop context transform (compaction / truncation) ──
      if (options.transformContext) {
        diag("transform_start");
        const transformed = await options.transformContext(messages);
        if (transformed !== messages) {
          diag("transform_compacted", {
            before: messages.length,
            after: transformed.length,
          });
          messages.length = 0;
          messages.push(...transformed);
        }
        diag("transform_end");
      }

      // ── Repair tool pairing: ensure every tool_use has an adjacent tool_result ──
      repairToolPairingAdjacent(messages);

      // ── Call LLM with overflow recovery ──
      let response;
      // Per-attempt abort controller: allows idle timeout to abort the stream
      // without affecting the caller's signal. The caller's abort is forwarded.
      const streamController = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimedOut = false;

      // Stream event counters — declared here so timeout callbacks can access them
      let streamEventCount = 0;
      let lastEventTime = Date.now();
      let streamCallStart = Date.now();
      // Track event types for diagnostics — shows what arrived before a stall
      const eventTypeCounts: Record<string, number> = {};
      let lastEventType = "";
      // Runaway tool-call detection — accumulated across all toolcall_delta
      // events in this stream attempt. When tripped we abort the stream and
      // bail out without retrying (the model has glitched, retries won't help).
      let toolcallDeltaChars = 0;
      let toolcallDeltaCount = 0;
      let runawayDetected: { kind: "chars" | "events"; chars: number; events: number } | null =
        null;
      // Track consumer processing time — helps distinguish "API stopped sending"
      // from "our consumer was slow to pull the next event"
      let lastYieldEndTime = Date.now();
      let maxConsumerLagMs = 0;

      // Forward caller abort to the per-attempt controller
      const forwardAbort = () => streamController.abort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });

      // Three-phase idle timeout:
      //  - Before first event: STREAM_FIRST_EVENT_TIMEOUT_MS (45s) -- Opus can
      //    take 30s+ to start on large contexts, that's not a stall.
      //  - After output event (text_delta, server_toolcall): STREAM_IDLE_TIMEOUT_MS
      //    (10s) -- once output is streaming, 10s of silence is dead. Retry fast.
      //  - After thinking events only: STREAM_THINKING_IDLE_TIMEOUT_MS (5min) --
      //    reasoning models (MiMo) can pause minutes between thinking and output.
      //
      // In non-streaming fallback mode the entire response arrives in a single
      // HTTP round-trip, so the idle timer is disabled -- only the hard timeout
      // applies. Synthesized events all arrive at once when the response returns.
      let hasReceivedEvent = false;
      let hasReceivedThinking = false;
      const resetIdleTimer = () => {
        if (useNonStreamingFallback) return; // no inter-event idle in non-streaming mode
        if (idleTimer) clearTimeout(idleTimer);
        const timeoutMs = hasReceivedEvent
          ? STREAM_IDLE_TIMEOUT_MS
          : hasReceivedThinking
            ? STREAM_THINKING_IDLE_TIMEOUT_MS
            : STREAM_FIRST_EVENT_TIMEOUT_MS;
        idleTimer = setTimeout(() => {
          diag("idle_timeout_fired", {
            events: streamEventCount,
            sinceLastEventMs: Date.now() - lastEventTime,
            lastEventType,
            maxConsumerLagMs,
            phase: hasReceivedEvent
              ? "mid_stream"
              : hasReceivedThinking
                ? "post_thinking"
                : "first_event",
            eventTypes: eventTypeCounts,
          });
          idleTimedOut = true;
          streamController.abort();
        }, timeoutMs);
      };

      // Hard timeout: absolute cap per LLM call. Safety net for streams that
      // keep sending sparse events (e.g. keep-alive pings) but never complete.
      // Extended dynamically when thinking events arrive (see thinking_delta handler).
      // Non-streaming fallback uses a single larger cap since there's no stream
      // to observe -- just wait for the full response up to the cap.
      let hardTimeoutMs = useNonStreamingFallback
        ? NON_STREAMING_HARD_TIMEOUT_MS
        : STREAM_HARD_TIMEOUT_MS;
      hardTimer = setTimeout(() => {
        diag("hard_timeout_fired", {
          events: typeof streamEventCount !== "undefined" ? streamEventCount : 0,
          nonStreaming: useNonStreamingFallback,
        });
        idleTimedOut = true;
        streamController.abort();
      }, hardTimeoutMs);

      try {
        diag("stream_call", { nonStreaming: useNonStreamingFallback });
        streamCallStart = Date.now();
        const result = stream({
          provider: options.provider,
          model: options.model,
          messages,
          tools: options.tools,
          serverTools: options.serverTools,
          webSearch: options.webSearch,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          thinking: options.thinking,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          signal: streamController.signal,
          accountId: options.accountId,
          projectId: options.projectId,
          cacheRetention: options.cacheRetention,
          promptCacheKey: options.promptCacheKey,
          serviceTier: options.serviceTier,
          supportsImages: options.supportsImages,
          supportsVideo: options.supportsVideo,
          compaction: options.compaction,
          clearToolUses: options.clearToolUses,
          userAgent: options.userAgent,
          defaultHeaders: options.defaultHeaders,
          // Flip to non-streaming fallback after repeated stream stalls.
          ...(useNonStreamingFallback ? { streaming: false } : {}),
        });
        diag("stream_created", { setupMs: Date.now() - streamCallStart });

        // Suppress unhandled rejection if the iterator path throws first
        result.response.catch(() => {});

        // Forward streaming deltas — reset idle timer on each event
        streamEventCount = 0;
        hasReceivedEvent = false;
        lastEventTime = Date.now();
        streamCallStart = Date.now();
        // Reset to streamCallStart so the first event's consumerLag reflects
        // network/provider latency, not the time spent before stream() returned.
        lastYieldEndTime = Date.now();
        resetIdleTimer();
        for await (const event of result) {
          // Measure consumer lag: time between finishing previous yield and
          // receiving this event. For event #1 this still includes network/
          // provider latency; for subsequent events it isolates how long
          // React/UI rendering held up the next pull.
          const pullTime = Date.now();
          const consumerLag = pullTime - lastYieldEndTime;
          // Only track mid-stream lag — first event lag is dominated by
          // server-side TTFB and would mask real UI starvation issues.
          if (streamEventCount > 0 && consumerLag > maxConsumerLagMs) {
            maxConsumerLagMs = consumerLag;
          }

          streamEventCount++;
          eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
          lastEventType = event.type;

          // Flip to mid-stream timeout on confirmed output events — text
          // deltas, completed tool calls, and tool call deltas (large file
          // writes can stream toolcall_delta for minutes without any text_delta).
          // Reasoning models (MiMo) are handled separately below — they can
          // stream hundreds of thinking events then pause minutes before output.
          if (
            (event.type === "text_delta" ||
              event.type === "server_toolcall" ||
              event.type === "toolcall_delta") &&
            !hasReceivedEvent
          ) {
            hasReceivedEvent = true;
            // Extend hard timeout now that output is actively streaming.
            // Long responses (plan mode, detailed code) can exceed 90s while
            // events flow continuously — the idle timeout (10s) catches real stalls.
            if (hardTimer && hardTimeoutMs < STREAM_OUTPUT_HARD_TIMEOUT_MS) {
              clearTimeout(hardTimer);
              hardTimeoutMs = STREAM_OUTPUT_HARD_TIMEOUT_MS;
              hardTimer = setTimeout(() => {
                diag("hard_timeout_fired", { events: streamEventCount });
                idleTimedOut = true;
                streamController.abort();
              }, hardTimeoutMs);
            }
          }
          // Track thinking events — extends idle timeout and hard timeout
          // so reasoning models aren't killed during thinking→output transition.
          if (event.type === "thinking_delta" && !hasReceivedThinking) {
            hasReceivedThinking = true;
            // Extend the hard timeout now that we know the model is reasoning
            if (hardTimer) clearTimeout(hardTimer);
            hardTimeoutMs = STREAM_THINKING_HARD_TIMEOUT_MS;
            hardTimer = setTimeout(() => {
              diag("hard_timeout_fired", { events: streamEventCount });
              idleTimedOut = true;
              streamController.abort();
            }, hardTimeoutMs);
          }

          const now = Date.now();
          const gap = now - lastEventTime;
          // Log first event and any suspiciously long gaps
          if (streamEventCount === 1) {
            diag("first_event", { type: event.type, ttfMs: now - streamCallStart });
          } else if (gap > 3000) {
            diag("slow_gap", {
              type: event.type,
              gapMs: gap,
              eventNum: streamEventCount,
              sinceStartMs: now - streamCallStart,
            });
          }
          lastEventTime = now;
          // The event is in hand -- the API has proven liveness, so stop the idle
          // timer for the duration of downstream processing. We re-arm it after
          // the yield completes (see below) so the idle window measures only API
          // silence, never the time our consumer/UI spent rendering this event.
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          if (event.type === "text_delta") {
            yield { type: "text_delta" as const, text: event.text };
          } else if (event.type === "thinking_delta") {
            yield { type: "thinking_delta" as const, text: event.text };
          } else if (event.type === "server_toolcall") {
            yield {
              type: "server_tool_call" as const,
              id: event.id,
              name: event.name,
              input: event.input,
            };
          } else if (event.type === "server_toolresult") {
            yield {
              type: "server_tool_result" as const,
              toolUseId: event.toolUseId,
              resultType: event.resultType,
              data: event.data,
            };
          } else if (event.type === "toolcall_delta") {
            const chunkChars = event.argsJson?.length ?? 0;
            toolcallDeltaChars += chunkChars;
            toolcallDeltaCount++;
            if (
              !runawayDetected &&
              (toolcallDeltaChars > MAX_TOOLCALL_DELTA_CHARS ||
                toolcallDeltaCount > MAX_TOOLCALL_DELTA_EVENTS)
            ) {
              runawayDetected = {
                kind: toolcallDeltaChars > MAX_TOOLCALL_DELTA_CHARS ? "chars" : "events",
                chars: toolcallDeltaChars,
                events: toolcallDeltaCount,
              };
              diag("runaway_toolcall_detected", {
                ...runawayDetected,
                provider: options.provider,
                model: options.model,
              });
              streamController.abort();
            }
            yield {
              type: "toolcall_delta" as const,
              chars: chunkChars,
            };
          }
          lastYieldEndTime = Date.now();
          // Re-arm the idle timer only now that we're done yielding -- the
          // countdown to the next event excludes the render time above.
          resetIdleTimer();
        }

        diag("stream_done", {
          events: streamEventCount,
          totalMs: Date.now() - streamCallStart,
          maxConsumerLagMs,
          eventTypes: eventTypeCounts,
        });
        response = await result.response;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        diag("stream_error", {
          error: errMsg.slice(0, 200),
          events: streamEventCount,
          totalMs: Date.now() - streamCallStart,
          idleTimedOut,
          aborted: !!options.signal?.aborted,
          eventTypes: eventTypeCounts,
          provider: options.provider,
          model: options.model,
        });
        // Subscription/plan usage-window exhaustion (e.g. Anthropic OAuth plan
        // out of usage). Not a transient throttle — retrying just burns minutes
        // before failing, which looks like a hang. Surface immediately so the
        // host UI shows a clear "usage finished" message. The conversation in
        // `messages` is left intact so the user can resume once it resets.
        if (isUsageLimitError(err)) {
          diag("usage_limit_reached", {
            provider: options.provider,
            model: options.model,
          });
          throw err;
        }
        // Context overflow: try a forced compaction before giving up.
        // The pre-turn transformContext check uses estimated tokens, which can
        // underestimate code-heavy content. When the API confirms overflow we
        // compact unconditionally and retry the turn, capped at
        // MAX_OVERFLOW_COMPACTIONS to avoid loops when compaction can't reduce
        // enough (e.g. single huge user message).
        if (isContextOverflow(err)) {
          const overflowDetails = extractContextOverflowDetails(err);
          diag("context_overflow_detected", {
            ...overflowDetails,
            error: errMsg.slice(0, 500),
            messages: messages.length,
          });

          const overflowToolResultMaxChars = Math.min(
            options.maxToolResultChars ?? 100_000,
            100_000,
          );
          if (!toolResultTruncationAttempted) {
            toolResultTruncationAttempted = true;
            const truncated = truncateOversizedToolResults(messages, overflowToolResultMaxChars);
            diag("overflow_tool_result_truncation", {
              truncated,
              maxChars: overflowToolResultMaxChars,
            });
            if (truncated) {
              yield {
                type: "retry" as const,
                reason: "overflow_compact" as const,
                attempt: overflowCompactionAttempts + 1,
                maxAttempts: MAX_OVERFLOW_COMPACTIONS,
                delayMs: 0,
                ...overflowDetails,
                silent: true,
              };
              turn--;
              continue;
            }
          }

          if (options.transformContext && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTIONS) {
            overflowCompactionAttempts++;
            diag("overflow_compact_start", {
              attempt: overflowCompactionAttempts,
              maxAttempts: MAX_OVERFLOW_COMPACTIONS,
              messages: messages.length,
              ...overflowDetails,
            });
            try {
              const compacted = await options.transformContext(messages, { force: true });
              if (compacted !== messages && compacted.length < messages.length) {
                messages.length = 0;
                messages.push(...compacted);
                diag("overflow_compact_success", {
                  attempt: overflowCompactionAttempts,
                  messages: messages.length,
                  ...overflowDetails,
                });
                yield {
                  type: "retry" as const,
                  reason: "overflow_compact" as const,
                  attempt: overflowCompactionAttempts,
                  maxAttempts: MAX_OVERFLOW_COMPACTIONS,
                  delayMs: 0,
                  ...overflowDetails,
                };
                turn--;
                continue;
              }
              diag("overflow_compact_noop", {
                attempt: overflowCompactionAttempts,
                before: messages.length,
                after: compacted.length,
                ...overflowDetails,
              });
            } catch (compactErr) {
              diag("overflow_compact_failed", {
                error: compactErr instanceof Error ? compactErr.message : String(compactErr),
                ...overflowDetails,
              });
            }
          }
          yield { type: "error" as const, error: err instanceof Error ? err : new Error(errMsg) };
          throw err;
        }
        // Transient provider errors (5xx), overload, and rate-limit: exponential backoff.
        const overloadKind = classifyOverload(err);
        if (overloadRetries < MAX_OVERLOAD_RETRIES && overloadKind) {
          overloadRetries++;
          // Honor a server-stated reset time (e.g. Gemini's RetryInfo.retryDelay)
          // when present, so we wait exactly as long as the provider asked
          // instead of guessing with blind exponential backoff. Fall back to
          // exponential backoff otherwise.
          const serverDelayMs = serverResetDelayMs(err);
          const delayMs =
            serverDelayMs !== undefined
              ? Math.min(serverDelayMs, OVERLOAD_MAX_DELAY_MS)
              : Math.min(
                  OVERLOAD_BASE_DELAY_MS * 2 ** (overloadRetries - 1),
                  OVERLOAD_MAX_DELAY_MS,
                );
          diag("retry", {
            reason: overloadKind,
            attempt: overloadRetries,
            maxAttempts: MAX_OVERLOAD_RETRIES,
            delayMs,
          });
          yield {
            type: "retry" as const,
            reason: overloadKind,
            attempt: overloadRetries,
            maxAttempts: MAX_OVERLOAD_RETRIES,
            delayMs,
          };
          await abortableSleep(delayMs, options.signal);
          turn--; // Don't count the failed turn
          continue;
        }
        // Stream stall: the API connection hung without closing.
        // Malformed stream: the SDK's SSE decoder hit truncated/corrupted JSON.
        // Both are transport failures — retry with exponential backoff and flip
        // to non-streaming mode after STALL_RETRIES_BEFORE_NON_STREAMING attempts,
        // since broken SSE often recovers when replayed as plain HTTP.
        // Runaway tool-call: the model never closed a tool-call block and
        // blew past the size/count caps. Retrying just reproduces the loop,
        // so surface a clear error and stop. Checked before the abort branch
        // since we ourselves aborted the stream to break the runaway.
        if (runawayDetected) {
          diag("runaway_toolcall_aborted", {
            ...runawayDetected,
            provider: options.provider,
            model: options.model,
          });
          const detail =
            runawayDetected.kind === "chars"
              ? `${(runawayDetected.chars / 1024).toFixed(0)} KB of tool-call arguments`
              : `${runawayDetected.events} tool-call delta events`;
          yield {
            type: "error" as const,
            error: new Error(
              `The model glitched mid-tool-call and produced ${detail} without closing the call. ` +
                `This is usually an upstream model bug — try the same request again or switch models. ` +
                `Your conversation is preserved.`,
            ),
          };
          break;
        }
        const malformed = isMalformedStream(err);
        const socketDrop = isTransportFailure(err);
        const transportFailure =
          (idleTimedOut || malformed || socketDrop) && !options.signal?.aborted;
        if (transportFailure && stallRetries < MAX_STALL_RETRIES) {
          stallRetries++;
          const cause = malformed
            ? "malformed_stream"
            : socketDrop
              ? "socket_drop"
              : "stream_stall";
          if (!useNonStreamingFallback && stallRetries >= STALL_RETRIES_BEFORE_NON_STREAMING) {
            useNonStreamingFallback = true;
            diag("non_streaming_fallback_enabled", {
              stallRetries,
              provider: options.provider,
              model: options.model,
              cause,
            });
          }
          const delayMs = Math.min(STALL_DELAY_MS * 2 ** (stallRetries - 1), 8_000);
          diag("retry", {
            reason: cause,
            attempt: stallRetries,
            maxAttempts: MAX_STALL_RETRIES,
            delayMs,
            events: streamEventCount,
            nonStreaming: useNonStreamingFallback,
          });
          yield {
            type: "retry" as const,
            reason: "stream_stall" as const,
            attempt: stallRetries,
            maxAttempts: MAX_STALL_RETRIES,
            delayMs,
            silent: stallRetries <= 2,
          };
          await abortableSleep(delayMs, options.signal);
          turn--; // Don't count the failed turn
          continue;
        }
        // Stream stall retries exhausted — surface a clear error so the UI
        // can distinguish "gave up after stalls" from "completed normally".
        if (transportFailure) {
          diag("stall_exhausted", {
            stallRetries: MAX_STALL_RETRIES,
            provider: options.provider,
            model: options.model,
          });
          yield {
            type: "error" as const,
            error: new Error(
              `The API provider's stream stalled ${MAX_STALL_RETRIES} times — the provider may be experiencing capacity issues. ` +
                `Your conversation is preserved. Send another message to retry.`,
            ),
          };
          break;
        }
        // Tool pairing 400: orphaned tool_result or tool_use in message history.
        // Run repair and retry once — if repair can't fix it, surface the error.
        if (isToolPairingError(err) && !toolPairingRepaired) {
          toolPairingRepaired = true;
          diag("tool_pairing_repair", { error: errMsg.slice(0, 200) });
          repairToolPairingAdjacent(messages);
          turn--;
          continue;
        }
        // Thinking-block integrity 400: a signed thinking block in the latest
        // assistant message couldn't be validated (commonly a partial signature
        // from an interrupted stream). Strip thinking from history — preserving
        // the reasoning as text — and retry once.
        if (isThinkingBlockError(err) && !thinkingBlocksStripped) {
          thinkingBlocksStripped = true;
          diag("thinking_block_repair", { error: errMsg.slice(0, 200) });
          stripThinkingBlocks(messages);
          turn--;
          continue;
        }
        // Abort errors (user cancellation) — exit loop cleanly instead of
        // crashing the process with an unhandled rejection.
        if (isAbortError(err) || options.signal?.aborted) {
          diag("aborted", { turn, provider: options.provider, model: options.model });
          break;
        }
        // Unhandled error — log before throwing so the crash is traceable
        diag("unhandled_error", {
          error: errMsg.slice(0, 500),
          turn,
          provider: options.provider,
          model: options.model,
        });
        throw err;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        options.signal?.removeEventListener("abort", forwardAbort);
      }

      overloadRetries = 0;
      stallRetries = 0;

      // Detect empty/degenerate responses — the API occasionally returns 0 tokens
      // with no content, or "thinks" without producing actionable output.
      // Reasoning models (MiMo, DeepSeek) may report outputTokens > 0 from
      // thinking alone while producing no text or tool calls — still a dud.
      const contentArr = Array.isArray(response.message.content) ? response.message.content : null;
      const hasActionableContent =
        response.message.content !== "" &&
        contentArr !== null &&
        contentArr.some(
          (p) => p.type === "text" || p.type === "tool_call" || p.type === "server_tool_call",
        );
      if (!hasActionableContent) {
        if (emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
          emptyResponseRetries++;
          diag("retry", {
            reason: "empty_response",
            attempt: emptyResponseRetries,
            maxAttempts: MAX_EMPTY_RESPONSE_RETRIES,
            provider: options.provider,
            model: options.model,
            contentTypes: contentArr?.map((p) => p.type).join(",") ?? "empty",
          });
          yield {
            type: "retry" as const,
            reason: "empty_response" as const,
            attempt: emptyResponseRetries,
            maxAttempts: MAX_EMPTY_RESPONSE_RETRIES,
            delayMs: 0,
          };
          turn--; // Don't count the failed turn — keep useNonStreamingFallback set
          // so the retry doesn't bounce back into a streaming connection that
          // will stall again with the same upstream problem.
          continue;
        }
        // Exhausted retries — fall through and let the agent finish
      }
      emptyResponseRetries = 0;

      // Only clear the non-streaming fallback after an actionable response —
      // an empty non-streaming reply means the upstream issue hasn't resolved,
      // so staying in non-streaming mode avoids retrying into another stall.
      useNonStreamingFallback = false;

      // Accumulate usage
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      if (response.usage.cacheRead) {
        totalUsage.cacheRead = (totalUsage.cacheRead ?? 0) + response.usage.cacheRead;
      }
      if (response.usage.cacheWrite) {
        totalUsage.cacheWrite = (totalUsage.cacheWrite ?? 0) + response.usage.cacheWrite;
      }

      // Append assistant message to conversation
      messages.push(response.message);

      yield {
        type: "turn_end" as const,
        turn,
        stopReason: response.stopReason,
        usage: response.usage,
      };

      // Server-side tool hit iteration limit — re-send to continue.
      // Do NOT add an extra user message; the API detects the trailing
      // server_tool_use block and resumes automatically.
      if (response.stopReason === "pause_turn") {
        consecutivePauses++;
        if (consecutivePauses >= maxContinuations) {
          break; // Safety limit — fall through to agent_done below
        }
        continue;
      }
      consecutivePauses = 0;

      // Extract tool calls — separate client-executed from provider built-in (e.g. Moonshot $web_search)
      const allToolCalls = extractToolCalls(response.message.content);

      // If no tool calls to execute, check for steering messages before stopping.
      // Check content (not just stopReason) because some providers (e.g. GLM)
      // return finish_reason="stop" even when tool calls are present.
      if (response.stopReason !== "tool_use" && allToolCalls.length === 0) {
        // Check for queued steering messages — if present, inject and continue
        // the loop instead of returning (follow-up pattern).
        if (options.getSteeringMessages) {
          const steering = await options.getSteeringMessages();
          if (steering && steering.length > 0) {
            for (const msg of steering) {
              yield { type: "steering_message" as const, content: msg.content };
              messages.push(msg);
            }
            continue; // Next iteration will call LLM with injected messages
          }
        }
        // Follow-up: lower priority than steering — only when agent would otherwise stop.
        if (options.getFollowUpMessages) {
          const followUp = await options.getFollowUpMessages();
          if (followUp && followUp.length > 0) {
            for (const msg of followUp) {
              yield { type: "follow_up_message" as const, content: msg.content };
              messages.push(msg);
            }
            continue;
          }
        }
        yield {
          type: "agent_done" as const,
          totalTurns: turn,
          totalUsage: { ...totalUsage },
        };
        return {
          message: response.message,
          totalTurns: turn,
          totalUsage: { ...totalUsage },
        };
      }
      const toolCalls: ToolCall[] = [];
      const toolResults: ToolResult[] = [];

      for (const tc of allToolCalls) {
        if (tc.name.startsWith("$")) {
          // Provider built-in tool (e.g. Moonshot $web_search) — not locally executed.
          // Still needs a tool_result for the message history round-trip.
          toolResults.push({
            type: "tool_result",
            toolCallId: tc.id,
            content: JSON.stringify(tc.args),
          });
        } else {
          toolCalls.push(tc);
        }
      }

      let fatalToolArgumentError: Error | null = null;
      const markFatalToolArgumentError = (error: Error): void => {
        fatalToolArgumentError = error;
      };
      const executionOptions: ToolBatchExecutionOptions = {
        signal: options.signal,
        maxToolResultChars: options.maxToolResultChars,
        toolMap,
        invalidToolArgumentCounts,
        markFatalToolArgumentError,
      };
      const hasSequentialToolCall = toolCalls.some(
        (toolCall) => toolMap.get(toolCall.name)?.executionMode === "sequential",
      );
      const executionResult = hasSequentialToolCall
        ? yield* executeToolCallsSequential(toolCalls, toolResults, executionOptions)
        : yield* executeToolCallsParallel(toolCalls, toolResults, executionOptions);
      messages.push({ role: "tool", content: executionResult.toolResults });
      const toolsAborted = executionResult.aborted;

      if (fatalToolArgumentError) {
        yield { type: "error" as const, error: fatalToolArgumentError };
        break;
      }

      // Exit loop after cleaning up aborted tools
      if (toolsAborted) break;

      // ── Steering messages: inject user messages queued during tool execution ──
      // Polled after tools complete so the next LLM call sees them in context.
      if (options.getSteeringMessages) {
        const steering = await options.getSteeringMessages();
        if (steering && steering.length > 0) {
          for (const msg of steering) {
            yield { type: "steering_message" as const, content: msg.content };
            messages.push(msg);
          }
        }
      }
    }
  } finally {
    // Sanitize orphaned server_tool_use blocks on abort.
    // When a stream is aborted mid-server-tool (e.g. web_search), the
    // assistant message containing the server_tool_use may already be in
    // the messages array, but the corresponding web_search_tool_result
    // never arrived.  The API rejects the next request with a 400 if it
    // finds an unmatched server_tool_use, so we strip it here.
    sanitizeOrphanedServerTools(messages);
  }

  // Exceeded max turns — return last assistant message
  let lastAssistant: AssistantMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = messages[i] as AssistantMessage;
      break;
    }
  }

  yield {
    type: "agent_done" as const,
    totalTurns: turn,
    totalUsage: { ...totalUsage },
  };

  return {
    message: lastAssistant ?? { role: "assistant" as const, content: [] },
    totalTurns: turn,
    totalUsage: { ...totalUsage },
  };
}

interface ToolExecutionRecord {
  toolCallId: string;
  content: ToolResultContent;
  isError: boolean;
}

interface ToolBatchExecutionOptions {
  signal?: AbortSignal;
  maxToolResultChars?: number;
  toolMap: Map<string, AgentTool>;
  invalidToolArgumentCounts: Map<string, number>;
  markFatalToolArgumentError: (error: Error) => void;
}

interface ToolBatchExecutionResult {
  toolResults: ToolResult[];
  aborted: boolean;
}

interface ToolEventState {
  finalized: boolean;
}

function pushToolEvent(
  eventStream: EventStream<AgentEvent>,
  state: ToolEventState,
  event: AgentEvent,
): void {
  if (!state.finalized) eventStream.push(event);
}

async function executeSingleToolCall(
  toolCall: ToolCall,
  options: ToolBatchExecutionOptions,
  pushEvent: (event: AgentEvent) => void,
): Promise<ToolExecutionRecord> {
  const startTime = Date.now();

  pushEvent({
    type: "tool_call_start" as const,
    toolCallId: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
  });

  let resultContent: ToolResultContent;
  let details: unknown;
  let isError = false;

  const tool = options.toolMap.get(toolCall.name);
  if (!tool) {
    resultContent = `Unknown tool: ${toolCall.name}`;
    isError = true;
  } else {
    try {
      const parsed = tool.parameters.parse(toolCall.args);
      const ctx: ToolContext = {
        signal: options.signal ?? AbortSignal.timeout(300_000),
        toolCallId: toolCall.id,
        onUpdate: (update: unknown) => {
          pushEvent({
            type: "tool_call_update" as const,
            toolCallId: toolCall.id,
            update,
          });
        },
      };
      const raw = await tool.execute(parsed, ctx);
      const normalized = normalizeToolResult(raw);
      resultContent = normalized.content;
      details = normalized.details;
      for (const key of options.invalidToolArgumentCounts.keys()) {
        if (key.startsWith(`${toolCall.name}:`)) options.invalidToolArgumentCounts.delete(key);
      }
    } catch (err) {
      isError = true;
      if (err instanceof ZodError) {
        // Zod v4's default `.message` is a JSON dump of `.issues`, which
        // the model can't act on. Prettify into "field X: expected Y,
        // received Z" lines so the next call comes back with valid args.
        const prettyError = prettifyError(err);
        const failureKey = `${toolCall.name}:${prettyError}`;
        const failureCount = (options.invalidToolArgumentCounts.get(failureKey) ?? 0) + 1;
        options.invalidToolArgumentCounts.set(failureKey, failureCount);
        resultContent =
          `Invalid arguments for tool \`${toolCall.name}\`:\n` +
          prettyError +
          "\nRe-issue the call with each field as the correct type.";
        if (failureCount >= 3) {
          options.markFatalToolArgumentError(
            new Error(
              `The model repeatedly issued invalid arguments for tool \`${toolCall.name}\`. ` +
                `This is usually an upstream model/tool-calling bug. Your conversation is preserved; ` +
                `send another message or switch models to continue.`,
            ),
          );
        }
      } else {
        resultContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const durationMs = Date.now() - startTime;

  pushEvent({
    type: "tool_call_end" as const,
    toolCallId: toolCall.id,
    result: toolResultPreview(resultContent),
    details,
    isError,
    durationMs,
  });

  return { toolCallId: toolCall.id, content: resultContent, isError };
}

async function* executeToolCallsSequential(
  toolCalls: ToolCall[],
  initialToolResults: ToolResult[],
  options: ToolBatchExecutionOptions,
): AsyncGenerator<AgentEvent, ToolBatchExecutionResult> {
  const eventStream = new EventStream<AgentEvent>();
  const state: ToolEventState = { finalized: false };
  const resultsById = new Map<string, ToolExecutionRecord>();
  const abortHandler = () => eventStream.abort(new Error("aborted"));
  options.signal?.addEventListener("abort", abortHandler, { once: true });

  void (async () => {
    try {
      for (const toolCall of toolCalls) {
        if (options.signal?.aborted) break;
        const record = await executeSingleToolCall(toolCall, options, (event) =>
          pushToolEvent(eventStream, state, event),
        );
        resultsById.set(record.toolCallId, record);
      }
      if (!state.finalized) eventStream.close();
    } catch (err) {
      if (!state.finalized) eventStream.abort(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  let aborted = false;
  try {
    for await (const event of eventStream) {
      yield event;
    }
  } catch (err) {
    if (isAbortError(err) || options.signal?.aborted) {
      aborted = true;
    } else {
      throw err;
    }
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    state.finalized = true;
  }

  const toolResults = buildToolResults(initialToolResults, toolCalls, resultsById);
  capToolResults(toolResults, options.maxToolResultChars);
  return { toolResults, aborted };
}

async function* executeToolCallsParallel(
  toolCalls: ToolCall[],
  initialToolResults: ToolResult[],
  options: ToolBatchExecutionOptions,
): AsyncGenerator<AgentEvent, ToolBatchExecutionResult> {
  const eventStream = new EventStream<AgentEvent>();
  const state: ToolEventState = { finalized: false };
  const resultsById = new Map<string, ToolExecutionRecord>();
  const abortHandler = () => eventStream.abort(new Error("aborted"));
  options.signal?.addEventListener("abort", abortHandler, { once: true });

  Promise.all(
    toolCalls.map(async (toolCall) => {
      const record = await executeSingleToolCall(toolCall, options, (event) =>
        pushToolEvent(eventStream, state, event),
      );
      resultsById.set(record.toolCallId, record);
    }),
  )
    .then(() => {
      if (!state.finalized) eventStream.close();
    })
    .catch((err) => {
      if (!state.finalized) eventStream.abort(err instanceof Error ? err : new Error(String(err)));
    });

  let aborted = false;
  try {
    for await (const event of eventStream) {
      yield event;
    }
  } catch (err) {
    if (isAbortError(err) || options.signal?.aborted) {
      aborted = true;
    } else {
      throw err;
    }
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    state.finalized = true;
  }

  const toolResults = buildToolResults(initialToolResults, toolCalls, resultsById);
  capToolResults(toolResults, options.maxToolResultChars);
  return { toolResults, aborted };
}

function buildToolResults(
  initialToolResults: ToolResult[],
  toolCalls: ToolCall[],
  resultsById: Map<string, ToolExecutionRecord>,
): ToolResult[] {
  const toolResults = [...initialToolResults];
  for (const toolCall of toolCalls) {
    const result = resultsById.get(toolCall.id);
    if (result) {
      toolResults.push({
        type: "tool_result",
        toolCallId: toolCall.id,
        content: result.content,
        isError: result.isError || undefined,
      });
    } else {
      toolResults.push({
        type: "tool_result",
        toolCallId: toolCall.id,
        content: "Tool execution was aborted.",
        isError: true,
      });
    }
  }
  return toolResults;
}

function capToolResults(toolResults: ToolResult[], maxToolResultChars: number | undefined): void {
  if (!maxToolResultChars) return;
  const hardMax = 400_000; // absolute ceiling regardless of context window
  const max = Math.min(maxToolResultChars, hardMax);
  for (const toolResult of toolResults) {
    if (typeof toolResult.content !== "string" || toolResult.content.length <= max) continue;
    // Keep 70% head + 30% tail to preserve errors/diagnostics at the end.
    const headChars = Math.floor(max * 0.7);
    const tailChars = max - headChars;
    const head = toolResult.content.slice(0, headChars);
    const tail = toolResult.content.slice(-tailChars);
    const omitted = toolResult.content.length - headChars - tailChars;
    toolResult.content = head + `\n\n[... ${omitted} characters omitted ...]\n\n` + tail;
  }
}

function normalizeToolResult(raw: ToolExecuteResult): StructuredToolResult {
  return typeof raw === "string" ? { content: raw } : raw;
}

/** Flatten tool result content to a plain-text preview for the tool_call_end event.
 *  Image blocks become a "[image]" placeholder so the UI has something to render. */
function toolResultPreview(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mediaType}]`))
    .join("\n");
}

function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tailChars = Math.min(Math.floor(maxChars * 0.3), 20_000);
  const headChars = Math.max(maxChars - tailChars, 0);
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n[... ${omitted} characters omitted after context overflow ...]\n\n${text.slice(-tailChars)}`;
}

function truncateOversizedToolResults(messages: Message[], maxChars: number): boolean {
  if (maxChars <= 0) return false;
  let changed = false;
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    const results = msg.content as ToolResult[];
    for (const result of results) {
      if (typeof result.content === "string") {
        const truncated = truncateToolResultText(result.content, maxChars);
        if (truncated !== result.content) {
          result.content = truncated;
          changed = true;
        }
      } else {
        for (const block of result.content) {
          if (block.type !== "text") continue;
          const truncated = truncateToolResultText(block.text, maxChars);
          if (truncated !== block.text) {
            block.text = truncated;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

function extractToolCalls(content: string | ContentPart[]): ToolCall[] {
  if (typeof content === "string") return [];
  return content.filter((part): part is ToolCall => part.type === "tool_call");
}

/**
 * Remove orphaned server_tool_use blocks from the last assistant message.
 * When a stream is aborted mid-server-tool (e.g. web_search), the assistant
 * message may contain a server_tool_call without a matching server_tool_result.
 * The API rejects the next request if these are unmatched.
 */
function sanitizeOrphanedServerTools(messages: Message[]): void {
  // Find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) break;

    // Collect server_tool_call ids and matched server_tool_result ids
    const serverToolIds = new Set<string>();
    const resultToolIds = new Set<string>();
    for (const part of msg.content) {
      if (part.type === "server_tool_call") serverToolIds.add(part.id);
      if (part.type === "server_tool_result") resultToolIds.add(part.toolUseId);
    }

    // Find unmatched server_tool_call blocks
    const orphanedIds = new Set<string>();
    for (const id of serverToolIds) {
      if (!resultToolIds.has(id)) orphanedIds.add(id);
    }

    if (orphanedIds.size === 0) break;

    // Strip orphaned server_tool_call blocks from the content
    const filtered = msg.content.filter(
      (part) => !(part.type === "server_tool_call" && orphanedIds.has(part.id)),
    );

    if (filtered.length === 0) {
      // Nothing left — remove the entire message
      messages.splice(i, 1);
    } else {
      (msg as { content: ContentPart[] }).content = filtered;
    }
    break;
  }
}

/**
 * Ensure every assistant message with tool_call blocks is immediately followed
 * by a tool message with matching tool_result entries. This prevents Anthropic
 * API 400 errors ("tool_use ids found without tool_result blocks immediately
 * after") that can occur after compaction, session restore, or abort recovery.
 *
 * Repairs in-place by inserting synthetic tool_result messages where needed.
 */
function repairToolPairingAdjacent(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;

    const toolCallIds = (msg.content as ContentPart[])
      .filter((p) => p.type === "tool_call")
      .map((p) => (p as ContentPart & { type: "tool_call"; id: string }).id);
    if (toolCallIds.length === 0) continue;

    const next = messages[i + 1];
    if (next?.role === "tool" && Array.isArray(next.content)) {
      // Tool message exists — check for missing results
      const existingIds = new Set((next.content as ToolResult[]).map((r) => r.toolCallId));
      const missing = toolCallIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        for (const id of missing) {
          (next.content as ToolResult[]).push({
            type: "tool_result",
            toolCallId: id,
            content: "Tool execution was interrupted.",
            isError: true,
          });
        }
      }
    } else {
      // No tool message follows — insert a synthetic one
      messages.splice(i + 1, 0, {
        role: "tool" as const,
        content: toolCallIds.map((id) => ({
          type: "tool_result" as const,
          toolCallId: id,
          content: "Tool execution was interrupted.",
          isError: true,
        })),
      });
    }
  }

  // Reverse repair: strip tool_result entries whose tool_use_id has no matching
  // tool_call in the preceding assistant message. This can happen when compaction
  // or stall recovery removes an assistant message but leaves its tool_result behind.
  const toolCallIdSet = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const p of msg.content as ContentPart[]) {
        if (p.type === "tool_call") toolCallIdSet.add((p as ToolCall).id);
      }
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      const results = msg.content as ToolResult[];
      const filtered = results.filter((r) => toolCallIdSet.has(r.toolCallId));
      if (filtered.length === 0) {
        // Entire tool message is orphaned — remove it
        messages.splice(i, 1);
        i--;
      } else if (filtered.length < results.length) {
        (msg as { content: ToolResult[] }).content = filtered;
      }
    }
  }
}

/**
 * Strip thinking / redacted_thinking content from every assistant message in
 * place. Last-resort recovery when Anthropic rejects the request for a
 * thinking-block integrity violation (e.g. a corrupt signature from an
 * interrupted stream). Reasoning text is preserved as a plain text block so no
 * conversational context is lost; tool_call/tool_result pairing is untouched.
 */
function stripThinkingBlocks(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const next: ContentPart[] = [];
    for (const part of msg.content as ContentPart[]) {
      if (part.type === "thinking") {
        if (part.text) next.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "raw") {
        const t = (part.data as { type?: string }).type;
        if (t === "thinking" || t === "redacted_thinking") continue;
      }
      next.push(part);
    }
    (msg as { content: ContentPart[] }).content = next;
  }
}
