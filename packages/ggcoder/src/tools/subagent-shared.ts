import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentDefinition } from "../core/agents.js";
import { getFastModel, getModelForTier } from "../core/model-registry.js";
import { truncateTail } from "./truncate.js";

export const SUB_AGENT_MAX_TURNS = 50;
/**
 * Sub-agents get at most ONE turn-budget extension. A child's extensions run
 * inside a single parent turn, so a child extending itself twice multiplies
 * against the parent's own budget.
 */
export const SUB_AGENT_MAX_TURN_EXTENSIONS = 1;
export const SUB_AGENT_MAX_OUTPUT_CHARS = 100_000;
export const SUB_AGENT_MAX_OUTPUT_LINES = 500;
export const SUB_AGENT_MAX_STDERR_CHARS = 10_000;
export const SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const SUB_AGENT_DEPTH_ENV = "GG_SUBAGENT_DEPTH";
export const MAX_BLOCKING_SUBAGENT_DEPTH = 3;

export interface SubAgentTokenUsage {
  /** Fresh, non-cached input reported by the normalized provider adapter. */
  input: number;
  output: number;
  cacheRead?: number;
  /** Fresh input written into the provider cache (separate on Anthropic). */
  cacheWrite?: number;
}

export interface SubAgentSelection {
  agentDef?: AgentDefinition;
  provider: Provider;
  parentModel: string;
  model: string;
}

export function resolveAgentDefinition(
  agents: AgentDefinition[],
  requestedName?: string,
): AgentDefinition | undefined {
  if (!requestedName) return undefined;
  return agents.find((agent) => agent.name.toLowerCase() === requestedName.toLowerCase());
}

export function selectSubAgent(
  agents: AgentDefinition[],
  requestedName: string | undefined,
  provider: Provider,
  parentModel: string,
): SubAgentSelection {
  const agentDef = resolveAgentDefinition(agents, requestedName);
  return {
    agentDef,
    provider,
    parentModel,
    model: resolveAgentModel(agentDef, provider, parentModel),
  };
}

/**
 * Resolve which model a named agent runs on.
 *
 * The choice is declared in the agent's `model:` frontmatter, never inferred.
 * This used to guess: any agent without bash/write/edit was treated as
 * "read-only" and silently routed to the provider's cheapest tier — so every
 * research, recon and audit agent always ran on a Haiku-class model, invisibly
 * and with no way to override it. Defaulting to the parent's model instead
 * makes a downgrade opt-in and one line of frontmatter away.
 *
 * `model:` accepts, in order: `inherit` (default), `fast` (alias for the
 * `low` tier), a cost tier keyword (`low` | `medium` | `high`, resolved
 * within the SAME provider), or an explicit model id passed through
 * verbatim. A tier keyword is opt-in per agent, same as `fast` always was —
 * no existing agent's resolved model changes unless its frontmatter says so.
 */
export function resolveAgentModel(
  agentDef: AgentDefinition | undefined,
  provider: Provider,
  parentModel: string,
): string {
  const preference = agentDef?.model?.trim();
  if (!preference || preference === "inherit") return parentModel;
  if (preference === "fast") return getFastModel(provider, parentModel).id;
  // A cost tier resolves within the SAME provider, same as `fast` always did
  // (getFastModel is now `low` under this same mechanism) — no provider jump,
  // no crash on a provider with no sibling in that band. Anything else is an
  // explicit model id and passes through verbatim, unchanged from before.
  const tier = preference.toLowerCase();
  if (tier === "low" || tier === "medium" || tier === "high") {
    return getModelForTier(provider, parentModel, tier).id;
  }
  return preference;
}

/**
 * Render the agent roster for a tool description.
 *
 * Both delegation tools use this: the dispatcher picks an agent from the tool
 * schema alone, so a tool that omits the roster leaves the model guessing a
 * name — which either errors or, worse, silently spawns a generic child.
 */
export function renderAgentRoster(agents: readonly AgentDefinition[]): string {
  if (agents.length === 0) return "\n\nNo named agents configured.";
  const list = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
  return `\n\nAvailable named agents:\n${list}`;
}

export function childThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  return level === "ultra" ? "max" : level;
}

export function subAgentCacheKey(
  parentCacheKey: string | undefined,
  model: string,
  agentName = "default",
): string | undefined {
  return parentCacheKey ? `${parentCacheKey}:subagent:${model}:${agentName}` : undefined;
}

export function currentSubAgentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env[SUB_AGENT_DEPTH_ENV] ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function childSubAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [SUB_AGENT_DEPTH_ENV]: String(currentSubAgentDepth(env) + 1) };
}

export function resolveSubAgentCliEntry(env: NodeJS.ProcessEnv = process.env): string {
  const monitoredEntry = env.GG_SUBAGENT_WORKER_ENTRY;
  if (monitoredEntry) return monitoredEntry;
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(cliPath) ? cliPath : process.argv[1];
}

export function boundSubAgentOutput(raw: string): string {
  const result = truncateTail(
    raw || "(no output)",
    SUB_AGENT_MAX_OUTPUT_LINES,
    SUB_AGENT_MAX_OUTPUT_CHARS,
  );
  return result.truncated
    ? `[Sub-agent output truncated: ${result.totalLines} total lines, showing last ${result.keptLines}]\n\n${result.content}`
    : result.content;
}
