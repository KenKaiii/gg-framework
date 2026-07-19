import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripBom } from "../utils/text.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIRS = [
  // Single-file desktop sidecar: resources live beside app-sidecar.mjs.
  path.resolve(MODULE_DIR, "skills"),
  // Source and npm CLI: assets live beside src/ and dist/.
  path.resolve(MODULE_DIR, "../../assets/skills"),
];

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: string;
  /** Directory used to resolve references linked from the skill content. */
  root?: string;
}

/**
 * Discover skills from global and project-local skill directories.
 */
export async function discoverSkills(options: {
  globalSkillsDir: string;
  projectDir?: string;
}): Promise<Skill[]> {
  const skillsByName = new Map<string, Skill>();
  const addSkills = (skills: Skill[]): void => {
    for (const skill of skills) skillsByName.set(skill.name.toLowerCase(), skill);
  };

  // Bundled defaults ship with GG Coder. Global and project definitions with
  // the same name override them, preserving user control.
  addSkills(await loadBundledSkills());
  addSkills(await loadSkillsFromDir(options.globalSkillsDir, "global"));

  if (options.projectDir) {
    const projectSkillsDir = path.join(options.projectDir, ".gg", "skills");
    addSkills(await loadSkillsFromDir(projectSkillsDir, "project"));
  }

  return [...skillsByName.values()];
}

async function loadBundledSkills(): Promise<Skill[]> {
  for (const dir of BUNDLED_SKILLS_DIRS) {
    const skills = await loadSkillsFromDir(dir, "bundled");
    if (skills.length > 0) return skills;
  }
  return [];
}

async function loadSkillsFromDir(dir: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of dirents) {
    const entryPath = path.join(dir, entry.name);

    // Flat layout: ~/.gg/skills/foo.md
    if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const content = await fs.readFile(entryPath, "utf-8");
        const skill = parseSkillFile(content, source);
        if (!skill.name) skill.name = path.basename(entry.name, ".md");
        skill.root = dir;
        skills.push(skill);
      } catch {
        // Skip unreadable files
      }
      continue;
    }

    // Directory layout (skills.sh ecosystem): ~/.gg/skills/foo/SKILL.md
    if (entry.isDirectory()) {
      const skillFile = path.join(entryPath, "SKILL.md");
      try {
        const content = await fs.readFile(skillFile, "utf-8");
        const skill = parseSkillFile(content, source);
        if (!skill.name) skill.name = entry.name;
        skill.root = entryPath;
        skills.push(skill);
      } catch {
        // No SKILL.md — skip
      }
    }
  }

  return skills;
}

/**
 * Parse a skill file with optional frontmatter.
 * Supports simple key: value frontmatter between --- delimiters.
 */
export function parseSkillFile(rawInput: string, source: string): Skill {
  // A BOM before `---` would otherwise silently kill frontmatter parsing.
  const raw = stripBom(rawInput);
  let name = "";
  let description = "";
  let content = raw;

  // Check for frontmatter
  if (raw.startsWith("---")) {
    const endIndex = raw.indexOf("---", 3);
    if (endIndex !== -1) {
      const frontmatter = raw.slice(3, endIndex).trim();
      content = raw.slice(endIndex + 3).trim();

      for (const line of frontmatter.split("\n")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        if (key === "name") name = value;
        else if (key === "description") description = value;
      }
    }
  }

  return { name, description, content, source };
}

/**
 * Format skills as a summary list for the system prompt.
 * Only includes names and descriptions — full content is loaded on-demand via the skill tool.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const list = skills
    .map((s) => `- **${s.name}**${s.description ? `: ${s.description}` : ""}`)
    .join("\n");

  return (
    `## Skills\n\n` +
    `Before acting, compare the user's request with every skill description below. ` +
    `When the request matches a skill's stated scope, invoke that skill with the **skill** tool before making decisions or edits. ` +
    `Respect explicit exclusions in the description. Matching skill instructions specialize this prompt but do not override project or file/module rules.\n\n` +
    list
  );
}
