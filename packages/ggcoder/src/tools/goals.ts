import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../core/logger.js";
import {
  canCompleteGoalRun,
  decideGoalNextAction,
  hasFreshGoalCompletionAudit,
} from "../core/goal-controller.js";
import { runGoalPrerequisiteCheckCommand } from "../core/goal-prerequisites.js";
import {
  appendGoalBlockers,
  appendGoalDecision,
  appendGoalEvidence,
  createGoalEvidence,
  formatGoalBlockingPrerequisiteList,
  formatGoalBlockingPrerequisites,
  getActiveGoalRun,
  getGoalRun,
  goalHasBlockingPrerequisites,
  loadGoalRuns,
  upsertGoalRun,
  updateGoalTask,
  type GoalEvidenceKind,
  type GoalEvidenceMechanism,
  type GoalPrerequisiteStatus,
  type GoalReference,
  type GoalRun,
  type GoalRunStatus,
  type GoalTaskMergeStrategy,
  type GoalTaskStatus,
  type GoalVerificationStatus,
} from "../core/goal-store.js";
import { referencesRequiringAcknowledgement } from "../core/goal-references.js";
import { getActiveGoalMode, type GoalMode } from "../core/runtime-mode.js";

const PrerequisiteInput = z.object({
  id: z.string().optional().describe("Stable prerequisite id"),
  label: z.string().describe("Human-readable prerequisite label"),
  status: z.enum(["unknown", "met", "missing"]).optional(),
  kind: z
    .enum(["local", "external"])
    .optional()
    .describe(
      "'local' = agent can satisfy it locally (default when check_command is set); 'external' = genuinely user-supplied input (paid creds, secrets, approvals, devices) that blocks the Goal. Reserve 'external' for true user prerequisites.",
    ),
  check_command: z.string().optional().describe("Optional command used to check this prerequisite"),
  instructions: z.string().optional().describe("What the user must provide when missing"),
  evidence: z.string().optional().describe("Short evidence, never secret values"),
});

const HarnessInput = z.object({
  id: z.string().optional().describe("Stable harness item id"),
  label: z.string().describe("Harness/diagnostic label"),
  command: z.string().optional().describe("Command that runs this harness item"),
  path: z.string().optional().describe("File path for a harness artifact"),
  description: z.string().optional().describe("What this harness observes or verifies"),
});

const EvidencePlanInput = z.object({
  id: z.string().optional().describe("Stable evidence-plan item id"),
  label: z.string().describe("Short evidence path label"),
  mechanism: z
    .enum([
      "command",
      "test",
      "script",
      "fixture",
      "log",
      "screenshot",
      "video",
      "browser",
      "device",
      "source",
      "file",
      "manual",
    ])
    .describe("How this proof will be gathered"),
  description: z.string().describe("What this evidence proves"),
  status: z.enum(["planned", "ready", "blocked"]).optional(),
  command: z.string().optional().describe("Runnable command when available"),
  path: z.string().optional().describe("Artifact path when available"),
  instructions: z.string().optional().describe("Exact user instructions when blocked"),
  evidence: z.string().optional().describe("Observed evidence summary when ready"),
});

const GoalsParams = z.object({
  action: z
    .enum([
      "create",
      "prerequisite",
      "task",
      "evidence",
      "evidence_plan",
      "verify",
      "audit",
      "status",
      "pause",
      "resume",
      "complete",
    ])
    .describe("Goal action to perform"),
  run_id: z.string().optional().describe("Goal run id; omitted actions use the active/latest run"),
  title: z.string().optional().describe("Goal or task title"),
  goal: z.string().optional().describe("Original user objective for create"),
  success_criteria: z
    .array(z.string())
    .optional()
    .describe("Concrete criteria that must be proven before completion"),
  prerequisites: z
    .array(PrerequisiteInput)
    .optional()
    .describe("Prerequisites that must be met before launching workers"),
  prerequisite_id: z.string().optional().describe("Prerequisite id to update"),
  prerequisite_status: z
    .enum(["unknown", "met", "missing"])
    .optional()
    .describe("Updated prerequisite status"),
  prerequisite_label: z.string().optional().describe("Label for an added/updated prerequisite"),
  instructions: z.string().optional().describe("User-facing instructions for missing prerequisite"),
  harness: z.array(HarnessInput).optional().describe("Harness/diagnostic commands and files"),
  evidence_plan: z
    .array(EvidencePlanInput)
    .optional()
    .describe("Planned proof paths for end-to-end verification"),
  evidence_plan_item_id: z.string().optional().describe("Evidence-plan item id to update"),
  evidence_plan_status: z
    .enum(["planned", "ready", "blocked"])
    .optional()
    .describe("Updated evidence-plan item status"),
  evidence: z.string().optional().describe("Observed evidence summary for an evidence-plan update"),
  path: z.string().optional().describe("Artifact path for an evidence-plan update"),
  verifier_command: z.string().optional().describe("Command that verifies the goal end-to-end"),
  verifier_description: z.string().optional().describe("Natural-language verifier description"),
  verifier_cwd: z
    .string()
    .optional()
    .describe(
      "Working directory for the verifier command; use a worker worktree path only when the verifier artifact lives there",
    ),
  task_id: z.string().optional().describe("Goal task id to update"),
  task_title: z.string().optional().describe("Short worker task title"),
  task_prompt: z
    .string()
    .optional()
    .describe("Standalone prompt for a disposable Goal worker in this same project"),
  task_status: z
    .enum(["pending", "running", "verifying", "done", "failed", "blocked"])
    .optional()
    .describe("Goal task status"),
  depends_on: z
    .array(z.string())
    .optional()
    .describe("Task ids that must be done before this task can start"),
  parallel_group: z
    .string()
    .optional()
    .describe("Coordinator-defined batch/group for tasks that may run in parallel"),
  expected_changed_scope: z
    .array(z.string())
    .optional()
    .describe("Expected file paths or globs this task is allowed or expected to change"),
  merge_strategy: z
    .enum(["parallel_candidate", "after_dependencies", "serial", "manual"])
    .optional()
    .describe("How the coordinator should integrate this task's candidate changes"),
  worker_id: z.string().optional().describe("Worker id associated with a task"),
  attempts: z.number().int().min(0).optional().describe("Task attempt count"),
  summary: z.string().optional().describe("Short summary or verification note"),
  evidence_kind: z
    .enum(["log", "command", "screenshot", "file", "summary"])
    .optional()
    .describe("Evidence kind"),
  evidence_label: z.string().optional().describe("Evidence label"),
  evidence_path: z.string().optional().describe("Evidence file/log/screenshot path"),
  evidence_content: z.string().optional().describe("Short evidence content"),
  verification_status: z
    .enum(["pass", "fail", "unknown"])
    .optional()
    .describe("Verifier result status"),
  exit_code: z.number().int().optional().describe("Verifier command exit code"),
  output_path: z.string().optional().describe("Path to verifier output/log"),
  blockers: z.array(z.string()).optional().describe("Current blockers"),
});

function asPrerequisiteStatus(value: string | undefined): GoalPrerequisiteStatus {
  if (value === "met" || value === "missing" || value === "unknown") return value;
  return "unknown";
}

function requiresPrerequisiteCheck(
  status: GoalPrerequisiteStatus,
  evidence: string | undefined,
): boolean {
  return status === "unknown" || (status === "met" && !evidence?.trim());
}

function uncheckedPrerequisiteInstructions(label: string): string {
  return `Check ${label} locally and record non-secret evidence before workers can start.`;
}

async function normalizePrerequisiteInput(
  cwd: string,
  item: z.infer<typeof PrerequisiteInput>,
): Promise<GoalRun["prerequisites"][number]> {
  const requestedStatus = asPrerequisiteStatus(item.status);
  const id = item.id ?? randomUUID();
  const kindField = item.kind ? { kind: item.kind } : {};
  if (item.check_command && requiresPrerequisiteCheck(requestedStatus, item.evidence)) {
    const result = await runGoalPrerequisiteCheckCommand({ cwd, command: item.check_command });
    return {
      id,
      label: item.label,
      status: result.status,
      ...kindField,
      checkCommand: item.check_command,
      evidence: result.evidence,
      ...(result.status === "missing" || item.instructions
        ? { instructions: item.instructions ?? `Make \`${item.check_command}\` pass locally.` }
        : {}),
    };
  }
  return {
    id,
    label: item.label,
    status: requestedStatus,
    ...kindField,
    ...(item.check_command ? { checkCommand: item.check_command } : {}),
    ...(item.instructions ? { instructions: item.instructions } : {}),
    ...(item.evidence ? { evidence: item.evidence } : {}),
    ...(requiresPrerequisiteCheck(requestedStatus, item.evidence) && !item.instructions
      ? { instructions: uncheckedPrerequisiteInstructions(item.label) }
      : {}),
  };
}

function asTaskStatus(value: string | undefined): GoalTaskStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "verifying" ||
    value === "done" ||
    value === "failed" ||
    value === "blocked"
  ) {
    return value;
  }
  return "pending";
}

function asTaskMergeStrategy(value: string | undefined): GoalTaskMergeStrategy | undefined {
  if (
    value === "parallel_candidate" ||
    value === "after_dependencies" ||
    value === "serial" ||
    value === "manual"
  ) {
    return value;
  }
  return undefined;
}

function asEvidenceKind(value: string | undefined): GoalEvidenceKind {
  if (
    value === "log" ||
    value === "command" ||
    value === "screenshot" ||
    value === "file" ||
    value === "summary"
  ) {
    return value;
  }
  return "summary";
}

function asEvidencePlanStatus(
  value: string | undefined,
): GoalRun["evidencePlan"][number]["status"] {
  if (value === "ready" || value === "blocked" || value === "planned") return value;
  return "planned";
}

function asEvidenceMechanism(value: string | undefined): GoalEvidenceMechanism {
  if (
    value === "command" ||
    value === "test" ||
    value === "script" ||
    value === "fixture" ||
    value === "log" ||
    value === "screenshot" ||
    value === "video" ||
    value === "browser" ||
    value === "device" ||
    value === "source" ||
    value === "file" ||
    value === "manual"
  ) {
    return value;
  }
  return "command";
}

function asVerificationStatus(value: string | undefined): GoalVerificationStatus {
  if (value === "pass" || value === "fail" || value === "unknown") return value;
  return "unknown";
}

function formatRun(run: GoalRun): string {
  const prereqs = run.prerequisites.length
    ? `${run.prerequisites.filter((item) => item.status === "met").length}/${run.prerequisites.length} prereqs met`
    : "no prereqs";
  const tasks = run.tasks.length
    ? `${run.tasks.filter((item) => item.status === "done").length}/${run.tasks.length} tasks done`
    : "no tasks";
  const verifier = run.verifier?.lastResult
    ? `verifier ${run.verifier.lastResult.status}`
    : run.verifier?.command
      ? "verifier configured"
      : "no verifier";
  const refs = run.references?.length ? `, ${run.references.length} reference(s)` : "";
  const audit = run.completionAudit
    ? `, final audit ${run.completionAudit.status}`
    : run.verifier?.lastResult?.status === "pass"
      ? ", final audit missing"
      : "";
  const blocker = goalHasBlockingPrerequisites(run)
    ? `\nUser prerequisites: ${formatGoalBlockingPrerequisites(run)}`
    : "";
  return `[${run.status}] ${run.title} (id: ${run.id.slice(0, 8)}) — ${prereqs}, ${tasks}, ${verifier}${refs}${audit}${blocker}`;
}

function recoverableTaskStatus(status: GoalTaskStatus): boolean {
  return status === "pending" || status === "failed";
}

function statusAfterTaskPatch(run: GoalRun, status: GoalTaskStatus): GoalRunStatus {
  if ((run.status !== "failed" && run.status !== "passed") || !recoverableTaskStatus(status)) {
    return run.status;
  }
  return goalHasBlockingPrerequisites(run) ? "blocked" : "ready";
}

function resolveTaskDependencyIds(
  run: GoalRun,
  dependencies: readonly string[] | undefined,
  currentTaskId: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!dependencies) return { ok: true, value: [] };

  const resolved: string[] = [];
  for (const dependency of dependencies) {
    const trimmed = dependency.trim();
    if (!trimmed) continue;

    const matches = run.tasks.filter(
      (task) =>
        task.id !== currentTaskId &&
        (task.id === trimmed || task.id.startsWith(trimmed) || task.title === trimmed),
    );
    if (matches.length === 0) {
      return {
        ok: false,
        error: `depends_on entry "${trimmed}" does not match an existing task id/prefix. Add dependency tasks first, then reference their id.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `depends_on entry "${trimmed}" is ambiguous; use a full task id.`,
      };
    }
    const id = matches[0]?.id;
    if (id && !resolved.includes(id)) resolved.push(id);
  }

  return { ok: true, value: resolved };
}

const SETUP_BLOCKER_PREFIX = "Goal setup incomplete:";

function referenceMentionTokens(reference: GoalReference): string[] {
  return [reference.id, reference.label, reference.value, reference.path]
    .filter((token): token is string => !!token?.trim())
    .map((token) => token.toLowerCase());
}

function unacknowledgedReferences(
  references: readonly GoalReference[] | undefined,
  fields: readonly string[],
): GoalReference[] {
  const haystack = fields.join("\n").toLowerCase();
  return referencesRequiringAcknowledgement(references ?? []).filter(
    (reference) => !referenceMentionTokens(reference).some((token) => haystack.includes(token)),
  );
}

function referencesAcknowledged(
  references: readonly GoalReference[] | undefined,
  fields: readonly string[],
): boolean {
  return unacknowledgedReferences(references, fields).length === 0;
}

function hasOriginalGoalPromptReference(references: readonly GoalReference[] | undefined): boolean {
  return (references ?? []).some(
    (reference) =>
      reference.id === "original-goal-prompt" &&
      reference.kind === "prompt" &&
      reference.content?.trim(),
  );
}

function setupBlockersForRun(run: {
  successCriteria: readonly string[];
  evidencePlan: readonly GoalRun["evidencePlan"][number][];
  verifier?: GoalRun["verifier"];
  references?: readonly GoalReference[];
  tasks: readonly GoalRun["tasks"][number][];
  evidence?: readonly GoalRun["evidence"][number][];
  goal?: string;
}): string[] {
  const blockers: string[] = [];
  const contractFields = [
    run.goal ?? "",
    ...run.successCriteria,
    ...(run.references ?? []).map(
      (reference) => `${reference.id} ${reference.label} ${reference.content ?? ""}`,
    ),
    ...(run.evidence ?? []).map(
      (item) => `${item.label}\n${item.path ?? ""}\n${item.content ?? ""}`,
    ),
  ].join("\n");
  const requiresReliabilityContract = /GOAL_PLAN/.test(contractFields);
  if (requiresReliabilityContract && !hasOriginalGoalPromptReference(run.references)) {
    blockers.push(`${SETUP_BLOCKER_PREFIX} durable [original-goal-prompt] reference is required.`);
  }
  const plannerFields = [
    run.goal ?? "",
    ...(run.evidence ?? []).map(
      (item) => `${item.label}\n${item.path ?? ""}\n${item.content ?? ""}`,
    ),
  ].join("\n");
  if (
    requiresReliabilityContract &&
    (!/GOAL_PLAN/.test(plannerFields) ||
      !/research=/.test(plannerFields) ||
      !/success=/.test(plannerFields))
  ) {
    blockers.push(`${SETUP_BLOCKER_PREFIX} durable planner GOAL_PLAN evidence/state is required.`);
  }
  if (run.successCriteria.length === 0)
    blockers.push(`${SETUP_BLOCKER_PREFIX} success criteria are required.`);
  if (run.evidencePlan.length === 0)
    blockers.push(`${SETUP_BLOCKER_PREFIX} evidence_plan is required.`);
  if (!run.verifier?.command)
    blockers.push(`${SETUP_BLOCKER_PREFIX} verifier_command is required.`);
  const referenceFields = [
    ...run.successCriteria,
    ...run.evidencePlan.map(
      (item) =>
        `${item.id} ${item.label} ${item.description} ${item.command ?? ""} ${item.path ?? ""} ${item.evidence ?? ""}`,
    ),
    ...run.tasks.map((task) => `${task.title} ${task.prompt}`),
    run.verifier?.description ?? "",
    run.verifier?.command ?? "",
  ];
  const missingReferences = unacknowledgedReferences(run.references, referenceFields);
  if (missingReferences.length > 0) {
    blockers.push(
      `${SETUP_BLOCKER_PREFIX} every non-prompt Goal reference must be named in success criteria, task prompts, evidence_plan, or verifier metadata. Missing: ${missingReferences.map((reference) => reference.id).join(", ")}.`,
    );
  }
  return blockers;
}

function blockersAfterSetupCheck(run: GoalRun, setupBlockers: readonly string[]): string[] {
  if (run.status !== "draft") return run.blockers;
  return Array.from(
    new Set([
      ...run.blockers.filter((blocker) => !blocker.startsWith(SETUP_BLOCKER_PREFIX)),
      ...setupBlockers,
    ]),
  );
}

function statusAfterSetupCheck(run: GoalRun, setupBlockers: readonly string[]): GoalRunStatus {
  if (run.status !== "draft") return run.status;
  if (setupBlockers.length > 0) return "draft";
  return goalHasBlockingPrerequisites(run) ? "blocked" : "ready";
}

function validatePassAuditContract(
  run: GoalRun,
  summary: string,
  outputPath: string | undefined,
): string | undefined {
  const verifier = run.verifier?.lastResult;
  if (!verifier) return "cannot audit completion before a verifier result exists.";
  if (!summary.startsWith("FINAL_AUDIT_PASS"))
    return "pass audit summary must start with FINAL_AUDIT_PASS.";
  if (!summary.includes(`verifier_checked_at=${verifier.checkedAt}`)) {
    return `pass audit summary must include verifier_checked_at=${verifier.checkedAt}.`;
  }
  if (!outputPath && !summary.match(/(?:output|artifact|log|path)=\S+/)) {
    return "pass audit must include output_path or an output/artifact/log/path reference in the summary.";
  }
  const contractFields = [
    run.goal,
    ...run.successCriteria,
    ...(run.references ?? []).map(
      (reference) => `${reference.id} ${reference.label} ${reference.content ?? ""}`,
    ),
    ...run.evidence.map((item) => `${item.label}\n${item.path ?? ""}\n${item.content ?? ""}`),
  ].join("\n");
  const requiresReliabilityContract = /GOAL_PLAN/.test(contractFields);
  if (requiresReliabilityContract && !summary.includes("original-goal-prompt")) {
    return "pass audit summary must explicitly reference original-goal-prompt.";
  }
  if (requiresReliabilityContract && !summary.includes("GOAL_PLAN")) {
    return "pass audit summary must explicitly reference durable GOAL_PLAN evidence.";
  }
  if (!referencesAcknowledged(run.references, [summary, outputPath ?? ""])) {
    return "pass audit summary or output_path must explicitly reference every non-prompt Goal reference id, label, URL, or path.";
  }
  return undefined;
}

async function resolveRun(cwd: string, id?: string): Promise<GoalRun | null> {
  if (id) return getGoalRun(cwd, id);
  return getActiveGoalRun(cwd);
}

function goalStorageCwd(cwd: string): string {
  return process.env.GG_GOAL_PROJECT_PATH || cwd;
}

export function createGoalsTool(
  cwd: string,
  goalModeRef?: { current: GoalMode },
  getGoalReferences?: () => readonly GoalReference[] | undefined,
): AgentTool<typeof GoalsParams> {
  const storageCwd = goalStorageCwd(cwd);
  return {
    name: "goals",
    description:
      "Manage durable Goal runs for /goal and Ctrl+G workflows. Use this instead of tasks when the user wants a programmatic goal loop: define success criteria first, check prerequisites before launching workers, persist harness/diagnostics/evidence, add standalone worker tasks, record final completion audits, and only mark the goal complete when verifier plus final-audit evidence proves the original objective. Do not require paid services or signups without recording a blocker and asking the user for the missing prerequisite.",
    parameters: GoalsParams,
    executionMode: "sequential",
    async execute(args) {
      if (getActiveGoalMode(goalModeRef) === "planner") {
        return "Error: goals is restricted in Goal planner mode. Emit a compact GOAL_PLAN block only; setup creates durable Goal state.";
      }
      switch (args.action) {
        case "create": {
          if (!args.title) return "Error: title is required for create.";
          if (!args.goal) return "Error: goal is required for create.";
          const existing = args.run_id ? await getGoalRun(storageCwd, args.run_id) : null;
          const prerequisites = args.prerequisites
            ? await Promise.all(
                args.prerequisites.map((item) => normalizePrerequisiteInput(storageCwd, item)),
              )
            : undefined;
          const harness = args.harness?.map((item) => ({
            id: item.id ?? randomUUID(),
            label: item.label,
            ...(item.command ? { command: item.command } : {}),
            ...(item.path ? { path: item.path } : {}),
            ...(item.description ? { description: item.description } : {}),
          }));
          const evidencePlan = args.evidence_plan?.map((item) => ({
            id: item.id ?? randomUUID(),
            label: item.label,
            mechanism: asEvidenceMechanism(item.mechanism),
            description: item.description,
            status: item.status ?? "planned",
            ...(item.command ? { command: item.command } : {}),
            ...(item.path ? { path: item.path } : {}),
            ...(item.instructions ? { instructions: item.instructions } : {}),
            ...(item.evidence ? { evidence: item.evidence } : {}),
          }));
          const verifier =
            args.verifier_command || args.verifier_description || args.verifier_cwd
              ? {
                  description:
                    args.verifier_description ?? existing?.verifier?.description ?? "Goal verifier",
                  ...((args.verifier_command ?? existing?.verifier?.command)
                    ? { command: args.verifier_command ?? existing?.verifier?.command }
                    : {}),
                  ...((args.verifier_cwd ?? existing?.verifier?.cwd)
                    ? { cwd: args.verifier_cwd ?? existing?.verifier?.cwd }
                    : {}),
                  ...(existing?.verifier?.lastResult
                    ? { lastResult: existing.verifier.lastResult }
                    : {}),
                }
              : existing?.verifier;
          const nextPrerequisites = prerequisites ?? existing?.prerequisites ?? [];
          const missingPrerequisites = formatGoalBlockingPrerequisiteList(nextPrerequisites);
          const hasBlockingPrerequisites =
            missingPrerequisites !== "Goal has no missing user prerequisites.";
          const references = [...(getGoalReferences?.() ?? existing?.references ?? [])];
          const plannerEvidence = args.summary?.includes("GOAL_PLAN")
            ? [
                createGoalEvidence({
                  kind: "summary",
                  label: "Planner GOAL_PLAN",
                  content: args.summary,
                }),
              ]
            : undefined;
          const draftProbe = {
            goal: args.goal,
            successCriteria: args.success_criteria ?? existing?.successCriteria ?? [],
            evidencePlan: evidencePlan ?? existing?.evidencePlan ?? [],
            references,
            tasks: existing?.tasks ?? [],
            evidence: plannerEvidence ?? existing?.evidence ?? [],
            verifier,
          };
          const setupBlockers = setupBlockersForRun(draftProbe);
          const priorBlockers = (args.blockers ?? existing?.blockers ?? []).filter(
            (blocker) => !blocker.startsWith(SETUP_BLOCKER_PREFIX),
          );
          const blockers = Array.from(
            new Set([
              ...priorBlockers,
              ...(hasBlockingPrerequisites ? [missingPrerequisites] : []),
              ...setupBlockers,
            ]),
          );
          const run = await upsertGoalRun(storageCwd, {
            ...(args.run_id ? { id: args.run_id } : {}),
            title: args.title,
            goal: args.goal,
            status:
              setupBlockers.length > 0
                ? "draft"
                : hasBlockingPrerequisites
                  ? "blocked"
                  : existing?.status === "draft"
                    ? "ready"
                    : (existing?.status ?? "ready"),
            successCriteria: draftProbe.successCriteria,
            prerequisites: nextPrerequisites,
            harness: harness ?? existing?.harness ?? [],
            evidencePlan: draftProbe.evidencePlan,
            references: draftProbe.references,
            ...(plannerEvidence
              ? { evidence: [...(existing?.evidence ?? []), ...plannerEvidence] }
              : {}),
            ...(verifier ? { verifier } : {}),
            blockers,
          });
          await appendGoalDecision(storageCwd, run.id, {
            kind: args.run_id ? "update" : "create",
            reason: `criteria=${run.successCriteria.length}; prerequisites=${run.prerequisites.length}; harness=${run.harness.length}; evidence_plan=${run.evidencePlan.length}; references=${run.references?.length ?? 0}; verifier=${run.verifier?.command ? "configured" : "missing"}`,
          });
          log("INFO", "goals", `Goal created: ${run.title}`, { id: run.id, status: run.status });
          const setupMessage =
            setupBlockers.length > 0 ? ` Setup blockers: ${setupBlockers.join(" ")}` : "";
          return goalHasBlockingPrerequisites(run)
            ? `Goal ${args.run_id ? "updated" : "created"}: "${run.title}" (id: ${run.id.slice(0, 8)}, ${run.status}). User prerequisites: ${formatGoalBlockingPrerequisites(run)}${setupMessage}`
            : `Goal ${args.run_id ? "updated" : "created"}: "${run.title}" (id: ${run.id.slice(0, 8)}, ${run.status}).${setupMessage}`;
        }

        case "status": {
          if (args.run_id) {
            const run = await getGoalRun(storageCwd, args.run_id);
            return run ? formatRun(run) : `Error: no goal found matching id "${args.run_id}".`;
          }
          const runs = await loadGoalRuns(storageCwd);
          if (runs.length === 0) return "No goals.";
          return runs.map(formatRun).join("\n");
        }

        case "prerequisite": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          const prereqId = args.prerequisite_id;
          if (!prereqId && !args.prerequisite_label) {
            return "Error: prerequisite_id or prerequisite_label is required.";
          }
          const prerequisites = [...run.prerequisites];
          const index = prereqId
            ? prerequisites.findIndex(
                (item) => item.id === prereqId || item.id.startsWith(prereqId),
              )
            : -1;
          const existingPrerequisite = index >= 0 ? prerequisites[index] : undefined;
          const patch = {
            id: prereqId ?? randomUUID(),
            label:
              args.prerequisite_label ?? existingPrerequisite?.label ?? prereqId ?? "Prerequisite",
            status: asPrerequisiteStatus(args.prerequisite_status),
            ...(args.instructions ? { instructions: args.instructions } : {}),
            ...(args.summary ? { evidence: args.summary } : {}),
            ...(asPrerequisiteStatus(args.prerequisite_status) === "met" && !args.summary
              ? {
                  instructions:
                    args.instructions ??
                    uncheckedPrerequisiteInstructions(
                      args.prerequisite_label ??
                        existingPrerequisite?.label ??
                        prereqId ??
                        "Prerequisite",
                    ),
                }
              : {}),
          };
          if (index >= 0) {
            prerequisites[index] = {
              ...prerequisites[index],
              ...patch,
              id: prerequisites[index].id,
            };
          } else {
            prerequisites.push(patch);
          }
          const prerequisiteRun: GoalRun = {
            ...run,
            prerequisites,
            status: goalHasBlockingPrerequisites({ ...run, prerequisites }) ? "blocked" : "ready",
            blockers: goalHasBlockingPrerequisites({ ...run, prerequisites }) ? run.blockers : [],
          };
          const setupBlockers = setupBlockersForRun(prerequisiteRun);
          const updated = await upsertGoalRun(storageCwd, {
            ...prerequisiteRun,
            status: statusAfterSetupCheck(prerequisiteRun, setupBlockers),
            blockers: blockersAfterSetupCheck(prerequisiteRun, setupBlockers),
          });
          await appendGoalDecision(storageCwd, updated.id, {
            kind: "prerequisites",
            reason: `Prerequisite ${patch.label} is ${patch.status}; run is ${updated.status}.`,
          });
          return goalHasBlockingPrerequisites(updated)
            ? `Prerequisite updated for "${updated.title}" (${updated.status}). User prerequisites: ${formatGoalBlockingPrerequisites(updated)}`
            : `User prerequisites complete for "${updated.title}". Goal is ready to run.`;
        }

        case "task": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          if (!args.task_id && (!args.task_title || !args.task_prompt)) {
            return "Error: task_title and task_prompt are required when adding a task.";
          }
          const taskId = args.task_id ?? randomUUID();
          const existingTask = run.tasks.find(
            (task) => task.id === taskId || task.id.startsWith(taskId),
          );
          const taskExisted = existingTask !== undefined;
          if (!taskExisted && (!args.task_title || !args.task_prompt)) {
            return "Error: task_title and task_prompt are required when adding a task.";
          }
          if (!taskExisted) {
            const missingReferences = unacknowledgedReferences(run.references, [
              args.task_title ?? "",
              args.task_prompt ?? "",
            ]);
            if (missingReferences.length > 0) {
              return `Error: task_prompt must explicitly include each non-prompt Goal reference id, label, URL, or path so workers cannot silently ignore the user's references. Missing: ${missingReferences.map((reference) => reference.id).join(", ")}.`;
            }
          }
          const taskStatus = asTaskStatus(args.task_status);
          const mergeStrategy = asTaskMergeStrategy(args.merge_strategy);
          const resolvedDependencies = resolveTaskDependencyIds(run, args.depends_on, taskId);
          if (!resolvedDependencies.ok) return `Error: ${resolvedDependencies.error}`;
          const updated = await updateGoalTask(storageCwd, run.id, taskId, {
            id: taskId,
            ...(args.task_title ? { title: args.task_title } : {}),
            ...(args.task_prompt ? { prompt: args.task_prompt } : {}),
            status: taskStatus,
            ...(args.worker_id ? { workerId: args.worker_id } : {}),
            ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
            ...(args.depends_on ? { dependsOn: resolvedDependencies.value } : {}),
            ...(args.parallel_group ? { parallelGroup: args.parallel_group } : {}),
            ...(args.expected_changed_scope
              ? { expectedChangedScope: args.expected_changed_scope }
              : {}),
            ...(mergeStrategy ? { mergeStrategy } : {}),
            ...(args.summary ? { lastSummary: args.summary } : {}),
          });
          const recovered = updated
            ? await (async () => {
                const taskPatchedRun: GoalRun = {
                  ...updated,
                  status: statusAfterTaskPatch(updated, taskStatus),
                };
                const setupBlockers = setupBlockersForRun(taskPatchedRun);
                return upsertGoalRun(updated.projectPath, {
                  ...taskPatchedRun,
                  status: statusAfterSetupCheck(taskPatchedRun, setupBlockers),
                  blockers: blockersAfterSetupCheck(taskPatchedRun, setupBlockers),
                });
              })()
            : null;
          if (!recovered) return `Error: no task found matching id "${taskId}".`;
          const updatedTask = recovered.tasks.find(
            (task) =>
              task.id === existingTask?.id || task.id === taskId || task.id.startsWith(taskId),
          );
          return `Goal task ${taskExisted ? "updated" : "added"}: "${updatedTask?.title ?? args.task_title ?? taskId}".`;
        }

        case "evidence": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          if (!args.evidence_label && !args.summary)
            return "Error: evidence_label or summary is required.";
          const updated = await appendGoalEvidence(storageCwd, run.id, {
            kind: asEvidenceKind(args.evidence_kind),
            label: args.evidence_label ?? "Evidence",
            ...(args.evidence_path ? { path: args.evidence_path } : {}),
            ...(args.evidence_content || args.summary
              ? { content: args.evidence_content ?? args.summary }
              : {}),
          });
          if (!updated) return "Error: failed to append evidence.";
          return `Evidence added to "${updated.title}".`;
        }

        case "evidence_plan": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          const evidencePlan = [...run.evidencePlan];
          if (args.evidence_plan?.length) {
            let added = 0;
            let updatedCount = 0;
            for (const item of args.evidence_plan) {
              const itemId = item.id ?? randomUUID();
              const nextItem = {
                id: itemId,
                label: item.label,
                mechanism: asEvidenceMechanism(item.mechanism),
                description: item.description,
                status: item.status ?? "planned",
                ...(item.command ? { command: item.command } : {}),
                ...(item.path ? { path: item.path } : {}),
                ...(item.instructions ? { instructions: item.instructions } : {}),
                ...(item.evidence ? { evidence: item.evidence } : {}),
              };
              const index = evidencePlan.findIndex(
                (existing) => existing.id === itemId || existing.id.startsWith(itemId),
              );
              if (index >= 0) {
                evidencePlan[index] = nextItem;
                updatedCount += 1;
              } else {
                evidencePlan.push(nextItem);
                added += 1;
              }
            }
            const evidencePlanRun: GoalRun = { ...run, evidencePlan };
            const setupBlockers = setupBlockersForRun(evidencePlanRun);
            const updated = await upsertGoalRun(storageCwd, {
              ...evidencePlanRun,
              status: statusAfterSetupCheck(evidencePlanRun, setupBlockers),
              blockers: blockersAfterSetupCheck(evidencePlanRun, setupBlockers),
            });
            await appendGoalDecision(storageCwd, updated.id, {
              kind: "evidence_plan",
              reason: `Evidence-plan items upserted: ${added} added, ${updatedCount} updated.`,
            });
            if (args.evidence_plan.length === 1) {
              const item = args.evidence_plan[0];
              return `Evidence-plan item ${added === 1 ? "added" : "updated"} for "${updated.title}": "${item?.label ?? "Evidence"}".`;
            }
            return `Evidence-plan items upserted for "${updated.title}": ${added} added, ${updatedCount} updated.`;
          }
          const evidencePlanItemId = args.evidence_plan_item_id;
          if (!evidencePlanItemId)
            return "Error: evidence_plan_item_id or evidence_plan is required.";
          const index = evidencePlan.findIndex(
            (item) => item.id === evidencePlanItemId || item.id.startsWith(evidencePlanItemId),
          );
          if (index < 0) {
            return `Error: no evidence-plan item found matching id "${args.evidence_plan_item_id}".`;
          }
          const existing = evidencePlan[index];
          const status = asEvidencePlanStatus(args.evidence_plan_status);
          const evidence = args.evidence ?? args.evidence_content ?? args.summary;
          const path = args.path ?? args.evidence_path;
          evidencePlan[index] = {
            ...existing,
            status,
            ...(args.instructions ? { instructions: args.instructions } : {}),
            ...(evidence ? { evidence } : {}),
            ...(path ? { path } : {}),
          };
          const canRecoverBlockedRun =
            run.status === "blocked" && status === "ready" && !goalHasBlockingPrerequisites(run);
          const evidencePlanRun: GoalRun = {
            ...run,
            evidencePlan,
            status: canRecoverBlockedRun ? "ready" : run.status,
            blockers: canRecoverBlockedRun ? [] : run.blockers,
          };
          const setupBlockers = setupBlockersForRun(evidencePlanRun);
          const updated = await upsertGoalRun(storageCwd, {
            ...evidencePlanRun,
            status: statusAfterSetupCheck(evidencePlanRun, setupBlockers),
            blockers: blockersAfterSetupCheck(evidencePlanRun, setupBlockers),
          });
          await appendGoalDecision(storageCwd, updated.id, {
            kind: "evidence_plan",
            reason: `Evidence-plan item ${existing.label} is ${status}.`,
          });
          return `Evidence-plan item updated for "${updated.title}": "${existing.label}" is ${status}.`;
        }

        case "verify": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          const result = {
            status: asVerificationStatus(args.verification_status),
            summary: args.summary ?? "Verifier recorded.",
            ...((args.verifier_command ?? run.verifier?.command)
              ? { command: args.verifier_command ?? run.verifier?.command }
              : {}),
            ...(args.exit_code !== undefined ? { exitCode: args.exit_code } : {}),
            ...(args.output_path ? { outputPath: args.output_path } : {}),
            checkedAt: new Date().toISOString(),
          };
          const runWithVerifier: GoalRun = {
            ...run,
            verifier: {
              description:
                args.verifier_description ?? run.verifier?.description ?? "Goal verifier",
              ...((args.verifier_command ?? run.verifier?.command)
                ? { command: args.verifier_command ?? run.verifier?.command }
                : {}),
              ...((args.verifier_cwd ?? run.verifier?.cwd)
                ? { cwd: args.verifier_cwd ?? run.verifier?.cwd }
                : {}),
              lastResult: result,
            },
            ...(result.status === "pass"
              ? {
                  completionAudit: {
                    status: "unknown" as const,
                    summary: "Final completion audit pending for latest verifier result.",
                    checkedAt: result.checkedAt,
                    verifierCheckedAt: result.checkedAt,
                    ...(result.outputPath ? { outputPath: result.outputPath } : {}),
                  },
                }
              : {}),
            evidence: [
              ...run.evidence,
              createGoalEvidence({
                kind: "command",
                label: "Verifier result",
                content: result.summary,
                ...(result.outputPath ? { path: result.outputPath } : {}),
              }),
            ],
          };
          const completion = canCompleteGoalRun(runWithVerifier);
          const updated = await upsertGoalRun(storageCwd, {
            ...runWithVerifier,
            status:
              result.status === "pass" && completion.ok
                ? "passed"
                : result.status === "pass"
                  ? goalHasBlockingPrerequisites(runWithVerifier)
                    ? "blocked"
                    : "ready"
                  : result.status === "fail"
                    ? goalHasBlockingPrerequisites(runWithVerifier)
                      ? "blocked"
                      : "ready"
                    : "verifying",
            blockers: result.status === "pass" ? [] : run.blockers,
            activeWorkerId: undefined,
          });
          return `Verifier recorded for "${updated.title}": ${result.status}.`;
        }

        case "audit": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          const verifierResult = run.verifier?.lastResult;
          if (!verifierResult || verifierResult.status !== "pass") {
            return "Error: cannot audit completion before a passing verifier result exists.";
          }
          const auditStatus = asVerificationStatus(args.verification_status);
          const auditSummary = args.summary ?? "Final completion audit recorded.";
          const auditOutputPath = args.output_path ?? verifierResult.outputPath;
          if (auditStatus === "pass") {
            const contractError = validatePassAuditContract(run, auditSummary, auditOutputPath);
            if (contractError)
              return `Error: invalid final completion audit pass contract: ${contractError}`;
          }
          const completionAudit = {
            status: auditStatus,
            summary: auditSummary,
            checkedAt: new Date().toISOString(),
            verifierCheckedAt: verifierResult.checkedAt,
            ...(auditOutputPath ? { outputPath: auditOutputPath } : {}),
          };
          const runWithAudit: GoalRun = {
            ...run,
            completionAudit,
            evidence: [
              ...run.evidence,
              createGoalEvidence({
                kind: "summary",
                label: `Final completion audit ${completionAudit.status}`,
                content: completionAudit.summary,
                ...(completionAudit.outputPath ? { path: completionAudit.outputPath } : {}),
              }),
            ],
          };
          const auditCheck = hasFreshGoalCompletionAudit(runWithAudit);
          const completion = canCompleteGoalRun(runWithAudit);
          const updated = await upsertGoalRun(storageCwd, {
            ...runWithAudit,
            status:
              completionAudit.status === "pass" && auditCheck.ok && completion.ok
                ? "passed"
                : goalHasBlockingPrerequisites(runWithAudit)
                  ? "blocked"
                  : "ready",
            blockers: completionAudit.status === "pass" && auditCheck.ok ? [] : run.blockers,
            activeWorkerId: undefined,
          });
          await appendGoalDecision(storageCwd, updated.id, {
            kind: "completion_audit",
            reason: auditCheck.reason,
            content: `status=${completionAudit.status}; verifierCheckedAt=${completionAudit.verifierCheckedAt ?? ""}; outputPath=${completionAudit.outputPath ?? ""}`,
          });
          return `Completion audit recorded for "${updated.title}": ${completionAudit.status}.`;
        }

        case "pause":
        case "resume":
        case "complete": {
          const run = await resolveRun(storageCwd, args.run_id);
          if (!run) return "Error: no active goal run found.";
          let status: GoalRunStatus;
          if (args.action === "pause") {
            if (run.activeWorkerId || run.tasks.some((task) => task.status === "running")) {
              return `Error: cannot pause goal while worker ${run.activeWorkerId ?? "task"} is active. Stop the worker first or wait for it to finish.`;
            }
            status = "paused";
          } else if (args.action === "resume") {
            const missing = goalHasBlockingPrerequisites(run)
              ? formatGoalBlockingPrerequisites(run)
              : "";
            if (missing) {
              const updated = await upsertGoalRun(storageCwd, {
                ...run,
                status: "blocked",
                blockers: appendGoalBlockers(run.blockers, missing),
                evidence: [
                  ...run.evidence,
                  createGoalEvidence({
                    kind: "summary",
                    label: "Goal resume blocked",
                    content: missing,
                  }),
                ],
              });
              return `Goal "${updated.title}" resume blocked: ${missing}`;
            }
            const requestedAt = new Date().toISOString();
            const resumed: GoalRun = {
              ...run,
              status: run.status === "running" || run.status === "verifying" ? run.status : "ready",
              continueRequestedAt: requestedAt,
              evidence: [
                ...run.evidence,
                createGoalEvidence({
                  kind: "summary",
                  label: "Goal resume requested",
                  content:
                    "Continuation requested; the next eligible Goal action will run automatically when no worker/verifier is active.",
                  createdAt: requestedAt,
                }),
              ],
            };
            const decision = decideGoalNextAction(resumed);
            const blockedReason = decision.kind === "blocked" ? decision.reason : undefined;
            const updated = await upsertGoalRun(storageCwd, {
              ...resumed,
              ...(blockedReason
                ? {
                    status: "blocked" as const,
                    continueRequestedAt: undefined,
                    blockers: appendGoalBlockers(run.blockers, blockedReason),
                    evidence: [
                      ...resumed.evidence,
                      createGoalEvidence({
                        kind: "summary",
                        label: "Goal resume blocked",
                        content: blockedReason,
                      }),
                    ],
                  }
                : {}),
            });
            await appendGoalDecision(storageCwd, updated.id, {
              kind: "resume",
              reason:
                decision.kind === "wait" ||
                decision.kind === "blocked" ||
                decision.kind === "terminal" ||
                decision.kind === "complete" ||
                decision.kind === "create_task" ||
                decision.kind === "start_worker" ||
                decision.kind === "run_verifier"
                  ? decision.reason
                  : "Resume decision queued.",
              content: `next=${decision.kind}`,
            });
            if (decision.kind === "wait") {
              return `Goal "${updated.title}" resume queued: ${decision.reason}`;
            }
            if (decision.kind === "blocked") {
              return `Goal "${updated.title}" resume blocked: ${decision.reason}`;
            }
            return `Goal "${updated.title}" resume requested; next action: ${decision.kind}.`;
          } else {
            const completion = canCompleteGoalRun(run);
            if (!completion.ok) return `Error: cannot complete goal: ${completion.reason}`;
            status = "passed";
          }
          const updated = await upsertGoalRun(storageCwd, { ...run, status });
          return `Goal "${updated.title}" is now ${updated.status}.`;
        }
      }
    },
  };
}
