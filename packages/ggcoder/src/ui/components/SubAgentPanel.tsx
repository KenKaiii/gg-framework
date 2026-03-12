import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../spinner-frames.js";

export interface SubAgentInfo {
  toolCallId: string;
  task: string;
  agentName: string;
  status: "running" | "done" | "error" | "aborted";
  toolUseCount: number;
  tokenUsage: { input: number; output: number };
  currentActivity?: string;
  result?: string;
  durationMs?: number;
}

interface SubAgentPanelProps {
  agents: SubAgentInfo[];
  aborted?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

const AgentRow = React.memo(
  function AgentRow({
    agent,
    isLast,
    aborted,
  }: {
    agent: SubAgentInfo;
    isLast: boolean;
    aborted: boolean;
  }) {
    const theme = useTheme();
    const isRunning = agent.status === "running" && !aborted;

    // Spinner for running agents
    const [frame, setFrame] = useState(0);
    useEffect(() => {
      if (!isRunning) return;
      const timer = setInterval(() => {
        setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      }, SPINNER_INTERVAL);
      return () => clearInterval(timer);
    }, [isRunning]);

    const branch = isLast ? "└─" : "├─";
    const continuation = isLast ? "   " : "│  ";

    const taskDisplay = agent.task.length > 50 ? agent.task.slice(0, 47) + "…" : agent.task;

    const totalTokens = agent.tokenUsage.input + agent.tokenUsage.output;

    // Status detail line shown below the task name
    let detail: React.ReactNode;
    if (isRunning) {
      detail = (
        <Text>
          <Text color={theme.primary}>{SPINNER_FRAMES[frame]} </Text>
          <Text color={theme.textDim}>{agent.currentActivity ?? "Starting…"}</Text>
        </Text>
      );
    } else if (agent.status === "done") {
      detail = (
        <Text color={theme.textDim}>
          {formatTokens(totalTokens)} tokens
          {agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}
        </Text>
      );
    } else {
      // error or aborted
      detail = (
        <Text color={theme.error}>
          {agent.status === "aborted" ? "Interrupted" : "Failed"}
          {agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}
        </Text>
      );
    }

    return (
      <Box flexDirection="column">
        {/* Task name line */}
        <Box>
          <Text color={theme.textDim}>{branch} </Text>
          <Text bold={isRunning} color={agent.status === "done" ? theme.success : undefined}>
            {agent.status === "done" ? "✓ " : agent.status === "error" ? "✗ " : ""}
          </Text>
          <Text bold={isRunning}>{taskDisplay}</Text>
        </Box>
        {/* Detail line */}
        <Box>
          <Text color={theme.textDim}>{continuation}⎿ </Text>
          {detail}
        </Box>
      </Box>
    );
  },
  (prev, next) => {
    // Skip re-render for completed agents — their display is static
    if (prev.agent.status !== "running" && next.agent.status !== "running") {
      return prev.isLast === next.isLast && prev.agent.status === next.agent.status;
    }
    // For running agents, always re-render (spinner, activity, tokens change)
    return false;
  },
);

export function SubAgentPanel({ agents, aborted = false }: SubAgentPanelProps) {
  const theme = useTheme();

  if (agents.length === 0) return null;

  const runningCount = agents.filter((a) => a.status === "running").length;
  const allDone = runningCount === 0;

  const headerText = aborted
    ? `${agents.length} agent${agents.length !== 1 ? "s" : ""} interrupted`
    : allDone
      ? `${agents.length} agent${agents.length !== 1 ? "s" : ""} completed`
      : `${agents.length} agent${agents.length !== 1 ? "s" : ""} launched`;

  return (
    <Box marginTop={1}>
      <Text color={theme.primary}>{"⏺ "}</Text>
      <Box flexDirection="column" flexShrink={1}>
        <Text bold>{headerText}</Text>
        {agents.map((agent, i) => (
          <AgentRow
            key={agent.toolCallId}
            agent={agent}
            isLast={i === agents.length - 1}
            aborted={aborted}
          />
        ))}
      </Box>
    </Box>
  );
}
