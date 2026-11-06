// The "Plan Mode" title shown when the agent enters plan mode: the same
// Alagard pixel lettering as Home's "GG Coder" title (scripts/gen-home-title.py),
// with the agent's reason beneath it in m5x7, Home's pixel body face.

import title from "./assets/home/plan-mode-title.png";

/** The title art's size in its own pixels (see scripts/gen-home-title.py). */
const PLAN_TITLE_W = 231;
const PLAN_TITLE_H = 39;

export function PlanModeLogo({ reason }: { reason?: string }): React.ReactElement {
  return (
    <div className="plan-logo">
      <img
        className="plan-logo-title"
        src={title}
        alt="Plan mode"
        width={PLAN_TITLE_W}
        height={PLAN_TITLE_H}
        draggable={false}
      />
      {reason ? <p className="plan-logo-reason">{reason}</p> : null}
    </div>
  );
}
