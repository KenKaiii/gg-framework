import fs from "node:fs/promises";
import path from "node:path";
import { formatSkillsForPrompt, type Skill } from "./core/skills.js";
import { TOOL_PROMPT_HINTS, buildToolSteering, DEFAULT_TOOL_NAMES } from "./tools/prompt-hints.js";
import type { LanguageId } from "./core/language-detector.js";
import { stripBom } from "./utils/text.js";
import { resolveShell } from "./core/shell.js";
import { renderStylePacksSection } from "./core/style-packs/index.js";
import { detectVerifyCommands, renderVerifySection } from "./core/verify-commands.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import type { Provider } from "@kenkaiiii/gg-ai";

// One instruction file per directory, first match wins (Codex-style selection).
// AGENTS.override.md lets a user shadow a checked-in AGENTS.md locally.
const CONTEXT_FILES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "CONVENTIONS.md",
];

/** Combined byte budget for all project instruction files (Codex default). */
export const PROJECT_CONTEXT_MAX_BYTES = 32 * 1024;
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
    `- Match neighbors (components/tokens/tone). When none exist, infer from the task and project; ask only when a missing product or taste decision would materially change the result. Keep edits small; plan multi-file work first.\n` +
    `- Do routine follow-up yourself (build, migrate, re-run). Ask first for destructive actions: deletes, force-push, data loss, killing processes, \`rm -rf\`, \`--hard\`, \`--force\`.\n` +
    `- Preserve user work: investigate unexpected files, branches, or locks before touching them. \`.gitignore\` generated artifacts, secrets, logs, scratch, and \`.env\`.\n` +
    `- Rule precedence: project context files → file/module patterns → applicable skill instructions → Language Style Packs → this prompt.\n` +
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

function renderResearchSection(toolNames: readonly string[] | undefined): string {
  const active = new Set(toolNames ?? DEFAULT_TOOL_NAMES);
  // The public-code guidance references the kencode-search MCP tools by name.
  // With deferred MCP loading those live in the tool_search catalog until
  // promoted — so point at discovery instead of naming tools the model can't
  // call yet. Never reference an unavailable tool.
  const publicCode = active.has("mcp__kencode-search__searchCode")
    ? `For public code, use ReferenceSources for curated repos or DiscoverRepos for current/top repos, then verify exact snippets with SearchCode literal text/RE2 (not semantic); \`path\` is a literal path substring and \`repo\` only after broad/peek proof. `
    : active.has("tool_search")
      ? `For public GitHub code and design references, call \`tool_search\` first (e.g. "search public code" or "UI design screens") — it unlocks the matching tools for your next step. `
      : "";
  // Only reference `web_search` when it's actually in the active tool set —
  // Anthropic sessions use server-side native search instead, and naming an
  // unavailable tool trains the model to call something that doesn't exist.
  const docs = active.has("web_search")
    ? `use \`web_search\` then \`web_fetch\` for authoritative docs`
    : `use \`web_fetch\` for authoritative docs (native web search is available)`;
  return (
    `## Research & Verification\n\n` +
    `Your training data has a cutoff; the real current date is the final line of this prompt. Assume your knowledge of library versions, APIs, CLI flags, config schema, defaults, and best practices has changed since then — treat it as a stale hint to verify, never as ground truth. ` +
    `Do not rely on memory for APIs, CLI flags, config schema, internals, or error wording — verify first. Use \`source_path\` for installed deps and inspect with read/grep/find/ls; ${docs}. ` +
    publicCode +
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

/**
 * Deterministic hierarchical instruction resolver.
 *
 * Walks from cwd up to the filesystem root picking at most ONE instruction
 * file per directory (CONTEXT_FILES priority order, first match wins), skips
 * empty files, strips BOMs, and renders root-first (broad → narrow) so the
 * nearest file lands last — where LLM recency bias weights it most. A 32 KiB
 * combined budget is filled nearest-first (the nearest instructions are the
 * most binding); files dropped by the cap are reported in a one-line note.
 */
export async function collectProjectContext(cwd: string): Promise<string[]> {
  // Nearest-first collection order (cwd → root).
  const collected: Array<{ relPath: string; content: string; bytes: number }> = [];
  let dir = cwd;
  const visited = new Set<string>();

  while (!visited.has(dir)) {
    visited.add(dir);
    for (const name of CONTEXT_FILES) {
      const filePath = path.join(dir, name);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue; // File doesn't exist — try the next candidate name.
      }
      const trimmed = stripBom(content).trim();
      const relPath = path.relative(cwd, filePath) || name;
      // Empty/whitespace-only files still claim the directory slot — an empty
      // AGENTS.override.md deliberately silences the directory's instructions.
      if (trimmed) {
        collected.push({ relPath, content: trimmed, bytes: Buffer.byteLength(trimmed, "utf-8") });
      }
      break; // One file per directory — first match wins.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Budget nearest-first: the closest files are the most binding.
  let budget = PROJECT_CONTEXT_MAX_BYTES;
  const kept = new Set<number>();
  const skipped: string[] = [];
  for (let i = 0; i < collected.length; i++) {
    const file = collected[i];
    if (file.bytes <= budget) {
      kept.add(i);
      budget -= file.bytes;
    } else {
      skipped.push(`${file.relPath} (${Math.round(file.bytes / 1024)}KB)`);
    }
  }

  // Render root-first (broad → narrow): reverse of collection order.
  const contextParts: string[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    if (!kept.has(i)) continue;
    const file = collected[i];
    contextParts.push(`### ${file.relPath}\n\n${file.content}`);
  }
  if (skipped.length > 0) {
    contextParts.push(`_Skipped (context budget): ${skipped.join(", ")}_`);
  }

  return contextParts;
}

function renderProjectContextSection(contextParts: readonly string[]): string | null {
  if (contextParts.length === 0) return null;
  return (
    `## Project Context\n\n` +
    `Files are ordered broadest → nearest. On conflict, the nearest file wins; explicit user instructions win over all files.\n\n` +
    contextParts.join("\n\n")
  );
}

function renderEnvironmentSection(cwd: string): string {
  // Static per host, so it lives in the cached prompt body: which shell bash
  // commands actually execute under (cmd.exe fallback on bash-less Windows).
  const shellLine = resolveShell("").isCmdFallback
    ? "- Shell: cmd.exe (no bash found)"
    : "- Shell: bash (POSIX)";
  return `## Environment\n\n- Working directory: ${cwd}\n- Platform: ${process.platform}\n${shellLine}`;
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

  sections.push(renderResearchSection(toolNames), renderCodeQualitySection());

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
