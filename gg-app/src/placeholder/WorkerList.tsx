import { useMemo } from "react";
import type { LiveToolEntry } from "../LiveToolPanel";
import { StatusDot, type StatusTone } from "./StatusDot";
import {
  collectGoalAgents,
  collectWorkers,
  goalAgentStateLabel,
  type GoalAgent,
  type WorkerGroup,
} from "./worker-status";
import "./placeholder.css";

function toneOf(agent: GoalAgent): StatusTone {
  if (agent.kind === "ask") return "warning";
  if (agent.status === "error") return "error";
  return agent.status === "working" ? "active" : "neutral";
}

/**
 * Placeholder (the fork owns the desktop design) for upstream's Goal world: the
 * coordinator and each worker it brought in, with a state label and what it
 * is doing now. Shown in place of the chat once a goal has started.
 */
export function WorkerList({
  groups,
  running,
  liveTools,
  waitingOnUser,
}: {
  /** Every sub-agent group in the transcript, oldest first. */
  groups: readonly WorkerGroup[];
  running: boolean;
  liveTools: readonly LiveToolEntry[];
  waitingOnUser: boolean;
}): React.ReactElement {
  const agents = useMemo(
    () => collectGoalAgents({ running, liveTools, waitingOnUser, workers: collectWorkers(groups) }),
    [groups, running, liveTools, waitingOnUser],
  );
  return (
    <section className="placeholder-goals" aria-label="Workers">
      <div className="placeholder-scroll">
        <ul className="placeholder-list">
          {agents.map((agent) => {
            const label = goalAgentStateLabel(agent);
            return (
              <li key={agent.key} className="placeholder-row">
                <span>
                  <StatusDot tone={toneOf(agent)} label={label} /> <strong>{agent.name}</strong>{" "}
                  <span className="placeholder-muted">{label}</span>
                </span>
                <span className="placeholder-muted">{agent.detail}</span>
              </li>
            );
          })}
        </ul>
        {agents.length === 1 && (
          <p className="placeholder-muted">No workers yet. The coordinator brings them in.</p>
        )}
      </div>
    </section>
  );
}
