// Who is working on a Goal and what each one is doing, derived from the
// window's live state: the coordinator from the main run's tool feed, and
// every worker it brought in from the transcript's sub-agent groups. Pure, so
// the Workers list and its tests share one mapping.
//
// Ported from upstream's goal-world-agents.ts, CritterFloor.tsx's
// collectFloorAgents/floorStatus and critter-tool-kind.ts, without the farm.

import type { LiveToolEntry } from "../LiveToolPanel";
import { formatSubAgentTokens, type SubAgentLine } from "../SubAgentFeed";

// ── Tool kinds (upstream critter-tool-kind.ts) ──
//
// A sub-agent's latest tool activity arrives in two shapes:
//  1. Humanized (the coder's tools/subagent.ts formatToolActivity):
//     "Reading src/a.ts", "Searching for \"foo\"", "Running pnpm test", …,
//     or "<name>: <detail>" / "<name>" for anything it doesn't special-case.
//  2. Raw (the coder's core/subagent-manager.ts activity()):
//     "<toolname>: <first string arg>" or "<toolname>".
// Waiting on or stopping a background task is bookkeeping, not work, so it
// maps to null and the worker keeps whatever it was doing.

export type ToolKind = "read" | "search" | "edit" | "run" | "web";

/** Humanized prefixes, most specific first ("Searching web for" before "Searching for"). */
const PREFIXES: readonly (readonly [string, ToolKind | null])[] = [
  ["Reading task output", null],
  ["Stopping task", null],
  ["Searching web for", "web"],
  ["Searching for", "search"],
  ["Finding", "search"],
  ["Resolving source for", "search"],
  ["Reading", "read"],
  ["Listing", "read"],
  ["Loading skill", "read"],
  ["Writing", "edit"],
  ["Editing", "edit"],
  ["Running", "run"],
  ["Fetching", "web"],
];

/** Raw tool names. Anything not listed (MCP tools, sub-agents…) is null. */
const TOOL_NAMES: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["read", "read"],
  ["ls", "read"],
  ["skill", "read"],
  ["grep", "search"],
  ["find", "search"],
  ["source_path", "search"],
  ["edit", "edit"],
  ["write", "edit"],
  ["bash", "run"],
  ["debug", "run"],
  ["web_fetch", "web"],
  ["web_search", "web"],
]);

/** A bare tool name, optionally followed by ": detail". */
const NAMED = /^([A-Za-z_][\w.-]*)(?::|$)/;

/** The kind of work an activity string describes, or null when it's not one we show. */
export function toolKindOf(activity: string | undefined): ToolKind | null {
  const text = activity?.trim();
  if (!text) return null;
  for (const [prefix, kind] of PREFIXES) {
    if (text === prefix || text.startsWith(`${prefix} `)) return kind;
  }
  const name = NAMED.exec(text)?.[1]?.toLowerCase();
  if (!name) return null;
  return TOOL_NAMES.get(name) ?? null;
}

// ── Workers from the transcript (upstream CritterFloor.tsx) ──

/** The transcript's sub-agent groups, as far as the Workers list cares. */
export interface WorkerGroup {
  readonly id: number;
  readonly agents: readonly SubAgentLine[];
  readonly aborted?: boolean;
}

export type WorkerAgentStatus = "running" | "idle" | "done" | "error" | "interrupted";

/** One worker, flattened from its sub-agent group. */
export interface WorkerAgent {
  /** Stable identity across renders. */
  readonly key: string;
  /** Named agent type (e.g. "researcher"). */
  readonly agentName: string | undefined;
  readonly label: string;
  readonly status: WorkerAgentStatus;
  /** Latest humanized tool activity. */
  readonly activity: string | undefined;
  /** Preformatted token readout (↑ · ↻ cached · ↓), or null before any usage. */
  readonly tokens: string | null;
  readonly durationMs: number | undefined;
  readonly toolUseCount: number;
}

function workerAgentStatus(agent: SubAgentLine, aborted: boolean): WorkerAgentStatus {
  switch (agent.status) {
    case "starting":
    case "running":
      return aborted ? "interrupted" : "running";
    default:
      return agent.status;
  }
}

function displayName(agent: SubAgentLine, index: number): string {
  return agent.agentName && agent.agentName !== "default" ? agent.agentName : `Agent ${index + 1}`;
}

/**
 * Flatten the transcript's sub-agent groups into one worker list. Keys carry
 * the group id because resumed history rows reuse positional ids.
 */
export function collectWorkers(groups: readonly WorkerGroup[]): WorkerAgent[] {
  return groups.flatMap((group) =>
    group.agents.map((agent, index): WorkerAgent => ({
      key: `${group.id}:${agent.toolCallId}`,
      agentName: agent.agentName,
      label: displayName(agent, index),
      status: workerAgentStatus(agent, group.aborted === true),
      activity: agent.activities[agent.activities.length - 1],
      tokens: formatSubAgentTokens(agent.tokenUsage),
      durationMs: agent.durationMs,
      toolUseCount: agent.toolUseCount,
    })),
  );
}

// ── Everyone on the goal (upstream goal-world-agents.ts) ──

/** Every kind of work the list can name. */
export const WORK_KINDS = [
  "read",
  "search",
  "edit",
  "run",
  "web",
  "think",
  "ask",
  "delegate",
  "wait",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type GoalAgentStatus = "working" | "idle" | "done" | "error";

export interface GoalAgent {
  readonly key: string;
  readonly agentName: string | undefined;
  readonly name: string;
  readonly coordinator: boolean;
  readonly status: GoalAgentStatus;
  /** What it is doing now; null when it has nothing to do. */
  readonly kind: WorkKind | null;
  /** The same in words, for the list and screen readers. */
  readonly detail: string;
}

export const COORDINATOR_KEY = "coordinator";
export const COORDINATOR_NAME = "Kleio Goals";

/** Coordinator tools that mean something other than their plain tool kind. */
const COORDINATOR_TOOLS: ReadonlyMap<string, WorkKind> = new Map<string, WorkKind>([
  ["ask_user", "ask"],
  ["spawn_agent", "delegate"],
  ["subagent", "delegate"],
  ["send_agent", "delegate"],
  ["wait_agent", "wait"],
  ["task_output", "wait"],
  ["tasks", "think"],
  ["checklist", "think"],
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function clip(value: string, max = 48): string {
  const single = value.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** What a coordinator tool call is, as a kind of work. */
export function coordinatorKind(toolName: string): WorkKind {
  return COORDINATOR_TOOLS.get(toolName) ?? toolKindOf(toolName) ?? "think";
}

/** One line saying what a coordinator tool call is doing. */
export function describeTool(name: string, args: Readonly<Record<string, unknown>>): string {
  const path = text(args.file_path) ?? text(args.path);
  switch (coordinatorKind(name)) {
    case "read":
      return path ? `Reading ${clip(baseName(path), 40)}` : "Reading";
    case "edit":
      return path ? `Editing ${clip(baseName(path), 40)}` : "Editing";
    case "search": {
      const query = text(args.pattern) ?? text(args.query);
      return query ? `Searching for “${clip(query, 32)}”` : "Searching";
    }
    case "run": {
      const command = text(args.command);
      return command ? `Running ${clip(command, 40)}` : "Running a command";
    }
    case "web": {
      const query = text(args.query) ?? text(args.url);
      return query ? `Browsing ${clip(query, 40)}` : "Browsing the web";
    }
    case "ask":
      return "Asking you a question";
    case "delegate":
      return "Bringing in help";
    case "wait":
      return "Waiting on the team";
    case "think":
      return "Planning";
  }
}

function goalAgentStatus(agent: WorkerAgent): GoalAgentStatus {
  switch (agent.status) {
    case "running":
      return "working";
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "error":
    case "interrupted":
      return "error";
  }
}

export interface GoalAgentsInput {
  /** The main run is in progress. */
  readonly running: boolean;
  /** The main run's recent tool calls, oldest first. */
  readonly liveTools: readonly LiveToolEntry[];
  /** The coordinator is waiting on an answer from the user. */
  readonly waitingOnUser: boolean;
  /** Every worker the coordinator brought in. */
  readonly workers: readonly WorkerAgent[];
}

function coordinator(input: GoalAgentsInput): GoalAgent {
  const base = {
    key: COORDINATOR_KEY,
    agentName: undefined,
    name: COORDINATOR_NAME,
    coordinator: true,
  };
  if (input.waitingOnUser) {
    return { ...base, status: "working", kind: "ask", detail: "Waiting for your answer" };
  }
  if (!input.running) {
    return { ...base, status: "idle", kind: null, detail: "Ready when you are" };
  }
  const current = [...input.liveTools].reverse().find((entry) => entry.status === "running");
  if (!current) {
    // Between tool calls the coordinator is thinking over what it just did,
    // so it stays with that kind of work; only before its first tool, or once
    // a question is answered, is it planning.
    const last = input.liveTools[input.liveTools.length - 1];
    const lastKind = last ? coordinatorKind(last.name) : null;
    const kind = lastKind && lastKind !== "ask" ? lastKind : "think";
    return { ...base, status: "working", kind, detail: "Planning" };
  }
  return {
    ...base,
    status: "working",
    kind: coordinatorKind(current.name),
    detail: describeTool(current.name, current.args),
  };
}

/** Everyone on the goal right now: the coordinator first, then its workers. */
export function collectGoalAgents(input: GoalAgentsInput): GoalAgent[] {
  const workers = input.workers.map((agent): GoalAgent => {
    const status = goalAgentStatus(agent);
    const activity = agent.activity?.trim();
    const kind = status === "working" ? (toolKindOf(activity) ?? "think") : null;
    return {
      key: agent.key,
      agentName: agent.agentName,
      name: agent.label,
      coordinator: false,
      status,
      kind,
      detail:
        status === "done"
          ? "Finished"
          : status === "error"
            ? "Stopped"
            : activity
              ? clip(activity)
              : status === "working"
                ? "Thinking"
                : "Waiting for work",
    };
  });
  return [coordinator(input), ...workers];
}

/** The state label a row shows next to its dot. */
export function goalAgentStateLabel(agent: GoalAgent): string {
  if (agent.kind === "ask") return "Waiting for you";
  switch (agent.status) {
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "done":
      return "Done";
    case "error":
      return agent.coordinator ? "Error" : "Stopped";
  }
}
