import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GoalRun, GoalTaskCandidate } from "./goal-store.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 2000;

export class GoalWorktreeDirtyError extends Error {
  readonly dirtyStatus: string;

  constructor(dirtyStatus: string) {
    super(
      `Goal workers need a clean working tree before they can start in an isolated worktree. Commit or stash the current changes first. Dirty files:\n${dirtyStatus.slice(0, MAX_GIT_OUTPUT)}`,
    );
    this.name = "GoalWorktreeDirtyError";
    this.dirtyStatus = dirtyStatus;
  }
}

export function isGoalWorktreeDirtyError(error: unknown): error is GoalWorktreeDirtyError {
  return error instanceof GoalWorktreeDirtyError;
}

export interface GoalWorktreeCommandRunner {
  execFile(
    file: string,
    args: readonly string[],
    options: { cwd: string },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface GoalWorktreeRequest {
  projectPath: string;
  goalRunId: string;
  goalTaskId: string;
  workerId: string;
  baseRef?: string;
  worktreesRoot?: string;
  commandRunner?: GoalWorktreeCommandRunner;
}

export interface GoalWorktreeCandidate {
  baseRef: string;
  branchName: string;
  path: string;
}

export interface GoalWorktreeIntegrationIssue {
  taskId: string;
  taskTitle: string;
  workerId?: string;
  worktreePath: string;
  baseRef: string;
  branchName: string;
  files: string[];
}

export interface GoalWorktreeIntegrationCheck {
  ok: boolean;
  issues: GoalWorktreeIntegrationIssue[];
  summary: string;
}

export async function defaultGoalWorktreeCommandRunner(
  file: string,
  args: readonly string[],
  options: { cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function goalWorktreeRoot(projectPath: string): string {
  return join(dirname(projectPath), `${projectBasename(projectPath)}-goal-worktrees`);
}

function projectBasename(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? "project";
}

export function sanitizeWorktreeToken(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "item"
  );
}

function parseNameOnly(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function parseChangedFiles(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export async function checkGoalWorktreeIntegration(
  projectPath: string,
  run: GoalRun,
  commandRunner?: GoalWorktreeCommandRunner,
): Promise<GoalWorktreeIntegrationCheck> {
  const runner = commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  const issues: GoalWorktreeIntegrationIssue[] = [];

  for (const task of run.tasks) {
    if (task.status !== "done" || !task.worktree || task.integration === "manual") continue;
    let status: string;
    try {
      status = await gitStdout(runner, task.worktree.path, ["status", "--porcelain"]);
    } catch (error) {
      issues.push({
        taskId: task.id,
        taskTitle: task.title,
        ...(task.workerId ? { workerId: task.workerId } : {}),
        worktreePath: task.worktree.path,
        baseRef: task.worktree.baseRef,
        branchName: task.worktree.branchName,
        files: [`Unable to inspect worktree: ${formatGitError(error)}`],
      });
      continue;
    }
    const files = parseChangedFiles(status);
    if (files.length === 0) continue;
    issues.push({
      taskId: task.id,
      taskTitle: task.title,
      ...(task.workerId ? { workerId: task.workerId } : {}),
      worktreePath: task.worktree.path,
      baseRef: task.worktree.baseRef,
      branchName: task.worktree.branchName,
      files,
    });
  }

  if (issues.length === 0) {
    return {
      ok: true,
      issues,
      summary: "All completed Goal worktree tasks are integrated or clean.",
    };
  }

  const issueSummary = issues
    .map(
      (issue) =>
        `${issue.taskTitle} (${issue.taskId}) has unintegrated files in ${issue.worktreePath}: ${issue.files.join(", ")}`,
    )
    .join("\n");
  return {
    ok: false,
    issues,
    summary:
      `Completed Goal worker artifacts are still stranded in isolated worktrees; integrate or reject them before verifier.\n${issueSummary}`.slice(
        0,
        MAX_GIT_OUTPUT,
      ),
  };
}

/** Fallback committer identity used only when the repo has none configured. */
const GOAL_BOT_COMMITTER = [
  "-c",
  "user.name=GG Coder Goal",
  "-c",
  "user.email=goal@ggcoder.local",
] as const;

/**
 * Return `-c user.name/-c user.email` args only when the repo has no committer
 * identity configured, so Goal auto-commits never fail on fresh clones/CI while
 * still preserving the user's real identity when it exists.
 */
export async function goalCommitterArgs(
  runner: GoalWorktreeCommandRunner,
  cwd: string,
): Promise<string[]> {
  try {
    const [email, name] = await Promise.all([
      runner.execFile("git", ["config", "user.email"], { cwd }),
      runner.execFile("git", ["config", "user.name"], { cwd }),
    ]);
    if (email.stdout.trim() && name.stdout.trim()) return [];
  } catch {
    // `git config <key>` exits non-zero when unset; fall through to the bot id.
  }
  return [...GOAL_BOT_COMMITTER];
}

/**
 * Commit, retrying once with a fallback bot identity ONLY when the failure was
 * caused by a missing committer identity (fresh clones / CI). Real failures
 * (hooks, etc.) propagate unchanged, and the happy path adds no extra git calls.
 */
async function commitWithIdentityFallback(
  runner: GoalWorktreeCommandRunner,
  cwd: string,
  message: string,
): Promise<void> {
  try {
    await gitStdout(runner, cwd, ["commit", "-m", message]);
  } catch (error) {
    const committer = await goalCommitterArgs(runner, cwd);
    if (committer.length === 0) throw error;
    await gitStdout(runner, cwd, [...committer, "commit", "-m", message]);
  }
}

/**
 * Whether `cwd` is inside a usable git work tree with at least one commit (a
 * resolvable HEAD to branch from). Used to decide whether Goal worktree
 * isolation is possible at all, so /goal degrades gracefully in non-git or
 * git-less environments instead of hard-crashing worker startup.
 */
export async function isGitWorktreeViable(
  projectPath: string,
  commandRunner?: GoalWorktreeCommandRunner,
): Promise<boolean> {
  const runner = commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  try {
    const inside = await runner.execFile("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectPath,
    });
    if (inside.stdout.trim() !== "true") return false;
    await runner.execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectPath });
    return true;
  } catch {
    return false;
  }
}

export interface GoalCheckpointResult {
  committed: boolean;
  status: string;
  sha?: string;
  files?: string[];
}

/**
 * Commit any uncommitted work in the project as a checkpoint before an isolated
 * Goal worker worktree is created. This is the rollback guarantee that licenses
 * unattended Goal autonomy: the auto-commit is clearly prefixed and reversible.
 */
export async function checkpointGoalWorkingTree({
  projectPath,
  message,
  commandRunner,
}: {
  projectPath: string;
  message: string;
  commandRunner?: GoalWorktreeCommandRunner;
}): Promise<GoalCheckpointResult> {
  const runner = commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  // Preserve the leading porcelain status codes (e.g. " M file"); only trim the
  // trailing newline so parseChangedFiles can slice each line correctly.
  let rawStatus: string;
  try {
    const result = await runner.execFile("git", ["status", "--porcelain"], { cwd: projectPath });
    rawStatus = result.stdout.replace(/\s+$/u, "");
  } catch (error) {
    throw new Error(`git status --porcelain failed: ${formatGitError(error)}`, { cause: error });
  }
  if (rawStatus.length === 0) return { committed: false, status: "" };
  await gitStdout(runner, projectPath, ["add", "-A"]);
  await commitWithIdentityFallback(runner, projectPath, message);
  const sha = await gitStdout(runner, projectPath, ["rev-parse", "HEAD"]);
  return { committed: true, sha, status: rawStatus, files: parseChangedFiles(rawStatus) };
}

/**
 * Commit a worktree worker's changes onto its own branch and return a typed,
 * structured candidate packet. This is the worker-commit discipline that lets
 * integration read exactly what changed instead of reverse-engineering a dirty
 * worktree, and it leaves the worktree clean so the integration check passes
 * deterministically. Returns undefined when the worker produced no changes.
 */
export async function commitGoalWorkerCandidate({
  worktreePath,
  branchName,
  baseRef,
  message,
  commandRunner,
}: {
  worktreePath: string;
  branchName: string;
  baseRef: string;
  message: string;
  commandRunner?: GoalWorktreeCommandRunner;
}): Promise<GoalTaskCandidate | undefined> {
  const runner = commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  const status = await gitStdout(runner, worktreePath, ["status", "--porcelain"]);
  let committed = false;
  if (status.length > 0) {
    await gitStdout(runner, worktreePath, ["add", "-A"]);
    await commitWithIdentityFallback(runner, worktreePath, message);
    committed = true;
  }
  const headSha = await gitStdout(runner, worktreePath, ["rev-parse", "HEAD"]);
  const changedFiles = parseNameOnly(
    await gitStdout(runner, worktreePath, ["diff", "--name-only", baseRef, "HEAD"]),
  );
  if (headSha === baseRef && changedFiles.length === 0) return undefined;
  return { baseRef, headSha, branchName, changedFiles, committed };
}

export interface GoalWorktreeCleanupResult {
  removedPaths: string[];
  removedBranches: string[];
}

/**
 * Remove a completed Goal run's worker worktrees and their branches, then prune
 * stale worktree metadata. Best-effort and idempotent: anything already gone is
 * ignored. Keeps the user's repo free of accumulating Goal worktrees/branches
 * across many runs without ever touching their working tree or other branches.
 */
export async function removeGoalRunWorktrees(
  projectPath: string,
  run: GoalRun,
  commandRunner?: GoalWorktreeCommandRunner,
): Promise<GoalWorktreeCleanupResult> {
  const runner = commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  const removedPaths: string[] = [];
  const removedBranches: string[] = [];
  const seenPaths = new Set<string>();
  const seenBranches = new Set<string>();
  for (const task of run.tasks) {
    const worktree = task.worktree;
    if (!worktree) continue;
    if (!seenPaths.has(worktree.path)) {
      seenPaths.add(worktree.path);
      try {
        await runner.execFile("git", ["worktree", "remove", "--force", worktree.path], {
          cwd: projectPath,
        });
        removedPaths.push(worktree.path);
      } catch {
        // Worktree already removed or never created; ignore.
      }
    }
    if (!seenBranches.has(worktree.branchName)) {
      seenBranches.add(worktree.branchName);
      try {
        await runner.execFile("git", ["branch", "-D", worktree.branchName], { cwd: projectPath });
        removedBranches.push(worktree.branchName);
      } catch {
        // Branch already deleted or checked out elsewhere; ignore.
      }
    }
  }
  try {
    await runner.execFile("git", ["worktree", "prune"], { cwd: projectPath });
  } catch {
    // Prune is best-effort hygiene.
  }
  return { removedPaths, removedBranches };
}

export async function createGoalWorkerWorktree({
  projectPath,
  goalRunId,
  goalTaskId,
  workerId,
  baseRef,
  worktreesRoot,
  commandRunner,
}: GoalWorktreeRequest): Promise<GoalWorktreeCandidate> {
  const runner = commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  await assertCleanProject(runner, projectPath);
  const resolvedBaseRef = baseRef ?? (await gitStdout(runner, projectPath, ["rev-parse", "HEAD"]));
  const token = sanitizeWorktreeToken(`${goalTaskId}-${workerId}`);
  const branchName = `goal/${sanitizeWorktreeToken(goalRunId)}/${token}`;
  const root = worktreesRoot ?? goalWorktreeRoot(projectPath);
  const worktreePath = join(root, token);

  await mkdir(root, { recursive: true });
  await runner.execFile(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, resolvedBaseRef],
    {
      cwd: projectPath,
    },
  );

  return { baseRef: resolvedBaseRef, branchName, path: worktreePath };
}

async function assertCleanProject(runner: GoalWorktreeCommandRunner, cwd: string): Promise<void> {
  const status = await gitStdout(runner, cwd, ["status", "--porcelain"]);
  if (status.length > 0) {
    throw new GoalWorktreeDirtyError(status);
  }
}

async function gitStdout(
  runner: GoalWorktreeCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await runner.execFile("git", args, { cwd });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${formatGitError(error)}`, { cause: error });
  }
}

export function formatGitError(error: unknown): string {
  if (error instanceof Error) {
    const maybe = error as Error & { stderr?: unknown; stdout?: unknown };
    const output = [maybe.stderr, maybe.stdout, error.message]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n")
      .trim();
    return output.slice(0, MAX_GIT_OUTPUT);
  }
  return String(error).slice(0, MAX_GIT_OUTPUT);
}
