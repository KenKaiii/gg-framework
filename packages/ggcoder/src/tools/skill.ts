import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { CONTEXT_LIMITS, type ContextLimits } from "../core/context-limits.js";
import { renderSkillLines, type BlockedSkill, type Skill } from "../core/skills.js";

// Haiku 5.5, loading 3 skills in parallel, sent `{ args }` with no `skill` in
// 3 of 9 calls (bench/prompt-diet skills-haiku-fix-1027, review-data); each
// failed call cost a turn. Field descriptions make the required name explicit.
const parameters = z.object({
  skill: z.string().describe("Required: the exact skill name from the list. One skill per call."),
  args: z.string().optional().describe("Optional context for the skill."),
});

export function createSkillTool(
  skills: Skill[],
  limits: ContextLimits = CONTEXT_LIMITS,
  blocked: readonly BlockedSkill[] = [],
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
        const refused = blocked.find((b) => b.name.toLowerCase() === input.skill.toLowerCase());
        if (refused) {
          // Thrown so the model can't mistake it for loaded instructions; the
          // plain reason lets it tell the user and carry on without the skill.
          throw new Error(
            `Skill "${refused.name}" was blocked for safety (${refused.reason}) and is not available. ` +
              `Tell the user and continue without it.`,
          );
        }
        // Thrown, not returned: a plain-text "not found" reads as success to the
        // model. Bench (glm-ab7): GLM "loaded" skill "enter_plan", believed it was
        // in plan mode, and edited without the plan step. Name the real tool.
        const available = skills
          .filter((s) => !s.hidden)
          .map((s) => s.name)
          .join(", ");
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
      if (skill.root) {
        // Children start with an empty context: a brief that says "follow the
        // skill" without its path silently drops the skill's rules.
        parts.push(
          `If you delegate part of this work to a child agent, it cannot see these instructions: put the skill root (${skill.root}), the exact reference files it must read, and the output you need in its brief.`,
        );
      }
      parts.push(DELEGATION_RULES, HOST_RULES);
      return parts.join("\n");
    },
  };
}

// One copy of the fan-out mechanics every bundled skill used to repeat in its
// own Scaling section (~1-1.5 KB each). Skills keep only *when* to fan out and
// how to slice; helpers are named by role because the agent roster differs by
// mode (Code: owl/bee/auditor/skeptic; Goals: scout/builder/checker), and a
// skill that names a missing agent makes the spawn fail.
export const DELEGATION_RULES =
  "Delegation, only where the skill's Scaling section allows it: use agent types your spawn_agent tool actually lists, matched by role: read-only repo helper (owl or scout), web researcher (researcher), security auditor and verifier (auditor and skeptic where listed, else a read-only helper), editor on strictly disjoint files (bee or builder). " +
  "Start parallel children in ONE spawn_agent call, at most 6. Each brief: the skill root, the reference files to read, its paths, the ledger rows it owns, the evidence labels, and output as findings with file:line plus explicit `checked` and `not checked` lists; children stay read-only unless the skill says otherwise. " +
  'A child that fails, times out, or skips a row leaves that row "not checked", never clean. Re-open every file:line a child reports before relying on it. Edits, database commands, and benchmarks stay serialized in the main thread.';

// Skills are written for a user at the keyboard; some hosts (a running goal)
// say not to ask now, and forbid branches or commits a skill may suggest.
export const HOST_RULES =
  "If your host instructions say not to ask the user right now (e.g. a running goal), use the default or recommended answer the skill gives for each question and report what you chose. Host rules on branches, commits and installs override the skill.";

function generateSkillDescription(skills: Skill[], limits: ContextLimits = CONTEXT_LIMITS): string {
  if (!skills.some((s) => !s.hidden)) {
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
    // "before writing code" alone: Haiku 5.5 skipped every skill on "Is our
    // users' data safe?" (a review, not code) in 9 of 10 bench runs.
    `Specialised method checklists. When the work is in a skill's scope below, load it before writing code, and before giving a review or a safety verdict. Match the work, not the topic: routine fixes and renames need none. Respect exclusions; never reload one.\n` +
    // Previously only in the no-skill-tool fallback prompt, so normal sessions
    // never saw it and launch checks picked one skill and skipped the rest.
    `Launch-readiness asks ("ready to ship?"): cover every in-scope skill (durable, compliance-guard), one report-only child each in one spawn_agent call where delegation is available.\n\n` +
    `${lines.join("\n")}${overflow}`
  );
}
