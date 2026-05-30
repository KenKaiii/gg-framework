import { join } from "node:path";
import type { GoalRun, GoalTask } from "./goal-store.js";
import {
  checkpointGoalWorkingTree,
  defaultGoalWorktreeCommandRunner,
  formatGitError,
  goalCommitterArgs,
  goalWorktreeRoot,
  sanitizeWorktreeToken,
  type GoalWorktreeCommandRunner,
} from "./goal-worktree.js";

const MAX_INTEGRATION_OUTPUT = 2000;

export interface GoalMainIntegrationConfirmation {
  applied: boolean;
  committed: boolean;
  sha?: string;
  files: string[];
  reason: string;
}

/**
 * Deterministically confirm — and finalize — that the user's main checkout now
 * contains the accepted integration, WITHOUT trusting any LLM worker to emit
 * exact evidence labels. Commits whatever an apply worker left uncommitted, then
 * checks that main advanced beyond the candidate integration base. The
 * orchestrator records canonical applied/committed evidence from this result, so
 * the completion gates can never silently stall on a worker that phrased its
 * evidence differently.
 */
export async function confirmAndCommitMainIntegration(options: {
  projectPath: string;
  baseRef: string;
  message: string;
  commandRunner?: GoalWorktreeCommandRunner;
}): Promise<GoalMainIntegrationConfirmation> {
  const { projectPath, baseRef, message } = options;
  const runner = options.commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  const checkpoint = await checkpointGoalWorkingTree({
    projectPath,
    message,
    ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
  });
  const head = await git(runner, projectPath, ["rev-parse", "HEAD"]);
  const applied = head !== baseRef;
  const files =
    checkpoint.files && checkpoint.files.length > 0
      ? checkpoint.files
      : applied
        ? parseNameOnly(await git(runner, projectPath, ["diff", "--name-only", baseRef, "HEAD"]))
        : [];
  return {
    applied,
    committed: checkpoint.committed,
    ...(applied ? { sha: head } : {}),
    files,
    reason: applied
      ? "Main advanced beyond the integration base."
      : "Main is unchanged versus the integration base; nothing was integrated.",
  };
}

interface GoalIntegrationCandidate {
  task: GoalTask;
  branchName: string;
  baseRef: string;
  changedFiles: string[];
}

/** Identity of a staged-but-not-yet-applied integration. */
export interface GoalStagedContext {
  stagingBranch: string;
  stagingPath: string;
  mainBase: string;
  integratedTaskIds: string[];
  changedFiles: string[];
}

export type GoalStageResult =
  | ({ status: "staged" } & GoalStagedContext)
  | { status: "fallback" | "noop"; reason: string };

/**
 * Done worktree tasks whose committed candidate changes must reach main.
 * Ordering is expressed by dependsOn; this gate only excludes tasks explicitly
 * marked integration="manual". Read-only tasks (no candidate changes) are
 * excluded.
 */
export function integrableWorktreeTasks(run: GoalRun): GoalTask[] {
  return run.tasks.filter(
    (task) =>
      task.status === "done" &&
      !!task.worktree &&
      task.integration !== "manual" &&
      (task.candidate?.changedFiles?.length ?? 0) > 0,
  );
}

/**
 * Translate a single `expected_changed_scope` glob into an anchored RegExp.
 * `**` matches across path separators; `*`/`?` stay within a single segment.
 * Intentionally conservative: anything it cannot confidently match falls back
 * to the guarded LLM apply task rather than risking an out-of-scope merge.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`, "u");
}

export function fileMatchesScope(file: string, scope: readonly string[]): boolean {
  return scope.some((glob) => globToRegExp(glob).test(file));
}

async function git(
  runner: GoalWorktreeCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const out = await runner.execFile("git", args, { cwd });
  return out.stdout.trim();
}

function parseNameOnly(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

type CandidatePlan =
  | { status: "eligible"; candidates: GoalIntegrationCandidate[]; changedFiles: string[] }
  | { status: "fallback" | "noop"; reason: string };

/**
 * Decide which candidate tasks can be integrated deterministically (committed
 * packet, in scope, non-overlapping) against a clean main checkout.
 * Returns `fallback`/`noop` for anything ambiguous so the guarded LLM apply task
 * runs instead — never a risky merge.
 */
async function planGoalIntegrationCandidates(
  runner: GoalWorktreeCommandRunner,
  projectPath: string,
  run: GoalRun,
): Promise<CandidatePlan> {
  const tasks = integrableWorktreeTasks(run);
  if (tasks.length === 0) {
    return { status: "noop", reason: "No candidate worktree tasks to integrate." };
  }

  const mainStatus = await git(runner, projectPath, ["status", "--porcelain"]);
  if (mainStatus.length > 0) {
    return {
      status: "fallback",
      reason: "Main checkout has uncommitted changes; deferring to the guarded apply task.",
    };
  }

  const candidates: GoalIntegrationCandidate[] = [];
  for (const task of tasks) {
    const worktree = task.worktree!;
    const scope = task.expectedChangedScope ?? [];
    if (scope.length === 0) {
      return {
        status: "fallback",
        reason: `Task "${task.title}" has no expected_changed_scope; cannot verify deterministic integration scope.`,
      };
    }

    // Prefer the worker's typed, committed candidate packet (no archaeology).
    let branchName = worktree.branchName;
    let baseRef = worktree.baseRef;
    let changedFiles: string[];
    if (task.candidate) {
      branchName = task.candidate.branchName;
      baseRef = task.candidate.baseRef;
      changedFiles = task.candidate.changedFiles;
    } else {
      await git(runner, worktree.path, ["add", "-A"]);
      let hasStagedChanges = false;
      try {
        await git(runner, worktree.path, ["diff", "--cached", "--quiet"]);
      } catch {
        hasStagedChanges = true;
      }
      if (hasStagedChanges) {
        await git(runner, worktree.path, ["commit", "-m", `goal(${run.id}): candidate ${task.id}`]);
      }
      changedFiles = parseNameOnly(
        await git(runner, worktree.path, ["diff", "--name-only", worktree.baseRef, "HEAD"]),
      );
    }
    if (changedFiles.length === 0) continue; // worker produced no changes; nothing to apply

    const outOfScope = changedFiles.filter((file) => !fileMatchesScope(file, scope));
    if (outOfScope.length > 0) {
      return {
        status: "fallback",
        reason: `Task "${task.title}" changed files outside expected_changed_scope: ${outOfScope.join(", ")}.`,
      };
    }
    candidates.push({ task, branchName, baseRef, changedFiles });
  }

  if (candidates.length === 0) {
    return { status: "noop", reason: "Candidate worktrees contained no changes to integrate." };
  }

  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    for (const file of candidate.changedFiles) {
      const owner = seen.get(file);
      if (owner) {
        return {
          status: "fallback",
          reason: `Candidates overlap on ${file} (tasks ${owner} and ${candidate.task.id}); deferring to the guarded apply task.`,
        };
      }
      seen.set(file, candidate.task.id);
    }
  }

  return {
    status: "eligible",
    candidates,
    changedFiles: [...seen.keys()].sort((a, b) => a.localeCompare(b)),
  };
}

function stagingRefs(
  projectPath: string,
  run: GoalRun,
  stagingRoot?: string,
): {
  stagingBranch: string;
  stagingPath: string;
} {
  const token = sanitizeWorktreeToken(run.id);
  return {
    stagingBranch: `goal/${token}/integration`,
    stagingPath: join(stagingRoot ?? goalWorktreeRoot(projectPath), `integration-${token}`),
  };
}

async function removeStagingWorktree(
  runner: GoalWorktreeCommandRunner,
  projectPath: string,
  stagingPath: string,
  stagingBranch: string,
): Promise<void> {
  try {
    await runner.execFile("git", ["worktree", "remove", "--force", stagingPath], {
      cwd: projectPath,
    });
  } catch {
    // Already gone.
  }
  try {
    await runner.execFile("git", ["branch", "-D", stagingBranch], { cwd: projectPath });
  } catch {
    // Already gone.
  }
  try {
    await runner.execFile("git", ["worktree", "prune"], { cwd: projectPath });
  } catch {
    // Best-effort.
  }
}

/**
 * Build the integration on a dedicated staging worktree/branch from the current
 * main HEAD WITHOUT touching the user's checkout. The caller verifies the
 * staged result and only then fast-forwards main (see {@link finalizeStagedIntegration}),
 * so main never holds unverified changes. Any ambiguity returns `fallback`/`noop`
 * and the staging worktree is cleaned up.
 *
 * Disable deterministic integration entirely with `GG_GOAL_AUTO_INTEGRATE=0`.
 */
export async function stageGoalIntegration(options: {
  projectPath: string;
  run: GoalRun;
  stagingRoot?: string;
  commandRunner?: GoalWorktreeCommandRunner;
}): Promise<GoalStageResult> {
  const { projectPath, run } = options;
  const runner = options.commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };

  if (process.env.GG_GOAL_AUTO_INTEGRATE === "0") {
    return {
      status: "fallback",
      reason: "Deterministic integration disabled via GG_GOAL_AUTO_INTEGRATE=0.",
    };
  }

  const { stagingBranch, stagingPath } = stagingRefs(projectPath, run, options.stagingRoot);
  try {
    const plan = await planGoalIntegrationCandidates(runner, projectPath, run);
    if (plan.status !== "eligible") return plan;

    const mainBase = await git(runner, projectPath, ["rev-parse", "HEAD"]);
    // Clear any leftover staging worktree/branch from a prior crashed attempt.
    await removeStagingWorktree(runner, projectPath, stagingPath, stagingBranch);
    await git(runner, projectPath, ["worktree", "add", "-b", stagingBranch, stagingPath, mainBase]);

    const committer = await goalCommitterArgs(runner, stagingPath);
    const integratedTaskIds: string[] = [];
    try {
      for (const candidate of plan.candidates) {
        await git(runner, stagingPath, [
          ...committer,
          "cherry-pick",
          `${candidate.baseRef}..${candidate.branchName}`,
        ]);
        integratedTaskIds.push(candidate.task.id);
      }
    } catch (error) {
      try {
        await git(runner, stagingPath, ["cherry-pick", "--abort"]);
      } catch {
        // No cherry-pick in progress.
      }
      await removeStagingWorktree(runner, projectPath, stagingPath, stagingBranch);
      return {
        status: "fallback",
        reason:
          `Cherry-pick conflict while staging integration; deferring to the guarded apply task: ${formatGitError(error)}`.slice(
            0,
            MAX_INTEGRATION_OUTPUT,
          ),
      };
    }

    return {
      status: "staged",
      stagingBranch,
      stagingPath,
      mainBase,
      integratedTaskIds,
      changedFiles: plan.changedFiles,
    };
  } catch (error) {
    await removeStagingWorktree(runner, projectPath, stagingPath, stagingBranch);
    return {
      status: "fallback",
      reason:
        `Could not stage deterministic integration; deferring to the guarded apply task: ${formatGitError(error)}`.slice(
          0,
          MAX_INTEGRATION_OUTPUT,
        ),
    };
  }
}

/**
 * Fast-forward main to a verified staging branch and clean up the staging
 * worktree. Throws if main cannot fast-forward (e.g. it moved), so the caller
 * can discard the staging and fall back without ever leaving main half-applied.
 */
export async function finalizeStagedIntegration(options: {
  projectPath: string;
  staging: GoalStagedContext;
  commandRunner?: GoalWorktreeCommandRunner;
}): Promise<{ commitSha: string }> {
  const { projectPath, staging } = options;
  const runner = options.commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  await git(runner, projectPath, ["merge", "--ff-only", staging.stagingBranch]);
  const commitSha = await git(runner, projectPath, ["rev-parse", "HEAD"]);
  await removeStagingWorktree(runner, projectPath, staging.stagingPath, staging.stagingBranch);
  return { commitSha };
}

/** Discard a staged integration (verifier failed or unusable); main untouched. */
export async function discardStagedIntegration(options: {
  projectPath: string;
  staging: GoalStagedContext;
  commandRunner?: GoalWorktreeCommandRunner;
}): Promise<void> {
  const { projectPath, staging } = options;
  const runner = options.commandRunner ?? { execFile: defaultGoalWorktreeCommandRunner };
  await removeStagingWorktree(runner, projectPath, staging.stagingPath, staging.stagingBranch);
}
