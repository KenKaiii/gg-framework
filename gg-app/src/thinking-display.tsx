/**
 * How a thinking level reads on screen: a word and a row of dots, one per level
 * the model supports, lit up to the current one. Off lights none. The colours
 * carry over from the old footer's "Thinking high" text: muted for low, accent
 * for medium, amber for high, pink for the top rungs.
 */
const LABELS: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export function thinkingLabel(level: string | null | undefined): string {
  if (!level) return "Off";
  return LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

export function thinkingTone(level: string | null | undefined): string {
  if (!level) return "off";
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high") return "high";
  return "max";
}

export function ThinkingDots({
  levels,
  level,
}: {
  levels: readonly string[];
  level: string | null | undefined;
}): React.ReactElement | null {
  if (levels.length === 0) return null;
  const lit = level ? levels.indexOf(level) + 1 : 0;
  return (
    <span className="tdots" data-tone={thinkingTone(level)} aria-hidden="true">
      {levels.map((l, i) => (
        <i key={l} data-on={i < lit || undefined} />
      ))}
    </span>
  );
}
