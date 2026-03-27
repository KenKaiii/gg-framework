import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

export const APP_NAME = "ggcoder";
export const VERSION = "0.0.1";

export interface AppPaths {
  agentDir: string;
  sessionsDir: string;
  settingsFile: string;
  authFile: string;
  telegramFile: string;
  logFile: string;
  skillsDir: string;
  extensionsDir: string;
  agentsDir: string;
}

export function getAppPaths(): AppPaths {
  const agentDir = path.join(os.homedir(), ".gg");
  return {
    agentDir,
    sessionsDir: path.join(agentDir, "sessions"),
    settingsFile: path.join(agentDir, "settings.json"),
    authFile: path.join(agentDir, "auth.json"),
    telegramFile: path.join(agentDir, "telegram.json"),
    logFile: path.join(agentDir, "debug.log"),
    skillsDir: path.join(agentDir, "skills"),
    extensionsDir: path.join(agentDir, "extensions"),
    agentsDir: path.join(agentDir, "agents"),
  };
}

export async function ensureAppDirs(): Promise<AppPaths> {
  const paths = getAppPaths();
  await fs.mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.skillsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.extensionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.agentsDir, { recursive: true, mode: 0o700 });
  await seedDefaultAgents(paths.agentsDir);
  return paths;
}

/** Seed built-in agent definitions on first run (won't overwrite user edits). */
async function seedDefaultAgents(agentsDir: string): Promise<void> {
  const defaults: Record<string, string> = {
    "owl.md": `---
name: owl
description: "Codebase explorer \u2014 reads, searches, and maps out code"
tools: read, grep, find, ls, bash
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
tools: read, write, edit, bash, find, grep, ls
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
