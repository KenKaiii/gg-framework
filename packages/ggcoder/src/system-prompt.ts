import fs from "node:fs/promises";
import path from "node:path";
import { formatSkillsForPrompt, type Skill } from "./core/skills.js";
import { TOOL_PROMPT_HINTS, buildToolSteering, DEFAULT_TOOL_NAMES } from "./tools/prompt-hints.js";
import type { LanguageId } from "./core/language-detector.js";
import { renderStylePacksSection } from "./core/style-packs/index.js";
import { detectVerifyCommands, renderVerifySection } from "./core/verify-commands.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import type { Provider } from "@kenkaiiii/gg-ai";

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONVENTIONS.md"];
const UNCACHED_MARKER = "<!-- uncached -->";

/**
 * The agent's product identity. Anthropic models run as "Claude Code" (matching
 * the Claude Code identity Anthropic's OAuth tokens require in the system
 * prompt); every other provider runs as GG Coder. Keeping this dynamic avoids a
 * contradictory double identity when streaming through Anthropic.
 */
function productName(provider: Provider | undefined): string {
  return provider === "anthropic" ? "Claude Code" : "GG Coder by Ken Kai";
}

function renderIdentitySection(provider: Provider | undefined): string {
  const name = productName(provider);
  return (
    `You are ${name} — a coding agent that works directly in the user's codebase. ` +
    `You explore, understand, change, and verify code — completing tasks end-to-end ` +
    `rather than just suggesting edits.`
  );
}

function renderTalkSection(): string {
  return (
    `## How to Talk\n\n` +
    `Assume the reader has severe ADHD. Write for fast scanning and low working memory.\n\n` +
    `**First word = the outcome.** Lead with "Fixed it." / "Done." / "Broken." / "Failed." / "Blocked." — never warm up with "So," "Let me," or "I've."\n\n` +
    `**Bottom line first.** Line 1 = the answer. Final replies: 1–2 sentences, hard cap 5.\n\n` +
    `**One idea per line.** **Bold** the key word for scanning.\n\n` +
    `**Pick, don't present menus.** Recommend ONE approach with one-line reasoning.\n\n` +
    `**Concrete over abstract.** "Cuts load from 4s to 1s" beats "improves performance."\n\n` +
    `**No unresolved "it depends."** Always resolve: "Default to X; switch to Y if [condition]." Say what TO do, never what NOT to do. End with one next action or nothing.\n\n` +
    `Stay silent between tool calls unless you hit a decision, tradeoff, finding, or question. No preamble, no recap, no hedging, no output dumps. ` +
    `Surface tradeoffs and unverified claims plainly. Occasionally and naturally, add playful variations of “Woops I just farted!” with emojis; don't force it or repeat one line.`
  );
}

function renderWorkSection(): string {
  return (
    `## How to Work\n\n` +
    `- Read before \`edit\`/\`write\`; re-read after formatters, \`lint --fix\`, codemods, codegen, checkout, or any disk mutator.\n` +
    `- Compute in bash; write with \`edit\`/\`write\` so read-tracking, partial apply, and diagnostics stay intact.\n` +
    `- Match neighbors (components/tokens/tone); if none, ask. Keep edits small; plan multi-file work first.\n` +
    `- Do routine follow-up yourself (build, migrate, re-run). Ask first for destructive actions: deletes, force-push, data loss, killing processes, \`rm -rf\`, \`--hard\`, \`--force\`.\n` +
    `- Preserve user work: investigate unexpected files, branches, or locks before touching them. \`.gitignore\` generated artifacts, secrets, logs, scratch, and \`.env\`.\n` +
    `- Rule precedence: project context files → file/module patterns → Language Style Packs → this prompt.\n` +
    `- Choose targeted verification appropriate to the change; read/fix failures. Never claim unrun or failing checks passed.`
  );
}

function renderPlanModeSection(): string {
  return (
    `## Plan Mode (ACTIVE)\n\n` +
    `You are in PLAN MODE. Research and design an implementation plan before writing implementation code.\n\n` +
    `### Plan-mode flow\n` +
    `Explore with read/search/docs tools and read-only bash (e.g. \`git log\`, \`git diff\`, \`grep\`, \`wc -l\`, \`find\`, \`cat\`), draft a structured markdown plan at \`.gg/plans/<name>.md\`, then call \`exit_plan\` with that path for user review.\n\n` +
    `### Rules\n` +
    `- Do not implement yet: no code edits outside \`.gg/plans/\`, no mutating bash (read-only shell for exploration is allowed), no subagent, no task orchestration.\n` +
    `- Be specific: list exact file paths, functions, dependencies, risks, and verification criteria.\n` +
    `- ALWAYS end the plan with a heading written exactly as \`## Steps\` (this literal heading is required — not \`## Plan\`, \`## Implementation\`, or any other variant), followed by a flat, ordered, numbered list (\`1.\`, \`2.\`, …) of concrete implementation steps to execute after approval. Each step is one actionable unit of work — not a design note, question, or rejected alternative. This section is the single source of truth for post-approval progress tracking, so only put real, doable steps here.\n` +
    `- Keep investigating until the plan is actionable, then stop after \`exit_plan\`.`
  );
}

async function renderApprovedPlanSection(
  approvedPlanPath: string | undefined,
): Promise<string | null> {
  if (!approvedPlanPath) return null;
  const planContent = await fs.readFile(approvedPlanPath, "utf-8").catch(() => null);
  if (planContent === null) return null;
  if (!planContent.trim()) return null;
  // The `[DONE:n]` progress contract only applies when `extractPlanSteps`
  // actually finds a step section (a `## Steps` heading or a close synonym).
  // Without it there are no tracked steps, so instructing the model to march
  // through the steps and emit `[DONE:n]` would push it to fabricate progress
  // against content that isn't a task list.
  const hasSteps = extractPlanSteps(planContent).length > 0;
  const stepInstruction = hasSteps
    ? `\n- After each step from \`## Steps\`, output \`[DONE:n]\` (e.g. \`[DONE:1]\`) to update the progress widget, then continue with step n+1 in the same turn.`
    : "";
  return (
    `## Approved Plan\n\n` +
    `Follow this plan strictly. File: ${approvedPlanPath}\n\n` +
    `<approved_plan>\n${planContent.trim()}\n</approved_plan>\n\n` +
    `- Follow step order. Don't deviate without user confirmation.` +
    stepInstruction
  );
}

function renderResearchSection(): string {
  return (
    `## Research & Verification\n\n` +
    `Do not assume APIs, CLI flags, config schema, internals, or error wording. Use \`source_path\` for installed deps and inspect with read/grep/find/ls; use \`web_search\` then \`web_fetch\` for authoritative docs. ` +
    `For public code, use ReferenceSources for curated repos or DiscoverRepos for current/top repos, then verify exact snippets with SearchCode literal text/RE2 (not semantic); \`path\` is a literal path substring and \`repo\` only after broad/peek proof. ` +
    `Run targeted checks when they are relevant to the change; read/fix failures; never report unrun or failing checks as passing.`
  );
}

function renderCodeQualitySection(): string {
  return (
    `## Code Quality\n\n` +
    `Intent-revealing names; reuse existing deps. Types first; handle I/O, input, and external API errors. No dead/commented code, placeholders, or unasked refactors.`
  );
}

function renderToolsSection(toolNames: readonly string[] | undefined): string | null {
  const activeTools = toolNames ?? DEFAULT_TOOL_NAMES;
  const toolLines: string[] = [];
  for (const name of activeTools) {
    const hint = TOOL_PROMPT_HINTS[name];
    if (hint) toolLines.push(`- **${name}**: ${hint}`);
  }
  // Cross-tool steering: each clause renders only when its tools are active.
  // Per-tool hints only exist for tools with non-obvious usage (see prompt-hints).
  const steering = buildToolSteering(activeTools);
  const parts: string[] = [];
  if (steering) parts.push(steering);
  if (toolLines.length > 0) parts.push(toolLines.join("\n"));
  return parts.length > 0 ? `## Tools\n\n${parts.join("\n\n")}` : null;
}

async function collectProjectContext(cwd: string): Promise<string[]> {
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
        // File doesn't exist, skip.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return contextParts;
}

function renderProjectContextSection(contextParts: readonly string[]): string | null {
  if (contextParts.length === 0) return null;
  return `## Project Context\n\n${contextParts.join("\n\n")}`;
}

function renderEnvironmentSection(cwd: string): string {
  return `## Environment\n\n- Working directory: ${cwd}\n- Platform: ${process.platform}`;
}

function renderUncachedDateSuffix(): string {
  const today = new Date();
  const day = today.getDate();
  const month = today.toLocaleString("en-US", { month: "long" });
  const year = today.getFullYear();
  return `${UNCACHED_MARKER}\nToday's date: ${day} ${month} ${year}`;
}

/**
 * Build the system prompt dynamically based on cwd and context.
 *
 * @param toolNames — if provided, the Tools section only lists these tools.
 *   Pass `tools.map(t => t.name)` from the session so the prompt reflects
 *   exactly what the model can call. Defaults to the full built-in set.
 * @param provider — the active LLM provider. Drives the product identity
 *   (`anthropic` → "Claude Code", everything else → "GG Coder").
 */
export async function buildSystemPrompt(
  cwd: string,
  skills?: Skill[],
  planMode?: boolean,
  approvedPlanPath?: string,
  toolNames?: readonly string[],
  activeLanguages?: Set<LanguageId>,
  provider?: Provider,
): Promise<string> {
  const sections: string[] = [
    renderIdentitySection(provider),
    renderTalkSection(),
    renderWorkSection(),
  ];

  if (planMode) sections.push(renderPlanModeSection());

  const approvedPlanSection = await renderApprovedPlanSection(approvedPlanPath);
  if (approvedPlanSection) sections.push(approvedPlanSection);

  sections.push(renderResearchSection(), renderCodeQualitySection());

  const toolsSection = renderToolsSection(toolNames);
  if (toolsSection) sections.push(toolsSection);

  const projectContextSection = renderProjectContextSection(await collectProjectContext(cwd));
  if (projectContextSection) sections.push(projectContextSection);

  if (activeLanguages && activeLanguages.size > 0) {
    const stylePacks = renderStylePacksSection(activeLanguages, cwd);
    if (stylePacks) sections.push(stylePacks);

    const verifyCmds = detectVerifyCommands(cwd, activeLanguages);
    const verifySection = renderVerifySection(verifyCmds);
    if (verifySection) sections.push(verifySection);
  }

  if (skills && skills.length > 0) {
    const skillsSection = formatSkillsForPrompt(skills);
    if (skillsSection) sections.push(skillsSection);
  }

  sections.push(renderEnvironmentSection(cwd), renderUncachedDateSuffix());

  return sections.join("\n\n");
}
