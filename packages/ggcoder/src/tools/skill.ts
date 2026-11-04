import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import { CONTEXT_LIMITS, type ContextLimits } from "../core/context-limits.js";
import { renderSkillLines, type Skill } from "../core/skills.js";

const parameters = z.object({
  skill: z.string(),
  args: z.string().optional(),
});

export function createSkillTool(
  skills: Skill[],
  limits: ContextLimits = CONTEXT_LIMITS,
): AgentTool<typeof parameters> {
  // Case-insensitive: discovery dedupes lowercase names, so `Foo` can be
  // listed while a literal lookup of `foo` (or vice versa) would miss.
  const skillMap = new Map(skills.map((s) => [s.name.toLowerCase(), s]));

  return {
    name: "skill",
    description: generateSkillDescription(skills, limits),
    parameters,
    async execute(input) {
      const skill = skillMap.get(input.skill.toLowerCase());
      if (!skill) {
        // Thrown, not returned: a plain-text "not found" reads as success to the
        // model. Bench (glm-ab7): GLM "loaded" skill "enter_plan", believed it was
        // in plan mode, and edited without the plan step. Name the real tool.
        const available = skills.map((s) => s.name).join(", ");
        throw new Error(
          `Skill "${input.skill}" not found; nothing was loaded. Skills: ${available || "none"}. ` +
            `If "${input.skill}" is a tool, call that tool directly instead.`,
        );
      }

      const parts = [`<skill_content name="${skill.name}">`];
      if (skill.root) parts.push(`Skill root directory: ${skill.root}`);
      parts.push(skill.content, `</skill_content>`);
      if (input.args) {
        parts.push(`\nUser context: ${input.args}`);
      }
      parts.push(
        "\nTreat the above skill instructions as authoritative within their stated scope. Preserve higher-priority project and file/module rules while following the skill to complete the task.",
      );
      return parts.join("\n");
    },
  };
}

function generateSkillDescription(skills: Skill[], limits: ContextLimits = CONTEXT_LIMITS): string {
  if (skills.length === 0) {
    return "Invoke a skill by name. No skills are currently available.";
  }

  // The active schema owns skill discovery; the system prompt omits its duplicate catalog.
  const { lines, dropped } = renderSkillLines(skills, limits);
  const overflow =
    dropped.length > 0 ? `\n_Skills omitted (catalog byte budget): ${dropped.join(", ")}_` : "";

  return (
    // Replay-tested on gpt-6-astra (Codex head-to-head): the previous "Before
    // acting, invoke a skill…" opener made the model spend a whole turn loading
    // `bulletproof` for a plain rename 6/6 times. The prompt-diet bench then
    // found the reverse on Sonnet 5.5: a description that opened with when NOT
    // to load meant 0 skill loads in 132 runs, including security work. So it
    // leads with the trigger and keeps the rename exclusion explicit.
    `Specialised method checklists. When the work is in a skill's scope below, load it before writing code. Match the work, not the topic: routine fixes and renames need none. Respect exclusions; never reload one.\n\n` +
    `${lines.join("\n")}${overflow}`
  );
}
