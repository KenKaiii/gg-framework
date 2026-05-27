import React from "react";
import { Text, Box, useInput } from "ink";
import { useTheme } from "../theme/theme.js";
import type { BackgroundProcess } from "../../core/process-manager.js";

const MAX_VISIBLE = 5;

interface BackgroundTasksBarProps {
  tasks: BackgroundProcess[];
  focused: boolean;
  expanded: boolean;
  selectedIndex: number;
  onExpand: () => void;
  onCollapse: () => void;
  onKill: (id: string) => void;
  onExit: () => void;
  onNavigate: (index: number) => void;
  compact?: boolean;
}

export interface FooterStatusLayoutOptions {
  columns: number;
  backgroundTaskCount: number;
  updatePending: boolean;
}

export interface FooterStatusLayoutDecision {
  hasBackgroundTasks: boolean;
  hasUpdateNotice: boolean;
  stack: boolean;
  compactBackgroundTasks: boolean;
}

export function getFooterStatusLayoutDecision({
  columns,
  backgroundTaskCount,
  updatePending,
}: FooterStatusLayoutOptions): FooterStatusLayoutDecision {
  const hasBackgroundTasks = backgroundTaskCount > 0;
  const hasUpdateNotice = updatePending;
  const visibleCount = [hasBackgroundTasks, hasUpdateNotice].filter(Boolean).length;
  return {
    hasBackgroundTasks,
    hasUpdateNotice,
    stack: visibleCount > 1 && columns < 100,
    compactBackgroundTasks: visibleCount > 1 && columns < 120,
  };
}

function truncateCommand(command: string, maxLen: number): string {
  if (command.length <= maxLen) return command;
  return command.slice(0, maxLen - 1) + "\u2026";
}

export function BackgroundTasksBar({
  tasks,
  focused,
  expanded,
  selectedIndex,
  onExpand,
  onCollapse,
  onKill,
  onExit,
  onNavigate,
  compact = false,
}: BackgroundTasksBarProps) {
  const theme = useTheme();

  // Keyboard: collapsed+focused — Enter opens, Esc/↑ exits
  useInput(
    (_input, key) => {
      if (!expanded) {
        if (key.return) {
          onExpand();
        } else if (key.escape || key.upArrow) {
          onExit();
        }
        return;
      }

      // Expanded mode
      if (key.escape) {
        onCollapse();
        return;
      }

      if (key.upArrow) {
        if (selectedIndex <= 0) {
          onCollapse();
        } else {
          onNavigate(selectedIndex - 1);
        }
        return;
      }

      if (key.downArrow) {
        const maxIdx = Math.min(tasks.length, MAX_VISIBLE) - 1;
        if (selectedIndex < maxIdx) {
          onNavigate(selectedIndex + 1);
        }
        return;
      }

      if (_input === "k" || _input === "K") {
        const task = tasks[selectedIndex];
        if (task) {
          onKill(task.id);
        }
      }
    },
    { isActive: focused },
  );

  if (tasks.length === 0) return null;

  const count = tasks.length;
  const label = `Background task${count !== 1 ? "s" : ""}`;
  const collapsedTextColor = focused ? theme.commandColor : theme.textDim;

  // Collapsed: single summary line
  if (!expanded) {
    return (
      <Box paddingLeft={1} paddingRight={1}>
        <Text color={collapsedTextColor}>{"● "}</Text>
        <Text color={collapsedTextColor}>({count})</Text>
        <Text color={collapsedTextColor}> {compact ? "bg tasks" : label}</Text>
        {focused && !compact && (
          <Text color={theme.textDim}>
            {" \u00B7 "}
            <Text color={theme.commandColor}>Enter</Text> to view
          </Text>
        )}
      </Box>
    );
  }

  // Expanded: show up to MAX_VISIBLE tasks
  const visible = tasks.slice(0, MAX_VISIBLE);
  const hidden = count - visible.length;

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Text color={theme.textDim}>
        -- {label.toLowerCase()} ({count}) --
      </Text>
      {visible.map((task, i) => {
        const isSelected = i === selectedIndex;
        const textColor = isSelected ? theme.commandColor : theme.textDim;
        const cmd = truncateCommand(task.command, 50);
        const isRunning = task.exitCode === null;
        const dot = isRunning ? "\u25CF" : "\u25CB";
        const statusLabel = isRunning ? "running" : `exit ${task.exitCode}`;

        return (
          <Box
            key={task.id}
            flexDirection="row"
            backgroundColor={isSelected ? theme.border : undefined}
          >
            <Box width={9} flexShrink={0}>
              <Text color={textColor}>{task.id}</Text>
            </Box>
            <Box flexGrow={1} paddingLeft={1}>
              <Text color={textColor} wrap="truncate">
                {cmd}
              </Text>
            </Box>
            <Box paddingLeft={2} flexShrink={0}>
              <Text color={textColor}>
                {dot} {statusLabel}
              </Text>
            </Box>
          </Box>
        );
      })}
      {hidden > 0 && <Text color={theme.textDim}>+{hidden} more</Text>}
      <Text color={theme.textDim}>
        <Text color={theme.primary}>↑↓</Text>
        {" navigate · "}
        <Text color={theme.primary}>K</Text>
        {" kill · "}
        <Text color={theme.primary}>Esc</Text>
        {" back"}
      </Text>
    </Box>
  );
}
