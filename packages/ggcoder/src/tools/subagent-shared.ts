import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Provider, ThinkingLevel } from "@kleio/ai";
import type { AgentDefinition } from "../core/agents.js";
import type { AgentSession } from "../core/agent-session.js";
import { getLowestThinkingLevel, getSupportedThinkingLevels } from "../core/thinking-level.js";
import { withoutPaidTier } from "../core/model-registry.js";
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
/**
 * The single tool-free turn a timed-out worker gets to answer from what it has
 * gathered. Anyone waiting on a time-limited child must allow for it.
 */
export const SUB_AGENT_TIMEOUT_RECOVERY_MS = 60_000;
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
  /** Thinking level the child runs at — see {@link subAgentThinkingLevel}. */
  thinkingLevel: ThinkingLevel | undefined;
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
  parentThinkingLevel?: ThinkingLevel,
): SubAgentSelection {
  const agentDef = resolveAgentDefinition(agents, requestedName);
  // Children never run on a paid tier: one opted-in parent would otherwise
  // multiply real-money spend across every agent it starts.
  const model = withoutPaidTier(resolveAgentModel(agentDef, parentModel));
  return {
    agentDef,
    provider,
    parentModel,
    model,
    thinkingLevel: subAgentThinkingLevel(provider, model, parentThinkingLevel),
  };
}

/**
 * Resolve which model a named agent runs on.
 *
 * Sub-agents never get a weaker model of their own: no `model:` frontmatter,
 * `inherit`, and the legacy `fast` all run on the parent's model. An explicit
 * model id is honoured as written, since that is a choice the user made in
 * their own agent definition.
 */
export function resolveAgentModel(
  agentDef: AgentDefinition | undefined,
  parentModel: string,
): string {
  const preference = agentDef?.model?.trim();
  if (!preference || preference === "inherit" || preference === "fast") return parentModel;
  return preference;
}

/**
 * OpenAI children inherit the parent's selection, including Ultra (resolved
 * by the transport), as in Codex. A pinned model with a lower ceiling is
 * capped to its supported ladder. Other providers keep their lowest-rung
 * policy. Resolve again from the original parent selection on fallback.
 */
export function subAgentThinkingLevel(
  provider: Provider,
  model: string,
  parentThinkingLevel?: ThinkingLevel,
): ThinkingLevel | undefined {
  if (provider !== "openai") return getLowestThinkingLevel(provider, model);
  if (!parentThinkingLevel) return undefined;
  const levels = getSupportedThinkingLevels(provider, model);
  if (levels.includes(parentThinkingLevel)) return parentThinkingLevel;
  // Older OpenAI models start at medium; never turn inherited low into xhigh.
  return parentThinkingLevel === "low" ? levels[0] : levels.at(-1);
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

/** One child started by a recorded `spawn_agent` call. */
export interface SpawnedTaskArgs {
  task_name?: string;
  task?: string;
  agent?: string;
}

/**
 * The children a recorded `spawn_agent` call started, for rebuilding history:
 * `{ tasks: [...] }` today, or the single `{ task_name, task, agent }` that
 * sessions saved before batch launch carry. Untrusted session data, so only
 * string fields are kept.
 */
export function spawnedTasks(args: unknown): SpawnedTaskArgs[] {
  if (typeof args !== "object" || args === null) return [{}];
  const record = args as Record<string, unknown>;
  const entries = Array.isArray(record.tasks) ? record.tasks : [record];
  const tasks = entries
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
    )
    .map((entry) => {
      const out: SpawnedTaskArgs = {};
      if (typeof entry.task_name === "string") out.task_name = entry.task_name;
      if (typeof entry.task === "string") out.task = entry.task;
      if (typeof entry.agent === "string") out.agent = entry.agent;
      return out;
    });
  return tasks.length > 0 ? tasks : [{}];
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

/**
 * Run one sub-agent prompt and resolve to the error the agent loop stopped on,
 * if it stopped on one.
 *
 * `prompt()` resolving is not proof the child finished. The loop ends some runs
 * by emitting an `error` event and then returning normally — repeated invalid
 * tool arguments, a provider that stopped responding, a tool call that never
 * closed — because an interactive user sees that error and simply sends
 * another message. A sub-agent has nobody to do that, so its host must treat
 * the event as a failed turn; otherwise the parent receives the child's
 * mid-task narration ("Let me re-read…") as if it were the final report.
 */
export async function promptSubAgent(
  session: Pick<AgentSession, "prompt" | "eventBus">,
  task: string,
): Promise<Error | undefined> {
  let stoppedOn: Error | undefined;
  const unsubscribe = session.eventBus.on("error", ({ error }) => {
    stoppedOn = error;
  });
  try {
    await session.prompt(task);
  } finally {
    unsubscribe();
  }
  return stoppedOn;
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
