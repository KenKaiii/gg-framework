import { useCallback, useRef, useState } from "react";
import { MENTOR_DISPLAY_NAME } from "./brand";
import type { Dispatch, SetStateAction } from "react";
import type { SidecarEvent } from "./agent";
import type { Item } from "./App";

/**
 * Ken Kai (mentor agent) client state + event handling, extracted from App.tsx.
 *
 * Ken runs as a second, read-only agent alongside the GG Coder build session, so
 * his activity is fully independent: his own running flag, token count, and
 * thinking timer (mirroring the build session's so his activity bar reads the
 * same), plus his own streaming bubble in the shared transcript. All of it is
 * driven by the `ken_*` family of SSE events, which `handleKenEvent` consumes.
 *
 * The hook owns no transcript array of its own — it appends/updates Ken bubbles
 * through the App's `setItems` (so Ken's messages interleave with the build
 * transcript) and mints ids with the App's shared `nextId` (so ids stay globally
 * unique). Only the `Item` type is imported, type-only, so there's no runtime
 * import cycle with App.
 */
export interface KenMentor {
  /** True while Ken is mid-run (drives his activity bar's visibility). */
  kenRunning: boolean;
  /** Accumulated output tokens for Ken's current run. */
  kenTokens: number;
  /** Timestamp (ms) Ken's run began, or null when idle. */
  kenRunStartTs: number | null;
  /** True while Ken is actively emitting reasoning/thinking. */
  kenIsThinking: boolean;
  /** Timestamp (ms) Ken's current thinking span began, or null. */
  kenThinkingStartTs: number | null;
  /** Completed thinking time (ms) from earlier spans in this run. */
  kenThinkingAccumMs: number;
  /**
   * Handle one `ken_*` SSE event. Returns true when the event belonged to Ken
   * and was consumed, so the caller can early-return; false for anything else.
   */
  handleKenEvent: (e: SidecarEvent) => boolean;
}

export function useKenMentor(opts: {
  setItems: Dispatch<SetStateAction<Item[]>>;
  nextId: () => number;
}): KenMentor {
  const { setItems, nextId } = opts;

  const [kenRunning, setKenRunning] = useState(false);
  // Ken's own activity metrics, mirroring the build session's so Ken's activity
  // bar shows the SAME elapsed/tokens/thinking readout (just tinted to Ken).
  const [kenTokens, setKenTokens] = useState(0);
  const [kenRunStartTs, setKenRunStartTs] = useState<number | null>(null);
  const [kenIsThinking, setKenIsThinking] = useState(false);
  const [kenThinkingStartTs, setKenThinkingStartTs] = useState<number | null>(null);
  const [kenThinkingAccumMs, setKenThinkingAccumMs] = useState(0);
  const kenTokensRef = useRef(0);
  const kenThinkingStartRef = useRef<number | null>(null);
  const kenThinkingAccumRef = useRef(0);
  // Id of the active Ken streaming bubble (null when Ken isn't streaming).
  const kenStreamingIdRef = useRef<number | null>(null);

  // Ken's streaming bubble. Ken's replies are short, so a direct setItems per
  // delta (no rAF buffering) is fine and keeps his path independent of GG
  // Coder's. First delta creates the magenta bubble; later deltas append to it.
  const appendKen = useCallback(
    (text: string) => {
      const current = kenStreamingIdRef.current;
      if (current === null) {
        const id = nextId();
        kenStreamingIdRef.current = id;
        setItems((prev) => [...prev, { kind: "ken", id, text }]);
      } else {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "ken" && it.id === current ? { ...it, text: it.text + text } : it,
          ),
        );
      }
    },
    [setItems, nextId],
  );

  // Ends the CURRENT Ken streaming bubble (also called mid-turn on tool calls to
  // break the bubble so post-tool text starts a fresh paragraph).
  const endKenStreaming = useCallback(() => {
    kenStreamingIdRef.current = null;
  }, []);

  // Close Ken's open thinking span (if any), folding its duration into the
  // accumulator. Mirrors the build's finalizeThinking. Called when text or a
  // tool begins, or the run ends, so the thinking timer doesn't over-count.
  const finalizeKenThinking = useCallback(() => {
    if (kenThinkingStartRef.current !== null) {
      kenThinkingAccumRef.current += Date.now() - kenThinkingStartRef.current;
      kenThinkingStartRef.current = null;
      setKenThinkingAccumMs(kenThinkingAccumRef.current);
      setKenThinkingStartTs(null);
    }
    setKenIsThinking(false);
  }, []);

  const handleKenEvent = useCallback(
    (e: SidecarEvent): boolean => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        // ── Ken Kai (mentor agent) ──────────────────────────────
        // Separate event family so Ken's reply renders in its own magenta
        // bubble and never touches GG Coder's streaming bubble / tool feed.
        case "ken_run_start":
          setKenRunning(true);
          endKenStreaming();
          // Reset Ken's activity metrics for this run (mirrors the build run_start).
          kenTokensRef.current = 0;
          kenThinkingStartRef.current = null;
          kenThinkingAccumRef.current = 0;
          setKenTokens(0);
          setKenRunStartTs(Date.now());
          setKenIsThinking(false);
          setKenThinkingStartTs(null);
          setKenThinkingAccumMs(0);
          return true;
        case "ken_text_delta":
          // First visible output ends any thinking span (mirrors finalizeThinking).
          finalizeKenThinking();
          appendKen(String(d.text ?? ""));
          return true;
        case "ken_thinking_delta":
          if (kenThinkingStartRef.current === null) {
            const now = Date.now();
            kenThinkingStartRef.current = now;
            setKenThinkingStartTs(now);
            setKenIsThinking(true);
          }
          return true;
        // A tool runs mid-turn: end Ken's current bubble so text streamed AFTER
        // the tool starts a fresh paragraph instead of gluing onto the pre-tool
        // text ("...work.Local tools..."). Mirrors the build session's
        // tool_call_start / server_tool_call handling. Covers both client tools
        // (read/grep/kencode-search) and Anthropic's native server web_search.
        case "ken_tool_call_start":
        case "ken_server_tool_call":
          // Close any open thinking span (mirrors the build's finalizeThinking on
          // tool_call_start) so the timer doesn't keep counting while a tool runs.
          finalizeKenThinking();
          endKenStreaming();
          return true;
        case "ken_turn_end": {
          const usage = d.usage as { outputTokens?: number } | undefined;
          if (usage && typeof usage.outputTokens === "number") {
            kenTokensRef.current += usage.outputTokens;
            setKenTokens(kenTokensRef.current);
          }
          return true;
        }
        case "ken_run_end":
          setKenRunning(false);
          endKenStreaming();
          // Close any open thinking span so the final readout is accurate.
          finalizeKenThinking();
          setKenRunStartTs(null);
          return true;
        case "ken_error": {
          setKenRunning(false);
          endKenStreaming();
          setKenIsThinking(false);
          setKenRunStartTs(null);
          // Structured payload from the sidecar's broadcastError; "Ken: " prefix on
          // the headline keeps it distinguishable from a GG Coder build error.
          const headline = typeof d.headline === "string" ? d.headline : undefined;
          setItems((prev) => [
            ...prev,
            headline
              ? {
                  kind: "error",
                  id: nextId(),
                  headline: `${MENTOR_DISPLAY_NAME}: ${headline}`,
                  message: typeof d.message === "string" ? d.message : undefined,
                  guidance: typeof d.guidance === "string" ? d.guidance : undefined,
                }
              : {
                  kind: "error",
                  id: nextId(),
                  text: `${MENTOR_DISPLAY_NAME}: ${String(d.message ?? "unknown")}`,
                },
          ]);
          return true;
        }
        // ken_tool_call_update / ken_tool_call_end carry Ken's read-only tool
        // activity; the activity bar (kenRunning) is the indicator, so they need
        // no transcript row. (ken_tool_call_start IS handled above to break the
        // streaming bubble around mid-turn tool calls.) Consume them so the
        // caller doesn't fall through to the build-event switch.
        case "ken_tool_call_update":
        case "ken_tool_call_end":
          return true;
        default:
          return false;
      }
    },
    [appendKen, endKenStreaming, finalizeKenThinking, setItems, nextId],
  );

  return {
    kenRunning,
    kenTokens,
    kenRunStartTs,
    kenIsThinking,
    kenThinkingStartTs,
    kenThinkingAccumMs,
    handleKenEvent,
  };
}
