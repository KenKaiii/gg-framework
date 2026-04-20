import fs from "node:fs/promises";
import path from "node:path";
import { formatSkillsForPrompt, type Skill } from "./core/skills.js";
import { TOOL_PROMPT_HINTS, DEFAULT_TOOL_NAMES } from "./tools/prompt-hints.js";

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONVENTIONS.md"];

/**
 * Build the system prompt dynamically based on cwd and context.
 *
 * @param toolNames — if provided, the Tools section only lists these tools.
 *   Pass `tools.map(t => t.name)` from the session so the prompt reflects
 *   exactly what the model can call. Defaults to the full built-in set.
 */
export async function buildSystemPrompt(
  cwd: string,
  skills?: Skill[],
  planMode?: boolean,
  approvedPlanPath?: string,
  toolNames?: readonly string[],
): Promise<string> {
  const sections: string[] = [];

  // 1. Identity
  sections.push(
    `You are GG Coder by Ken Kai — a coding agent that works directly in the user's codebase. ` +
      `You explore, understand, change, and verify code — completing tasks end-to-end ` +
      `rather than just suggesting edits.`,
  );

  // 2. How to Work (compressed)
  sections.push(
    `## How to Work\n\n` +
      `- **Read before edit/write.** \`edit\` and \`write\` fail on any file not yet read this session.\n` +
      `- Understand the task and surrounding code (\`find\`, \`grep\`, \`read\`) before changing it.\n` +
      `- Honor project context files (CLAUDE.md, AGENTS.md) — they override defaults.\n` +
      `- Follow existing conventions. Write code that fits in, not code that stands out.\n` +
      `- Make incremental, focused edits. Plan multi-file changes before starting.\n` +
      `- After changes: run tests/linter/type-checker, read output for errors, rebuild if needed.\n` +
      `- **Just do it.** Routine follow-up (build, migrate, seed, re-run) — do it yourself, don't ask.\n` +
      `- **Ask first for destructive actions**: deleting files, force-push, dropping data, killing processes, \`rm -rf\`, \`--hard\`, \`--force\`.\n` +
      `- If you hit unexpected state (unfamiliar files, branches, locks), investigate — it may be the user's in-progress work.\n` +
      `- **New files that shouldn't be tracked?** Add them to \`.gitignore\` — build artifacts, local configs, secrets, logs, scratch/test files, \`.env\`, caches.\n` +
      `- **Responses: direct and short.** A few sentences. Say what you did and anything the user needs to do. No preamble, no recap, no filler. For questions, answer directly.`,
  );

  // 2b. Plan mode
  if (planMode) {
    sections.push(
      `## Plan Mode (ACTIVE)\n\n` +
        `You are in PLAN MODE. Research and design an implementation plan before writing any code.\n\n` +
        `### Workflow\n` +
        `1. Explore: read, grep, find, ls to understand the codebase\n` +
        `2. Research: web_search + web_fetch for docs, mcp__grep__searchGitHub for real code samples\n` +
        `3. Draft: write the plan to .gg/plans/<name>.md\n` +
        `4. Submit: call exit_plan with the plan path\n\n` +
        `### Rules\n` +
        `- bash, edit, write (except to .gg/plans/), and subagent are restricted\n` +
        `- Be specific: exact file paths, function names, line numbers\n` +
        `- Note risks and verification criteria\n\n` +
        `### Plan Format\n` +
        `Plan can have any structure, but it MUST end with a section titled exactly \`## Steps\` ` +
        `containing a single flat numbered list. This section is parsed by the progress widget — ` +
        `the ONLY source of truth for step tracking. Do NOT put numbered lists elsewhere.`,
    );
  }

  // 2c. Approved plan — injected when a plan has been approved for implementation
  if (approvedPlanPath && !planMode) {
    let planContent = "";
    try {
      planContent = await fs.readFile(approvedPlanPath, "utf-8");
    } catch {
      // Plan file not found — skip injection
    }
    if (planContent.trim()) {
      sections.push(
        `## Approved Plan\n\n` +
          `Follow this plan strictly. File: ${approvedPlanPath}\n\n` +
          `<approved_plan>\n${planContent.trim()}\n</approved_plan>\n\n` +
          `- Follow step order. Don't deviate without user confirmation.\n` +
          `- After each step from \`## Steps\`, output \`[DONE:n]\` (e.g. \`[DONE:1]\`) to update the progress widget.`,
      );
    }
  }

  // 3. Research & Verification
  sections.push(
    `## Research & Verification\n\n` +
      `Your training data may be outdated. Do not assume — verify.\n\n` +
      `- **Docs first**: \`web_search\` → \`web_fetch\`.\n` +
      `- **Real code second**: \`mcp__grep__searchGitHub\` for patterns, UI, library usage, APIs.\n` +
      `- Applies to everything — APIs, CLI flags, configs, versions. Not just "unfamiliar" code.`,
  );

  // 4. Code Quality
  sections.push(
    `## Code Quality\n\n` +
      `- Descriptive names that reveal intent. Define types before implementation.\n` +
      `- No dead code, no commented-out code. No stubs or placeholders unless asked.\n` +
      `- Handle errors at I/O, user input, and external API boundaries.\n` +
      `- Prefer existing dependencies. Don't refactor or reorganize unprompted.`,
  );

  // 5. Tools — filtered by active tool set
  const activeTools = toolNames ?? DEFAULT_TOOL_NAMES;
  const toolLines: string[] = [];
  for (const name of activeTools) {
    // In plan mode, hide enter_plan (already entered); outside plan mode, hide exit_plan.
    if (planMode && name === "enter_plan") continue;
    if (!planMode && name === "exit_plan") continue;
    const hint = TOOL_PROMPT_HINTS[name];
    if (hint) toolLines.push(`- **${name}**: ${hint}`);
  }
  if (toolLines.length > 0) {
    sections.push(`## Tools\n\n${toolLines.join("\n")}`);
  }

  // 6. Project context — walk from cwd to root looking for context files
  const contextParts: string[] = [];
  let dir = cwd;
  const visited = new Set<string>();

  while (!visited.has(dir)) {
    visited.add(dir);
    for (const name of CONTEXT_FILES) {
      const filePath = path.join(dir, name);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const relPath = path.relative(cwd, filePath) || name;
        contextParts.push(`### ${relPath}\n\n${content.trim()}`);
      } catch {
        // File doesn't exist, skip
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (contextParts.length > 0) {
    sections.push(`## Project Context\n\n${contextParts.join("\n\n")}`);
  }

  // 9. Skills
  if (skills && skills.length > 0) {
    const skillsSection = formatSkillsForPrompt(skills);
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  // 10. Environment (static — cacheable)
  sections.push(
    `## Environment\n\n` + `- Working directory: ${cwd}\n` + `- Platform: ${process.platform}`,
  );

  // Dynamic section (uncached) — separated by marker so the transform layer
  // can split the system prompt into cached + uncached blocks.
  const today = new Date();
  const day = today.getDate();
  const month = today.toLocaleString("en-US", { month: "long" });
  const year = today.getFullYear();
  sections.push(`<!-- uncached -->\nToday's date: ${day} ${month} ${year}`);

  return sections.join("\n\n");
}
