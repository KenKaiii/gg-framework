import { theme } from "./theme";

/**
 * Footer context-usage indicator — mirrors the ggcoder TUI footer's context
 * reading. Percentage only, color-graded by pressure: green under 50%, amber
 * from 50%, red from 80%. Hidden by the caller until there's a real reading
 * (a context window + some tokens).
 */
function contextColor(pct: number): string {
  if (pct >= 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

export function getContextPercent(contextTokens: number, contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0 || contextTokens <= 0) return 0;
  return Math.min(100, Math.round((contextTokens / contextWindow) * 100));
}

export function ContextMeter({ pct }: { pct: number }): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = contextColor(clamped);
  return (
    <span className="ctx-meter-pct" title={`Context used: ${clamped}%`} style={{ color }}>
      {clamped}%
    </span>
  );
}
