import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Skill } from "../core/skills.js";

const parameters = z.object({
  skill: z.string().describe("The name of the skill to invoke"),
  args: z.string().optional().describe("Optional arguments or context for the skill"),
});

export function createSkillTool(skills: Skill[]): AgentTool<typeof parameters> {
  // Case-insensitive: discovery dedupes lowercase names, so `Foo` can be
  // listed while a literal lookup of `foo` (or vice versa) would miss.
  const skillMap = new Map(skills.map((s) => [s.name.toLowerCase(), s]));

  return {
    name: "skill",
    description: generateSkillDescription(skills),
    parameters,
    async execute(input) {
      const skill = skillMap.get(input.skill.toLowerCase());
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        return `Error: Skill "${input.skill}" not found. Available skills: ${available || "none"}`;
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

function generateSkillDescription(skills: Skill[]): string {
  if (skills.length === 0) {
    return "Invoke a skill by name. No skills are currently available.";
  }

  const list = skills
    .map((s) => `- **${s.name}**: ${s.description || "No description"}`)
    .join("\n");

  return (
    `Invoke a skill by name to get specialized instructions for a task. ` +
    `Before acting, invoke a skill when the request matches its scope and respect explicit exclusions.\n\n` +
    `Available skills:\n${list}`
  );
}
