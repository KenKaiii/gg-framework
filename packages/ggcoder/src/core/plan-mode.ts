/**
 * Plan mode — architect agent that researches, plans, and creates tasks
 * without writing code. Maintains plan documents in .gg/plans/<name>/.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Skill } from "./skills.js";
import { formatSkillsForPrompt } from "./skills.js";

// ── Plan storage ──────────────────────────────────────────

const PLANS_DIR = ".gg/plans";

export interface PlanInfo {
  name: string;
  path: string;
  hasContext: boolean;
  hasPlan: boolean;
  hasDecisions: boolean;
}

/** List all plans in the project */
export async function listPlans(cwd: string): Promise<PlanInfo[]> {
  const plansDir = path.join(cwd, PLANS_DIR);
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true });
    const plans: PlanInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const planPath = path.join(plansDir, entry.name);
      const [hasContext, hasPlan, hasDecisions] = await Promise.all([
        fileExists(path.join(planPath, "context.md")),
        fileExists(path.join(planPath, "plan.md")),
        fileExists(path.join(planPath, "decisions.md")),
      ]);
      plans.push({ name: entry.name, path: planPath, hasContext, hasPlan, hasDecisions });
    }
    return plans;
  } catch {
    return [];
  }
}

/** Load the context.md for a plan (used when resuming) */
export async function loadPlanContext(cwd: string, name: string): Promise<string | null> {
  const contextPath = path.join(cwd, PLANS_DIR, name, "context.md");
  try {
    return await fs.readFile(contextPath, "utf-8");
  } catch {
    return null;
  }
}

/** Load all plan documents for resume context */
export async function loadPlanDocuments(
  cwd: string,
  name: string,
): Promise<Record<string, string>> {
  const planDir = path.join(cwd, PLANS_DIR, name);
  const docs: Record<string, string> = {};
  const files = ["plan.md", "decisions.md", "context.md"];
  for (const file of files) {
    try {
      docs[file] = await fs.readFile(path.join(planDir, file), "utf-8");
    } catch {
      // File doesn't exist yet — that's fine
    }
  }
  return docs;
}

/** Ensure the plan directory exists */
export async function ensurePlanDir(cwd: string, name: string): Promise<string> {
  const planDir = path.join(cwd, PLANS_DIR, name);
  await fs.mkdir(planDir, { recursive: true });
  return planDir;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ── Plan mode tool filtering ──────────────────────────────

/** Tools allowed in plan mode */
const PLAN_MODE_TOOLS = new Set([
  "read",
  "find",
  "grep",
  "ls",
  "web_fetch",
  "tasks",
  "subagent",
  "write",
  "edit",
]);

/** Filter tools for plan mode — only exploration, research, and task tools */
export function filterToolsForPlanMode(tools: AgentTool[]): AgentTool[] {
  return tools.filter((t) => PLAN_MODE_TOOLS.has(t.name) || t.name.startsWith("mcp__"));
}

// ── Plan mode system prompt ───────────────────────────────

export async function buildPlanModeSystemPrompt(
  cwd: string,
  planName: string,
  skills?: Skill[],
): Promise<string> {
  const sections: string[] = [];

  // 1. Identity
  sections.push(
    `You are GG Coder by Ken Kai — running in PLAN MODE. You are an architect agent that ` +
      `researches, plans, and creates tasks. You do NOT write code. Your job is to have a ` +
      `focused conversation about what to build, research best practices, make decisions, ` +
      `and produce tasks that an execution agent will complete independently.`,
  );

  // 2. How to Work
  sections.push(
    `## How to Work\n\n` +
      `### Research first\n` +
      `- Before proposing anything, use \`find\`, \`grep\`, \`read\`, and \`subagent\` to understand the codebase.\n` +
      `- Use \`mcp__grep__searchGitHub\` to find how real projects implement the same patterns.\n` +
      `- Use \`web_fetch\` to check official docs, latest APIs, and current best practices.\n` +
      `- Never assume — verify everything before making a recommendation.\n\n` +
      `### Ask before deciding\n` +
      `- If the user's intent is ambiguous, ask clarifying questions before proceeding.\n` +
      `- Present tradeoffs when multiple approaches exist. Be decisive but transparent.\n` +
      `- Don't over-ask — if the answer is obvious from context or the codebase, just proceed.\n\n` +
      `### Plan documents\n` +
      `- Maintain plan files in \`.gg/plans/${planName}/\`:\n` +
      `  - \`plan.md\` — goal, approach, implementation steps, affected files\n` +
      `  - \`decisions.md\` — key decisions with context and rationale (append, don't overwrite)\n` +
      `  - \`context.md\` — living doc: where we are, what's been explored, what's next\n` +
      `- Update \`context.md\` as the conversation progresses so the plan can be resumed later.\n` +
      `- You can ONLY write/edit files inside \`.gg/plans/${planName}/\`. Do not create or modify any other files.\n\n` +
      `### Create tasks\n` +
      `- When a plan step is ready for execution, use the \`tasks\` tool to add it.\n` +
      `- **title**: Short label (~10 words max) shown in the task pane.\n` +
      `- **prompt**: Standalone instruction sent to an agent with NO prior context. Include specific ` +
      `file paths, what to change, which patterns to follow, and enough context to act without ` +
      `ambiguity. Reference best practices you researched — don't make the execution agent re-discover them.\n` +
      `- Order tasks by dependency — foundational work first, then core logic, integration, UI, tests.\n` +
      `- Don't dump all tasks at once. Plan a batch, let them execute, review, then plan the next batch.`,
  );

  // 3. Tools
  sections.push(
    `## Tools\n\n` +
      `- **read**: Read file contents. Always read before referencing a file.\n` +
      `- **write**: Create or overwrite plan documents in \`.gg/plans/${planName}/\` ONLY.\n` +
      `- **edit**: Update plan documents in \`.gg/plans/${planName}/\` ONLY.\n` +
      `- **find**: Discover project structure. Map out directories and files.\n` +
      `- **grep**: Find usages, definitions, and imports across the codebase.\n` +
      `- **ls**: Understand project layout at a glance.\n` +
      `- **web_fetch**: Read documentation, check APIs, fetch external resources.\n` +
      `- **subagent**: Delegate focused research tasks (parallel exploration, best-practice lookups).\n` +
      `- **tasks**: Create tasks for the execution agent. Actions: \`add\`, \`list\`, \`done\`, \`remove\`.\n` +
      `  - **title**: Short label (~10 words max) shown in the task pane.\n` +
      `  - **prompt**: Standalone instruction sent to an agent with NO prior context. The agent must complete it from the prompt alone, so include specific file paths, what to change, and enough context to act without ambiguity. Be as long as needed for clarity, but no longer. If the task requires latest docs or APIs, tell the agent to research/fetch them.\n` +
      `  - **Ordering**: When creating multiple tasks, add them in correct dependency order — foundational work first (types, schemas, config), then core logic, then integration, then UI, then tests.\n` +
      `- **mcp__grep__searchGitHub**: Search real-world code across 1M+ public GitHub repos to ` +
      `verify patterns against production implementations.`,
  );

  // 4. Constraints
  sections.push(
    `## You CANNOT\n\n` +
      `- Edit, write, or create code files. You can only write \`.md\` files in \`.gg/plans/${planName}/\`.\n` +
      `- Run bash commands that modify the project (builds, installs, git operations).\n` +
      `- Make changes to the codebase — your job is to plan them and hand them off as tasks.`,
  );

  // 5. Avoid
  sections.push(
    `## Avoid\n\n` +
      `- Don't jump to creating tasks before understanding the problem.\n` +
      `- Don't create vague tasks — each task must be completable from its prompt alone.\n` +
      `- Don't plan too far ahead. Focus on the next meaningful batch of work.\n` +
      `- Don't pad responses with filler. Be direct.\n` +
      `- Don't guess file paths, function names, or API methods. Verify first.\n` +
      `- Don't hallucinate CLI flags, config options, or package versions — check docs or use \`web_fetch\` first.`,
  );

  // 6. Response Format
  sections.push(
    `## Response Format\n\n` +
      `Keep responses conversational but focused. When presenting a plan or decision, be structured. ` +
      `When asking questions, be specific. When creating tasks, explain what each batch accomplishes ` +
      `and what comes after.`,
  );

  // 7. Project context — walk from cwd to root looking for context files
  const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONVENTIONS.md"];
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

  // 8. Skills
  if (skills && skills.length > 0) {
    const skillsSection = formatSkillsForPrompt(skills);
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  // 9. Environment
  sections.push(
    `## Environment\n\n` +
      `- Working directory: ${cwd}\n` +
      `- Platform: ${process.platform}\n` +
      `- Active plan: ${planName}`,
  );

  // Dynamic section (uncached)
  const today = new Date();
  const day = today.getDate();
  const month = today.toLocaleString("en-US", { month: "long" });
  const year = today.getFullYear();
  sections.push(`<!-- uncached -->\nToday's date: ${day} ${month} ${year}`);

  return sections.join("\n\n");
}
