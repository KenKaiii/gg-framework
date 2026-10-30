import { useEffect, useState } from "react";
import type { TaskActivity } from "./task-activity";
import { ThinkingOrb } from "thinking-orbs";
import { theme } from "./theme";
import { ShimmerText } from "./ShimmerText";
import { outcomePhrase } from "./activity-copy";
import { useMotionLevel } from "./window-motion";

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

/**
 * Idle-line variations for the ready state — rotated so the quiet line under
 * the transcript isn't always the same "Ready for work". Re-rolled each time
 * the bar returns to the bare idle state (never the same phrase twice in a
 * row). Tone: deadpan, a little self-deprecating about being an idle AI —
 * funny like the wake screen, never meme-speak. The original stays first.
 */
const READY_PHRASES = [
  "Ready for work",
  "Ready when you are",
  "Your move",
  "Standing by. Obviously.",
  "Waiting on you, as usual",
  "Doing nothing, expertly",
  "Napping, but professionally",
  "Polishing my tokens",
  "Idling at 0 tokens/sec",
  "Stretching my context window",
] as const;

function pickReadyPhrase(exclude?: string): string {
  const pool = exclude ? READY_PHRASES.filter((p) => p !== exclude) : READY_PHRASES;
  return pool[Math.floor(Math.random() * pool.length)] ?? "Ready for work";
}

export function formatElapsed(ms: number): string {
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
  /** Event-grounded whole-task progress and final outcome. */
  activity?: TaskActivity;
  /** Cancellation was requested and is awaiting provider settlement. */
  cancelling?: boolean;
  /**
   * When the current run began, kept by the caller (which is never hidden).
   * The bar sits inside the chat, which a goal's Workers view hides; its own
   * effects re-run when the chat comes back, so a start it took itself would
   * restart from zero every time.
   */
  runStartedAt?: number | null;
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
export function ToolsToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      className="nav-toggle tools-toggle dissolve-in"
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

// Keep the visible rail terse without discarding the event model's richer context.
const SHORT_LABELS: Record<string, string> = {
  "Working on your request…": "Working…",
  "Working through your request…": "On it…",
  "Continuing with your request…": "Continuing…",
  "Reasoning through the next step…": "Reasoning…",
  "Writing a response…": "Writing…",
  "Putting the response into words…": "Composing…",
  "Composing the response…": "Drafting…",
  "Reading the relevant code…": "Reading code…",
  "Looking through the code…": "Browsing code…",
  "Examining the code…": "Examining code…",
  "Making the changes…": "Editing…",
  "Editing the code…": "Updating code…",
  "Applying the changes…": "Applying changes…",
  "Consulting reference material…": "Reading references…",
  "Coordinating agent work…": "Agents working…",
  "Checking background work…": "Checking progress…",
  "Working through a command…": "Executing…",
  "Checking the changes…": "Checking…",
  "Running verification…": "Verifying…",
  "Reviewing the work…": "Reviewing…",
  "Applying Ken’s corrections…": "Fixing review notes…",
  "Preparing Ken’s review…": "Review starting…",
  "Keeping the task context…": "Saving context…",
  "Continuing the task…": "Continuing…",
  "Continuing with your decision…": "Continuing…",
  "Question closed · checking next step…": "Resuming…",
  "Your decision needed": "Needs you",
  "Plan needs your decision": "Approve plan",
  "Plan ready for review…": "Plan ready",
  "Plan approved · preparing implementation…": "Starting plan…",
  "Changed · verification incomplete": "Not verified",
  "Verification incomplete": "Not verified",
  "Done · checks passed": "Checks passed",
  "Stopped · unfinished": "Stopped",
  "Paused · review limit reached": "Review limit reached",
  "Reconnected · review latest result": "Check latest result",
  "Stopping the task…": "Stopping…",
  "Cancellation failed · task still running": "Stop failed",
};

/** The existing animated row now represents a whole task, including Ken's review. */
export function ActivityBar({
  running,
  activity,
  runStartedAt = null,
  cancelling = false,
  tokens,
  doneStatus,
  planTotal = 0,
  planDone = 0,
  onCancel,
  toolsHidden = false,
  hasToolFeed = false,
  onToggleTools,
}: Props): React.ReactElement {
  const [now, setNow] = useState(0);
  const [fallbackStart, setFallbackStart] = useState(0);
  const [readyPhrase, setReadyPhrase] = useState(() => pickReadyPhrase());
  const hasActivity = activity !== undefined && activity.phase !== "idle";
  const starting = running && typeof activity?.endedAt === "number";
  const active =
    starting ||
    (hasActivity ? activity.phase === "working" || activity.phase === "reviewing" : running);
  const bareIdle = !active && !hasActivity && !doneStatus;
  const startedAt = activity?.startedAt;
  const motion = useMotionLevel();
  useEffect(() => {
    if (bareIdle) setReadyPhrase((cur) => pickReadyPhrase(cur));
  }, [bareIdle]);
  useEffect(() => {
    if (active) setFallbackStart(startedAt ?? runStartedAt ?? Date.now());
  }, [active, startedAt, runStartedAt]);
  // The elapsed clock keeps counting in a visible background window (it's
  // status, not decoration); a hidden window skips the ticks and catches up
  // the moment it's shown.
  const clockLive = active && motion !== "off";
  useEffect(() => {
    if (!clockLive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clockLive]);

  const showToolsToggle =
    Boolean(onToggleTools) && (hasToolFeed || toolsHidden || hasActivity || Boolean(doneStatus));
  const totalTokens = hasActivity ? activity.tokens : tokens;
  const elapsed =
    hasActivity && activity.startedAt !== null
      ? Math.max(0, (activity.endedAt ?? now) - activity.startedAt)
      : Math.max(0, now - fallbackStart);
  const tone = starting
    ? theme.textMuted
    : activity?.phase === "failed" || activity?.label === "Cancellation failed · task still running"
      ? theme.error
      : activity?.connectionLost ||
          activity?.label === "Retrying…" ||
          ["attention", "unverified", "stopped"].includes(activity?.phase ?? "")
        ? theme.warning
        : activity?.phase === "done"
          ? theme.success
          : theme.textMuted;
  const fullLabel = cancelling
    ? "Stopping the task…"
    : starting
      ? "Starting…"
      : hasActivity
        ? activity.label
        : active
          ? "Working on your request…"
          : doneStatus
            ? "Response ready"
            : readyPhrase;
  const label =
    (!active && outcomePhrase(fullLabel, activity?.startedAt ?? 0)) ||
    SHORT_LABELS[fullLabel] ||
    fullLabel;
  const canCancel = running || active;

  return (
    <div className="task-activity" data-phase={activity?.phase ?? (running ? "working" : "idle")}>
      <div className={`statusrow${active ? " running" : ""}`}>
        <div className="activity-summary">
          <span
            className="statusrow-left"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            title={activity?.detail || undefined}
          >
            {/* Only work in progress gets a lead: the orb's motion. A settled
                status is its words alone, coloured by outcome. */}
            {active && (
              <ThinkingOrb
                state="listening"
                size={20}
                theme="auto"
                paused={motion !== "full"}
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              />
            )}
            {/* Remount only the label when its meaning changes. Timer/token
                updates must not restart the reveal or the running orb. */}
            <span key={`${active}:${label}`} className="activity-label-reveal" title={label}>
              {active ? (
                <ShimmerText base={tone} bright={theme.text}>
                  {label}
                </ShimmerText>
              ) : (
                <span style={{ color: bareIdle ? theme.textMuted : tone }}>{label}</span>
              )}
            </span>
            {!active && activity?.workspaceWarning && (
              <span className="activity-workspace-warning" style={{ color: theme.warning }}>
                {activity.workspaceWarning}
              </span>
            )}
          </span>
          {(active || hasActivity) && !starting && (
            <span className="activity-meta dissolve-in">
              {formatElapsed(elapsed)}
              {totalTokens > 0 && (
                <span className="activity-token-count" title="Output tokens">
                  {` · ${formatTokenCount(totalTokens)} tok`}
                </span>
              )}
            </span>
          )}
        </div>
        {active && planTotal > 0 && planDone < planTotal && (
          // One bar and a count, whatever the plan's length: twenty steps
          // must not mean twenty blocks.
          <span
            className="plan-steps-running dissolve-in"
            title={`Plan: step ${planDone + 1} of ${planTotal}`}
          >
            <span className="plan-steps-badge">
              <span className="plan-steps-word">Plan</span>
              <span
                className="plan-steps-bar"
                aria-hidden="true"
                style={{ "--p": Math.round((planDone / planTotal) * 100) } as React.CSSProperties}
              />
              <span className="plan-steps-count">
                {planDone}/{planTotal}
              </span>
            </span>
          </span>
        )}
        <span className="statusrow-right">
          {showToolsToggle && onToggleTools && (
            <ToolsToggle hidden={toolsHidden} onToggle={onToggleTools} />
          )}
          {canCancel && (
            <button
              className="cancel dissolve-in"
              style={{ color: cancelling ? theme.textMuted : theme.error }}
              onClick={onCancel}
              disabled={cancelling}
              aria-label={cancelling ? "Cancellation in progress" : "Cancel agent run"}
            >
              {cancelling ? "Stopping…" : "Stop"}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
