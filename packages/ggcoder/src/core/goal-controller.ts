import {
  formatGoalBlockingPrerequisites,
  goalHasBlockingPrerequisites,
  goalHasUnmetLocalPrerequisites,
  unmetLocalGoalPrerequisites,
  type GoalReference,
  type GoalRun,
  type GoalTask,
} from "./goal-store.js";
import {
  formatGoalReferencesForPrompt,
  referencesRequiringAcknowledgement,
} from "./goal-references.js";

export const DEFAULT_GOAL_TASK_ATTEMPT_LIMIT = 5;
export const DEFAULT_GOAL_VERIFIER_FIX_LIMIT = 5;
export const DEFAULT_GOAL_STRATEGY_LIMIT = 2;
/**
 * Hard ceiling on total controller decisions per run. A safety net that
 * guarantees termination even if some unforeseen state oscillates without
 * tripping the per-dimension attempt/strategy/verifier/audit limits. Set high
 * enough that legitimate large goals never hit it.
 */
export const DEFAULT_GOAL_DECISION_LIMIT = 300;

export const APPLY_INTEGRATION_TO_MAIN_TASK_TITLE = "Apply integrated worktree to main";
export const RESOLVE_LOCAL_PREREQUISITES_TASK_TITLE = "Resolve local Goal prerequisites";
export const RE_STRATEGIZE_GOAL_TASK_TITLE = "Re-strategize Goal approach";
export const FINAL_COMPLETION_AUDIT_TASK_TITLE = "Audit Goal completion evidence";
const BUILD_GOAL_EVIDENCE_PATH_TASK_TITLE = "Build Goal evidence path";
const BUILD_GOAL_VERIFICATION_HARNESS_TASK_TITLE = "Build Goal verification harness";
const DEFINE_GOAL_VERIFIER_TASK_TITLE = "Define Goal verifier";
const FIX_VERIFIER_FAILURE_TASK_TITLE = "Fix verifier failure";
const DEFAULT_GOAL_COMPLETION_AUDIT_LIMIT = 3;

export type GoalControllerDecision =
  | {
      kind: "blocked";
      reason: string;
    }
  | {
      kind: "create_task";
      title: string;
      prompt: string;
      reason: string;
    }
  | {
      kind: "terminal";
      reason: string;
      status: "blocked" | "failed" | "passed" | "paused";
    }
  | {
      kind: "wait";
      reason: string;
      workerId?: string;
    }
  | {
      kind: "start_worker";
      task: GoalTask;
      attempts: number;
      reason: string;
    }
  | {
      kind: "run_verifier";
      command: string;
      reason: string;
    }
  | {
      kind: "complete";
      reason: string;
    };

export interface GoalCompletionCheck {
  ok: boolean;
  reason: string;
}

export interface GoalControllerOptions {
  taskAttemptLimit?: number;
  verifierFixLimit?: number;
  strategyLimit?: number;
  decisionLimit?: number;
}

/** Count of controller decisions already recorded as durable evidence. */
export function goalDecisionCount(run: GoalRun): number {
  return run.evidence.filter((item) => item.label.startsWith("Goal decision:")).length;
}

function needsHarnessInstrumentation(run: GoalRun): boolean {
  return run.harness.some((item) => !item.command && !item.path);
}

function referencePromptSection(references: readonly GoalReference[] | undefined): string {
  const section = formatGoalReferencesForPrompt(references ?? []);
  return section ? `${section}\n\n` : "";
}

function referenceMentionTokens(reference: GoalReference): string[] {
  return [reference.id, reference.label, reference.value, reference.path]
    .filter((token): token is string => !!token?.trim())
    .map((token) => token.toLowerCase());
}

function requiresGoalReliabilityContract(run: GoalRun): boolean {
  const fields = [
    run.goal,
    ...run.successCriteria,
    ...(run.references ?? []).map(
      (reference) => `${reference.id} ${reference.label} ${reference.content ?? ""}`,
    ),
    ...run.evidence.map((item) => `${item.label}\n${item.path ?? ""}\n${item.content ?? ""}`),
  ].join("\n");
  return /GOAL_PLAN/.test(fields);
}

function hasOriginalGoalPromptReference(run: GoalRun): boolean {
  return (run.references ?? []).some(
    (reference) =>
      reference.id === "original-goal-prompt" &&
      reference.kind === "prompt" &&
      reference.content?.trim(),
  );
}

function hasDurableGoalPlan(run: GoalRun): boolean {
  const fields = [
    run.goal,
    ...run.evidence.map((item) => `${item.label}\n${item.path ?? ""}\n${item.content ?? ""}`),
  ].join("\n");
  return /GOAL_PLAN/.test(fields) && /research=/.test(fields) && /success=/.test(fields);
}

function goalPromptDurabilityFailure(run: GoalRun): string | undefined {
  if (!requiresGoalReliabilityContract(run)) return undefined;
  if (!hasOriginalGoalPromptReference(run)) {
    return "Goal is missing durable [original-goal-prompt] reference content.";
  }
  if (!hasDurableGoalPlan(run)) {
    return "Goal is missing durable planner GOAL_PLAN evidence/state.";
  }
  return undefined;
}

function fieldContainsReference(reference: GoalReference, fields: readonly string[]): boolean {
  const haystack = fields.join("\n").toLowerCase();
  return referenceMentionTokens(reference).some((token) => haystack.includes(token));
}

function unacknowledgedGoalReferences(run: GoalRun): GoalReference[] {
  const setupAndWorkFields = [
    ...run.successCriteria,
    ...run.evidencePlan.map(
      (item) =>
        `${item.id} ${item.label} ${item.description} ${item.command ?? ""} ${item.path ?? ""} ${item.evidence ?? ""}`,
    ),
    ...run.tasks.map((task) => `${task.title} ${task.prompt} ${task.lastSummary ?? ""}`),
    ...run.evidence.map((item) => `${item.label} ${item.path ?? ""} ${item.content ?? ""}`),
    run.verifier?.description ?? "",
    run.verifier?.command ?? "",
    run.verifier?.lastResult?.summary ?? "",
    run.completionAudit?.summary ?? "",
  ];
  const completionFields = [
    run.verifier?.description ?? "",
    run.verifier?.command ?? "",
    run.verifier?.lastResult?.summary ?? "",
    run.verifier?.lastResult?.outputPath ?? "",
    run.completionAudit?.summary ?? "",
    run.completionAudit?.outputPath ?? "",
  ];
  return (run.references ?? []).filter((reference) => {
    if (reference.kind === "prompt") {
      return (
        requiresGoalReliabilityContract(run) &&
        reference.id === "original-goal-prompt" &&
        !fieldContainsReference(reference, completionFields)
      );
    }
    if (!referencesRequiringAcknowledgement([reference]).length) return false;
    return !fieldContainsReference(reference, setupAndWorkFields);
  });
}

function buildHarnessTaskPrompt(run: GoalRun): string {
  const harnessItems = run.harness
    .filter((item) => !item.command && !item.path)
    .map((item) => `- ${item.label}: ${item.description ?? "Create local instrumentation."}`)
    .join("\n");
  return (
    `Goal: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Build only the missing local/free harness instrumentation needed before verification. Start by restating the intended experience, the relevant failure modes, and the senses/signals this harness must observe; do not default to generic tests, scripts, screenshots, benchmarks, or simulations unless that signal is required for this specific goal.\n` +
    `${harnessItems}\n\n` +
    `Inventory available local capabilities just deeply enough to choose a proportional instrument, then build it. Update the Goal harness/verifier metadata with the goals tool and record durable evidence showing the instrument exists and works. Do not require paid services or signups; block only with exact user instructions if a true external prerequisite is missing.`
  );
}

function blockedEvidencePlanReason(run: GoalRun): string | undefined {
  const blocked = run.evidencePlan.find((item) => item.status === "blocked");
  if (!blocked) return undefined;
  return `${blocked.label}: ${blocked.instructions?.trim() || "User must provide this evidence prerequisite."}`;
}

function needsEvidenceInstrumentation(run: GoalRun): boolean {
  return unsatisfiedGoalEvidencePlanItems(run).some((item) => item.status === "planned");
}

export function unsatisfiedGoalEvidencePlanItems(run: GoalRun): GoalRun["evidencePlan"] {
  return run.evidencePlan.filter((item) => !evidencePlanItemSatisfiedByDurableEvidence(run, item));
}

function unsatisfiedEvidencePlanItemReason(
  run: GoalRun,
  item: GoalRun["evidencePlan"][number],
): string {
  if (item.status === "ready" && !item.evidence?.trim() && !item.path && !item.command) {
    return `${item.label} (ready but no durable evidence, path, or command recorded)`;
  }
  if (item.path && !run.evidence.some((evidence) => evidence.path === item.path)) {
    return `${item.label} (missing durable evidence for path ${item.path})`;
  }
  if (
    item.command &&
    !run.evidence.some((evidence) => exactTokenReferenced(evidence.content, item.command))
  ) {
    return `${item.label} (missing durable evidence for command ${item.command})`;
  }
  return item.label;
}

function exactTokenReferenced(content: string | undefined, token: string | undefined): boolean {
  return !!content?.trim() && !!token?.trim() && content.includes(token);
}

function evidencePlanItemSatisfiedByDurableEvidence(
  run: GoalRun,
  item: GoalRun["evidencePlan"][number],
): boolean {
  if (item.status === "ready" && item.evidence?.trim()) return true;
  if (item.evidence?.trim()) return true;

  const verifier = run.verifier?.lastResult;
  if (verifier?.status === "pass") {
    if (item.command && verifier.command === item.command) return true;
    if (item.path && verifier.outputPath === item.path) return true;
  }
  return run.evidence.some((evidence) => {
    if (item.path && evidence.path === item.path) return true;
    if (item.command && exactTokenReferenced(evidence.content, item.command)) return true;
    if (item.path && exactTokenReferenced(evidence.content, item.path)) return true;
    return false;
  });
}

export function hasRequiredGoalEvidence(run: GoalRun): GoalCompletionCheck {
  const missing = unsatisfiedGoalEvidencePlanItems(run);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Goal evidence plan is not satisfied: ${missing.map((item) => unsatisfiedEvidencePlanItemReason(run, item)).join(", ")}.`,
    };
  }
  return {
    ok: true,
    reason: "All required evidence-plan items are ready or proven by durable evidence.",
  };
}

function finalAuditTaskCount(run: GoalRun): number {
  return run.tasks.filter((task) => task.title === FINAL_COMPLETION_AUDIT_TASK_TITLE).length;
}

function hasApplyIntegrationTask(run: GoalRun): boolean {
  return run.tasks.some((task) => task.title === APPLY_INTEGRATION_TO_MAIN_TASK_TITLE);
}

/**
 * Done worktree tasks whose committed candidate changes must reach the main
 * checkout. Ordering is expressed by dependsOn; this gate only excludes tasks
 * explicitly marked integration="manual". Read-only tasks (audit, etc.)
 * produce no candidate changes and are excluded.
 */
function pendingWorktreeIntegrationTasks(run: GoalRun): GoalTask[] {
  return run.tasks.filter(
    (task) =>
      task.status === "done" &&
      !!task.worktree &&
      task.integration !== "manual" &&
      (task.candidate?.changedFiles?.length ?? 0) > 0,
  );
}

/** Typed integration gate: candidates reached main (applied or committed). */
function integrationApplied(run: GoalRun): boolean {
  return run.integration?.status === "applied" || run.integration?.status === "committed";
}

/** Typed integration gate: integrated changes are committed in main. */
function integrationCommitted(run: GoalRun): boolean {
  return run.integration?.status === "committed";
}

function hasIntegratedWorktreeChanges(run: GoalRun): boolean {
  return (
    pendingWorktreeIntegrationTasks(run).length > 0 ||
    (run.integration != null && run.integration.status !== "none")
  );
}

/**
 * True when the latest verifier result predates the most recent substantive
 * (non-audit, non-integration) worker completion, so the verifier evidence is
 * stale and must be re-run before the audit/completion gates can trust it.
 */
function verifierStaleAfterWorker(run: GoalRun): boolean {
  return (
    !!run.verifier?.lastResult?.checkedAt &&
    !!run.lastSubstantiveWorkerAt &&
    run.lastSubstantiveWorkerAt > run.verifier.lastResult.checkedAt
  );
}

function needsMainIntegrationApplyTask(run: GoalRun): boolean {
  return (
    pendingWorktreeIntegrationTasks(run).length > 0 &&
    !hasApplyIntegrationTask(run) &&
    !integrationApplied(run)
  );
}

function shouldCreateFinalAuditTask(
  run: GoalRun,
  limit = DEFAULT_GOAL_COMPLETION_AUDIT_LIMIT,
): boolean {
  return finalAuditTaskCount(run) < limit;
}

export function hasFreshGoalCompletionAudit(run: GoalRun): GoalCompletionCheck {
  const verifierResult = run.verifier?.lastResult;
  if (!verifierResult || verifierResult.status !== "pass") {
    return { ok: false, reason: "Goal has no passing verifier result to audit." };
  }

  if (verifierStaleAfterWorker(run)) {
    return {
      ok: false,
      reason: "Latest verifier result is stale after a later substantive Goal worker completion.",
    };
  }

  const audit = run.completionAudit;
  if (!audit) {
    return { ok: false, reason: "Goal has no final completion audit." };
  }
  if (audit.status !== "pass") {
    return { ok: false, reason: `Final completion audit status is ${audit.status}.` };
  }
  if (!audit.outputPath) {
    return {
      ok: false,
      reason: "Final completion audit pass must reference verifier output or artifacts.",
    };
  }
  if (audit.verifierCheckedAt !== verifierResult.checkedAt) {
    return {
      ok: false,
      reason: "Final completion audit does not match the latest verifier result.",
    };
  }
  if (audit.checkedAt < verifierResult.checkedAt) {
    return {
      ok: false,
      reason: "Final completion audit is older than the latest verifier result.",
    };
  }

  return { ok: true, reason: "Final completion audit passed after latest verifier evidence." };
}

function buildEvidencePlanTaskPrompt(run: GoalRun): string {
  const plannedItems = unsatisfiedGoalEvidencePlanItems(run)
    .map(
      (item) =>
        `- ${item.label} (${item.mechanism}): ${item.description}${item.command ? `; candidate command: ${item.command}` : ""}${item.path ? `; artifact: ${item.path}` : ""}`,
    )
    .join("\n");
  return (
    `Goal: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Turn the planned proof paths below into real local/free verification capability before the Goal verifier runs. For each path, preserve the orchestrator's goal-specific sensory intent: what experience is being observed, what failure it catches, and what signal proves it.\n` +
    `${plannedItems}\n\n` +
    `Inventory available local capabilities without anchoring on any fixed tool category. Build only the proportional instrument needed for this proof path, update the Goal evidence_plan/harness/verifier metadata with the goals tool, and persist concrete command/file/artifact/log evidence that the instrument works. If the verifier artifact exists only in your isolated worker worktree, set verifier_cwd to that worktree path when recording the verifier; otherwise copy/integrate the verifier artifact into the main checkout before using a main-checkout-relative command. Do not use narrative-only verification or human visual inspection as completion evidence. Only block with exact user instructions for inputs that cannot be generated or checked locally.`
  );
}

function buildVerifierTaskPrompt(run: GoalRun): string {
  return (
    `Goal: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Define and build a real end-to-end verifier for this Goal. Begin from the intended experience and required senses/signals already implied by the success criteria and evidence plan, including mandatory Goal references. Choose a proportional local/free verifier that observes those signals and catches the important goal-specific failures; do not add generic simulations, screenshots, benchmarks, or scripts unless they directly support that proof. Update the Goal with a verifier_command, verifier_description, and verifier_cwd when the command must run from an isolated worker worktree. The verifier must be runnable locally/free and produce durable command or file evidence, not narrative or human visual inspection. If an external prerequisite is missing, mark it missing with exact user instructions.`
  );
}

function buildApplyIntegrationToMainTaskPrompt(run: GoalRun): string {
  const integrationTasks = pendingWorktreeIntegrationTasks(run)
    .map(
      (task) =>
        `- ${task.id} / ${task.title}: worktree=${task.worktree?.path ?? "unknown"}; branch=${task.worktree?.branchName ?? "unknown"}; base=${task.worktree?.baseRef ?? "unknown"}; summary=${task.lastSummary?.slice(0, 600) ?? "none"}`,
    )
    .join("\n");
  return (
    `Goal: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Apply accepted integration worktree changes into the user's main checkout before any release, verifier, final audit, or completion. This task intentionally runs in the main checkout, not a new isolated worktree.\n\n` +
    `Integrated candidate worker outputs to apply:\n${integrationTasks || "- none recorded"}\n\n` +
    `For each integrated worktree, inspect its candidate packet, patch, diffstat, changed files, base SHA, verification logs, and risk notes. Apply or port only accepted changes to the main checkout; reject stale/risky/unrelated artifacts with durable evidence. Preserve user work. Run targeted checks in the main checkout after applying. Record durable evidence with label "Integrated worktree applied to main" containing the source worktree(s), accepted/rejected artifacts, changed files, diffstat, commands/results, and restart-needed note. The orchestrator will deterministically commit/confirm accepted changes after this worker exits. Do not mark the whole Goal complete.`
  );
}

function incompleteTasks(run: GoalRun): GoalTask[] {
  return run.tasks.filter((task) => task.status !== "done");
}

function activeTask(run: GoalRun): GoalTask | undefined {
  return run.tasks.find((task) => task.status === "running" || task.status === "verifying");
}

function recoverableTask(task: GoalTask): boolean {
  return task.status === "pending" || task.status === "failed";
}

function existingTaskWithTitle(run: GoalRun, title: string): GoalTask | undefined {
  return run.tasks.find((task) => task.title === title);
}

function existingBlockedTaskWithTitle(run: GoalRun, title: string): GoalTask | undefined {
  return run.tasks.find((task) => task.title === title && task.status === "blocked");
}

function reconcileExistingAutoTaskDecision(task: GoalTask, reason: string): GoalControllerDecision {
  if (task.status === "running" || task.status === "verifying") {
    return {
      kind: "wait",
      reason: `Goal auto-task "${task.title}" already exists and is ${task.status}; ${reason}`,
      ...(task.workerId ? { workerId: task.workerId } : {}),
    };
  }
  if (task.status === "pending" || task.status === "failed") {
    return {
      kind: "start_worker",
      task,
      attempts: task.attempts + 1,
      reason: `Goal auto-task "${task.title}" already exists; reusing it instead of creating a duplicate. ${reason}`,
    };
  }
  return {
    kind: "blocked",
    reason: `Goal auto-task "${task.title}" already exists with status ${task.status}; not creating a duplicate. Reconcile its evidence or update the existing task before continuing. ${reason}`,
  };
}

function duplicateAutoTaskDecision(
  run: GoalRun,
  title: string,
  reason: string,
): GoalControllerDecision | undefined {
  const existingTask = existingTaskWithTitle(run, title);
  return existingTask ? reconcileExistingAutoTaskDecision(existingTask, reason) : undefined;
}

function taskMatchesDependency(task: GoalTask, dependencyId: string): boolean {
  return task.id === dependencyId || task.id.startsWith(dependencyId);
}

function blockedTaskDependencies(run: GoalRun, task: GoalTask): string[] {
  return (task.dependsOn ?? []).filter((dependencyId) => {
    const dependency = run.tasks.find((item) => taskMatchesDependency(item, dependencyId));
    return dependency === undefined || dependency.status !== "done";
  });
}

function nextRunnableTask(run: GoalRun): GoalTask | undefined {
  return run.tasks.find(
    (task) => recoverableTask(task) && blockedTaskDependencies(run, task).length === 0,
  );
}

function nextBlockedDependencyTask(
  run: GoalRun,
): { task: GoalTask; dependencies: string[] } | undefined {
  for (const task of run.tasks) {
    if (!recoverableTask(task)) continue;
    const dependencies = blockedTaskDependencies(run, task);
    if (dependencies.length > 0) return { task, dependencies };
  }
  return undefined;
}

export function canCompleteGoalRun(run: GoalRun): GoalCompletionCheck {
  if (run.status === "draft") {
    return { ok: false, reason: "Goal setup is incomplete and remains draft." };
  }
  if (run.successCriteria.length === 0) {
    return { ok: false, reason: "Goal setup is incomplete: success criteria are required." };
  }
  if (run.evidencePlan.length === 0) {
    return { ok: false, reason: "Goal setup is incomplete: an evidence plan is required." };
  }
  if (!run.verifier?.command) {
    return { ok: false, reason: "Goal setup is incomplete: verifier command is required." };
  }
  const promptDurabilityFailure = goalPromptDurabilityFailure(run);
  if (promptDurabilityFailure) return { ok: false, reason: promptDurabilityFailure };
  const unacknowledgedReferences = unacknowledgedGoalReferences(run);
  if (unacknowledgedReferences.length > 0) {
    return {
      ok: false,
      reason: `Goal references are not covered by criteria/tasks/evidence/verifier/audit: ${unacknowledgedReferences.map((item) => item.label).join(", ")}.`,
    };
  }
  if (goalHasBlockingPrerequisites(run)) {
    return { ok: false, reason: formatGoalBlockingPrerequisites(run) };
  }

  const remainingTasks = incompleteTasks(run);
  if (remainingTasks.length > 0) {
    return {
      ok: false,
      reason: `${remainingTasks.length} Goal task${remainingTasks.length === 1 ? " is" : "s are"} not done.`,
    };
  }

  const requiredEvidence = hasRequiredGoalEvidence(run);
  if (!requiredEvidence.ok) return requiredEvidence;

  if (hasIntegratedWorktreeChanges(run) && !integrationCommitted(run)) {
    return {
      ok: false,
      reason: "Integrated Goal changes have not been committed in the main checkout.",
    };
  }

  const verifierResult = run.verifier?.lastResult;
  if (!verifierResult) {
    return { ok: false, reason: "Goal has no verifier evidence." };
  }
  if (verifierResult.status !== "pass") {
    return { ok: false, reason: `Verifier status is ${verifierResult.status}.` };
  }

  const completionAudit = hasFreshGoalCompletionAudit(run);
  if (!completionAudit.ok) return completionAudit;

  return {
    ok: true,
    reason: "All tasks are done, verifier evidence passed, and final completion audit passed.",
  };
}

export function shouldClearGoalContinuation(decision: GoalControllerDecision): boolean {
  return decision.kind !== "wait";
}

export function shouldCreateVerifierFixTask(
  run: GoalRun,
  limit = DEFAULT_GOAL_VERIFIER_FIX_LIMIT,
): boolean {
  return run.tasks.filter((task) => task.title === "Fix verifier failure").length < limit;
}

export function verifierFixTaskCount(run: GoalRun): number {
  return run.tasks.filter((task) => task.title === "Fix verifier failure").length;
}

export function hasRepeatedVerifierFailure(run: GoalRun, repeatLimit = 2): boolean {
  const failures = run.evidence
    .filter((item) => item.label === "Verifier fail" || item.label === "Verifier result")
    .map((item) => (item.content ?? "").trim())
    .filter(Boolean);
  if (failures.length < repeatLimit) return false;
  const last = failures[failures.length - 1];
  return failures.slice(-repeatLimit).every((item) => item === last);
}

function buildFinalCompletionAuditTaskPrompt(run: GoalRun): string {
  const verifier = run.verifier?.lastResult;
  const evidencePlanItems = run.evidencePlan
    .map(
      (item) =>
        `- ${item.id} / ${item.label} (${item.status}, ${item.mechanism}): ${item.description}${item.command ? `; command=${item.command}` : ""}${item.path ? `; path=${item.path}` : ""}${item.evidence ? `; evidence=${item.evidence}` : ""}`,
    )
    .join("\n");
  const recentEvidence = run.evidence
    .slice(-12)
    .map(
      (item) =>
        `- ${item.createdAt} ${item.label}${item.path ? ` (${item.path})` : ""}: ${(item.content ?? "").slice(0, 320)}`,
    )
    .join("\n");
  return (
    `Goal: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `You are the final read-only Goal completion auditor. Do not edit files, do not run broad implementation work, do not mark the Goal complete, and do not trust worker summaries by themselves. Verify the original success criteria and every mandatory Goal reference against actual durable artifacts after the latest verifier pass.\n\n` +
    `Success criteria:\n${run.successCriteria.map((item) => `- ${item}`).join("\n") || "- none recorded"}\n\n` +
    `Latest verifier: status=${verifier?.status ?? "unknown"}; checkedAt=${verifier?.checkedAt ?? "unknown"}; command=${verifier?.command ?? run.verifier?.command ?? "not recorded"}; output=${verifier?.outputPath ?? "not recorded"}; summary=${verifier?.summary ?? "not recorded"}\n\n` +
    `Evidence plan:\n${evidencePlanItems || "- none"}\n\n` +
    `Recent durable evidence:\n${recentEvidence || "- none"}\n\n` +
    `Read the referenced report/log/source artifacts and compare them with the latest verifier result. The coordinator schedules and records decisions/state; the verifier path/UI/controller executes the configured verifier command as the final pre-audit gate and records goals verify evidence; this final audit records goals audit only after comparing the latest verifier output and references, including [original-goal-prompt] and durable GOAL_PLAN evidence. If an evidence-plan item is still planned but already matched by durable verifier/source/file evidence, update that evidence_plan item to status=ready with a concise evidence summary before recording the audit; if proof is missing, create a new pending Goal task with exact fix instructions and do not pass the audit. If everything matches, record a passing completion audit with the goals tool using action=audit and verification_status=pass: write a plain-prose summary of which durable artifacts you compared and reference any mandatory non-prompt Goal references (and, when this Goal uses GOAL_PLAN planning, mention original-goal-prompt and GOAL_PLAN). The system auto-stamps FINAL_AUDIT_PASS and verifier_checked_at and fills output_path from the recorded verifier run, so do not transcribe the timestamp; any remaining contract gaps are returned all at once. If anything is missing, stale, contradictory, or unverified, create a new pending Goal task with exact instructions to fix it, record evidence describing the mismatch, and leave the audit failing or absent so the coordinator resumes a worker until fixed.`
  );
}

function buildVerifierFailureTaskPrompt(run: GoalRun): string {
  const result = run.verifier?.lastResult;
  const priorSummaries =
    run.evidence
      .filter((item) => item.label.startsWith("Verifier"))
      .slice(-3)
      .map(
        (item) =>
          `- ${item.label}${item.path ? ` (${item.path})` : ""}: ${(item.content ?? "").slice(0, 500)}`,
      )
      .join("\n") || "- none";
  const attempt = verifierFixTaskCount(run) + 1;
  return (
    `Original objective: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Success criteria:\n${run.successCriteria.map((item) => `- ${item}`).join("\n") || "- none recorded"}\n\n` +
    `Verifier command: ${run.verifier?.command ?? "(missing)"}\n` +
    `Exit code: ${result?.exitCode ?? "unknown"}\n` +
    `Output path: ${result?.outputPath ?? "not recorded"}\n` +
    `Fix attempt ${attempt}/${DEFAULT_GOAL_VERIFIER_FIX_LIMIT}.\n\n` +
    `Prior verifier summaries:\n${priorSummaries}\n\n` +
    `Run targeted diagnostics, fix the root cause, update durable Goal evidence with the goals tool, and rerun the exact verifier command. Do not mark the Goal complete.`
  );
}

function buildResolveLocalPrerequisitesTaskPrompt(run: GoalRun): string {
  const items = unmetLocalGoalPrerequisites(run)
    .map(
      (item) =>
        `- ${item.label} (${item.status})${item.checkCommand ? `; check: ${item.checkCommand}` : ""}${item.instructions ? `; instructions: ${item.instructions}` : ""}`,
    )
    .join("\n");
  return (
    `Goal: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Resolve the following local Goal prerequisites so the Goal can proceed unattended. These are not user-supplied external inputs; satisfy each one locally with free tools.\n\n` +
    `${items || "- none recorded"}\n\n` +
    `For each prerequisite, make its check pass locally (install/configure/build as needed using local/free tooling), then record durable evidence and update the prerequisite to status=met with the goals tool (action="prerequisite"). If a prerequisite turns out to genuinely require user-supplied external input, mark it kind=external with exact user instructions instead of guessing.`
  );
}

function isReStrategizeTask(task: GoalTask): boolean {
  return task.title.startsWith(RE_STRATEGIZE_GOAL_TASK_TITLE);
}

export function goalStrategyTaskCount(run: GoalRun): number {
  return run.tasks.filter(isReStrategizeTask).length;
}

function workerEvidenceContentsForTask(run: GoalRun, task: GoalTask): string[] {
  if (!task.workerId) return [];
  return run.evidence
    .filter((item) => {
      const match = /^Worker\s+(\S+)\s+/.exec(item.label);
      return match?.[1] === task.workerId;
    })
    .map((item) => (item.content ?? "").trim())
    .filter(Boolean);
}

/**
 * No-progress signal for an implementation task: the latest two worker evidence
 * contents for the task's worker are identical, so re-running the same approach
 * is unlikely to make progress.
 */
export function taskFailureRepeatedWithoutProgress(run: GoalRun, task: GoalTask): boolean {
  const contents = workerEvidenceContentsForTask(run, task);
  if (contents.length < 2) return false;
  return contents[contents.length - 1] === contents[contents.length - 2];
}

function buildReStrategizeTaskPrompt(run: GoalRun, focus?: GoalTask): string {
  const priorContents = focus
    ? workerEvidenceContentsForTask(run, focus)
    : run.evidence
        .filter((item) => item.label.startsWith("Verifier"))
        .map((item) => (item.content ?? "").trim())
        .filter(Boolean);
  const priorSummaries = priorContents
    .slice(-3)
    .map((content) => `- ${content.slice(0, 500)}`)
    .join("\n");
  const what = focus ? `task "${focus.title}" (${focus.id})` : "the configured verifier";
  return (
    `Original objective: ${run.goal}\n\n` +
    referencePromptSection(run.references) +
    `Prior attempts at ${what} repeatedly failed without progress.\n\n` +
    `Prior attempt summaries:\n${priorSummaries || "- none recorded"}\n\n` +
    `Analyze why the prior attempts failed, then take a fundamentally different approach to accomplish the original objective. Do not repeat the same strategy. Use local/free tools, record durable evidence with the goals tool, and update task status.${focus ? ` When you accomplish the objective, also mark the original failing task ${focus.id} done with the goals tool so the Goal can proceed.` : ""} If the objective genuinely requires user-supplied external input, record it as an external prerequisite with exact instructions.`
  );
}

/**
 * Bounded re-strategy escalation: run an existing recoverable re-strategy task,
 * else create one (up to the strategy limit), else terminate the run in
 * `failed` with a structured diagnosis brief. Replaces the former pause/block
 * dead-ends so the loop always either changes state or resolves.
 */
function reStrategizeOrFailDecision(
  run: GoalRun,
  options: GoalControllerOptions,
  context: { focus?: GoalTask; startReason: string; failReason: string },
): GoalControllerDecision {
  const attemptLimit = options.taskAttemptLimit ?? DEFAULT_GOAL_TASK_ATTEMPT_LIMIT;
  // Run an existing recoverable re-strategy task, but only while it still has
  // attempt budget left, so a perpetually-failing strategy task cannot loop.
  const recoverableStrategy = run.tasks.find(
    (item) => isReStrategizeTask(item) && recoverableTask(item) && item.attempts < attemptLimit,
  );
  if (recoverableStrategy) {
    return {
      kind: "start_worker",
      task: recoverableStrategy,
      attempts: recoverableStrategy.attempts + 1,
      reason: context.startReason,
    };
  }
  const strategyLimit = options.strategyLimit ?? DEFAULT_GOAL_STRATEGY_LIMIT;
  const strategyCount = goalStrategyTaskCount(run);
  if (strategyCount < strategyLimit) {
    // Distinct titles per attempt so the orchestrator creates a fresh task
    // instead of reusing an exhausted same-title one.
    const title =
      strategyCount === 0
        ? RE_STRATEGIZE_GOAL_TASK_TITLE
        : `${RE_STRATEGIZE_GOAL_TASK_TITLE} (${strategyCount + 1})`;
    return {
      kind: "create_task",
      title,
      prompt: buildReStrategizeTaskPrompt(run, context.focus),
      reason: `${context.startReason} (${strategyCount + 1}/${strategyLimit})`,
    };
  }
  return {
    kind: "terminal",
    status: "failed",
    reason: buildGoalFailureDiagnosis(run, context.failReason),
  };
}

/**
 * Structured diagnosis brief recorded when a Goal terminates in `failed` so the
 * run ends resolved (not spinning, not silently paused) with an honest verdict.
 */
export function buildGoalFailureDiagnosis(run: GoalRun, reason: string): string {
  const attempts = run.tasks
    .map(
      (task) =>
        `- ${task.title} (${task.id}): status=${task.status}; attempts=${task.attempts}${task.lastSummary ? `; last=${task.lastSummary.slice(0, 240)}` : ""}`,
    )
    .join("\n");
  const failureSignatures = Array.from(
    new Set(
      run.evidence
        .filter((item) => item.label === "Verifier fail" || item.label === "Verifier result")
        .map((item) => (item.content ?? "").trim())
        .filter(Boolean),
    ),
  )
    .slice(-5)
    .map((signature) => `- ${signature.slice(0, 240)}`)
    .join("\n");
  const verifier = run.verifier?.lastResult;
  const externalNeeds = run.prerequisites
    .filter((item) => (item.status !== "met" || !item.evidence?.trim()) && item.kind === "external")
    .map((item) => `- ${item.label}: ${item.instructions ?? "user-supplied input required"}`)
    .join("\n");
  return [
    "GOAL_FAILURE_DIAGNOSIS",
    `objective=${run.goal}`,
    `reason=${reason}`,
    `tasks:\n${attempts || "- none"}`,
    `distinct_failure_signatures:\n${failureSignatures || "- none"}`,
    `latest_verifier=${verifier ? `${verifier.status} (exit ${verifier.exitCode ?? "unknown"}): ${verifier.summary?.slice(0, 240) ?? ""}` : "none"}`,
    `human_decision_needed:\n${externalNeeds || "- none"}`,
  ].join("\n");
}

export function formatGoalControllerDecision(decision: GoalControllerDecision): {
  label: string;
  content: string;
} {
  const parts = [`kind=${decision.kind}`];
  if ("reason" in decision) parts.push(`reason=${decision.reason}`);
  if (decision.kind === "start_worker") {
    parts.push(
      `task=${decision.task.id}`,
      `title=${decision.task.title}`,
      `attempts=${decision.attempts}`,
    );
    if (decision.task.workerId) parts.push(`worker=${decision.task.workerId}`);
    if (decision.task.dependsOn?.length)
      parts.push(`depends_on=${decision.task.dependsOn.join(",")}`);
    if (decision.task.parallelGroup) parts.push(`parallel_group=${decision.task.parallelGroup}`);
    if (decision.task.expectedChangedScope?.length) {
      parts.push(`expected_changed_scope=${decision.task.expectedChangedScope.join(",")}`);
    }
    if (decision.task.integration) parts.push(`integration=${decision.task.integration}`);
  }
  if (decision.kind === "wait" && decision.workerId) parts.push(`worker=${decision.workerId}`);
  if (decision.kind === "run_verifier") parts.push(`verifier=${decision.command}`);
  if (decision.kind === "terminal") parts.push(`status=${decision.status}`);
  if (decision.kind === "create_task") parts.push(`title=${decision.title}`);
  return { label: `Goal decision: ${decision.kind}`, content: parts.join("; ") };
}

export function decideGoalNextAction(
  run: GoalRun,
  options: GoalControllerOptions = {},
): GoalControllerDecision {
  const completion = canCompleteGoalRun(run);
  if (completion.ok) {
    if (run.continueRequestedAt && run.verifier?.command) {
      return {
        kind: "run_verifier",
        command: run.verifier.command,
        reason: "Goal rerun requested; rerunning configured verifier before any new final audit.",
      };
    }
    return { kind: "complete", reason: completion.reason };
  }

  // Hard termination guarantee: if a run somehow keeps making decisions without
  // completing or hitting a narrower limit, fail with a diagnosis rather than
  // loop forever.
  const decisionLimit = options.decisionLimit ?? DEFAULT_GOAL_DECISION_LIMIT;
  if (goalDecisionCount(run) > decisionLimit) {
    return {
      kind: "terminal",
      status: "failed",
      reason: buildGoalFailureDiagnosis(
        run,
        `Goal exceeded the maximum of ${decisionLimit} controller decisions without completing; stopping to avoid an unbounded loop.`,
      ),
    };
  }

  if (goalHasBlockingPrerequisites(run)) {
    return { kind: "blocked", reason: formatGoalBlockingPrerequisites(run) };
  }

  if (
    (run.status === "blocked" && run.verifier?.lastResult?.status !== "pass") ||
    run.status === "failed" ||
    (run.status === "passed" && run.verifier?.lastResult?.status !== "pass") ||
    (run.status === "paused" && !run.continueRequestedAt)
  ) {
    return { kind: "terminal", status: run.status, reason: `Goal is ${run.status}.` };
  }

  if (run.activeWorkerId) {
    return {
      kind: "wait",
      reason: "Goal already has an active worker.",
      workerId: run.activeWorkerId,
    };
  }

  const runningTask = activeTask(run);
  if (runningTask) {
    return {
      kind: "wait",
      reason: `Goal task "${runningTask.title}" is already ${runningTask.status}.`,
      ...(runningTask.workerId ? { workerId: runningTask.workerId } : {}),
    };
  }

  if (goalHasUnmetLocalPrerequisites(run)) {
    const duplicateDecision = duplicateAutoTaskDecision(
      run,
      RESOLVE_LOCAL_PREREQUISITES_TASK_TITLE,
      "Local Goal prerequisites must be satisfied locally before implementation.",
    );
    if (duplicateDecision) return duplicateDecision;
    return {
      kind: "create_task",
      title: RESOLVE_LOCAL_PREREQUISITES_TASK_TITLE,
      prompt: buildResolveLocalPrerequisitesTaskPrompt(run),
      reason: `Resolving ${unmetLocalGoalPrerequisites(run).length} local Goal prerequisite(s) locally instead of blocking.`,
    };
  }

  const task = nextRunnableTask(run);
  if (task) {
    const attempts = task.attempts + 1;
    const limit = options.taskAttemptLimit ?? DEFAULT_GOAL_TASK_ATTEMPT_LIMIT;
    if (attempts > limit) {
      // Past the soft attempt limit: keep retrying while the failure signature
      // keeps changing (still making progress); on a no-progress repeat,
      // re-strategize a bounded number of times, then fail with a diagnosis.
      if (!isReStrategizeTask(task) && !taskFailureRepeatedWithoutProgress(run, task)) {
        return {
          kind: "start_worker",
          task,
          attempts,
          reason: `Goal task "${task.title}" passed the soft attempt limit but is still making progress; continuing attempt ${attempts}.`,
        };
      }
      return reStrategizeOrFailDecision(run, options, {
        focus: task,
        startReason: `Re-strategizing "${task.title}" with a fundamentally different approach.`,
        failReason: `Task "${task.title}" could not be completed after ${task.attempts} attempt(s) and the bounded re-strategy limit.`,
      });
    }
    return {
      kind: "start_worker",
      task,
      attempts,
      reason: `Goal task "${task.title}" is ready for worker attempt ${attempts}.`,
    };
  }

  const dependencyBlockedTask = nextBlockedDependencyTask(run);
  if (dependencyBlockedTask) {
    const missingDependencies = dependencyBlockedTask.dependencies.filter(
      (dependencyId) => !run.tasks.some((item) => taskMatchesDependency(item, dependencyId)),
    );
    if (missingDependencies.length > 0) {
      return {
        kind: "terminal",
        status: "failed",
        reason: buildGoalFailureDiagnosis(
          run,
          `Goal task "${dependencyBlockedTask.task.title}" depends on missing task(s) that cannot be synthesized: ${missingDependencies.join(", ")}.`,
        ),
      };
    }
    return {
      kind: "wait",
      reason: `Goal task "${dependencyBlockedTask.task.title}" is waiting for dependency task(s): ${dependencyBlockedTask.dependencies.join(", ")}.`,
    };
  }

  const blockedEvidence = blockedEvidencePlanReason(run);
  if (blockedEvidence) {
    return { kind: "blocked", reason: blockedEvidence };
  }

  if (needsMainIntegrationApplyTask(run)) {
    return {
      kind: "create_task",
      title: APPLY_INTEGRATION_TO_MAIN_TASK_TITLE,
      prompt: buildApplyIntegrationToMainTaskPrompt(run),
      reason:
        "Accepted integration worktree changes must be applied to the user's main checkout before verifier, final audit, release, commit, or completion.",
    };
  }

  if (
    run.verifier?.lastResult?.status === "pass" &&
    verifierStaleAfterWorker(run) &&
    run.verifier?.command
  ) {
    return {
      kind: "run_verifier",
      command: run.verifier.command,
      reason:
        "Latest verifier result is stale after later Goal worker evidence; rerunning configured verifier as the final pre-audit gate.",
    };
  }

  if (needsEvidenceInstrumentation(run)) {
    if (run.verifier?.lastResult?.status === "pass") {
      if (shouldCreateFinalAuditTask(run)) {
        return {
          kind: "create_task",
          title: FINAL_COMPLETION_AUDIT_TASK_TITLE,
          prompt: buildFinalCompletionAuditTaskPrompt(run),
          reason: `Verifier passed; final read-only audit must reconcile ${unsatisfiedGoalEvidencePlanItems(run).length} evidence-plan item(s) before the Goal can pass (${finalAuditTaskCount(run) + 1}/${DEFAULT_GOAL_COMPLETION_AUDIT_LIMIT}).`,
        };
      }
      return {
        kind: "terminal",
        status: "failed",
        reason: buildGoalFailureDiagnosis(
          run,
          "Verifier passed, but the final completion audit could not reconcile the Goal evidence plan after bounded attempts.",
        ),
      };
    }
    const duplicateDecision = duplicateAutoTaskDecision(
      run,
      BUILD_GOAL_EVIDENCE_PATH_TASK_TITLE,
      "Goal evidence plan still requires local instrumentation or exact prerequisite handling before verification.",
    );
    if (duplicateDecision) return duplicateDecision;
    return {
      kind: "create_task",
      title: BUILD_GOAL_EVIDENCE_PATH_TASK_TITLE,
      prompt: buildEvidencePlanTaskPrompt(run),
      reason:
        "Goal evidence plan requires local instrumentation or exact prerequisite handling before verification.",
    };
  }

  if (needsHarnessInstrumentation(run)) {
    const duplicateDecision = duplicateAutoTaskDecision(
      run,
      BUILD_GOAL_VERIFICATION_HARNESS_TASK_TITLE,
      "Goal harness still requires local instrumentation before verification.",
    );
    if (duplicateDecision) return duplicateDecision;
    return {
      kind: "create_task",
      title: BUILD_GOAL_VERIFICATION_HARNESS_TASK_TITLE,
      prompt: buildHarnessTaskPrompt(run),
      reason: "Goal harness requires local instrumentation before verification.",
    };
  }

  if (run.verifier?.lastResult?.status === "fail") {
    if (hasRepeatedVerifierFailure(run)) {
      return reStrategizeOrFailDecision(run, options, {
        startReason:
          "Verifier produced the same failure repeatedly; re-strategizing with a fundamentally different approach.",
        failReason:
          "Verifier produced the same failure repeatedly and bounded re-strategy attempts were exhausted.",
      });
    }
    const limit = options.verifierFixLimit ?? DEFAULT_GOAL_VERIFIER_FIX_LIMIT;
    const blockedFixTask = existingBlockedTaskWithTitle(run, FIX_VERIFIER_FAILURE_TASK_TITLE);
    if (blockedFixTask) {
      return reStrategizeOrFailDecision(run, options, {
        startReason:
          "A blocked verifier-fix task exists; re-strategizing the verifier fix with a different approach.",
        failReason:
          "A verifier-fix task was blocked and bounded re-strategy attempts were exhausted.",
      });
    }
    if (shouldCreateVerifierFixTask(run, limit)) {
      return {
        kind: "create_task",
        title: FIX_VERIFIER_FAILURE_TASK_TITLE,
        prompt: buildVerifierFailureTaskPrompt(run),
        reason: `Verifier failed; creating bounded fix task ${verifierFixTaskCount(run) + 1}/${limit}.`,
      };
    }
    return {
      kind: "terminal",
      status: "failed",
      reason: buildGoalFailureDiagnosis(
        run,
        `Verifier failed and the bounded verifier-fix limit (${limit}) was reached without a pass.`,
      ),
    };
  }

  if (run.verifier?.lastResult?.status === "pass") {
    if (shouldCreateFinalAuditTask(run)) {
      return {
        kind: "create_task",
        title: FINAL_COMPLETION_AUDIT_TASK_TITLE,
        prompt: buildFinalCompletionAuditTaskPrompt(run),
        reason: `Verifier passed; creating final read-only completion audit before the Goal can pass (${finalAuditTaskCount(run) + 1}/${DEFAULT_GOAL_COMPLETION_AUDIT_LIMIT}).`,
      };
    }
    return {
      kind: "terminal",
      status: "failed",
      reason: buildGoalFailureDiagnosis(
        run,
        "Verifier passed, but the final completion audit did not pass after bounded attempts.",
      ),
    };
  }

  if (run.verifier?.command) {
    return {
      kind: "run_verifier",
      command: run.verifier.command,
      reason: "All Goal tasks are done; running configured verifier for real completion evidence.",
    };
  }

  const duplicateDecision = duplicateAutoTaskDecision(
    run,
    DEFINE_GOAL_VERIFIER_TASK_TITLE,
    "No verifier command is configured yet.",
  );
  if (duplicateDecision) return duplicateDecision;
  return {
    kind: "create_task",
    title: DEFINE_GOAL_VERIFIER_TASK_TITLE,
    prompt: buildVerifierTaskPrompt(run),
    reason: "No pending Goal task or verifier command is configured.",
  };
}
