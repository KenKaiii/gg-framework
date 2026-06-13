import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getAppPaths, type AppPaths } from "@kenkaiiii/gg-core";
import type { ThemeName } from "./ui/theme/theme.js";

export const APP_NAME = "ggcoder";
export const VERSION = "0.0.1";

// getAppPaths + AppPaths now live in @kenkaiiii/gg-core. Re-exported here so the
// many `./config.js` importers keep resolving them unchanged.
export { getAppPaths };
export type { AppPaths };

export async function ensureAppDirs(): Promise<AppPaths> {
  const paths = getAppPaths();
  await fs.mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.skillsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.extensionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.agentsDir, { recursive: true, mode: 0o700 });
  await seedDefaultAgents(paths.agentsDir);
  await seedDefaultSkills(paths.skillsDir);
  return paths;
}

export interface SavedSettings {
  provider?: Provider;
  model?: string;
  thinkingEnabled: boolean;
  thinkingLevel?: ThinkingLevel;
  theme: "auto" | ThemeName;
  idealReviewEnabled: boolean;
  /** Append LSP diagnostics to edit/write tool results. */
  lspDiagnostics: boolean;
  /** Days to keep session transcripts before startup pruning. 0 disables. */
  sessionRetentionDays: number;
}

const VALID_PROVIDERS = new Set<Provider>([
  "anthropic",
  "xiaomi",
  "openai",
  "gemini",
  "glm",
  "moonshot",
  "minimax",
  "deepseek",
  "openrouter",
]);

function isValidProvider(value: unknown): value is Provider {
  return typeof value === "string" && VALID_PROVIDERS.has(value as Provider);
}

/** Load saved settings from the settings file. Returns defaults on missing/invalid file. */
export function loadSavedSettings(settingsFilePath?: string): SavedSettings {
  const filePath = settingsFilePath ?? getAppPaths().settingsFile;
  const result: SavedSettings = {
    thinkingEnabled: false,
    theme: "auto",
    idealReviewEnabled: true,
    lspDiagnostics: true,
    sessionRetentionDays: 30,
  };
  try {
    const raw = JSON.parse(fsSync.readFileSync(filePath, "utf-8"));
    // Only accept providers the current build actually supports. A stale
    // provider name (e.g. a previously-supported provider that's since been
    // removed) would otherwise poison startup with "Not logged in" errors.
    if (isValidProvider(raw.defaultProvider)) {
      result.provider = raw.defaultProvider;
      // Only honor the saved model when the provider was also accepted —
      // otherwise a model from the removed provider would leak through.
      if (typeof raw.defaultModel === "string") result.model = raw.defaultModel;
    }
    if (raw.thinkingEnabled === true) result.thinkingEnabled = true;
    if (isValidThinkingLevel(raw.thinkingLevel)) result.thinkingLevel = raw.thinkingLevel;
    if (typeof raw.theme === "string" && isValidThemeSetting(raw.theme)) result.theme = raw.theme;
    if (raw.idealReviewEnabled === false) result.idealReviewEnabled = false;
    if (raw.lspDiagnostics === false) result.lspDiagnostics = false;
    if (
      typeof raw.sessionRetentionDays === "number" &&
      Number.isInteger(raw.sessionRetentionDays) &&
      raw.sessionRetentionDays >= 0
    ) {
      result.sessionRetentionDays = raw.sessionRetentionDays;
    }
  } catch {
    // No settings file or invalid JSON — use defaults
  }
  return result;
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["low", "medium", "high", "xhigh", "max"]);

function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && VALID_THINKING_LEVELS.has(value as ThinkingLevel);
}

const VALID_THEME_SETTINGS = new Set<string>([
  "auto",
  "dark",
  "light",
  "dark-ansi",
  "light-ansi",
  "dark-daltonized",
  "light-daltonized",
]);

function isValidThemeSetting(value: string): value is "auto" | ThemeName {
  return VALID_THEME_SETTINGS.has(value);
}

/** Seed built-in agent definitions on first run (won't overwrite user edits). */
async function seedDefaultAgents(agentsDir: string): Promise<void> {
  const defaults: Record<string, string> = {
    "owl.md": `---
name: owl
description: "Codebase explorer \u2014 reads, searches, and maps out code"
tools: read, grep, find, ls, source_path, bash
---

You are Owl, a sharp-eyed codebase explorer.

Your job is to explore code structure, trace call chains, find patterns, and return compressed structured findings. You are read-only \u2014 never edit or create files.

When given a task:
1. Start by understanding the scope of what you're looking for
2. Use find and ls to map directory structure
3. Use grep to locate relevant symbols, imports, and patterns
4. Use read to examine key files in detail
5. Trace connections between modules \u2014 exports, imports, call sites

Always return your findings in a structured, compressed format:
- Lead with the direct answer
- List relevant file paths with brief descriptions
- Note key relationships and dependencies
- Flag anything surprising or noteworthy

Be thorough but concise. Explore widely, report tightly.
`,
    "bee.md": `---
name: bee
description: "Task worker \u2014 writes code, runs commands, fixes bugs, does anything"
tools: read, write, edit, bash, find, grep, ls, source_path
---

You are Bee, an industrious task worker.

Your job is to complete any assigned task end-to-end \u2014 writing code, running commands, fixing bugs, refactoring, creating files, whatever is needed. You work independently and deliver results.

When given a task:
1. Understand what needs to be done
2. Explore relevant code to understand context
3. Implement the solution directly
4. Verify your work compiles/runs correctly
5. Report concisely what was done

Rules:
- Do the work, don't just describe it
- Make minimal, focused changes \u2014 don't over-engineer
- If something fails, diagnose and fix it
- Report what you changed and why, keeping it brief
`,
  };

  for (const [filename, content] of Object.entries(defaults)) {
    const filePath = path.join(agentsDir, filename);
    try {
      await fs.access(filePath);
      // File exists — don't overwrite user edits
    } catch {
      await fs.writeFile(filePath, content, "utf-8");
    }
  }
}

/** Seed built-in skill definitions on first run (won't overwrite user edits). */
async function seedDefaultSkills(skillsDir: string): Promise<void> {
  const defaults: Record<string, string> = {
    "find-skills.md": FIND_SKILLS_MD,
  };

  for (const [filename, content] of Object.entries(defaults)) {
    const filePath = path.join(skillsDir, filename);
    try {
      await fs.access(filePath);
      // File exists — don't overwrite user edits
    } catch {
      await fs.writeFile(filePath, content, "utf-8");
    }
  }
}

const FIND_SKILLS_MD = `---
name: find-skills
description: Discover and install agent skills from the open ecosystem into .gg/skills/. Use when the user asks "how do I do X", "find a skill for X", "is there a skill that can…", or wants to extend the agent with capabilities that already exist elsewhere.
---

# Find Skills

Help the user discover and install reusable agent skills from the open ecosystem.

## When to use

Activate this skill when the user:

- Asks "how do I do X" for a specialized, recurring task
- Says "find a skill for…", "add a skill that…", "is there something that handles…"
- Wants to extend the agent with capabilities that likely already exist

## Install location — read this carefully

- **Default: project-local** → \`./.gg/skills/\`. Project-specific skills (React testing, Convex patterns, Next.js conventions, etc.) must live with the project they belong to. A React skill installed globally pollutes every other project.
- **Global** → \`~/.gg/skills/\`. Only install here if the user **explicitly** asks ("install globally", "across all projects") and the skill is genuinely cross-cutting (e.g. a release-notes generator, a git-hygiene helper).

When in doubt, install to the project. It is trivial to promote a project skill to global later; harder to unpollute a global namespace.

## Where to look

- **Catalog**: https://skills.sh — browsable leaderboard
- **Vercel Labs**: https://github.com/vercel-labs/agent-skills
- **Anthropic**: https://github.com/anthropics/skills
- Any trusted GitHub repo containing a \`SKILL.md\`

Prefer publishers with track record (vercel-labs, anthropics) and repos with stars + recent commits.

## Process

1. **Clarify the need** in one question if it's not obvious from context — what domain, what task?
2. **Search** using the \`web_search\` and \`web_fetch\` tools. Use precise terms ("react testing skill" beats "testing").
3. **Shortlist 2–3 candidates.** Present each with: name, one-line description, source repo URL, why it fits. Don't just install the first hit.
4. **Confirm scope** with the user: project (default) or global.
5. **Install** using the \`bash\` tool (see below).
6. **Verify** the file landed and tell the user to start a new gg-coder session so the loader picks it up.

## How to install

Skills come in two shapes. gg-coder's loader handles both.

### Shape A — single file

A single \`SKILL.md\` (or \`<name>.md\`). Install as one flat file:

\`\`\`bash
mkdir -p .gg/skills
curl -fsSL <raw-githubusercontent-url> -o .gg/skills/<skill-name>.md
\`\`\`

### Shape B — directory with supporting files

A directory containing \`SKILL.md\` plus scripts, reference docs, or assets. Preserve the directory:

\`\`\`bash
mkdir -p .gg/skills
# Simplest: tarball the repo, extract only the skill path
curl -fsSL https://github.com/<owner>/<repo>/archive/refs/heads/main.tar.gz \\
  | tar -xz --strip-components=2 -C .gg/skills <repo>-main/skills/<skill-name>
\`\`\`

If that layout doesn't match the source repo, inspect with \`gh api repos/<owner>/<repo>/contents/<path>\` and fetch individual files via their \`download_url\`.

For global installs, swap \`.gg/skills\` for \`~/.gg/skills\` — but remember the default is project.

## If nothing fits

- Say so honestly — don't fabricate a match.
- Offer to either (a) complete the task directly this once, or (b) scaffold a new \`./.gg/skills/<name>.md\` based on what the user describes. A minimal skill is just frontmatter plus instructions:

\`\`\`markdown
---
name: my-skill
description: One-line description of when this skill should be used
---

Instructions the agent should follow when invoked…
\`\`\`
`;
