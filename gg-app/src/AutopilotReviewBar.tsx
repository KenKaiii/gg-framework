import { useEffect, useState } from "react";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";
import { SPINNER_FRAMES, SPINNER_FRAME_MS } from "./ActivityBar";

interface Props {
  /** Stop the in-flight autopilot review (reuses the shared /cancel path). */
  onCancel: () => void;
}

/**
 * Autopilot review status row. Shown in the activity-bar region (not the
 * transcript) while Ken is silently auto-reviewing GG Coder's just-finished
 * turn — same braille spinner + statusrow layout as the run/Ken bars, tinted to
 * Ken and labelled "Ken reviewing…". No timer/tokens: the review is short and
 * its verdict lands as a Ken bubble, so this is a pure activity indicator.
 */
export function AutopilotReviewBar({ onCancel }: Props): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const spin = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_FRAME_MS,
    );
    return () => clearInterval(spin);
  }, []);

  return (
    <div className="statusrow running ken-statusrow" style={{ color: theme.textMuted }}>
      <span className="statusrow-left">
        <span className="statusrow-icon spinner ken-spinner" style={{ color: theme.ken }}>
          {SPINNER_FRAMES[frame]}
        </span>
        <span className="working" style={{ color: theme.ken }}>
          {`${MENTOR_DISPLAY_NAME} reviewing\u2026`}
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
