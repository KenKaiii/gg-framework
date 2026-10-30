import { useEffect, useId, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { theme } from "./theme";
import { formatElapsed, formatTokenCount, ToolsToggle } from "./ActivityBar";
import { ShimmerText } from "./ShimmerText";
import { useMotionLevel } from "./window-motion";

interface Props {
  /** Timestamp (ms) Ken's run began, or null when not running. */
  runStartTs: number | null;
  /** Accumulated output tokens for Ken's current run. */
  tokens: number;
  onCancel: () => void;
  /** The tool panel's show/hide chevron, beside Stop as on the main bar. */
  toolsHidden?: boolean;
  onToggleTools?: () => void;
}

/**
 * Ken Kai's activity bar: the GG Coder ActivityBar's running row exactly (the
 * listening orb, label, `elapsed · N tok` meta and the Stop key), with the orb
 * and label tinted Ken's colour and reading "Ken is thinking…".
 */
export function KenActivityBar({
  runStartTs,
  tokens,
  onCancel,
  toolsHidden = false,
  onToggleTools,
}: Props): React.ReactElement {
  const orbTintId = useId();
  const [now, setNow] = useState(() => Date.now());
  const motion = useMotionLevel();

  // Same clock as ActivityBar: ticks in a visible window, catches up when shown.
  useEffect(() => {
    if (motion === "off") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [motion]);

  const elapsed = runStartTs ? Math.max(0, now - runStartTs) : 0;

  return (
    <div className="task-activity" data-phase="working">
      <div className="statusrow running ken-statusrow">
        <div className="activity-summary">
          <span className="statusrow-left" role="status" aria-live="polite" aria-atomic="true">
            {/* Tint the canvas alpha with Ken's colour; the package has no color prop. */}
            <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
              <defs>
                <filter id={orbTintId} colorInterpolationFilters="sRGB">
                  {/* In `style`, not the attribute: presentation attributes don't resolve var(). */}
                  <feFlood style={{ floodColor: theme.ken }} />
                  <feComposite in2="SourceAlpha" operator="in" />
                </filter>
              </defs>
            </svg>
            <ThinkingOrb
              state="listening"
              size={20}
              theme="auto"
              paused={motion !== "full"}
              aria-hidden="true"
              style={{ flexShrink: 0, filter: `url(#${orbTintId})` }}
            />
            <span className="activity-label-reveal" title="Ken is thinking…">
              <ShimmerText base={theme.ken} bright={theme.text}>
                {"Ken is thinking…"}
              </ShimmerText>
            </span>
          </span>
          <span className="activity-meta dissolve-in">
            {formatElapsed(elapsed)}
            {tokens > 0 && (
              <span className="activity-token-count" title="Output tokens">
                {` · ${formatTokenCount(tokens)} tok`}
              </span>
            )}
          </span>
        </div>
        <span className="statusrow-right">
          {onToggleTools && <ToolsToggle hidden={toolsHidden} onToggle={onToggleTools} />}
          <button
            className="cancel dissolve-in"
            style={{ color: theme.error }}
            onClick={onCancel}
            aria-label="Cancel Ken's reply"
          >
            Stop
          </button>
        </span>
      </div>
    </div>
  );
}
