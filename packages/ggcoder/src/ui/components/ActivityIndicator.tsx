import React, { useEffect, useRef, useState } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";

import { REDUCED_MOTION_DOT } from "../spinner-frames.js";
import {
  useFocusedAnimation,
  deriveFrame,
  useReducedMotion,
  useTerminalFocus,
} from "./AnimationContext.js";

// ── Gemini spinner style ──────────────────────────────────

const GEMINI_DOTS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const GEMINI_DOTS_INTERVAL = 80;
const GEMINI_COLOR_CYCLE_DURATION_MS = 4000;
const GEMINI_COLOR_CYCLE = [
  "#D7AFFF", // AccentPurple
  "#87AFFF", // AccentBlue
  "#87D7D7", // AccentCyan
  "#D7FFD7", // AccentGreen
  "#FFFFAF", // AccentYellow
  "#FF87AF", // AccentRed
] as const;

function interpolateHexChannel(start: number, end: number, amount: number): number {
  return Math.round(start + (end - start) * amount);
}

function parseHexColor(color: string): [number, number, number] {
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
}

function toHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function getGeminiSpinnerColor(elapsedMs: number): string {
  const progress =
    ((elapsedMs % GEMINI_COLOR_CYCLE_DURATION_MS) + GEMINI_COLOR_CYCLE_DURATION_MS) %
    GEMINI_COLOR_CYCLE_DURATION_MS;
  const scaled = (progress / GEMINI_COLOR_CYCLE_DURATION_MS) * GEMINI_COLOR_CYCLE.length;
  const startIndex = Math.floor(scaled) % GEMINI_COLOR_CYCLE.length;
  const endIndex = (startIndex + 1) % GEMINI_COLOR_CYCLE.length;
  const amount = scaled - Math.floor(scaled);
  const start = parseHexColor(GEMINI_COLOR_CYCLE[startIndex]);
  const end = parseHexColor(GEMINI_COLOR_CYCLE[endIndex]);
  return `#${toHexChannel(interpolateHexChannel(start[0], end[0], amount))}${toHexChannel(
    interpolateHexChannel(start[1], end[1], amount),
  )}${toHexChannel(interpolateHexChannel(start[2], end[2], amount))}`;
}

// ── Low-churn liveness ────────────────────────────────────

const LOW_CHURN_INTERVAL = 80;
const LOW_CHURN_COLOR_INTERVAL = 2000;
// ── Formatting helpers ────────────────────────────────────

type ActivityAccentColors = {
  duration: string;
  tokens: string;
  thinking: string;
};

export function getActivityAccentColors(themeName: string): ActivityAccentColors {
  if (themeName.includes("ansi")) {
    return {
      duration: "#aaaaaa",
      tokens: "#ff55ff",
      thinking: "#55ffff",
    };
  }

  if (themeName.startsWith("light")) {
    return {
      duration: "#6b7280",
      tokens: "#7c3aed",
      thinking: "#0891b2",
    };
  }

  return {
    duration: "#9ca3af",
    tokens: "#a78bfa",
    thinking: "#67e8f9",
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

export function getThinkingShimmerColor(themeName: string): string {
  if (themeName.includes("ansi")) return "#55ff55";
  if (themeName.startsWith("light")) return "#15803d";
  return "#22c55e";
}

/**
 * Dedicated hue for the "Working..." label shimmer. Deliberately distinct from
 * the spinner cycle (cool purples/blues), the token accent (violet), the
 * thinking shimmer (green), and the duration (gray) so the sweep reads as its
 * own signal — a warm amber/coral.
 */
export function getWorkingShimmerColor(themeName: string): string {
  if (themeName.includes("ansi")) return "#ffaf00";
  if (themeName.startsWith("light")) return "#c2410c";
  return "#fb923c";
}

const ShimmerText: React.FC<{
  text: string;
  color: string;
  shimmerPos: number;
  /** Optional color for the bright sweep band; falls back to `color` + no dim. */
  brightColor?: string;
  italic?: boolean;
}> = ({ text, color, shimmerPos, brightColor, italic }) => (
  <Text>
    {text.split("").map((char, i) => {
      const isBright = Math.abs(i - shimmerPos) <= SHIMMER_WIDTH;
      return (
        <Text
          color={isBright && brightColor ? brightColor : color}
          dimColor={!isBright}
          italic={italic}
          key={i}
        >
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
      {meta.duration && <Text color={colors.duration}>{meta.duration}</Text>}
      {hasTokenSeparator && <Text color={mutedColor}>{" · "}</Text>}
      {meta.tokens && <Text color={colors.tokens}>{meta.tokens}</Text>}
      {hasThinkingSeparator && <Text color={mutedColor}>{" · "}</Text>}
      {meta.thinking && (
        <Text color={isThinking ? colors.thinking : mutedColor}>{meta.thinking}</Text>
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
  tool_argument_glitch: "Provider dropped tool call args — auto-continuing",
  runaway_toolcall: "Provider tool call stream glitched — retrying",
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
  retryInfo,
  planDone = 0,
  planTotal = 0,
  pulseColors: pulseColorsOverride,
  staticDisplay = false,
}: ActivityIndicatorProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const thinkingShimmerColor = getThinkingShimmerColor(theme.name);
  const workingShimmerColor = getWorkingShimmerColor(theme.name);
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
  const pulseColors =
    pulseColorsOverride && pulseColorsOverride.length > 0 ? pulseColorsOverride : null;
  const colorFrame =
    pulseColors && lowChurnActive
      ? Math.floor((lowChurnFrame * LOW_CHURN_INTERVAL) / LOW_CHURN_COLOR_INTERVAL) %
        pulseColors.length
      : 0;
  const geminiElapsedMs = fullAnimationActive
    ? tick * 30
    : lowChurnActive
      ? lowChurnFrame * LOW_CHURN_INTERVAL
      : 0;
  const spinnerColor = pulseColors
    ? (pulseColors[colorFrame] ?? pulseColors[0] ?? theme.spinnerColor)
    : getGeminiSpinnerColor(geminiElapsedMs);
  const geminiSpinnerFrame = fullAnimationActive
    ? deriveFrame(tick, GEMINI_DOTS_INTERVAL, GEMINI_DOTS_FRAMES.length)
    : lowChurnActive
      ? lowChurnFrame % GEMINI_DOTS_FRAMES.length
      : 0;
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

  // ── "Working..." label shimmer ─────────────────────────
  // A slow sweep of brightness across the label, riding whichever animation
  // clock is live: the 100ms tick in full mode, or the 80ms low-churn frame
  // in the (static) status-row mode. Falls back to plain text when idle,
  // unfocused, or reduced-motion so scrollback stays stable.
  const WORKING_LABEL = "Working...";
  const workingShimmerFrame = fullAnimationActive ? tick : lowChurnActive ? lowChurnFrame : null;
  const workingShimmerCycle = WORKING_LABEL.length + SHIMMER_WIDTH * 2;
  const workingShimmerPos =
    workingShimmerFrame !== null
      ? (workingShimmerFrame % workingShimmerCycle) - SHIMMER_WIDTH
      : null;

  // ── Plan progress label ────────────────────────────────
  // "Plan Steps" gets the same green shimmer treatment as the thinking label,
  // riding whichever animation clock is live. Falls back to a static sweep
  // position when idle/unfocused/reduced-motion so scrollback stays stable.
  const PLAN_LABEL = "Plan Steps";
  const planShimmerCycle = PLAN_LABEL.length + SHIMMER_WIDTH * 2;
  const planShimmerPos =
    workingShimmerFrame !== null
      ? (workingShimmerFrame % planShimmerCycle) - SHIMMER_WIDTH
      : -SHIMMER_WIDTH;

  // ── Retry display ──────────────────────────────────────
  if (phase === "retrying" && retryInfo) {
    const retryLabel = RETRY_REASON_LABELS[retryInfo.reason];
    const retryColor = "#f59e0b"; // amber
    const delaySec =
      retryInfo.delayMs > 0 ? ` waiting ${Math.round(retryInfo.delayMs / 1000)}s` : "";
    return (
      <Box>
        <Text color={retryColor}>
          {reducedMotion ? REDUCED_MOTION_DOT : GEMINI_DOTS_FRAMES[geminiSpinnerFrame]}{" "}
        </Text>
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
      <Text color={spinnerColor}>
        {reducedMotion ? REDUCED_MOTION_DOT : GEMINI_DOTS_FRAMES[geminiSpinnerFrame]}{" "}
      </Text>
      {workingShimmerPos !== null ? (
        <ShimmerText
          text={WORKING_LABEL}
          color={theme.text}
          brightColor={workingShimmerColor}
          shimmerPos={workingShimmerPos}
          italic
        />
      ) : (
        <Text color={theme.text} italic wrap="truncate-end">
          {WORKING_LABEL}
        </Text>
      )}
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
      {planTotal > 0 && (
        <Text>
          {"  "}
          <ShimmerText
            text={PLAN_LABEL}
            color={thinkingShimmerColor}
            brightColor={thinkingShimmerColor}
            shimmerPos={planShimmerPos}
          />
          <Text color={theme.textDim}>
            {" "}
            {planDone}/{planTotal}
          </Text>
        </Text>
      )}
    </Box>
  );
}
