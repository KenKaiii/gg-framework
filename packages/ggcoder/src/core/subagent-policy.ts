import { resolveFastModeModel } from "@kenkaiiii/gg-ai";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";

export const ASYNC_ORCHESTRATION_MARKER = "\n\n## Async subagent orchestration\n";

const ULTRA_ORCHESTRATION_PROMPT =
  `${ASYNC_ORCHESTRATION_MARKER}` +
  `Proactively use spawn_agent for substantial independent workstreams. Start every independent child before calling wait_agent, and continue useful parent work while children run. ` +
  `Use send_message to steer active work, followup_task to reuse an idle child's context, list_agents for status, interrupt_agent to stop a turn, and wait_agent to collect every required result before finalizing. ` +
  `Keep small, tightly coupled, or sequential work in the parent. Children share the same workspace: parallel writes must target clearly disjoint files or subsystems. Delegation never expands scope or bypasses approval boundaries.`;

const EXPLICIT_ORCHESTRATION_PROMPT =
  `${ASYNC_ORCHESTRATION_MARKER}` +
  `Use spawn_agent and the async agent controls only when the user or applicable project/skill instructions explicitly request delegation. Start independent children before waiting, avoid overlapping file edits, and collect required results before finalizing.`;

export const OPENAI_SKILL_MARKER = "\n\n## Skill loading\n";

// OpenAI-only (bench/h2h/arena + bench/prompt-diet, gpt-6-luna): GPT loaded a
// skill in about half of runs that needed none, 1-5 extra calls each; Haiku 5.5
// loaded none in ~1,400. Most of those skills were removed or hidden after the
// skill-value bench (sv-haiku-1027); the general brake and the search line stay.
// On `explore` Luna searched in up to 6 narrow rounds where Haiku used 1-2.
const OPENAI_SKILL_PROMPT =
  `${OPENAI_SKILL_MARKER}` +
  "Load a skill only for that skill's specific kind of work; ordinary features, bug fixes, refactors and renames need none.\n" +
  "Find code with one broad search, then read all relevant hits in one response.";

/**
 * Re-render the model-dependent end of a system prompt: OpenAI skill-loading
 * guidance, then Astra/Sol async-orchestration guidance. Anything after either
 * marker is replaced, so repeated calls (model switches) never stack copies.
 */
export function applyAsyncSubagentPolicy(
  prompt: string,
  provider: Provider,
  model: string,
  thinkingLevel: ThinkingLevel | undefined,
  toolNames: readonly string[],
): string {
  const cuts = [ASYNC_ORCHESTRATION_MARKER, OPENAI_SKILL_MARKER]
    .map((marker) => prompt.indexOf(marker))
    .filter((index) => index !== -1);
  const stripped = cuts.length === 0 ? prompt : prompt.slice(0, Math.min(...cuts));
  const basePrompt =
    provider === "openai" && toolNames.includes("skill")
      ? stripped + OPENAI_SKILL_PROMPT
      : stripped;
  // Fast-mode ids are the same model at a faster tier — same policy.
  const baseModel = resolveFastModeModel(provider, model).model;
  const supportsPolicy =
    toolNames.includes("spawn_agent") &&
    provider === "openai" &&
    (baseModel === "gpt-6-astra" || baseModel === "gpt-6.1-sol");
  if (!supportsPolicy) return basePrompt;
  return (
    basePrompt +
    (thinkingLevel === "ultra" ? ULTRA_ORCHESTRATION_PROMPT : EXPLICIT_ORCHESTRATION_PROMPT)
  );
}
