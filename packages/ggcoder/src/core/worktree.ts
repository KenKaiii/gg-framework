import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ── Helpers ─────────────────────────────────────────────────

function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeout = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout }, (error, stdout, stderr) => {
      if (error) {
        const err = error as Error & { stderr?: string };
        err.message = `${err.message}\n${stderr}`.trim();
        reject(err);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

// ── Repo root detection ─────────────────────────────────────

/**
 * Get the git repo root for the given cwd. Returns null if not a git repo.
 */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], cwd);
    return stdout || null;
  } catch {
    return null;
  }
}

/**
 * Get the true repo root even when inside a worktree.
 * A worktree's --show-toplevel returns the worktree path, not the main repo.
 * This resolves through --git-common-dir to find the actual repo root.
 */
export async function getTrueRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
    );
    // --git-common-dir returns the .git directory (e.g., /repo/.git)
    // The repo root is one level up
    if (stdout.endsWith("/.git")) {
      return stdout.slice(0, -5);
    }
    // If it doesn't end with /.git, fall back to --show-toplevel
    return getRepoRoot(cwd);
  } catch {
    return getRepoRoot(cwd);
  }
}

// ── Branch detection ────────────────────────────────────────

/**
 * Get the default remote branch (e.g., "main" or "master").
 */
export async function getDefaultRemoteBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    // Returns something like "refs/remotes/origin/main"
    const parts = stdout.split("/");
    return parts[parts.length - 1] || "main";
  } catch {
    return "main";
  }
}

// ── Worktree lifecycle ──────────────────────────────────────

export interface CreateWorktreeOptions {
  repoRoot: string;
  name: string;
  baseBranch?: string;
}

/**
 * Sanitize a worktree name to prevent path traversal and invalid git branch names.
 * Strips path separators, ".." sequences, and characters invalid in git refs.
 */
export function sanitizeWorktreeName(name: string): string {
  // Remove path traversal and separators
  let safe = name.replace(/\.\./g, "").replace(/[/\\]/g, "-");
  // Remove characters invalid in git branch names: space, ~, ^, :, ?, *, [, control chars
  safe = safe.replace(/[\s~^:?*[\]\\@{}\x00-\x1f\x7f]/g, "-");
  // Collapse multiple dashes and trim
  safe = safe.replace(/-+/g, "-").replace(/^-|-$/g, "");
  // Ensure non-empty
  return safe || "worktree";
}

/**
 * Create a git worktree at `<repoRoot>/.gg/worktrees/<name>/` with
 * branch `worktree-<name>`. Returns the absolute worktree path.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { repoRoot } = opts;
  const name = sanitizeWorktreeName(opts.name);
  const worktreePath = join(repoRoot, ".gg", "worktrees", name);
  const branchName = `worktree-${name}`;
  const baseBranch = opts.baseBranch ?? (await getDefaultRemoteBranch(repoRoot));

  // Ensure parent directory exists
  await mkdir(join(repoRoot, ".gg", "worktrees"), { recursive: true });

  await exec("git", ["worktree", "add", "-b", branchName, worktreePath, baseBranch], repoRoot);

  return worktreePath;
}

export interface RemoveWorktreeOptions {
  repoRoot: string;
  worktreePath: string;
  branchName?: string;
}

/**
 * Remove a git worktree and attempt to delete its branch.
 */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { repoRoot, worktreePath } = opts;

  try {
    await exec("git", ["worktree", "remove", "--force", worktreePath], repoRoot);
  } catch {
    // If remove fails, try pruning stale worktrees
    try {
      await exec("git", ["worktree", "prune"], repoRoot);
    } catch {
      // Best effort
    }
  }

  // Delete the branch (best-effort)
  if (opts.branchName) {
    try {
      await exec("git", ["branch", "-D", opts.branchName], repoRoot);
    } catch {
      // Branch may already be deleted or merged
    }
  }
}

// ── Dirty state detection ───────────────────────────────────

/**
 * Check if a worktree has uncommitted changes or unpushed commits.
 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  // Check for uncommitted changes
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], worktreePath);
    if (stdout.length > 0) return true;
  } catch {
    return true; // Assume dirty if we can't check
  }

  // Check for commits ahead of base (unpushed)
  try {
    const { stdout } = await exec(
      "git",
      ["log", "--oneline", "HEAD", "--not", "--remotes"],
      worktreePath,
    );
    if (stdout.length > 0) return true;
  } catch {
    // No upstream tracking or check failed — assume dirty to be safe
    return true;
  }

  return false;
}

// ── Name generation ─────────────────────────────────────────

/**
 * Generate a random worktree name like "sub-a1b2c3d4".
 */
export function generateWorktreeName(): string {
  return `sub-${randomBytes(4).toString("hex")}`;
}
