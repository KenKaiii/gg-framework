import { useEffect, useState } from "react";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";
import { SPINNER_FRAMES, SPINNER_FRAME_MS, formatTokenCount } from "./ActivityBar";

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

interface Props {
  /** Timestamp (ms) Ken's run began, or null when not running. */
  runStartTs: number | null;
  /** Accumulated output tokens for Ken's current run. */
  tokens: number;
  /** True while Ken is actively emitting reasoning/thinking. */
  isThinking: boolean;
  /** Timestamp (ms) Ken's current thinking span began, or null. */
  thinkingStartTs: number | null;
  /** Completed thinking time (ms) from earlier spans in this run. */
  thinkingAccumMs: number;
  onCancel: () => void;
}

/**
 * Ken Kai's activity bar. A 1:1 mirror of the GG Coder ActivityBar's running row
 * — same braille spinner, same `(elapsed · ↓ N tokens · thinking for Xs)` meta,
 * same statusrow layout + esc-to-cancel — just tinted to Ken and labelled "Ken
 * is thinking…". Stacks above the main bar while Ken runs concurrently, so its
 * own top border is dropped (the main bar keeps the divider).
 */
export function KenActivityBar({
  runStartTs,
  tokens,
  isThinking,
  thinkingStartTs,
  thinkingAccumMs,
  onCancel,
}: Props): React.ReactElement {
  const [frame, setFrame] = useState(0);
  // `now` is bumped every 250ms; the elapsed + thinking timers are derived from
  // it + the start timestamps, mirroring the ActivityBar's live-tick approach
  // without reading a ref during render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const spin = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_FRAME_MS,
    );
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearInterval(spin);
      clearInterval(tick);
    };
  }, []);

  const elapsed = runStartTs ? now - runStartTs : 0;
  const liveThinkingDelta = isThinking && thinkingStartTs ? now - thinkingStartTs : 0;
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
    <div className="statusrow running ken-statusrow" style={{ color: theme.textMuted }}>
      <span className="statusrow-left">
        <span className="statusrow-icon spinner ken-spinner" style={{ color: theme.ken }}>
          {SPINNER_FRAMES[frame]}
        </span>
        <span className="working" style={{ color: theme.ken }}>
          {`${MENTOR_DISPLAY_NAME} is thinking\u2026`}
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
                      ? theme.ken
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
      <span className="statusrow-right">
        <button className="cancel" style={{ color: theme.error }} onClick={onCancel}>
          esc to cancel
        </button>
      </span>
    </div>
  );
}
