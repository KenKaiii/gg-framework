import {
  APPLY_INTEGRATION_TO_MAIN_TASK_TITLE,
  decideGoalNextAction,
  type GoalControllerOptions,
} from "./goal-controller.js";
import type { GoalStagedContext, GoalStageResult } from "./goal-integration.js";
import type {
  GoalEvidenceInput,
  GoalIntegrationState,
  GoalRun,
  GoalTask,
  GoalVerificationResult,
} from "./goal-store.js";

/**
 * Outcome of a single {@link stepGoalRun} call.
 * - `continue`: state advanced; the driver should step again.
 * - `wait`: a worker/verifier is already in flight; the driver waits for the
 *   completion event before stepping again.
 * - `complete`/`terminal`/`blocked`: the run resolved; stop stepping.
 */
export type GoalStepOutcome = "continue" | "wait" | "complete" | "terminal" | "blocked";

/**
 * Side-effect surface the pure engine drives. The React hook and the headless
 * driver each supply an implementation backed by the real store/worker/verifier/
 * integration modules; the engine itself contains only decision→effect mapping
 * and is unit-testable with a fake `GoalEffects`.
 */
export interface GoalEffects {
  /** Injected clock; never `Date.now()` inline in the engine. */
  now(): string;
  log(level: "INFO" | "WARN" | "ERROR", msg: string): void;
  /** Reload the latest persisted run after an out-of-band store mutation. */
  reload(): Promise<GoalRun>;
  /**
   * Run a worker for `task` to completion: the implementation commits the
   * candidate, marks the task, records a substantive-worker timestamp for
   * non-audit/non-integration work, and confirms apply-integration into main.
   */
  startWorker(task: GoalTask, attempts: number): Promise<void>;
  /** Execute the verifier command and return its structured result. */
  runVerifier(command: string, cwd?: string): Promise<GoalVerificationResult>;
  /** Persist the verifier result (+ pending completion audit on pass). */
  recordVerifierResult(
    result: GoalVerificationResult,
    options: { staging: boolean },
  ): Promise<GoalRun>;
  /** Attempt deterministic staged integration on a throwaway branch. */
  stageIntegration(run: GoalRun): Promise<GoalStageResult>;
  /** Fast-forward main to a verified staging branch. */
  finalizeIntegration(staging: GoalStagedContext): Promise<{ commitSha: string }>;
  /** Discard an unusable staged integration; main untouched. */
  discardIntegration(staging: GoalStagedContext): Promise<void>;
  /** Stamp typed integration state from git truth. */
  setIntegrationState(state: GoalIntegrationState): Promise<void>;
  /** Create (or reuse) an auto-task with the given title/prompt. */
  createTask(title: string, prompt: string): Promise<void>;
  appendEvidence(entry: GoalEvidenceInput): Promise<void>;
}

export interface GoalStepResult {
  run: GoalRun;
  outcome: GoalStepOutcome;
}

/**
 * Execute exactly one controller decision's worth of work against the injected
 * effects and return the next run + outcome. Behavior-equivalent to the
 * `startGoalRun`/`verifyGoalRun` decision→effect mapping that previously lived
 * only in the React hook, but pure and testable with a fake `GoalEffects`.
 */
export async function stepGoalRun(
  run: GoalRun,
  effects: GoalEffects,
  options: GoalControllerOptions = {},
): Promise<GoalStepResult> {
  const decision = decideGoalNextAction(run, options);
  switch (decision.kind) {
    case "complete":
      return { run, outcome: "complete" };
    case "blocked":
      return { run, outcome: "blocked" };
    case "wait":
      return { run, outcome: "wait" };
    case "terminal": {
      if (decision.status === "failed") {
        await effects.appendEvidence({
          kind: "summary",
          label: "Goal failure diagnosis",
          content: decision.reason,
        });
      }
      return { run, outcome: "terminal" };
    }
    case "run_verifier": {
      const result = await effects.runVerifier(decision.command, run.verifier?.cwd);
      const next = await effects.recordVerifierResult(result, { staging: false });
      return { run: next, outcome: "continue" };
    }
    case "start_worker": {
      await effects.startWorker(decision.task, decision.attempts);
      const next = await effects.reload();
      return { run: next, outcome: "continue" };
    }
    case "create_task": {
      if (decision.title === APPLY_INTEGRATION_TO_MAIN_TASK_TITLE) {
        const staged = await effects.stageIntegration(run);
        if (staged.status === "staged") {
          return stepStagedIntegration(run, effects, staged);
        }
        if (staged.status === "fallback") {
          await effects.appendEvidence({
            kind: "summary",
            label: "Goal decision: staged_integration_fallback",
            content: staged.reason,
          });
        }
      }
      await effects.createTask(decision.title, decision.prompt);
      const next = await effects.reload();
      return { run: next, outcome: "continue" };
    }
  }
}

/**
 * Verify a staged integration on its throwaway branch and only fast-forward
 * main on a pass — main never holds unverified changes. On failure the staging
 * is discarded and main is left untouched, then the verifier result is recorded
 * so the controller's fix loop can react.
 */
async function stepStagedIntegration(
  run: GoalRun,
  effects: GoalEffects,
  staged: Extract<GoalStageResult, { status: "staged" }>,
): Promise<GoalStepResult> {
  await effects.appendEvidence({
    kind: "summary",
    label: "Integration staged",
    content: `Staged ${staged.integratedTaskIds.length} candidate(s) on ${staged.stagingBranch} for verify-before-fast-forward; files=${staged.changedFiles.join(", ")}.`,
    path: staged.stagingPath,
  });
  const command = run.verifier?.command;
  if (!command) {
    await effects.discardIntegration(staged);
    await effects.appendEvidence({
      kind: "summary",
      label: "Staged integration discarded",
      content:
        "No verifier command is configured; discarded the staging branch and left main unchanged.",
    });
    const next = await effects.reload();
    return { run: next, outcome: "continue" };
  }
  const result = await effects.runVerifier(command, staged.stagingPath);
  if (result.status === "pass") {
    try {
      const ff = await effects.finalizeIntegration(staged);
      await effects.setIntegrationState({
        status: "committed",
        headSha: ff.commitSha,
        baseRef: staged.mainBase,
        files: staged.changedFiles,
        updatedAt: effects.now(),
      });
      await effects.appendEvidence({
        kind: "summary",
        label: "Integrated worktree applied to main",
        content: `Verified staged integration fast-forwarded to main. tasks=${staged.integratedTaskIds.join(", ")}; files=${staged.changedFiles.join(", ")}; commit=${ff.commitSha}`,
      });
      await effects.appendEvidence({
        kind: "summary",
        label: "Integrated Goal changes committed",
        content: `Fast-forwarded ${staged.changedFiles.length} file(s) to main; commit=${ff.commitSha}.`,
      });
    } catch (err) {
      await effects.discardIntegration(staged);
      await effects.appendEvidence({
        kind: "summary",
        label: "Integration fast-forward failed",
        content: `Staged integration verified but main could not fast-forward; will retry or apply. ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    await effects.discardIntegration(staged);
    await effects.appendEvidence({
      kind: "summary",
      label: "Staged integration discarded",
      content:
        "Verifier failed on the staged integration; discarded the staging branch and left main unchanged.",
    });
  }
  const next = await effects.recordVerifierResult(result, { staging: true });
  return { run: next, outcome: "continue" };
}
