import { formatElapsed, formatTokenCount } from "../ActivityBar";
import type { GoalFinish as GoalFinishScore } from "./goal-finish";
import "./placeholder.css";

const TITLE: Readonly<Record<GoalFinishScore["outcome"], string>> = {
  done: "Job done",
  unverified: "Done, not all checked",
  failed: "Couldn't finish",
};

/**
 * Placeholder (the fork owns the desktop design) for upstream's GoalFinishCard:
 * a stretch of goal work has finished, with its score (time, workers, turns,
 * tokens) and the way to the coordinator's summary in the chat. Announced
 * once; never takes focus; the caller takes it down.
 */
export function GoalFinish({
  finish,
  onShowChat,
  onClose,
}: {
  finish: GoalFinishScore;
  onShowChat: () => void;
  onClose: () => void;
}): React.ReactElement {
  const stats = [
    { label: "Time", value: formatElapsed(finish.elapsedMs) },
    {
      label: "Workers",
      value:
        finish.failedWorkers > 0
          ? `${finish.workers} (${finish.failedWorkers} failed)`
          : String(finish.workers),
    },
    { label: "Turns", value: String(finish.turns) },
    { label: "Tokens written", value: formatTokenCount(finish.outputTokens) },
  ];
  return (
    <section
      className="placeholder-notice placeholder-bar"
      role="status"
      aria-label={TITLE[finish.outcome]}
    >
      <div className="placeholder-notice-body">
        <p>
          <span className="placeholder-notice-headline">{TITLE[finish.outcome]}.</span>{" "}
          {finish.line}
        </p>
        <dl className="placeholder-list">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="placeholder-muted">{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <button type="button" onClick={onClose}>
          Close
        </button>{" "}
        <button type="button" onClick={onShowChat}>
          Read summary in Chat
        </button>
      </div>
    </section>
  );
}
