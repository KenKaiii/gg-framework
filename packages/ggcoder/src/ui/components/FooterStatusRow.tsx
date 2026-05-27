import React from "react";
import { Box, Text } from "ink";
import { BackgroundTasksBar, type FooterStatusLayoutDecision } from "./BackgroundTasksBar.js";
import type { BackgroundProcess } from "../../core/process-manager.js";
import type { useTheme } from "../theme/theme.js";

interface FooterStatusRowProps {
  columns: number;
  layout: FooterStatusLayoutDecision;
  tasks: BackgroundProcess[];
  focused: boolean;
  expanded: boolean;
  selectedIndex: number;
  onExpand: () => void;
  onCollapse: () => void;
  onKill: (id: string) => void;
  onExit: () => void;
  onNavigate: (index: number) => void;
  theme: ReturnType<typeof useTheme>;
}

export function FooterStatusRow({
  columns,
  layout,
  tasks,
  focused,
  expanded,
  selectedIndex,
  onExpand,
  onCollapse,
  onKill,
  onExit,
  onNavigate,
  theme,
}: FooterStatusRowProps) {
  if (!layout.hasBackgroundTasks && !layout.hasUpdateNotice) return null;

  return (
    <Box flexDirection={layout.stack ? "column" : "row"} width={columns}>
      {layout.hasBackgroundTasks && (
        <BackgroundTasksBar
          tasks={tasks}
          focused={focused}
          expanded={expanded}
          selectedIndex={selectedIndex}
          onExpand={onExpand}
          onCollapse={onCollapse}
          onKill={onKill}
          onExit={onExit}
          onNavigate={onNavigate}
          compact={layout.compactBackgroundTasks}
        />
      )}
      {layout.hasUpdateNotice && (
        <Box paddingLeft={layout.stack || !layout.hasBackgroundTasks ? 1 : 2} paddingRight={1}>
          <Text color={theme.success} bold wrap="truncate">
            ✨ Update ready · restart to apply
          </Text>
        </Box>
      )}
    </Box>
  );
}
