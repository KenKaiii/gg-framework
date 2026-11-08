import "./placeholder.css";

interface Props {
  /** The reader has scrolled up, so the chat no longer follows new output. */
  away: boolean;
  /** New rows arrived below while the reader was scrolled up. */
  hasNew: boolean;
  /**
   * Where a question still waiting on the user sits, when it is off screen:
   * above the view (the agent kept talking after asking it) or below it (the
   * reader scrolled up past it). Null when there is none, or it is on screen.
   */
  askAt: "above" | "below" | null;
  onScrollToBottom: () => void;
  onJumpToNew: () => void;
  onJumpToAsk: () => void;
}

/**
 * Placeholder (the fork owns the desktop design): the transcript's way around,
 * floating along the bottom of `.transcript-frame`. An unanswered question out
 * of view (the agent is blocked on it) wins over "You have new chats", which
 * only shows while scrolled up. Controls render only when they apply.
 */
export function TranscriptJump({
  away,
  hasNew,
  askAt,
  onScrollToBottom,
  onJumpToNew,
  onJumpToAsk,
}: Props): React.ReactElement | null {
  const showAsk = askAt !== null;
  const showNew = !showAsk && away && hasNew;
  if (!showAsk && !showNew && !away) return null;
  return (
    <div className="placeholder-jump">
      {showAsk && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onJumpToAsk}>
          {askAt === "below" ? "↓" : "↑"} You have a new question
        </button>
      )}
      {showNew && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onJumpToNew}>
          {"↓"} You have new chats
        </button>
      )}
      {away && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onScrollToBottom}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
        >
          {"↓"}
        </button>
      )}
    </div>
  );
}
