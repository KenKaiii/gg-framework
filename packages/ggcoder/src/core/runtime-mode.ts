export type GoalMode = "off" | "planner" | "setup" | "coordinator";

export interface RuntimeModeRefs {
  goalModeRef?: { current: GoalMode };
  planModeRef?: { current: boolean };
}

export function getActiveGoalMode(goalModeRef?: { current: GoalMode }): GoalMode {
  return goalModeRef?.current ?? "off";
}

export function isGoalModeActive(goalModeRef?: { current: GoalMode }): boolean {
  return getActiveGoalMode(goalModeRef) !== "off";
}

export function goalModeRestriction(toolName: string, action: string): string {
  return `Error: ${toolName} is restricted in Goal mode. The parent session is planning/orchestration-only; use the appropriate Goal phase for ${action} and let Goal workers perform implementation.`;
}

export function isPlanModeActive(planModeRef?: { current: boolean }): boolean {
  return planModeRef?.current === true;
}

export function planModeRestriction(toolName: string): string {
  return `Error: ${toolName} is restricted in plan mode. Use read-only tools to explore (read-only bash like git log, wc, grep is allowed), write the plan under .gg/plans/, then call exit_plan for review.`;
}
