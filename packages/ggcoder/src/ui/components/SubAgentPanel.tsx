import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../spinner-frames.js";
import { useFocusedAnimation, deriveFrame } from "./AnimationContext.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { ToolUseLoader } from "./ToolUseLoader.js";

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
  marginTop?: number;
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

// Tree-drawing prefix widths (visual characters):
// "├─ " or "└─ " = 3 chars;  "│  " or "   " = 3 chars;  "⎿ " = 2 chars
const RESPONSE_LEFT_PADDING = 1;
const BRANCH_WIDTH = 3; // "├─ " / "└─ "
const DETAIL_PREFIX_WIDTH = 5; // continuation (3) + "⎿ " (2)

const AgentRow = React.memo(
  function AgentRow({
    agent,
    isLast,
    aborted,
    columns,
  }: {
    agent: SubAgentInfo;
    isLast: boolean;
    aborted: boolean;
    columns: number;
  }) {
    const theme = useTheme();
    const isRunning = agent.status === "running" && !aborted;

    // Derive spinner frame from global animation tick
    const { active: animationActive, tick } = useFocusedAnimation(isRunning);
    const frame = animationActive ? deriveFrame(tick, SPINNER_INTERVAL, SPINNER_FRAMES.length) : 0;

    const branch = isLast ? "└─" : "├─";
    const continuation = isLast ? "   " : "│  ";

    // Extract a clean, single-line display name from the task.
    // Strip markdown bold markers and take only the first line to prevent
    // multi-line prompts from leaking into the tree view.
    const firstLine = agent.task.split("\n")[0].replace(/\*\*/g, "");
    const taskDisplay = firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;

    const totalTokens = agent.tokenUsage.input + agent.tokenUsage.output;

    // Width budgets for content (excluding prefix columns)
    const taskContentWidth = Math.max(10, columns - BRANCH_WIDTH);
    const detailContentWidth = Math.max(10, columns - DETAIL_PREFIX_WIDTH);

    // Status detail line shown below the task name
    let detail: React.ReactNode;
    if (isRunning) {
      const activity = agent.currentActivity ?? "Starting…";
      detail = (
        <Text wrap="wrap">
          <Text color={theme.primary}>{SPINNER_FRAMES[frame]} </Text>
          <Text color={theme.textDim}>{activity}</Text>
        </Text>
      );
    } else if (agent.status === "done") {
      detail = (
        <Text color={theme.textDim} wrap="wrap">
          {formatTokens(totalTokens)} tokens
          {agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}
        </Text>
      );
    } else {
      // error or aborted
      detail = (
        <Text color={theme.error} wrap="wrap">
          {agent.status === "aborted" ? "Interrupted" : "Failed"}
          {agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ""}
        </Text>
      );
    }

    return (
      <Box flexDirection="column">
        {/* Task name line: fixed-width prefix + wrapping content */}
        <Box flexDirection="row">
          <Box width={BRANCH_WIDTH} flexShrink={0}>
            <Text color={theme.textDim}>{branch}</Text>
          </Box>
          <Box flexGrow={1} width={taskContentWidth}>
            <Text
              bold={isRunning}
              wrap="wrap"
              color={agent.status === "done" ? theme.success : undefined}
            >
              {agent.status === "done" ? "✓ " : agent.status === "error" ? "✗ " : ""}
            </Text>
            <Text bold={isRunning} wrap="wrap">
              {taskDisplay}
            </Text>
          </Box>
        </Box>
        {/* Detail line: fixed-width prefix + wrapping content */}
        <Box flexDirection="row">
          <Box width={DETAIL_PREFIX_WIDTH} flexShrink={0}>
            <Text color={theme.textDim}>{continuation}⎿ </Text>
          </Box>
          <Box flexGrow={1} width={detailContentWidth}>
            {detail}
          </Box>
        </Box>
      </Box>
    );
  },
  (prev, next) => {
    // Skip re-render for completed agents — their display is static
    if (prev.agent.status !== "running" && next.agent.status !== "running") {
      return (
        prev.isLast === next.isLast &&
        prev.agent.status === next.agent.status &&
        prev.columns === next.columns
      );
    }
    // For running agents, always re-render (spinner, activity, tokens change)
    return false;
  },
);

export function SubAgentPanel({ agents, aborted = false, marginTop = 0 }: SubAgentPanelProps) {
  const { columns } = useTerminalSize();

  if (agents.length === 0) return null;

  const runningCount = agents.filter((a) => a.status === "running").length;
  const allDone = runningCount === 0;

  // ToolUseLoader minWidth={2} = 2 chars
  const HEADER_PREFIX = 2;
  const contentColumns = Math.max(10, columns - RESPONSE_LEFT_PADDING - HEADER_PREFIX);

  const headerText = aborted
    ? `${agents.length} agent${agents.length !== 1 ? "s" : ""} interrupted`
    : allDone
      ? `${agents.length} agent${agents.length !== 1 ? "s" : ""} completed`
      : `${agents.length} agent${agents.length !== 1 ? "s" : ""} launched`;

  const dotStatus = aborted ? "error" : allDone ? "done" : "running";

  return (
    <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
      <ToolUseLoader status={dotStatus} />
      <Box flexDirection="column" flexGrow={1} width={contentColumns}>
        <Text bold wrap="wrap">
          {headerText}
        </Text>
        {agents.map((agent, i) => (
          <AgentRow
            key={agent.toolCallId}
            agent={agent}
            isLast={i === agents.length - 1}
            aborted={aborted}
            columns={contentColumns}
          />
        ))}
      </Box>
    </Box>
  );
}
