// Baseline 06 — skill/command injection cost (baseline for item #15 on-demand
// skill retrieval).
//
// Measures the CURRENT token cost of the skill listing in the system prompt:
// section-by-section breakdown of the real prompt, the delta from injecting
// the actually-installed skills, and a synthetic 5/10/20-skill simulation
// (upper bound of what on-demand retrieval could save). No LLM calls.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  REPO_ROOT,
  buildSystemPrompt,
  estTokens,
  writeResult,
  fmt,
  pct,
  table,
} from "./lib.mjs";

const { discoverSkills, formatSkillsForPrompt } = await import(
  path.join(REPO_ROOT, "packages/ggcoder/dist/core/skills.js")
);

// ── How injection works (from packages/ggcoder/src/system-prompt.ts + core/skills.ts) ──
// - Skills: agent-session.ts calls discoverSkills({globalSkillsDir: ~/.gg/skills,
//   projectDir}) → bundled + global + project .gg/skills. buildSystemPrompt
//   appends formatSkillsForPrompt(skills) as a "## Skills" section containing
//   one "- **name**: description" line per skill (the full SKILL.md body is
//   NOT inlined — it's loaded on demand via the `skill` tool).
// - Slash commands: NOT injected into the system prompt — they live in a
//   client-side SlashCommandRegistry and are expanded/executed locally
//   (agent-session.ts); no commands section exists in system-prompt.ts.
// - MCP tools: deferred — the prompt only points at `tool_search` discovery
//   (renderResearchSection), MCP tool schemas are not inlined either.
const injectionNotes = {
  skills: "discoverSkills() merges bundled + ~/.gg/skills + <project>/.gg/skills; buildSystemPrompt appends a '## Skills' section via formatSkillsForPrompt() with one description line per skill; full skill bodies load on demand via the skill tool.",
  slashCommands: "Not injected into the system prompt (client-side SlashCommandRegistry expansion).",
  mcpTools: "Deferred behind tool_search; schemas not inlined in the prompt.",
};

// ── Installed skills ──
const globalSkillsDir = path.join(homedir(), ".gg", "skills");
const skills = await discoverSkills({ globalSkillsDir, projectDir: REPO_ROOT });
const skillInventory = skills.map((s) => ({
  name: s.name,
  source: s.source,
  descriptionChars: s.description.length,
  bodyChars: s.content.length,
}));
console.log("── installed skills ──");
table(
  skillInventory.map((s) => [s.name, s.source, s.descriptionChars, s.bodyChars]),
  ["name", "source", "desc chars", "body chars (not inlined)"],
);

// ── Real prompt, section breakdown ──
const promptNoSkills = await buildSystemPrompt(REPO_ROOT);
const promptWithSkills = await buildSystemPrompt(REPO_ROOT, skills);

// Section boundaries from system-prompt.ts: identity preamble (no heading),
// then "## How to Talk", "## How to Work", "## Research & Verification",
// "## Code Quality", "## Tools", "## Project Context", [style packs / verify],
// ["## Skills"], "## Environment", and the uncached date suffix.
function splitSections(prompt) {
  const sections = [];
  const re = /^## .*$/gm;
  let match;
  let prev = { name: "(identity preamble)", start: 0 };
  const marks = [];
  while ((match = re.exec(prompt))) marks.push({ name: match[0], start: match.index });
  // The uncached suffix ("<!-- uncached -->\nToday's date: …") is its own tail section.
  const uncachedIdx = prompt.indexOf("<!-- uncached -->");
  const parts = [];
  const boundaries = [{ name: "(identity preamble)", start: 0 }, ...marks];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].start;
    let end = i + 1 < boundaries.length ? boundaries[i + 1].start : prompt.length;
    if (uncachedIdx >= 0 && uncachedIdx > start && uncachedIdx < end) end = uncachedIdx;
    parts.push({ name: boundaries[i].name, text: prompt.slice(start, end) });
  }
  if (uncachedIdx >= 0) parts.push({ name: "(uncached date suffix)", text: prompt.slice(uncachedIdx) });
  return parts.map((p) => ({
    name: p.name,
    chars: p.text.length,
    estTokens: estTokens(p.text),
    pctOfTotal: pct(p.text.length, prompt.length),
  }));
}

const sections = splitSections(promptWithSkills);
console.log(`\n── real system prompt sections (with installed skills) ──`);
console.log(`total: ${promptWithSkills.length} chars (~${estTokens(promptWithSkills)} est tokens)`);
table(
  sections.map((s) => [s.name, s.chars, s.estTokens, fmt(s.pctOfTotal, 1) + "%"]),
  ["section", "chars", "estTokens", "% of total"],
);

// ── Delta: skills section on/off (upper bound of on-demand retrieval savings) ──
const skillsSectionText = formatSkillsForPrompt(skills);
const realDelta = {
  skillsInstalled: skills.length,
  skillsSectionChars: skillsSectionText.length,
  skillsSectionEstTokens: estTokens(skillsSectionText),
  promptWithoutChars: promptNoSkills.length,
  promptWithChars: promptWithSkills.length,
  deltaChars: promptWithSkills.length - promptNoSkills.length,
  deltaEstTokens: estTokens(promptWithSkills) - estTokens(promptNoSkills),
  pctOfPrompt: pct(skillsSectionText.length, promptWithSkills.length),
};
console.log(`\n── skills section delta (real, ${skills.length} installed) ──`);
console.log(
  `skills section: ${realDelta.skillsSectionChars} chars (~${realDelta.skillsSectionEstTokens} tok) = ${fmt(realDelta.pctOfPrompt, 1)}% of prompt`,
);

// ── Synthetic simulation: 5 / 10 / 20 skills at ~80 words each ──
const WORD =
  "Use for designing, implementing, and reviewing production-grade user interfaces across web and mobile surfaces including pages, components, dashboards, and design systems ";
function makeDescription(words) {
  const ws = [];
  const pool = WORD.trim().split(/\s+/);
  for (let i = 0; i < words; i++) ws.push(pool[i % pool.length]);
  return ws.join(" ") + ".";
}
const synthDesc = makeDescription(80);
const synthetic = [5, 10, 20].map((n) => {
  const synth = Array.from({ length: n }, (_, i) => ({
    name: `synthetic-skill-${String(i + 1).padStart(2, "0")}`,
    description: synthDesc,
    content: "",
    source: "synthetic",
  }));
  const section = formatSkillsForPrompt(synth);
  return {
    skills: n,
    wordsPerDescription: 80,
    sectionChars: section.length,
    sectionEstTokens: estTokens(section),
    pctOfRealPrompt: pct(section.length, promptNoSkills.length),
  };
});
console.log("\n── synthetic skills section cost (~80 words/skill) ──");
table(
  synthetic.map((s) => [s.skills, s.sectionChars, s.sectionEstTokens, fmt(s.pctOfRealPrompt, 1) + "%"]),
  ["skills", "section chars", "estTokens", "% of current prompt"],
);

writeResult("06-skills-cost", {
  injectionNotes,
  skillInventory,
  prompt: {
    chars: promptWithSkills.length,
    estTokens: estTokens(promptWithSkills),
    sections,
  },
  skillsSectionDelta: realDelta,
  syntheticSimulation: synthetic,
  notes:
    "Only skill name+description lines are injected today (bodies load on demand via the skill tool), " +
    "so the on-demand-retrieval upper bound is the '## Skills' listing section itself. Slash commands " +
    "and MCP tool schemas are not inlined in the system prompt at all.",
});
process.exit(0);
