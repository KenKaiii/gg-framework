import "./placeholder.css";

export type StatusTone = "error" | "warning" | "history" | "active" | "neutral";

const TONE_LABEL: Record<StatusTone, string> = {
  error: "Error",
  warning: "Warning",
  history: "Earlier error",
  active: "Working",
  neutral: "Idle",
};

// Placeholder until the redesign: a dot whose colour follows the tone.
export function StatusDot({
  tone,
  label = TONE_LABEL[tone],
}: {
  tone: StatusTone;
  label?: string;
}): React.ReactElement {
  return <span className="placeholder-dot" data-tone={tone} role="img" aria-label={label} />;
}
