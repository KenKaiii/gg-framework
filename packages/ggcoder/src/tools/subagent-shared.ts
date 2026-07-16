import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentDefinition } from "../core/agents.js";
import { getFastModel } from "../core/model-registry.js";
import { truncateTail } from "./truncate.js";

const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

export const SUB_AGENT_MAX_TURNS = 50;
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
  const readOnly =
    !!agentDef &&
    agentDef.tools.length > 0 &&
    !agentDef.tools.some((tool) => MUTATING_TOOLS.has(tool.toLowerCase()));
  return {
    agentDef,
    provider,
    parentModel,
    model: readOnly ? getFastModel(provider, parentModel).id : parentModel,
  };
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

export function resolveSubAgentCliEntry(): string {
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
