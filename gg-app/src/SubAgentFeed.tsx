import { theme } from "./theme";
import { formatTokenCount } from "./ActivityBar";

// BLACK_CIRCLE — ⏺, matching the rest of the app's status figures.
const DOT = "\u23FA";

/** Max activity lines shown per running agent — older ones roll off the top. */
const MAX_FEED_ROWS = 4;

/** One delegated sub-agent, mirrored from the sidecar's subagent tool stream. */
export interface SubAgentLine {
  toolCallId: string;
  /** Named agent (e.g. "researcher") when supplied, else a positional label. */
  agentName?: string;
  status: "starting" | "running" | "idle" | "done" | "error" | "interrupted";
  async?: boolean;
  /** Rolling feed of tool activities the agent has run (already humanized). */
  activities: string[];
  toolUseCount: number;
  /** Cumulative token usage for this agent (live during the run). */
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  durationMs?: number;
}

interface Props {
  agents: readonly SubAgentLine[];
  aborted?: boolean;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function displayName(agent: SubAgentLine, index: number): string {
  return agent.agentName && agent.agentName !== "default" ? agent.agentName : `Agent ${index + 1}`;
}

/** Codex-style fresh-input + cached-input + output readout. */
export function formatSubAgentTokens(usage: SubAgentLine["tokenUsage"]): string | null {
  if (!usage) return null;
  // Anthropic reports newly cacheable input under cacheWrite, while OpenAI
  // reports it as ordinary non-cached input. Add writes back so the two rows
  // compare the same quantity instead of making Claude look artificially tiny.
  const freshInput = usage.input + (usage.cacheWrite ?? 0);
  const cacheRead = usage.cacheRead ?? 0;
  if (freshInput + cacheRead + usage.output === 0) return null;
  return [
    `\u2191 ${formatTokenCount(freshInput)}`,
    ...(cacheRead > 0 ? [`\u21BB ${formatTokenCount(cacheRead)} cached`] : []),
    `\u2193 ${formatTokenCount(usage.output)}`,
  ].join(" \u00b7 ");
}

/**
 * In-transcript display of sub-agents spawned in a turn. They run in parallel,
 * so each gets its own row: a status dot + name, then a live, truncated feed of
 * the tools it's running. Activity lines truncate to one line each (CSS
 * ellipsis), so the panel stays clean and reflows when the window resizes.
 */
export function SubAgentFeed({ agents, aborted = false }: Props): React.ReactElement | null {
  if (agents.length === 0) return null;

  const running = agents.filter(
    (agent) => agent.status === "running" || agent.status === "starting",
  ).length;
  const headerColor = aborted ? theme.error : running > 0 ? theme.primary : theme.success;
  const noun = `agent${agents.length !== 1 ? "s" : ""}`;
  const header = aborted
    ? `${agents.length} ${noun} interrupted`
    : running > 0
      ? `${agents.length} ${noun} running`
      : `${agents.length} ${noun} done`;

  return (
    <div className="subagents">
      <div className="subagents-head">
        <span className="tool-dot" style={{ color: headerColor }}>
          {DOT}
        </span>
        <span style={{ fontWeight: 600, color: theme.text }}>{header}</span>
      </div>
      <div className="subagents-list">
        {agents.map((agent, i) => {
          const isRunning = (agent.status === "running" || agent.status === "starting") && !aborted;
          const icon = aborted
            ? "\u2717"
            : agent.status === "done"
              ? "\u2713"
              : agent.status === "error" || agent.status === "interrupted"
                ? "\u2717"
                : DOT;
          const iconColor =
            agent.status === "done"
              ? theme.success
              : agent.status === "error" || agent.status === "interrupted" || aborted
                ? theme.error
                : theme.primary;

          // Done/errored agents collapse to a one-line summary; running agents
          // show their live tool feed (most recent last).
          const feed = isRunning ? agent.activities.slice(-MAX_FEED_ROWS) : [];
          const tokens = formatSubAgentTokens(agent.tokenUsage);

          return (
            <div className="subagent" key={agent.toolCallId}>
              <div className="subagent-row">
                <span
                  className={`subagent-icon${isRunning ? " blink" : ""}`}
                  style={{ color: iconColor }}
                >
                  {icon}
                </span>
                <span className="subagent-name" style={{ color: theme.text }}>
                  {displayName(agent, i)}
                </span>
                {tokens && (
                  <span className="subagent-tokens" style={{ color: theme.textDim }}>
                    {tokens}
                  </span>
                )}
                {!isRunning && (
                  <span className="subagent-summary" style={{ color: theme.textDim }}>
                    {aborted
                      ? "interrupted"
                      : agent.status === "error"
                        ? "failed"
                        : agent.status === "interrupted"
                          ? "interrupted"
                          : agent.status === "idle"
                            ? "idle · ready for follow-up"
                            : `${agent.toolUseCount} ${agent.toolUseCount === 1 ? "tool" : "tools"}`}
                    {agent.durationMs != null && !aborted
                      ? ` \u00b7 ${formatDuration(agent.durationMs)}`
                      : ""}
                  </span>
                )}
              </div>
              {feed.length > 0 && (
                <div className="subagent-feed">
                  {feed.map((activity, j) => (
                    <div
                      className="subagent-activity"
                      key={`${activity}-${j}`}
                      style={{
                        // Latest activity is brightest; older lines fade back.
                        color: j === feed.length - 1 ? theme.textSecondary : theme.textDim,
                      }}
                      title={activity}
                    >
                      {activity}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
