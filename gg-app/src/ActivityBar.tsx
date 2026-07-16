import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";

// Braille rotation spinner — the native language of CLI coding tools (ora,
// npm, cargo). Smooth, monospace, and unmistakably "ours" rather than the
// Matrix-flavored sparkle it replaces. Exported so Ken's activity row spins
// with the exact same frames (aligned, not a separate visual language).
export const SPINNER_FRAMES = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
];
export const SPINNER_FRAME_MS = 80;
const FRAMES = SPINNER_FRAMES;
const FRAME_MS = SPINNER_FRAME_MS;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

interface Props {
  running: boolean;
  /** Cancellation was requested and is awaiting provider settlement. */
  cancelling?: boolean;
  /** Accumulated output tokens for the current/just-finished run. */
  tokens: number;
  /** Done-status phrase shown when a run just finished (e.g. "Brewed up a response in 12s"). */
  doneStatus: string | null;
  /** True while the model is actively emitting reasoning/thinking. */
  isThinking: boolean;
  /** Timestamp (ms) the current thinking span began, or null when not thinking. */
  thinkingStartTs: number | null;
  /** Completed thinking time (ms) from earlier spans in this run. */
  thinkingAccumMs: number;
  /** Total steps in the approved plan (0 = no plan tracking). */
  planTotal?: number;
  /** Completed plan steps so far. */
  planDone?: number;
  onCancel: () => void;
  /** Whether the live tool panel is currently collapsed. */
  toolsHidden?: boolean;
  /** True when there are tool entries to show (gates the toggle's visibility). */
  hasToolFeed?: boolean;
  /** Toggle the live tool panel's collapsed state. */
  onToggleTools?: () => void;
}

// Chevron toggle for the live tool panel — mirrors the nav-toggle chevron up
// top. Down chevron = panel shown (click to hide), up chevron = panel hidden
// (click to show). Rendered in the activity bar so it's always reachable.
function ToolsToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      className="nav-toggle tools-toggle"
      title={hidden ? "Show tool panel" : "Hide tool panel"}
      aria-label={hidden ? "Show tool panel" : "Hide tool panel"}
      onClick={onToggle}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: "block" }}
      >
        <polyline points={hidden ? "6 15 12 9 18 15" : "6 9 12 15 18 9"} />
      </svg>
    </button>
  );
}

/**
 * Live activity bar beneath the transcript. While running: sparkle spinner +
 * "Working…" + `elapsed · ↓ N tokens` + esc-to-cancel. After a run: a quiet
 * done-status phrase. Otherwise: a quiet ready line.
 */
export function ActivityBar({
  running,
  cancelling = false,
  tokens,
  doneStatus,
  isThinking,
  thinkingStartTs,
  thinkingAccumMs,
  planTotal = 0,
  planDone = 0,
  onCancel,
  toolsHidden = false,
  hasToolFeed = false,
  onToggleTools,
}: Props): React.ReactElement {
  // Show the toggle when there's tool activity to collapse, when the panel is
  // already hidden (so it can be brought back), or right after a run finishes
  // (doneStatus) so it stays reachable in the "Built & ran in 4m" bar for the
  // next run. Only the bare idle "Ready for work" line stays uncluttered.
  const showToolsToggle =
    Boolean(onToggleTools) && (hasToolFeed || toolsHidden || Boolean(doneStatus));
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [, setNow] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const spin = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    const tick = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
      // Repaint so the live thinking timer advances each tick.
      setNow((n) => n + 1);
    }, 250);
    return () => {
      clearInterval(spin);
      clearInterval(tick);
    };
  }, [running]);

  // Plan-step progress is live run feedback, not durable idle status. Keeping
  // it mounted after run_end made a blocked/malformed marker sequence look like
  // active work forever, including the misleading "x/x" stale state.
  const planBadge =
    running && planTotal > 0 && planDone < planTotal ? (
      <span className="plan-steps-badge">
        <span style={{ color: theme.warning }}>{"Plan Steps"}</span>{" "}
        <span style={{ color: theme.textDim }}>
          {planDone}/{planTotal}
        </span>
      </span>
    ) : null;

  if (!running) {
    // doneStatus is "{verb} {duration} \u2022 \u2193 N tokens" — mirror the TUI by
    // coloring the "\u273b {verb} {duration}" head in success and the token tail dim.
    const [doneHead, ...doneTail] = doneStatus ? doneStatus.split(" \u2022 ") : [];
    return (
      <div className="statusrow" style={{ color: theme.textDim }}>
        {doneStatus ? (
          <span className="statusrow-left">
            <span className="statusrow-icon" style={{ color: theme.success }}>
              {"\u273b"}
            </span>
            <span style={{ color: theme.success }}>{doneHead}</span>
            {doneTail.length > 0 && (
              <span style={{ color: theme.textDim }}>{` \u2022 ${doneTail.join(" \u2022 ")}`}</span>
            )}
          </span>
        ) : (
          <span className="statusrow-ready">
            <span className="statusrow-icon" style={{ color: theme.accent }}>
              {"\u276f"}
            </span>
            <span>Ready for work</span>
          </span>
        )}
        {showToolsToggle && onToggleTools && (
          <span className="statusrow-tools-toggle" style={{ marginLeft: "auto" }}>
            <ToolsToggle hidden={toolsHidden} onToggle={onToggleTools} />
          </span>
        )}
      </div>
    );
  }

  // Live ticking timer: the 250ms `setNow` interval above forces this repaint,
  // and reading the clock during render is what advances the displayed elapsed
  // time each tick. Intentional, not a purity bug.
  const liveThinkingDelta =
    // eslint-disable-next-line react-hooks/purity
    isThinking && thinkingStartTs ? Date.now() - thinkingStartTs : 0;
  const thinkingMs = thinkingAccumMs + liveThinkingDelta;
  const thinkingLabel = isThinking
    ? thinkingMs >= 1000
      ? `thinking for ${formatElapsed(thinkingMs)}`
      : "thinking"
    : thinkingMs >= 1000
      ? `thought for ${formatElapsed(thinkingMs)}`
      : "";

  const meta: { text: string; thinking?: boolean }[] = [{ text: formatElapsed(elapsed) }];
  if (tokens > 0) meta.push({ text: `\u2193 ${formatTokenCount(tokens)} tokens` });
  if (thinkingLabel) meta.push({ text: thinkingLabel, thinking: true });

  return (
    <div
      className="statusrow running"
      style={{ color: theme.textMuted }}
      role="status"
      aria-live="polite"
    >
      <span className="statusrow-left">
        <span
          className="statusrow-icon spinner"
          style={{ color: theme.primary }}
          aria-hidden="true"
        >
          {FRAMES[frame]}
        </span>
        <span className="working" style={{ color: theme.text }}>
          {"Working\u2026"}
        </span>
        <span style={{ color: theme.textMuted }}>
          {"("}
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 ? " \u2022 " : ""}
              <span
                style={{
                  color: part.thinking
                    ? isThinking
                      ? theme.language
                      : theme.textMuted
                    : theme.textMuted,
                }}
              >
                {part.text}
              </span>
            </span>
          ))}
          {")"}
        </span>
      </span>
      {planBadge && <span className="plan-steps-running">{planBadge}</span>}
      <span className="statusrow-right">
        {showToolsToggle && onToggleTools && (
          <ToolsToggle hidden={toolsHidden} onToggle={onToggleTools} />
        )}
        <button
          className="cancel"
          style={{ color: cancelling ? theme.textMuted : theme.error }}
          onClick={onCancel}
          disabled={cancelling}
          aria-label={cancelling ? "Cancellation in progress" : "Cancel agent run"}
        >
          {cancelling ? "Cancelling..." : "esc to cancel"}
        </button>
      </span>
    </div>
  );
}
