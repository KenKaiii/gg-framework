/**
 * True when this process is the gg-app sidecar. Tauri always spawns it with
 * `GG_APP_PORT` set (even to "0"); the plain `ggcoder` CLI never sets it.
 *
 * Used to phrase user-facing notices in terms of the desktop app's UI instead
 * of TUI keybinds, and to hide TUI-only surfaces the app doesn't render.
 */
export function isGgApp(): boolean {
  return process.env.GG_APP_PORT !== undefined;
}

export function isPlanModeActive(planModeRef?: { current: boolean }): boolean {
  return planModeRef?.current === true;
}

// Tools that can't change the workspace or run commands. A helper agent limited
// to these may research during plan mode.
const READ_ONLY_AGENT_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "steroids",
]);

/** An agent whose allow-list is all read-only tools (an empty list inherits everything). */
export function isReadOnlyAgent(agent: { readonly tools: readonly string[] } | undefined): boolean {
  return (
    agent !== undefined &&
    agent.tools.length > 0 &&
    agent.tools.every((tool) => READ_ONLY_AGENT_TOOLS.has(tool))
  );
}

/** The plan-mode refusal for a helper agent that could edit, naming the ones that may run. */
export function planModeAgentRestriction(
  toolName: string,
  agents: readonly { readonly name: string; readonly tools: readonly string[] }[],
): string {
  const allowed = agents.filter(isReadOnlyAgent).map((agent) => agent.name);
  const hint =
    allowed.length > 0
      ? ` Only read-only agents can run in plan mode: ${allowed.join(", ")}.`
      : " No read-only agents are available; research with read-only tools instead.";
  return `Error: ${toolName} is restricted in plan mode for agents that can edit or run commands.${hint}`;
}

export function planModeRestriction(toolName: string): string {
  return `Error: ${toolName} is restricted in plan mode. Use read-only tools to explore (read-only bash like git log, wc, grep is allowed), write the plan under .gg/plans/, then call exit_plan for review.`;
}
