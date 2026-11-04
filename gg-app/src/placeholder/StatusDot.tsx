import "./placeholder.css";

export type StatusTone = "error" | "warning" | "history";

const TONE_LABEL: Record<StatusTone, string> = {
  error: "Error",
  warning: "Warning",
  history: "Earlier error",
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
