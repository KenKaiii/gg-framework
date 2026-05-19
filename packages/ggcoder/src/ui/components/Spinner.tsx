import React, { useRef } from "react";
import { Text } from "ink";
import { useTheme } from "../theme/theme.js";
import { SPINNER_FRAMES, SPINNER_INTERVAL, REDUCED_MOTION_DOT } from "../spinner-frames.js";
import {
  useFocusedAnimation,
  deriveFrame,
  useReducedMotion,
  TICK_INTERVAL,
} from "./AnimationContext.js";

// Claude Code's error red for stall interpolation
const ERROR_RED = { r: 171, g: 43, b: 63 };

/**
 * Parse a hex color string to RGB components.
 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Interpolate between two RGB colors by ratio t (0–1).
 */
function interpolateColor(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): string {
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

interface SpinnerProps {
  label?: string;
  /** When true, the spinner transitions to the error/red color. */
  isStalled?: boolean;
  /** How long (in ms) the spinner has been stalled. Controls transition speed. */
  stallDurationMs?: number;
  /** Disable decorative frame ticks so terminal scrollback remains usable. */
  staticDisplay?: boolean;
}

export function Spinner({ label, isStalled, stallDurationMs = 0, staticDisplay }: SpinnerProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const enabled = !staticDisplay && (!reducedMotion || !!isStalled);
  const { active: animationActive, tick } = useFocusedAnimation(enabled);

  // Smoothed stall intensity via exponential lerp (matches CC: 0.1 step)
  const intensityRef = useRef(0);

  if (staticDisplay) {
    return (
      <Text color={theme.spinnerColor} wrap="wrap">
        {SPINNER_FRAMES[0]} {label && <Text dimColor>{label}</Text>}
      </Text>
    );
  }

  if (!animationActive) {
    return (
      <Text color={theme.spinnerColor} wrap="wrap">
        {SPINNER_FRAMES[0]} {label && <Text dimColor>{label}</Text>}
      </Text>
    );
  }

  if (reducedMotion) {
    // Static filled circle with slow dim/undim cycle (2s)
    const dimCycle = Math.floor((tick * TICK_INTERVAL) / 1000) % 2;
    return (
      <Text color={theme.text} dimColor={dimCycle === 1}>
        {REDUCED_MOTION_DOT} {label && <Text dimColor>{label}</Text>}
      </Text>
    );
  }

  const frame = deriveFrame(tick, SPINNER_INTERVAL, SPINNER_FRAMES.length);

  // Stall color interpolation:
  // - Stall starts after 3000ms of no tokens
  // - Intensity ramps from 0 to 1 over the next 2000ms
  // - Smoothed with 0.1 lerp steps
  let color = theme.spinnerColor;
  if (isStalled && stallDurationMs > 3000) {
    const rawIntensity = Math.min((stallDurationMs - 3000) / 2000, 1);
    const diff = rawIntensity - intensityRef.current;
    intensityRef.current += diff * 0.1;
    const baseRGB = parseHex(theme.spinnerColor);
    color = interpolateColor(baseRGB, ERROR_RED, intensityRef.current);
  } else {
    // Decay back toward 0 when not stalled
    intensityRef.current *= 0.9;
  }

  return (
    <Text color={color} wrap="wrap">
      {SPINNER_FRAMES[frame]} {label && <Text dimColor>{label}</Text>}
    </Text>
  );
}
