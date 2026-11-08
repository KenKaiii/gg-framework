import { useEffect, useState } from "react";
import { StatusDot, type StatusTone } from "./StatusDot";
import { LONG_THINK_MS, type GoalStatus } from "./goal-status";
import "./placeholder.css";

/** Seconds, then minutes and seconds, then whole minutes from ten on. */
export function formatFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m >= 10) return `${m}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const DOT: Readonly<Record<GoalStatus["tone"], StatusTone>> = {
  work: "active",
  ask: "warning",
  paused: "neutral",
  error: "error",
  done: "neutral",
  idle: "neutral",
};

/**
 * Placeholder (the fork owns the desktop design) for upstream's KenStatus pill:
 * what the coordinator is doing now, how long that step has taken, and the
 * line the headline doesn't say. A problem shows its line by itself; a long
 * think gets a reassuring note. Polite live region, never takes focus.
 */
export function StatusPill({ status }: { status: GoalStatus }): React.ReactElement {
  // The timer restarts whenever the moment changes (a new key).
  const [moment, setMoment] = useState(() => ({ key: status.key, since: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  const ticking = status.timed || status.thinking;
  useEffect(() => {
    const started = Date.now();
    setMoment((prev) => (prev.key === status.key ? prev : { key: status.key, since: started }));
    setNow(started);
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking, status.key]);
  const since = moment.key === status.key ? moment.since : now;
  const slow = status.thinking && now - since >= LONG_THINK_MS;
  return (
    <span className="placeholder-notice" role="status" aria-live="polite" data-tone={status.tone}>
      <StatusDot tone={DOT[status.tone]} label={status.headline} />
      <span className="placeholder-notice-body">
        <span className="placeholder-notice-headline">{status.headline}</span>
        {status.timed && <span className="placeholder-muted"> {formatFor(now - since)}</span>}
        {status.detail && (
          <span className={status.opens ? "placeholder-attention" : "placeholder-muted"}>
            {" "}
            {status.detail}
          </span>
        )}
        {slow && <span className="placeholder-muted"> Long think. Normal for a big step.</span>}
      </span>
    </span>
  );
}
