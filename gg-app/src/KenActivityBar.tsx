import { useEffect, useState } from "react";
import { theme } from "./theme";
import { ActivityMeta, ToolsToggle } from "./ActivityBar";
import { ActivityGlyph } from "./ActivityGlyph";
import { ShimmerText } from "./ShimmerText";
import { useMotionLevel } from "./window-motion";

interface Props {
  /** Timestamp (ms) Ken's run began, or null when not running. */
  runStartTs: number | null;
  /** Accumulated output tokens for Ken's current run. */
  tokens: number;
  /** The tool panel's show/hide chevron, as on the main bar. */
  toolsHidden?: boolean;
  onToggleTools?: () => void;
}

/**
 * Ken Kai's activity bar: the GG Coder ActivityBar's running row exactly (the
 * glyph well, label and elapsed/token wells), with the glyph and label in
 * Ken's colour and reading "Ken is thinking…".
 */
export function KenActivityBar({
  runStartTs,
  tokens,
  toolsHidden = false,
  onToggleTools,
}: Props): React.ReactElement {
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
            <ActivityGlyph glyph="think" color={theme.ken} live={motion === "full"} />
            <span className="activity-label-reveal" title="Ken is thinking…">
              <ShimmerText base={theme.ken} bright={theme.text}>
                {"Ken is thinking…"}
              </ShimmerText>
            </span>
          </span>
          <ActivityMeta elapsedMs={elapsed} tokens={tokens} />
        </div>
        <span className="statusrow-right">
          {onToggleTools && <ToolsToggle hidden={toolsHidden} onToggle={onToggleTools} />}
        </span>
      </div>
    </div>
  );
}
