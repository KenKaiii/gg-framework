import { useEffect, useRef } from "react";
import { formatElapsed, formatTokenCount } from "./ActivityBar";
import type { GoalFinish } from "./goal-finish";
import { drawKenPortrait } from "./goal-ken-portrait";

interface Props {
  finish: GoalFinish;
  /** Take the user to the conversation, where Ken's full summary is. */
  onShowChat: () => void;
  onClose: () => void;
}

const TITLE: Readonly<Record<GoalFinish["outcome"], string>> = {
  done: "Job done",
  unverified: "Done, not all checked",
  failed: "Ken got stuck",
};

/**
 * A stretch of goal work has finished: the end-of-level card over the
 * Workers view, in Ken's storybook style (as GoalAskNotice). His face and
 * the line he ended on, the stretch's score (time, workers, turns, tokens),
 * and the way to his full summary in the chat. Announced once when it
 * appears; never takes focus; stays until closed, the user goes to the chat,
 * or work starts again (the caller decides).
 */
export function GoalFinishCard({ finish, onShowChat, onClose }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) drawKenPortrait(canvasRef.current, finish.face, { plain: true });
  }, [finish.face]);
  const title = TITLE[finish.outcome];
  const stats = [
    { label: "Time", value: formatElapsed(finish.elapsedMs) },
    {
      label: "Workers",
      value: String(finish.workers),
      note: finish.failedWorkers > 0 ? `${finish.failedWorkers} failed` : undefined,
    },
    { label: "Turns", value: String(finish.turns) },
    { label: "Tokens", value: formatTokenCount(finish.outputTokens) },
  ];
  return (
    <div className="goal-finish" role="status">
      <section className="goal-finish-sign" aria-label={title}>
        <div className="goal-ask-board goal-finish-board" data-outcome={finish.outcome}>
          <h2 className="goal-ask-title">{title}</h2>
          <div className="goal-finish-said">
            <span className="goal-ask-ken" aria-hidden="true">
              <canvas ref={canvasRef} />
            </span>
            <p className="goal-finish-line">{finish.line}</p>
          </div>
          <dl className="goal-finish-stats">
            {stats.map((stat) => (
              <div key={stat.label} className="goal-finish-stat">
                <dt>{stat.label}</dt>
                <dd>
                  {stat.value}
                  {stat.note && <span className="goal-finish-note">{stat.note}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <div className="goal-finish-actions">
            <button type="button" className="goal-finish-close" onClick={onClose}>
              Close
            </button>
            <button type="button" className="goal-ask-answer" onClick={onShowChat}>
              Read summary in Chat
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
