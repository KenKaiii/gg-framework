import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clampToBytes, CONTEXT_LIMITS, type ContextLimits } from "./context-limits.js";
import { cleanInstructionText } from "../utils/text.js";
import { parseFrontmatter } from "./frontmatter.js";
import { log } from "./logger.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SKILLS_DIRS: readonly string[] = [
  // Single-file desktop sidecar: resources live beside app-sidecar.mjs.
  path.resolve(MODULE_DIR, "skills"),
  // Source and npm CLI: assets live beside src/ and dist/.
  path.resolve(MODULE_DIR, "../../assets/skills"),
];

/**
 * Motion mode's private bundle: `<root>/plugin.json`, `<root>/skills/<name>/`
 * and `<root>/bin/hyperframes.mjs`. Deliberately NOT part of
 * `BUNDLED_SKILLS_DIRS` — Motion skills must never reach coder or chat.
 */
const MOTION_BUNDLE_DIRS = [
  path.resolve(MODULE_DIR, "motion"),
  path.resolve(MODULE_DIR, "../../assets/motion"),
];

/** Where Motion mode's skills and HyperFrames launcher live on disk. */
export interface MotionBundle {
  root: string;
  skillsDir: string;
  launcher: string;
  version: string;
}

/**
 * Locate Motion mode's bundle, or null when this install has none. Validates
 * the manifest so a half-copied bundle reads as absent, not as a broken mode.
 */
export async function findMotionBundle(
  candidates: readonly string[] = MOTION_BUNDLE_DIRS,
): Promise<MotionBundle | null> {
  for (const root of candidates) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf-8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name !== "hyperframes" || typeof manifest.version !== "string") continue;
      const launcher = path.join(root, "bin", "hyperframes.mjs");
      await fs.access(launcher);
      return { root, skillsDir: path.join(root, "skills"), launcher, version: manifest.version };
    } catch {
      // Missing or unreadable candidate — try the next layout.
    }
  }
  return null;
}

/** Load only Motion's authored skills; keep their contracts intact and catalog order stable. */
export async function loadMotionSkills(bundle: MotionBundle): Promise<Skill[]> {
  const skills = await loadSkillsFromDir(bundle.skillsDir, "motion");
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

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
 * Frontmatter values may be quoted or YAML block scalars (`description: >`).
 */
export function parseSkillFile(rawInput: string, source: string): Skill {
  // A BOM before `---` would otherwise silently kill frontmatter parsing, and a
  // skill or command shipped in a repo can hide instructions in invisible text.
  const cleaned = cleanInstructionText(rawInput);
  const { fields, body: content } = parseFrontmatter(cleaned.text);
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (cleaned.stripped > 0) {
    log("WARN", "skills", "Stripped invisible characters from a skill file", {
      name,
      source,
      stripped: cleaned.stripped,
    });
  }

  return { name, description, content, source };
}

/**
 * Render the per-skill catalog lines under byte budgets: each description is
 * clamped to `skillDescriptionBytes`, then lines are admitted into a shared
 * `skillCatalogBytes` budget in listed order. Skills dropped by the catalog
 * budget are named in `dropped` so callers can surface them — a silently
 * missing skill is indistinguishable from one that does not exist.
 *
 * Shared by the prompt's Skills section and the skill tool's description: both
 * are attacker-bloatable surfaces for the same list.
 */
export function renderSkillLines(
  skills: Skill[],
  limits: ContextLimits = CONTEXT_LIMITS,
): { lines: string[]; dropped: string[] } {
  const lines: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const skill of skills) {
    // Every bundled description opens "Use when/for …"; on a one-line-per-
    // skill list that prefix is pure repetition, so the catalog drops it.
    const description = skill.description
      ? clampToBytes(
          skill.description.replace(/^Use (?:when|for) (\w)/, (_m, c: string) => c.toUpperCase()),
          limits.skillDescriptionBytes,
        ).text
      : "";
    const line = `- **${skill.name}**${description ? `: ${description}` : ""}`;
    const bytes = Buffer.byteLength(line, "utf8") + 1; // + newline
    if (used + bytes <= limits.skillCatalogBytes) {
      lines.push(line);
      used += bytes;
    } else {
      dropped.push(skill.name);
    }
  }
  return { lines, dropped };
}

/**
 * Format skills as a summary list for the system prompt.
 * Only includes names and descriptions — full content is loaded on-demand via the skill tool.
 */
export function formatSkillsForPrompt(
  skills: Skill[],
  limits: ContextLimits = CONTEXT_LIMITS,
): string {
  if (skills.length === 0) return "";

  const { lines, dropped } = renderSkillLines(skills, limits);
  const list = lines.join("\n");
  const overflow =
    dropped.length > 0 ? `\n\n_Skills omitted (catalog byte budget): ${dropped.join(", ")}_` : "";

  return (
    `## Skills\n\n` +
    `Before acting, compare the user's request with every skill description below; when the work enters one's scope, load it with the **skill** tool first. ` +
    `Match the work, not the topic; respect exclusions; skip skills for routine work; never reload one. ` +
    `Launch-readiness asks: one report-only child per in-scope skill (durable, bulletproof, compliance-guard, lean, evidence-led-ui) in one spawn_agent call; a failed child is "not checked", never clean.\n\n` +
    list +
    overflow
  );
}
