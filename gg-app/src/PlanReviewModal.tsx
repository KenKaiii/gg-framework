import { useState } from "react";
import { MENTOR_DISPLAY_NAME } from "./brand";
import { theme } from "./theme";
import { YourPlanLogo } from "./PlanModeLogo";
import { Markdown } from "./Markdown";

interface Props {
  /** Plan markdown to review. */
  content: string;
  /** True while Autopilot Ken is reviewing this plan himself — shows a small
   *  indicator above the actions. Buttons stay ENABLED: a manual Accept/
   *  Feedback/Reject always overrides Ken (the sidecar's generation guard
   *  discards his stale verdict). */
  kenReviewing?: boolean;
  onAccept: () => void;
  onFeedback: (feedback: string) => void;
  onReject: () => void;
}

/**
 * Full-screen plan review shown on plan_exit (mirrors the ggcoder CLI plan
 * overlay): the amber "YOUR PLAN" banner, the rendered plan markdown, and three
 * actions — Accept (implement), Feedback (revise with notes), Reject (dismiss).
 */
export function PlanReviewModal({
  content,
  kenReviewing = false,
  onAccept,
  onFeedback,
  onReject,
}: Props): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div className="plan-review">
      <div className="plan-review-banner">
        <YourPlanLogo />
      </div>
      <div className="plan-review-body">
        <Markdown>{content || "_(plan is empty)_"}</Markdown>
      </div>

      {kenReviewing && (
        <div className="plan-review-ken" style={{ color: theme.ken }}>
          {MENTOR_DISPLAY_NAME} is reviewing this plan… you can still accept or reject it yourself.
        </div>
      )}
      <div className="plan-review-actions">
        {feedbackMode ? (
          <div className="plan-feedback">
            <textarea
              className="plan-feedback-input"
              value={feedback}
              placeholder="What should change about this plan?"
              autoFocus
              rows={3}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (feedback.trim()) onFeedback(feedback.trim());
                } else if (e.key === "Escape") {
                  setFeedbackMode(false);
                }
              }}
            />
            <div className="plan-feedback-row">
              <span className="plan-feedback-hint" style={{ color: theme.textDim }}>
                {"\u2318\u23CE to send \u00b7 Esc to cancel"}
              </span>
              <span className="plan-feedback-buttons">
                <button className="btn btn-ghost btn-sm" onClick={() => setFeedbackMode(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!feedback.trim()}
                  onClick={() => onFeedback(feedback.trim())}
                >
                  Send feedback
                </button>
              </span>
            </div>
          </div>
        ) : (
          <>
            <button className="btn btn-primary" onClick={onAccept}>
              Accept
            </button>
            <button className="btn btn-ghost" onClick={() => setFeedbackMode(true)}>
              Feedback
            </button>
            <button className="btn btn-ghost plan-reject" onClick={onReject}>
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
