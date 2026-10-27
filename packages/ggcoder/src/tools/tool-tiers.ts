import type { AgentTool } from "@kenkaiiii/gg-agent";

/**
 * Two-tier split of the built-in toolset.
 *
 * Every tool in `this.tools` ships its full JSON parameter schema on every
 * request, inside the cached prefix. A core tool earns that cost because it is
 * reached in most sessions. A deferred tool does not: it contributes one
 * `- **name**: hint` line to the system prompt's Tools section (~15-25 tokens)
 * instead of a full schema (~300-500 tokens), and `tool_search` promotes it
 * into the live toolset the moment the model asks for that capability.
 *
 * The index line is what makes deferral safe. Dropping a schema WITHOUT
 * advertising the capability trades tokens for capability blindness — the model
 * cannot search for a tool it does not know exists. That is why every deferred
 * name is required to carry a `TOOL_PROMPT_HINTS` entry (enforced by test).
 *
 * Tier membership rule: a tool stays core if it is reached in more than roughly
 * one in five sessions. Deferring a tool is only safe while capability-discovery
 * rates hold: measure that, not just the token saving, before moving a name.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  // Core wherever it is registered at all (the app sidecar): a question the
  // model must `tool_search` for first is a question it writes in prose
  // instead. Hosts with nobody to answer never build it, so they pay nothing.
  "ask_user",
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "skill",
  "tool_search",
];

/**
 * Built-ins that live in the catalog as index lines until `tool_search` is
 * called. Each one is either rare (image generation, screenshots, the
 * debugger, package source resolution) or only reachable after another tool has already run
 * (the child-agent control cluster follows `spawn_agent`).
 *
 * `web_search` moved here after a 30-day usage count over 718 local sessions
 * found it in ~6% of working sessions. `steroids` (~8%) and `subagent` (~15%)
 * followed after a 2026-10 count over 255 working sessions, and a GLM-5.3
 * head-to-head with Dirac (bench/h2h/DIRAC-FINDINGS.md) showed the always-on
 * prefix — ~5.4k chars for these two schemas — was GG's main per-request
 * overhead.
 *
 * The 2026-10 prompt diet (bench/prompt-diet, GLM-5.3-Flash, 22 tasks) counted
 * 1,429 sessions over 60 days and deferred every built-in under the one-in-five
 * rule: find/ls (8%), code_search/code_nav (5%; both removed 2026-10-27 after 0
 * calls in 2,818 sessions), spawn_agent (4%), web_fetch
 * (3%), enter_plan/exit_plan (1%), task_send (0%). Together ~1.9k tokens per
 * request. Promotion appends to the tool list, so a session that does reach
 * one pays a cache restart once; the bench showed no pass-rate or speed loss.
 * `exit_plan` is promoted automatically whenever plan mode turns on,
 * `wait_agent` as soon as a spawn succeeds, and the task_* trio as soon as
 * bash starts a background process (task_output 12%, task_stop 4%).
 */
/**
 * Deferred tools that load themselves when their trigger runs (bash in the
 * background, a spawn, plan mode), so the model never needs to discover them:
 * they get no line in the prompt's on-demand index, only `tool_search` hints.
 */
export const AUTO_LOADED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task_output",
  "task_send",
  "task_stop",
  "wait_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "interrupt_agent",
  "exit_plan",
]);

export const DEFERRED_TOOL_NAMES: readonly string[] = [
  "task_output",
  "task_stop",
  "find",
  "ls",
  "web_fetch",
  "task_send",
  "spawn_agent",
  "enter_plan",
  "exit_plan",
  "web_search",
  "steroids",
  "subagent",
  "ui_registry",
  "ui_adopt",
  "source_path",
  "screenshot",
  "debug",
  "generate_image",
  "tasks",
  "checklist",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
];

const DEFERRED_SET: ReadonlySet<string> = new Set(DEFERRED_TOOL_NAMES);

export interface ToolTierPartition {
  /** Tools whose full schema stays in every request. */
  core: AgentTool[];
  /** Tools held in the deferred catalog until `tool_search` promotes them. */
  deferred: AgentTool[];
}

/**
 * Split a freshly built toolset into its two tiers, preserving input order
 * within each tier. An unrecognised name (a future built-in, an MCP tool that
 * reached this path) defaults to `core`: shipping one extra schema is a token
 * cost, whereas silently hiding an unknown capability is a behaviour loss.
 */
export function partitionToolsByTier(tools: readonly AgentTool[]): ToolTierPartition {
  const core: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const tool of tools) {
    if (DEFERRED_SET.has(tool.name)) deferred.push(tool);
    else core.push(tool);
  }
  return { core, deferred };
}
