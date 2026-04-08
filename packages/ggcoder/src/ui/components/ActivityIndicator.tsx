import React, { useMemo, useRef } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";

import { SPINNER_FRAMES, SPINNER_INTERVAL, REDUCED_MOTION_DOT } from "../spinner-frames.js";
import { PLANNING_PHRASES, selectPhrases, shuffleArray } from "../activity-phrases.js";
import {
  useAnimationTick,
  useAnimationActive,
  deriveFrame,
  useReducedMotion,
} from "./AnimationContext.js";

// ── Color pulse cycle ─────────────────────────────────────

const PULSE_COLORS = [
  "#60a5fa", // blue
  "#818cf8", // indigo
  "#a78bfa", // violet
  "#818cf8", // indigo (back)
  "#60a5fa", // blue (back)
  "#38bdf8", // sky
  "#60a5fa", // blue (back)
];

const PLAN_PULSE_COLORS = [
  "#f59e0b", // amber
  "#fbbf24", // amber light
  "#f59e0b", // amber
  "#d97706", // amber dark
  "#f59e0b", // amber
  "#fbbf24", // amber light
  "#d97706", // amber dark
];
const PULSE_INTERVAL = 400;

// ── Ellipsis animation ────────────────────────────────────

const ELLIPSIS_FRAMES = ["", ".", "..", "..."];
const ELLIPSIS_INTERVAL = 500;

// ── Phrase rotation ───────────────────────────────────────

const WAITING_PHRASE_INTERVAL = 3000;
const OTHER_PHRASE_INTERVAL = 4000;

// ── Formatting helpers ────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

function buildMetaSuffix(
  elapsedMs: number,
  thinkingMs: number,
  isThinking: boolean,
  tokenEstimate: number,
): string {
  const parts: string[] = [];
  parts.push(formatElapsed(elapsedMs));

  if (tokenEstimate > 0) parts.push(`↓ ${formatTokenCount(tokenEstimate)} tokens`);

  if (isThinking) {
    // Live label — always show while thinking, add duration once >= 1s
    parts.push(thinkingMs >= 1000 ? `thinking for ${formatElapsed(thinkingMs)}` : "thinking");
  } else if (thinkingMs >= 1000) {
    // Frozen — past tense with duration
    parts.push(`thought for ${formatElapsed(thinkingMs)}`);
  }

  return parts.join(" · ");
}

// ── Shimmer effect ────────────────────────────────────────

const SHIMMER_WIDTH = 3;
const SHIMMER_INTERVAL = 100;

const ShimmerText: React.FC<{ text: string; color: string; shimmerPos: number }> = ({
  text,
  color,
  shimmerPos,
}) => (
  <Text>
    {text.split("").map((char, i) => {
      const isBright = Math.abs(i - shimmerPos) <= SHIMMER_WIDTH;
      return (
        <Text bold={isBright} color={color} dimColor={!isBright} key={i}>
          {char}
        </Text>
      );
    })}
  </Text>
);

// ── Component ─────────────────────────────────────────────

interface ActivityIndicatorProps {
  phase: ActivityPhase;
  elapsedMs: number;
  /** Run start time ref — for smooth elapsed time on each animation tick. */
  runStartRef?: React.RefObject<number>;
  thinkingMs: number;
  isThinking: boolean;
  tokenEstimate: number;
  /** Raw character count ref for smooth token animation (read every tick). */
  charCountRef?: React.RefObject<number>;
  /** Accumulated real tokens from completed turns. */
  realTokensAccumRef?: React.RefObject<number>;
  userMessage?: string;
  activeToolNames?: string[];
  planMode?: boolean;
  retryInfo?: RetryInfo | null;
  planDone?: number;
  planTotal?: number;
}

const RETRY_REASON_LABELS: Record<RetryInfo["reason"], string> = {
  overloaded: "Provider overloaded",
  rate_limit: "Rate limited",
  empty_response: "Empty response",
  stream_stall: "Provider stream stalled",
};

export function ActivityIndicator({
  phase,
  elapsedMs: elapsedMsProp,
  runStartRef,
  thinkingMs,
  isThinking,
  tokenEstimate,
  charCountRef: charCountRefProp,
  realTokensAccumRef: realTokensAccumRefProp,
  userMessage = "",
  activeToolNames = [],
  planMode,
  retryInfo,
  planDone = 0,
  planTotal = 0,
}: ActivityIndicatorProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  // Smooth elapsed time: compute from runStartRef on each animation tick
  // instead of using the 1000ms state update (which looks jerky).
  const elapsedMs =
    runStartRef?.current && phase !== "idle" ? Date.now() - runStartRef.current : elapsedMsProp;

  // Use the global animation tick instead of a local timer.
  // This eliminates a duplicate 100ms setInterval that was causing
  // independent re-renders on top of the global AnimationProvider tick.
  useAnimationActive();
  const tick = useAnimationTick();

  // ── Smooth token counter animation ─────────────────────
  // Smooths the TOTAL token estimate (real + estimated) so it never
  // jumps — whether tokens arrive from streaming deltas or from
  // turn_end replacing char estimates with real API counts.
  //
  // On each 100ms animation tick the displayed count catches up to
  // the target at a speed that scales with the gap, producing a
  // rolling-odometer effect.
  const displayedTokensRef = useRef(0);
  const currentChars = charCountRefProp?.current ?? 0;
  const realTokens = realTokensAccumRefProp?.current ?? 0;
  const targetTokens = charCountRefProp ? realTokens + Math.ceil(currentChars / 4) : tokenEstimate;

  if (reducedMotion || !charCountRefProp) {
    displayedTokensRef.current = targetTokens;
  } else {
    const gap = targetTokens - displayedTokensRef.current;
    if (gap > 0) {
      // Scale increment with gap size for smooth catch-up
      let increment: number;
      if (gap < 20) {
        increment = 1;
      } else if (gap < 50) {
        increment = Math.max(2, Math.ceil(gap * 0.1));
      } else if (gap < 200) {
        increment = Math.max(5, Math.ceil(gap * 0.12));
      } else {
        // Large jump (e.g. turn_end real tokens) — faster catch-up
        increment = Math.max(15, Math.ceil(gap * 0.08));
      }
      displayedTokensRef.current = Math.min(displayedTokensRef.current + increment, targetTokens);
    } else if (gap < 0) {
      // Reset happened (new run) — snap to target
      displayedTokensRef.current = targetTokens;
    }
  }

  const smoothTokenEstimate = displayedTokensRef.current;

  // Derive all animation frames from the single tick counter
  const spinnerFrame = reducedMotion
    ? 0
    : deriveFrame(tick, SPINNER_INTERVAL, SPINNER_FRAMES.length);
  const pulseColors = planMode ? PLAN_PULSE_COLORS : PULSE_COLORS;
  const colorFrame = deriveFrame(tick, PULSE_INTERVAL, pulseColors.length);
  const ellipsisFrame = deriveFrame(tick, ELLIPSIS_INTERVAL, ELLIPSIS_FRAMES.length);

  // Phrase rotation — pick phrases based on phase + user message + active tools, shuffle, rotate
  const toolNamesKey = activeToolNames.sort().join(",");
  const phrases = useMemo(
    () =>
      shuffleArray(
        planMode && phase === "waiting"
          ? PLANNING_PHRASES
          : selectPhrases(phase, userMessage, activeToolNames),
      ),
    [phase, userMessage, toolNamesKey, planMode], // activeToolNames captured via stable string key
  );
  const phraseInterval = phase === "waiting" ? WAITING_PHRASE_INTERVAL : OTHER_PHRASE_INTERVAL;
  const phraseIndex = Math.floor((tick * SHIMMER_INTERVAL) / phraseInterval) % phrases.length;

  const spinnerColor = pulseColors[colorFrame];
  const phrase = phrases[phraseIndex] ?? phrases[0];
  const ellipsis = ELLIPSIS_FRAMES[ellipsisFrame];

  // Shimmer — derive position from tick, wrapping across phrase length
  const shimmerCycle = phrase.length + SHIMMER_WIDTH * 2;
  const shimmerPos = (tick % shimmerCycle) - SHIMMER_WIDTH;

  // Pad ellipsis to prevent text from shifting
  const paddedEllipsis = ellipsis + " ".repeat(3 - ellipsis.length);

  const meta = buildMetaSuffix(elapsedMs, thinkingMs, isThinking, smoothTokenEstimate);

  // ── Plan progress bar ──────────────────────────────────
  const planBar = useMemo(() => {
    if (planTotal <= 0) return null;
    const barWidth = Math.min(planTotal, 20);
    const filledWidth = Math.round((planDone / planTotal) * barWidth);
    return "\u2588".repeat(filledWidth) + "\u2591".repeat(barWidth - filledWidth);
  }, [planDone, planTotal]);

  // ── Retry display ──────────────────────────────────────
  if (phase === "retrying" && retryInfo) {
    const retryLabel = RETRY_REASON_LABELS[retryInfo.reason];
    const retryColor = "#f59e0b"; // amber
    const delaySec =
      retryInfo.delayMs > 0 ? ` waiting ${Math.round(retryInfo.delayMs / 1000)}s` : "";
    return (
      <Box>
        <Text color={retryColor} bold>
          {reducedMotion ? REDUCED_MOTION_DOT : SPINNER_FRAMES[spinnerFrame]}{" "}
        </Text>
        <Text color={retryColor}>
          {retryLabel} — retrying ({retryInfo.attempt}/{retryInfo.maxAttempts})
        </Text>
        <Text color={theme.textDim}>
          {delaySec}
          {"  ("}
          {formatElapsed(elapsedMs)}
          {")"}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={spinnerColor} bold>
        {reducedMotion ? REDUCED_MOTION_DOT : SPINNER_FRAMES[spinnerFrame]}{" "}
      </Text>
      {reducedMotion ? (
        <Text dimColor color={spinnerColor}>
          {phrase}
        </Text>
      ) : (
        <ShimmerText text={phrase} color={spinnerColor} shimmerPos={shimmerPos} />
      )}
      <Text color={theme.textDim}>{reducedMotion ? "..." : paddedEllipsis}</Text>
      {meta && (
        <Text color={theme.textDim}>
          {"  ("}
          {meta}
          {")"}
        </Text>
      )}
      {planBar && (
        <Text>
          {"  "}
          <Text color={planDone === planTotal ? theme.success : theme.planPrimary}>{planBar}</Text>
          <Text color={theme.textDim}>
            {" "}
            {planDone}/{planTotal}
          </Text>
        </Text>
      )}
    </Box>
  );
}
