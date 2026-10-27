import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clampToBytes, CONTEXT_LIMITS, type ContextLimits } from "./context-limits.js";
import { cleanInstructionText } from "../utils/text.js";
import { parseFrontmatter } from "./frontmatter.js";
import { log } from "./logger.js";
import {
  defaultSkillScanCache,
  loadSkillScanCacheFile,
  saveSkillScanCacheFile,
  scanSkillFile,
  scanSkillFolder,
  skillBlockMessage,
  type SkillScanCache,
  type SkillScanResult,
} from "./skill-scan.js";

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
  const skills = await loadSkillsFromDir(bundle.skillsDir, "motion", newLoadContext());
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: string;
  /** Directory used to resolve references linked from the skill content. */
  root?: string;
  /**
   * `hidden: true` in frontmatter: left out of the skill catalog and the skill
   * tool's list, so the model never picks it for routine work, but still
   * loadable by exact name (the app's Checklist audits name bulletproof/lean).
   */
  hidden?: boolean;
}

/** A skill that discovery refused to load because the safety scan caught it. */
export interface BlockedSkill {
  name: string;
  /** The skill's file (flat layout) or folder (SKILL.md layout). */
  path: string;
  /** Where it came from: "project", "global", "bundled" or "motion". */
  scope: string;
  /** Plain words: what the skill tried to do. */
  reason: string;
  /** Content hash of what was scanned; "" when the block isn't about content. */
  hash: string;
}

export interface SkillDiscovery {
  skills: Skill[];
  blocked: BlockedSkill[];
}

/** One plain line for the user: what was blocked and why. */
export function blockedSkillNotice(blocked: BlockedSkill): string {
  return `Skill "${blocked.name}" blocked for safety: ${blocked.reason}`;
}

/** File that remembers scan verdicts across starts: beside the global skills dir. */
export function skillScanCacheFile(globalSkillsDir: string): string {
  return path.join(path.dirname(globalSkillsDir), "skill-scan-cache.json");
}

interface LoadContext {
  cache: SkillScanCache;
  blocked: BlockedSkill[];
}

function newLoadContext(cache: SkillScanCache = defaultSkillScanCache): LoadContext {
  return { cache, blocked: [] };
}

/**
 * Discover skills from global and project-local skill directories.
 */
export async function discoverSkills(options: {
  globalSkillsDir: string;
  projectDir?: string;
}): Promise<Skill[]> {
  return (await discoverSkillsWithBlocked(options)).skills;
}

/**
 * Discover skills and also report the ones the safety scan blocked, so the
 * app, the CLI and the skill tool can say so instead of staying silent.
 * Verdicts persist in `cacheFile` (default: beside `globalSkillsDir`), so an
 * unchanged skill is never rescanned on a later start.
 */
export async function discoverSkillsWithBlocked(options: {
  globalSkillsDir: string;
  projectDir?: string;
  cacheFile?: string;
  cache?: SkillScanCache;
}): Promise<SkillDiscovery> {
  const ctx = newLoadContext(options.cache);
  // Under vitest only an explicit file is used: many suites discover skills
  // against the real global dir, and tests must never write the real ~/.gg.
  const cacheFile =
    options.cacheFile ??
    (process.env.VITEST ? undefined : skillScanCacheFile(options.globalSkillsDir));
  if (cacheFile) await loadSkillScanCacheFile(ctx.cache, cacheFile);
  const changesBefore = ctx.cache.changes;

  const skillsByName = new Map<string, Skill>();
  const addSkills = (skills: Skill[]): void => {
    for (const skill of skills) skillsByName.set(skill.name.toLowerCase(), skill);
  };

  // Bundled defaults ship with GG Coder. Global and project definitions with
  // the same name override them, preserving user control.
  addSkills(await loadBundledSkills(ctx));
  addSkills(await loadSkillsFromDir(options.globalSkillsDir, "global", ctx));

  if (options.projectDir) {
    const projectSkillsDir = path.join(options.projectDir, ".gg", "skills");
    addSkills(await loadSkillsFromDir(projectSkillsDir, "project", ctx));
  }

  if (cacheFile && ctx.cache.changes !== changesBefore)
    await saveSkillScanCacheFile(ctx.cache, cacheFile);

  // A blocked name that a loaded skill of the same name replaced isn't missing.
  const blocked = ctx.blocked.filter((b) => !skillsByName.has(b.name.toLowerCase()));
  return { skills: [...skillsByName.values()], blocked };
}

async function loadBundledSkills(ctx: LoadContext): Promise<Skill[]> {
  for (const dir of BUNDLED_SKILLS_DIRS) {
    const skills = await loadSkillsFromDir(dir, "bundled", ctx);
    if (skills.length > 0) return skills;
  }
  return [];
}

/**
 * GG Coder's own bundled and Motion skills ship inside the app and are not
 * scanned at runtime (that is pure start-up cost); skills-blocked.test.ts
 * proves every bundled one is clean at build time.
 */
const SHIPPED: SkillScanResult = { ok: true };

async function loadSkillsFromDir(dir: string, source: string, ctx: LoadContext): Promise<Skill[]> {
  const skills: Skill[] = [];
  const shipped = source === "bundled" || source === "motion";

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  // Skills load concurrently so their file I/O overlaps; results (and the
  // blocked list) are then taken in directory order, so output is stable.
  const loaded = await Promise.all(
    dirents.map(
      async (entry): Promise<{ skill: Skill; verdict: SkillScanResult; at: string } | null> => {
        const entryPath = path.join(dir, entry.name);

        // Flat layout: ~/.gg/skills/foo.md
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const content = await fs.readFile(entryPath, "utf-8");
            const skill = parseSkillFile(content, source);
            if (!skill.name) skill.name = path.basename(entry.name, ".md");
            const verdict = shipped ? SHIPPED : await scanSkillFile(entryPath, content, ctx.cache);
            skill.root = dir;
            return { skill, verdict, at: entryPath };
          } catch {
            return null; // Skip unreadable files
          }
        }

        // Directory layout (skills.sh ecosystem): ~/.gg/skills/foo/SKILL.md
        if (entry.isDirectory()) {
          try {
            const content = await fs.readFile(path.join(entryPath, "SKILL.md"), "utf-8");
            const skill = parseSkillFile(content, source);
            if (!skill.name) skill.name = entry.name;
            const verdict = shipped
              ? SHIPPED
              : await scanSkillFolder(entryPath, content, ctx.cache);
            skill.root = entryPath;
            return { skill, verdict, at: entryPath };
          } catch {
            return null; // No SKILL.md — skip
          }
        }
        return null;
      },
    ),
  );

  for (const item of loaded) {
    if (!item || isBlocked(item.skill.name, source, item.at, item.verdict, ctx)) continue;
    skills.push(item.skill);
  }

  return skills;
}

/**
 * gg-safe S1: a skill that matches a malware/exfil/hiding rule is not loaded.
 * No prompt — the user may be away — one log line plus an entry in the
 * blocked list that the app, CLI and skill tool surface in plain words.
 */
function isBlocked(
  name: string,
  source: string,
  skillPath: string,
  verdict: SkillScanResult,
  ctx: LoadContext,
): boolean {
  if (verdict.ok) return false;
  log("WARN", "skills", skillBlockMessage(name, verdict.finding), {
    source,
    rule: verdict.finding.rule,
  });
  ctx.blocked.push({
    name,
    path: skillPath,
    scope: source,
    reason: verdict.finding.reason,
    hash: verdict.hash ?? "",
  });
  return true;
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

  return {
    name,
    description,
    content,
    source,
    ...(fields.hidden === "true" ? { hidden: true } : {}),
  };
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
    if (skill.hidden) continue;
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
  if (!skills.some((skill) => !skill.hidden)) return "";

  const { lines, dropped } = renderSkillLines(skills, limits);
  const list = lines.join("\n");
  const overflow =
    dropped.length > 0 ? `\n\n_Skills omitted (catalog byte budget): ${dropped.join(", ")}_` : "";

  return (
    `## Skills\n\n` +
    `Before acting, compare the user's request with every skill description below; when the work enters one's scope, load it with the **skill** tool first. ` +
    `Match the work, not the topic; respect exclusions; skip skills for routine work; never reload one. ` +
    `Launch-readiness asks: one report-only child per in-scope skill (durable, compliance-guard) in one spawn_agent call; a failed child is "not checked", never clean.\n\n` +
    list +
    overflow
  );
}
