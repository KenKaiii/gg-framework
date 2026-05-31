export interface RuntimeModeRefs {
  planModeRef?: { current: boolean };
}

export function isPlanModeActive(planModeRef?: { current: boolean }): boolean {
  return planModeRef?.current === true;
}

export function planModeRestriction(toolName: string): string {
  return `Error: ${toolName} is restricted in plan mode. Use read-only tools to explore (read-only bash like git log, wc, grep is allowed), write the plan under .gg/plans/, then call exit_plan for review.`;
}
