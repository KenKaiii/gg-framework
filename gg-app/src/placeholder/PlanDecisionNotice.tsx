import type { PlanDecision } from "../transcript-item";
import { StatusDot } from "./StatusDot";

const COPY: Readonly<Record<PlanDecision, string>> = {
  accepted: "Plan accepted. Implementing it now.",
  feedback: "Feedback sent. Revising the plan.",
  rejected: "Plan rejected. Nothing was built.",
};

export function describePlanDecision(decision: PlanDecision): string {
  return COPY[decision];
}

/**
 * Placeholder (the fork owns the desktop design): the transcript row a plan
 * decision leaves behind. Accepting or revising sends the agent off to work;
 * a rejection ends it.
 */
export function PlanDecisionNotice({ decision }: { decision: PlanDecision }): React.ReactElement {
  const rejected = decision === "rejected";
  return (
    <div className="placeholder-notice" role="status">
      <StatusDot tone={rejected ? "neutral" : "active"} label={rejected ? "Stopped" : "Working"} />
      <span className={rejected ? "placeholder-muted" : "placeholder-attention"}>
        {describePlanDecision(decision)}
      </span>
    </div>
  );
}
