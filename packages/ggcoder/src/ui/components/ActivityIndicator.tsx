import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";

import { SPINNER_FRAMES, SPINNER_INTERVAL, REDUCED_MOTION_DOT } from "../spinner-frames.js";
import { PLANNING_PHRASES, selectPhrases, shuffleArray } from "../activity-phrases.js";
import {
  useFocusedAnimation,
  deriveFrame,
  useReducedMotion,
  useTerminalFocus,
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

// ── Low-churn liveness ────────────────────────────────────

const LOW_CHURN_INTERVAL = 1000;
const LOW_CHURN_PHRASE_INTERVAL = 10_000;
const LOW_CHURN_COLOR_INTERVAL = 2000;
const HEARTBEAT_DOT_COUNT = 3;
const HEARTBEAT_ACTIVE_INDEXES = [0, 1, 2, 1] as const;

// ── Ellipsis animation ────────────────────────────────────

const ELLIPSIS_FRAMES = ["", ".", "..", "..."];
const ELLIPSIS_INTERVAL = 500;

// ── Phrase rotation ───────────────────────────────────────

const WAITING_PHRASE_INTERVAL = 3000;
const OTHER_PHRASE_INTERVAL = 4000;

// ── Formatting helpers ────────────────────────────────────

type ActivityAccentColors = {
  duration: string;
  tokens: string;
  thinking: string;
};

export function getActivityAccentColors(themeName: string): ActivityAccentColors {
  if (themeName.includes("ansi")) {
    return {
      duration: "#55ffff",
      tokens: "#ff55ff",
      thinking: "#55ff55",
    };
  }

  if (themeName.startsWith("light")) {
    return {
      duration: "#2563eb",
      tokens: "#c026d3",
      thinking: "#16a34a",
    };
  }

  return {
    duration: "#38bdf8",
    tokens: "#f472b6",
    thinking: "#4ade80",
  };
}

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

type ActivityMetaParts = {
  duration: string;
  tokens: string;
  thinking: string;
};

export function buildMetaParts(
  elapsedMs: number,
  thinkingMs: number,
  isThinking: boolean,
  tokenEstimate: number,
): { prefix: string; thinking: string } {
  const meta = buildStructuredMetaParts(elapsedMs, thinkingMs, isThinking, tokenEstimate);
  const prefix = [meta.duration, meta.tokens].filter(Boolean).join(" · ");

  return { prefix, thinking: meta.thinking };
}

function buildStructuredMetaParts(
  elapsedMs: number,
  thinkingMs: number,
  isThinking: boolean,
  tokenEstimate: number,
): ActivityMetaParts {
  const tokens = tokenEstimate > 0 ? `↓ ${formatTokenCount(tokenEstimate)} tokens` : "";
  const thinking = isThinking
    ? thinkingMs >= 1000
      ? `thinking for ${formatElapsed(thinkingMs)}`
      : "thinking"
    : thinkingMs >= 1000
      ? `thought for ${formatElapsed(thinkingMs)}`
      : "";

  return {
    duration: formatElapsed(elapsedMs),
    tokens,
    thinking,
  };
}

// ── Shimmer effect ────────────────────────────────────────

const SHIMMER_WIDTH = 3;
const SHIMMER_INTERVAL = 100;

export function getThinkingShimmerColor(themeName: string): string {
  if (themeName.includes("ansi")) return "#55ff55";
  if (themeName.startsWith("light")) return "#15803d";
  return "#22c55e";
}

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

function useLowChurnFrame(enabled: boolean): number {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;

    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, LOW_CHURN_INTERVAL);

    return () => clearInterval(timer);
  }, [enabled]);

  return enabled ? frame : 0;
}

function HeartbeatGlyph({ activeIndex, color }: { activeIndex: number; color: string }) {
  return (
    <Text>
      {Array.from({ length: HEARTBEAT_DOT_COUNT }, (_, index) => {
        const active = index === activeIndex;
        return (
          <Text bold={active} color={color} dimColor={!active} key={index}>
            {active ? "●" : "·"}
          </Text>
        );
      })}{" "}
    </Text>
  );
}

function ActivityMetaText({
  colors,
  isThinking,
  meta,
  mutedColor,
}: {
  colors: ActivityAccentColors;
  isThinking: boolean;
  meta: ActivityMetaParts;
  mutedColor: string;
}) {
  if (!meta.duration && !meta.tokens && !meta.thinking) return null;

  const hasTokenSeparator = !!meta.duration && !!meta.tokens;
  const hasThinkingSeparator = !!meta.thinking && (!!meta.duration || !!meta.tokens);

  return (
    <Text>
      <Text color={mutedColor}>{"  ("}</Text>
      {meta.duration && (
        <Text color={colors.duration} bold>
          {meta.duration}
        </Text>
      )}
      {hasTokenSeparator && <Text color={mutedColor}>{" · "}</Text>}
      {meta.tokens && (
        <Text color={colors.tokens} bold>
          {meta.tokens}
        </Text>
      )}
      {hasThinkingSeparator && <Text color={mutedColor}>{" · "}</Text>}
      {meta.thinking && (
        <Text color={isThinking ? colors.thinking : mutedColor} bold={isThinking}>
          {meta.thinking}
        </Text>
      )}
      <Text color={mutedColor}>{")"}</Text>
    </Text>
  );
}

// ── Component ─────────────────────────────────────────────

interface ActivityIndicatorProps {
  phase: ActivityPhase;
  elapsedMs: number;
  /** Run start time ref — for smooth elapsed time on each animation tick. */
  runStartRef?: React.RefObject<number>;
  thinkingMs: number;
  isThinking: boolean;
  thinkingEnabled?: boolean;
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
  /**
   * Override the default phrase library per-phase. Pass any subset — phases
   * not provided fall back to ggcoder's contextual selectPhrases. gg-boss
   * uses this to swap in orchestration-themed phrases ("Coordinating workers"
   * vs "Cogitating") so the activity bar reads as a manager, not a coder.
   */
  phrases?: Partial<Record<ActivityPhase, string[]>>;
  /**
   * Override the spinner pulse-color cycle. Defaults to the cool blue/violet
   * cycle ggcoder uses; gg-boss passes its crimson→fuchsia palette so the
   * spinner reads as Boss, not Coder.
   */
  pulseColors?: readonly string[];
  /** Disable decorative per-tick animation so terminal scrollback remains usable. */
  staticDisplay?: boolean;
}

const RETRY_REASON_LABELS: Record<RetryInfo["reason"], string> = {
  overloaded: "Provider overloaded",
  rate_limit: "Rate limited",
  provider_error: "Provider server error",
  empty_response: "Empty response",
  stream_stall: "Provider stream stalled",
  overflow_compact: "Context overflow — compacting",
};

export function ActivityIndicator({
  phase,
  elapsedMs: elapsedMsProp,
  runStartRef,
  thinkingMs,
  isThinking,
  thinkingEnabled = false,
  tokenEstimate,
  charCountRef: charCountRefProp,
  realTokensAccumRef: realTokensAccumRefProp,
  userMessage = "",
  activeToolNames = [],
  planMode,
  retryInfo,
  planDone = 0,
  planTotal = 0,
  phrases: phrasesByPhase,
  pulseColors: pulseColorsOverride,
  staticDisplay = false,
}: ActivityIndicatorProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const thinkingShimmerColor = getThinkingShimmerColor(theme.name);
  const accentColors = getActivityAccentColors(theme.name);

  // Full animation uses the shared 100ms clock. Static display deliberately
  // avoids that clock and uses a tiny 1s heartbeat instead.
  const canAnimate = phase !== "idle" && !reducedMotion;
  const { active: fullAnimationActive, tick } = useFocusedAnimation(canAnimate && !staticDisplay);
  const focused = useTerminalFocus(canAnimate && staticDisplay);
  const lowChurnActive = canAnimate && staticDisplay && focused;
  const lowChurnFrame = useLowChurnFrame(lowChurnActive);

  // Smooth elapsed time only in full-animation mode. Low-churn mode uses the
  // existing 1s timer from useAgentLoop so the status line repaints slowly.
  const elapsedMs =
    runStartRef?.current && phase !== "idle" && fullAnimationActive
      ? Date.now() - runStartRef.current
      : elapsedMsProp;

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

  if (!fullAnimationActive || !charCountRefProp) {
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

  // Derive all animation frames from the single tick counter.
  const spinnerFrame = fullAnimationActive
    ? deriveFrame(tick, SPINNER_INTERVAL, SPINNER_FRAMES.length)
    : 0;
  const pulseColors =
    planMode || !pulseColorsOverride || pulseColorsOverride.length === 0
      ? planMode
        ? PLAN_PULSE_COLORS
        : PULSE_COLORS
      : pulseColorsOverride;
  const colorFrame = fullAnimationActive
    ? deriveFrame(tick, PULSE_INTERVAL, pulseColors.length)
    : lowChurnActive
      ? Math.floor((lowChurnFrame * LOW_CHURN_INTERVAL) / LOW_CHURN_COLOR_INTERVAL) %
        pulseColors.length
      : 0;
  const ellipsisFrame = fullAnimationActive
    ? deriveFrame(tick, ELLIPSIS_INTERVAL, ELLIPSIS_FRAMES.length)
    : lowChurnActive
      ? lowChurnFrame % ELLIPSIS_FRAMES.length
      : 0;
  const heartbeatFrame = lowChurnActive ? lowChurnFrame % HEARTBEAT_ACTIVE_INDEXES.length : 0;

  // Phrase rotation — pick phrases based on phase + user message + active tools, shuffle, rotate
  const sortedActiveToolNames = [...activeToolNames].sort();
  const toolNamesKey = sortedActiveToolNames.join(",");
  const overridePhrases = phrasesByPhase?.[phase];
  const phrases = useMemo(
    () =>
      shuffleArray(
        overridePhrases && overridePhrases.length > 0
          ? overridePhrases
          : planMode && phase === "waiting"
            ? PLANNING_PHRASES
            : selectPhrases(phase, userMessage, activeToolNames, thinkingEnabled),
      ),
    [phase, userMessage, toolNamesKey, planMode, overridePhrases, thinkingEnabled], // activeToolNames captured via stable string key
  );
  const phraseInterval = lowChurnActive
    ? LOW_CHURN_PHRASE_INTERVAL
    : phase === "waiting"
      ? WAITING_PHRASE_INTERVAL
      : OTHER_PHRASE_INTERVAL;
  const phraseIndex = fullAnimationActive
    ? Math.floor((tick * SHIMMER_INTERVAL) / phraseInterval) % phrases.length
    : lowChurnActive
      ? Math.floor((lowChurnFrame * LOW_CHURN_INTERVAL) / phraseInterval) % phrases.length
      : 0;

  const spinnerColor = pulseColors[colorFrame] ?? pulseColors[0] ?? theme.spinnerColor;
  const heartbeatIndex = HEARTBEAT_ACTIVE_INDEXES[heartbeatFrame] ?? HEARTBEAT_ACTIVE_INDEXES[0];
  const phrase = phrases[phraseIndex] ?? phrases[0];
  const ellipsis = ELLIPSIS_FRAMES[ellipsisFrame];

  // Shimmer — derive position from tick, wrapping across phrase length
  const shimmerCycle = phrase.length + SHIMMER_WIDTH * 2;
  const shimmerPos = fullAnimationActive ? (tick % shimmerCycle) - SHIMMER_WIDTH : -SHIMMER_WIDTH;

  // Pad ellipsis to prevent text from shifting
  const paddedEllipsis =
    fullAnimationActive || lowChurnActive ? ellipsis + " ".repeat(3 - ellipsis.length) : "...";

  const structuredMeta = buildStructuredMetaParts(
    elapsedMs,
    thinkingMs,
    isThinking,
    smoothTokenEstimate,
  );
  const legacyMeta = buildMetaParts(elapsedMs, thinkingMs, isThinking, smoothTokenEstimate);
  const thinkingShimmerCycle = Math.max(1, legacyMeta.thinking.length + SHIMMER_WIDTH * 2);
  const thinkingShimmerPos = fullAnimationActive
    ? (tick % thinkingShimmerCycle) - SHIMMER_WIDTH
    : -SHIMMER_WIDTH;

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
        {lowChurnActive ? (
          <HeartbeatGlyph activeIndex={heartbeatIndex} color={retryColor} />
        ) : (
          <Text color={retryColor} bold>
            {reducedMotion ? REDUCED_MOTION_DOT : SPINNER_FRAMES[spinnerFrame]}{" "}
          </Text>
        )}
        <Text color={retryColor}>
          {retryLabel} — retrying ({retryInfo.attempt}/{retryInfo.maxAttempts})
        </Text>
        <Text color={theme.textDim}>{delaySec}</Text>
        <ActivityMetaText
          colors={accentColors}
          isThinking={isThinking}
          meta={{ duration: formatElapsed(elapsedMs), tokens: "", thinking: "" }}
          mutedColor={theme.textDim}
        />
      </Box>
    );
  }

  return (
    <Box>
      {lowChurnActive ? (
        <HeartbeatGlyph activeIndex={heartbeatIndex} color={spinnerColor} />
      ) : (
        <Text color={spinnerColor} bold>
          {reducedMotion ? REDUCED_MOTION_DOT : SPINNER_FRAMES[spinnerFrame]}{" "}
        </Text>
      )}
      {fullAnimationActive ? (
        <ShimmerText text={phrase} color={spinnerColor} shimmerPos={shimmerPos} />
      ) : (
        <Text color={spinnerColor} bold={canAnimate && (fullAnimationActive || lowChurnActive)}>
          {phrase}
        </Text>
      )}
      <Text color={theme.textDim}>{reducedMotion ? "..." : paddedEllipsis}</Text>
      {fullAnimationActive && isThinking && legacyMeta.thinking ? (
        <Text>
          <Text color={theme.textDim}>{"  ("}</Text>
          {legacyMeta.prefix && <Text color={theme.textDim}>{legacyMeta.prefix}</Text>}
          {legacyMeta.prefix && legacyMeta.thinking ? (
            <Text color={theme.textDim}>{" · "}</Text>
          ) : null}
          <ShimmerText
            text={legacyMeta.thinking}
            color={thinkingShimmerColor}
            shimmerPos={thinkingShimmerPos}
          />
          <Text color={theme.textDim}>{")"}</Text>
        </Text>
      ) : (
        <ActivityMetaText
          colors={accentColors}
          isThinking={isThinking}
          meta={structuredMeta}
          mutedColor={theme.textDim}
        />
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
