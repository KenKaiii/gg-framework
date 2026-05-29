import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GoalRun } from "./goal-store.js";

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
    if (task.status !== "done" || !task.worktree || task.mergeStrategy === "manual") continue;
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
  await gitStdout(runner, projectPath, ["commit", "-m", message]);
  const sha = await gitStdout(runner, projectPath, ["rev-parse", "HEAD"]);
  return { committed: true, sha, status: rawStatus, files: parseChangedFiles(rawStatus) };
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
