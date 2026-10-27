import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getGitDirtyFileCount, realpathNative, runBackgroundGit } from "../utils/git.js";

/**
 * A project's git worktrees for Home (open, review, clean up) and the setup
 * command a new worktree runs. GG-made worktrees live under `~/.gg/worktrees`;
 * the user's own worktrees are listed too but never removed from here.
 */

const TIMEOUT_MS = 5_000;
/** `git worktree remove` deletes files; give a big checkout time. */
const REMOVE_TIMEOUT_MS = 60_000;

export interface WorktreeRow {
  path: string;
  /** Checked-out branch, or null when detached. */
  branch: string | null;
  /** Made by GG Coder (under ~/.gg/worktrees): removable from Home. */
  managed: boolean;
  /** The folder is gone (deleted outside git). */
  missing: boolean;
  /** Uncommitted changes in it. */
  dirty: number;
  /** Commits on its branch that the main folder's branch doesn't have. */
  ahead: number;
}

export interface WorktreeList {
  /** The repository's main folder. */
  mainPath: string;
  /** The branch the main folder has checked out, or null when detached. */
  mainBranch: string | null;
  worktrees: WorktreeRow[];
}

async function git(args: readonly string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  const { stdout } = await runBackgroundGit(args, { cwd, timeoutMs });
  return stdout;
}

// `native`: on Windows it expands 8.3 short names (RUNNER~1), so a path from git
// and one from Node compare equal.
const realOr = (p: string): Promise<string> =>
  // A deleted folder can't be resolved; `path.resolve` still normalises it
  // (git prints forward slashes on Windows).
  realpathNative(p).catch(() => path.resolve(p));

interface Porcelain {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

export function parseWorktreePorcelain(text: string): Porcelain[] {
  const out: Porcelain[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const at = lines.find((l) => l.startsWith("worktree "));
    if (!at) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? null;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? null;
    out.push({
      path: at.slice(9),
      head,
      branch: ref?.startsWith("refs/heads/") ? ref.slice(11) : null,
      bare: lines.includes("bare"),
      prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
    });
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The repository's main folder for any checkout of it (itself for the main one), or null. */
export async function mainCheckoutOf(dir: string): Promise<string | null> {
  try {
    const listed = parseWorktreePorcelain(await git(["worktree", "list", "--porcelain"], dir));
    const main = listed[0];
    return main && !main.bare ? await realOr(main.path) : null;
  } catch {
    return null;
  }
}

/** Every linked worktree of the repository `dir` belongs to, with its status. */
export async function listWorktrees(
  dir: string,
  managedRoot: string,
): Promise<WorktreeList | null> {
  let listed: Porcelain[];
  try {
    listed = parseWorktreePorcelain(await git(["worktree", "list", "--porcelain"], dir));
  } catch {
    return null;
  }
  const [main, ...linked] = listed;
  if (!main || main.bare) return null;
  const mainPath = await realOr(main.path);
  const mainBranch = main.branch;
  const base = mainBranch ?? main.head;
  const managedReal = await realOr(managedRoot);
  const worktrees = await Promise.all(
    linked.map(async (entry): Promise<WorktreeRow> => {
      const real = await realOr(entry.path);
      const missing = entry.prunable || !existsSync(real);
      let dirty = 0;
      let ahead = 0;
      if (!missing) {
        dirty = await getGitDirtyFileCount(real).catch(() => 0);
        if (base && entry.head) {
          const count = await git(
            ["rev-list", "--count", `${base}..${entry.head}`],
            mainPath,
          ).catch(() => "0");
          ahead = Number.parseInt(count.trim(), 10) || 0;
        }
      }
      return {
        path: real,
        branch: entry.branch,
        managed: isInside(real, managedReal) || isInside(entry.path, managedRoot),
        missing,
        dirty,
        ahead,
      };
    }),
  );
  worktrees.sort((a, b) => (a.branch ?? a.path).localeCompare(b.branch ?? b.path));
  return { mainPath, mainBranch, worktrees };
}

/** A removal git or the safety checks refused; `message` is safe to show. */
export class WorktreeRemoveError extends Error {
  override name = "WorktreeRemoveError";
  constructor(
    message: string,
    /** Uncommitted changes that removing would lose (confirm with `force`). */
    readonly dirty = 0,
  ) {
    super(message);
  }
}

/**
 * Remove a GG-made worktree's folder. The branch and its commits stay. Refuses
 * the user's own worktrees, one with uncommitted changes unless `force`, and
 * one a window is open in (`openWindows`).
 */
export async function removeWorktree(options: {
  dir: string;
  target: string;
  managedRoot: string;
  force: boolean;
  openWindows: number;
}): Promise<void> {
  const list = await listWorktrees(options.dir, options.managedRoot);
  const target = await realOr(options.target);
  const row = list?.worktrees.find((w) => w.path === target);
  if (!list || !row) throw new WorktreeRemoveError("That folder isn't a worktree of this project.");
  if (!row.managed) {
    throw new WorktreeRemoveError("Only worktrees GG Coder made can be removed here.");
  }
  if (options.openWindows > 0) {
    throw new WorktreeRemoveError("A window is open in this worktree. Close it first.");
  }
  if (row.missing) {
    await git(["worktree", "prune"], list.mainPath);
    return;
  }
  if (row.dirty > 0 && !options.force) {
    throw new WorktreeRemoveError(
      `It has ${row.dirty} uncommitted ${row.dirty === 1 ? "change" : "changes"}.`,
      row.dirty,
    );
  }
  try {
    await git(
      ["worktree", "remove", ...(options.force ? ["--force"] : []), target],
      list.mainPath,
      REMOVE_TIMEOUT_MS,
    );
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
    throw new WorktreeRemoveError(detail.trim().split("\n").slice(-3).join("\n") || "git failed");
  }
  // `<repo>-<hash>/` holds only this project's worktrees; drop it once empty.
  await fs.rmdir(path.dirname(target)).catch(() => {});
}

// ── Setup command ────────────────────────────────────────────────────────────

export interface SetupCommand {
  command: string;
  /** Where it came from, for the agent and the picker ("pnpm-lock.yaml"). */
  source: string;
}

/** Install commands by lockfile, first match wins (reproducible installs only). */
const LOCKFILE_SETUP: readonly (readonly [string, string])[] = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --prefer-offline"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["package-lock.json", "npm ci --prefer-offline --no-audit --no-fund"],
  ["yarn.lock", "yarn install"],
  ["uv.lock", "uv sync --frozen"],
];

export const WORKTREE_CONFIG = path.join(".gg", "worktree.json");

/**
 * What a new worktree at `root` runs once to become runnable: `setup` from the
 * project's `.gg/worktree.json` (an empty string or `false` turns it off),
 * else the install command for its lockfile, else nothing.
 */
export async function resolveSetupCommand(root: string): Promise<SetupCommand | null> {
  const configPath = path.join(root, WORKTREE_CONFIG);
  const raw = await fs.readFile(configPath, "utf8").catch(() => null);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { setup?: unknown };
      if (parsed.setup === false || parsed.setup === "") return null;
      if (typeof parsed.setup === "string" && parsed.setup.trim()) {
        return { command: parsed.setup.trim(), source: WORKTREE_CONFIG };
      }
    } catch {
      // Malformed config: fall back to the lockfile rather than run nothing.
    }
  }
  for (const [lockfile, command] of LOCKFILE_SETUP) {
    if (existsSync(path.join(root, lockfile))) return { command, source: lockfile };
  }
  return null;
}

/** The agent's note about its new worktree's setup. */
export function setupNote(setup: SetupCommand | null, taskId: string | null): string {
  if (setup && taskId) {
    return (
      `Setup for this new worktree is running: \`${setup.command}\` (from ${setup.source}), as ` +
      `background task ${taskId}. Wait for it to finish (task_output) before running builds or tests.`
    );
  }
  if (setup) {
    return `This new worktree's setup (\`${setup.command}\`) could not start; run it before building or testing.`;
  }
  return (
    "This new worktree has no dependencies installed and no setup command was found (a project " +
    `can set one in ${WORKTREE_CONFIG} as {"setup": "<command>"}). Install them before running ` +
    "builds or tests."
  );
}
