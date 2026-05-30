import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { GoalControllerDecision } from "./goal-controller.js";

export type GoalRunStatus =
  | "draft"
  | "blocked"
  | "ready"
  | "running"
  | "verifying"
  | "passed"
  | "failed"
  | "paused";

export type GoalTaskStatus = "pending" | "running" | "verifying" | "done" | "failed" | "blocked";

/**
 * Whether a task's committed candidate is auto-integrated into main
 * (`candidate`) or left for manual handling (`manual`). Ordering is expressed by
 * `dependsOn`, not this axis.
 */
export type GoalTaskIntegration = "candidate" | "manual";

/**
 * @deprecated Legacy four-way axis. Inputs are folded to {@link GoalTaskIntegration}
 * on normalize: `manual` → `manual`; everything else → `candidate`.
 */
export type GoalTaskMergeStrategy =
  | "parallel_candidate"
  | "after_dependencies"
  | "serial"
  | "manual";

export function foldGoalTaskIntegration(
  value: GoalTaskIntegration | GoalTaskMergeStrategy | undefined,
): GoalTaskIntegration {
  return value === "manual" ? "manual" : "candidate";
}

export type GoalIntegrationStatus = "none" | "applied" | "committed";

export interface GoalIntegrationState {
  status: GoalIntegrationStatus;
  /** main HEAD after integration. */
  headSha?: string;
  /** integration base the candidates branched from. */
  baseRef?: string;
  /** integrated file paths (for the journal/diagnosis). */
  files?: string[];
  /** ISO; injected clock, never Date.now() inline in pure code. */
  updatedAt: string;
}

export type GoalPrerequisiteStatus = "unknown" | "met" | "missing";

export type GoalPrerequisiteKind = "local" | "external";

export type GoalEvidenceKind = "log" | "command" | "screenshot" | "file" | "summary";

export type GoalVerificationStatus = "pass" | "fail" | "unknown";

export interface GoalVerificationResult {
  status: GoalVerificationStatus;
  summary: string;
  command?: string;
  exitCode?: number;
  outputPath?: string;
  checkedAt: string;
}

export interface GoalCompletionAudit {
  status: GoalVerificationStatus;
  summary: string;
  checkedAt: string;
  verifierCheckedAt?: string;
  outputPath?: string;
}

export interface GoalPrerequisite {
  id: string;
  label: string;
  status: GoalPrerequisiteStatus;
  /**
   * Whether the agent can satisfy this prerequisite locally ("local") or it
   * genuinely requires user-supplied external input ("external"). When omitted,
   * {@link prerequisiteKind} infers it: a runnable checkCommand implies local.
   */
  kind?: GoalPrerequisiteKind;
  checkCommand?: string;
  instructions?: string;
  evidence?: string;
}

export interface GoalHarnessItem {
  id: string;
  label: string;
  command?: string;
  path?: string;
  description?: string;
}

export type GoalEvidenceMechanism =
  | "command"
  | "test"
  | "script"
  | "fixture"
  | "log"
  | "screenshot"
  | "video"
  | "browser"
  | "device"
  | "source"
  | "file"
  | "manual";

export interface GoalEvidencePlan {
  id: string;
  label: string;
  mechanism: GoalEvidenceMechanism;
  description: string;
  status: "planned" | "ready" | "blocked";
  command?: string;
  path?: string;
  instructions?: string;
  evidence?: string;
}

export type GoalReferenceKind = "prompt" | "url" | "repo" | "file" | "image" | "text";

export interface GoalReference {
  id: string;
  kind: GoalReferenceKind;
  label: string;
  value?: string;
  path?: string;
  mediaType?: string;
  description?: string;
  content?: string;
  source?: string;
}

export interface GoalTaskWorktree {
  baseRef: string;
  branchName: string;
  path: string;
  status: "planned" | "created" | "failed";
  error?: string;
}

/**
 * Structured, committed candidate packet produced by a worktree worker. Lets
 * integration read exactly what changed (committed commit + changed files)
 * instead of reverse-engineering a dirty worktree.
 */
export interface GoalTaskCandidate {
  baseRef: string;
  headSha: string;
  branchName: string;
  changedFiles: string[];
  committed: boolean;
}

export interface GoalTask {
  id: string;
  title: string;
  prompt: string;
  status: GoalTaskStatus;
  workerId?: string;
  attempts: number;
  dependsOn?: string[];
  parallelGroup?: string;
  expectedChangedScope?: string[];
  integration?: GoalTaskIntegration;
  worktree?: GoalTaskWorktree;
  candidate?: GoalTaskCandidate;
  verification?: GoalVerificationResult;
  lastSummary?: string;
}

export interface GoalEvidence {
  id: string;
  kind: GoalEvidenceKind;
  label: string;
  path?: string;
  content?: string;
  createdAt: string;
}

export interface GoalVerifier {
  description: string;
  command?: string;
  cwd?: string;
  lastResult?: GoalVerificationResult;
}

export interface GoalRun {
  id: string;
  title: string;
  goal: string;
  status: GoalRunStatus;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  successCriteria: string[];
  prerequisites: GoalPrerequisite[];
  harness: GoalHarnessItem[];
  evidencePlan: GoalEvidencePlan[];
  references?: GoalReference[];
  tasks: GoalTask[];
  evidence: GoalEvidence[];
  verifier?: GoalVerifier;
  completionAudit?: GoalCompletionAudit;
  integration?: GoalIntegrationState;
  /**
   * ISO time of the most recent NON-audit, NON-integration worker completion.
   * Drives verifier/audit staleness deterministically (replaces the
   * "Worker ... after verifier" evidence scans).
   */
  lastSubstantiveWorkerAt?: string;
  blockers: string[];
  activeWorkerId?: string;
  continueRequestedAt?: string;
}

export interface GoalCounts {
  total: number;
  active: number;
  blocked: number;
  pending: number;
  running: number;
  passed: number;
  failed: number;
}

export interface ReconcileActiveGoalRunsOptions {
  isWorkerActive?: (workerId: string, run: GoalRun) => boolean;
  isVerifierActive?: (run: GoalRun) => boolean;
}

export interface GoalReconciliationResult {
  runs: GoalRun[];
  repairedRunIds: string[];
  evidenceCount: number;
}

export interface GoalRunInput {
  id?: string;
  title: string;
  goal: string;
  status?: GoalRunStatus;
  successCriteria?: string[];
  prerequisites?: GoalPrerequisite[];
  harness?: GoalHarnessItem[];
  evidencePlan?: GoalEvidencePlan[];
  references?: GoalReference[];
  tasks?: GoalTask[];
  evidence?: GoalEvidence[];
  verifier?: GoalVerifier;
  completionAudit?: GoalCompletionAudit;
  integration?: GoalIntegrationState;
  lastSubstantiveWorkerAt?: string;
  blockers?: string[];
  activeWorkerId?: string;
  continueRequestedAt?: string;
}

export interface GoalTaskInput {
  id?: string;
  title: string;
  prompt: string;
  status?: GoalTaskStatus;
  workerId?: string;
  attempts?: number;
  dependsOn?: string[];
  parallelGroup?: string;
  expectedChangedScope?: string[];
  integration?: GoalTaskIntegration;
  /** @deprecated legacy input; folded to {@link integration} on normalize. */
  mergeStrategy?: GoalTaskMergeStrategy;
  worktree?: GoalTaskWorktree;
  candidate?: GoalTaskCandidate;
  verification?: GoalVerificationResult;
  lastSummary?: string;
}

export interface GoalEvidenceInput {
  id?: string;
  kind: GoalEvidenceKind;
  label: string;
  path?: string;
  content?: string;
  createdAt?: string;
}

const GOALS_BASE_ENV = "GG_GOALS_BASE";
const DEFAULT_PROJECT_DIR_NAME = "projects";

let writeQueue: Promise<void> = Promise.resolve();

function goalsBaseDir(): string {
  return process.env[GOALS_BASE_ENV] ?? join(homedir(), ".gg", "goals", DEFAULT_PROJECT_DIR_NAME);
}

export function normalizeProjectPath(cwd: string): string {
  return resolve(cwd);
}

function nowIso(): string {
  return new Date().toISOString();
}

function mergeGoalTasks(existing: GoalTask[], input: GoalTask[] | undefined): GoalTask[] {
  if (!input) return existing;
  const byId = new Map(input.map((task) => [task.id, task]));
  const merged = existing.map((task) => {
    const next = byId.get(task.id);
    if (!next) return task;
    return {
      ...task,
      ...next,
      status:
        task.status !== next.status || task.attempts > next.attempts ? task.status : next.status,
      attempts: Math.max(task.attempts, next.attempts),
      workerId: task.workerId ?? next.workerId,
      dependsOn: task.dependsOn ?? next.dependsOn,
      parallelGroup: task.parallelGroup ?? next.parallelGroup,
      expectedChangedScope: task.expectedChangedScope ?? next.expectedChangedScope,
      integration: task.integration ?? next.integration,
      verification: task.verification ?? next.verification,
      lastSummary: task.lastSummary ?? next.lastSummary,
    };
  });
  for (const task of input) {
    if (!existing.some((item) => item.id === task.id)) merged.push(task);
  }
  return merged;
}

function mergeGoalEvidence(
  existing: GoalEvidence[],
  input: GoalEvidence[] | undefined,
): GoalEvidence[] {
  if (!input) return existing;
  const byId = new Map(existing.map((item) => [item.id, item]));
  const merged = [...existing];
  for (const item of input) {
    if (!byId.has(item.id)) merged.push(item);
  }
  return merged;
}

function mergeGoalReferences(
  existing: GoalReference[],
  input: GoalReference[] | undefined,
): GoalReference[] {
  if (!input) return existing;
  const merged = [...existing];
  const seen = new Set(
    existing
      .map((item) => item.id)
      .concat(
        existing.map(
          (item) => `${item.kind}:${item.value ?? item.path ?? item.content ?? item.label}`,
        ),
      ),
  );
  for (const item of input) {
    const identity = `${item.kind}:${item.value ?? item.path ?? item.content ?? item.label}`;
    if (seen.has(item.id) || seen.has(identity)) continue;
    seen.add(item.id);
    seen.add(identity);
    merged.push(item);
  }
  return merged;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRunStatus(value: unknown): value is GoalRunStatus {
  return (
    value === "draft" ||
    value === "blocked" ||
    value === "ready" ||
    value === "running" ||
    value === "verifying" ||
    value === "passed" ||
    value === "failed" ||
    value === "paused"
  );
}

function isTaskStatus(value: unknown): value is GoalTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "verifying" ||
    value === "done" ||
    value === "failed" ||
    value === "blocked"
  );
}

function isTaskIntegration(value: unknown): value is GoalTaskIntegration {
  return value === "candidate" || value === "manual";
}

function isPrerequisiteStatus(value: unknown): value is GoalPrerequisiteStatus {
  return value === "unknown" || value === "met" || value === "missing";
}

function isPrerequisiteKind(value: unknown): value is GoalPrerequisiteKind {
  return value === "local" || value === "external";
}

function isEvidenceKind(value: unknown): value is GoalEvidenceKind {
  return (
    value === "log" ||
    value === "command" ||
    value === "screenshot" ||
    value === "file" ||
    value === "summary"
  );
}

function isEvidenceMechanism(value: unknown): value is GoalEvidenceMechanism {
  return (
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
  );
}

function isGoalReferenceKind(value: unknown): value is GoalReferenceKind {
  return (
    value === "prompt" ||
    value === "url" ||
    value === "repo" ||
    value === "file" ||
    value === "image" ||
    value === "text"
  );
}

function isEvidencePlanStatus(value: unknown): value is GoalEvidencePlan["status"] {
  return value === "planned" || value === "ready" || value === "blocked";
}

function isVerificationStatus(value: unknown): value is GoalVerificationStatus {
  return value === "pass" || value === "fail" || value === "unknown";
}

function normalizeVerification(value: unknown): GoalVerificationResult | undefined {
  if (!isObject(value)) return undefined;
  return {
    status: isVerificationStatus(value.status) ? value.status : "unknown",
    summary: typeof value.summary === "string" ? value.summary : "",
    ...(optionalString(value.command) ? { command: optionalString(value.command) } : {}),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(optionalString(value.outputPath) ? { outputPath: optionalString(value.outputPath) } : {}),
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : nowIso(),
  };
}

function normalizePrerequisite(value: unknown): GoalPrerequisite | null {
  if (!isObject(value)) return null;
  const label = typeof value.label === "string" ? value.label : "Prerequisite";
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    label,
    status: isPrerequisiteStatus(value.status) ? value.status : "unknown",
    ...(isPrerequisiteKind(value.kind) ? { kind: value.kind } : {}),
    ...(optionalString(value.checkCommand)
      ? { checkCommand: optionalString(value.checkCommand) }
      : {}),
    ...(optionalString(value.instructions)
      ? { instructions: optionalString(value.instructions) }
      : {}),
    ...(optionalString(value.evidence) ? { evidence: optionalString(value.evidence) } : {}),
  };
}

function normalizeHarnessItem(value: unknown): GoalHarnessItem | null {
  if (!isObject(value)) return null;
  const label = typeof value.label === "string" ? value.label : "Harness";
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    label,
    ...(optionalString(value.command) ? { command: optionalString(value.command) } : {}),
    ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
    ...(optionalString(value.description)
      ? { description: optionalString(value.description) }
      : {}),
  };
}

function normalizeEvidencePlanItem(value: unknown): GoalEvidencePlan | null {
  if (!isObject(value)) return null;
  const label = typeof value.label === "string" ? value.label : "Evidence path";
  const description = typeof value.description === "string" ? value.description : label;
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    label,
    mechanism: isEvidenceMechanism(value.mechanism) ? value.mechanism : "command",
    description,
    status: isEvidencePlanStatus(value.status) ? value.status : "planned",
    ...(optionalString(value.command) ? { command: optionalString(value.command) } : {}),
    ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
    ...(optionalString(value.instructions)
      ? { instructions: optionalString(value.instructions) }
      : {}),
    ...(optionalString(value.evidence) ? { evidence: optionalString(value.evidence) } : {}),
  };
}

function normalizeReference(value: unknown): GoalReference | null {
  if (!isObject(value)) return null;
  const label = typeof value.label === "string" ? value.label : "Goal reference";
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    kind: isGoalReferenceKind(value.kind) ? value.kind : "text",
    label,
    ...(optionalString(value.value) ? { value: optionalString(value.value) } : {}),
    ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
    ...(optionalString(value.mediaType) ? { mediaType: optionalString(value.mediaType) } : {}),
    ...(optionalString(value.description)
      ? { description: optionalString(value.description) }
      : {}),
    ...(optionalString(value.content) ? { content: optionalString(value.content) } : {}),
    ...(optionalString(value.source) ? { source: optionalString(value.source) } : {}),
  };
}

function normalizeTaskWorktree(value: unknown): GoalTaskWorktree | undefined {
  if (!isObject(value)) return undefined;
  const baseRef = optionalString(value.baseRef);
  const branchName = optionalString(value.branchName);
  const worktreePath = optionalString(value.path);
  const rawStatus = value.status;
  const status =
    rawStatus === "planned" || rawStatus === "created" || rawStatus === "failed"
      ? rawStatus
      : undefined;
  if (!baseRef || !branchName || !worktreePath || !status) return undefined;
  return {
    baseRef,
    branchName,
    path: worktreePath,
    status,
    ...(optionalString(value.error) ? { error: optionalString(value.error) } : {}),
  };
}

function normalizeTaskCandidate(value: unknown): GoalTaskCandidate | undefined {
  if (!isObject(value)) return undefined;
  const baseRef = optionalString(value.baseRef);
  const headSha = optionalString(value.headSha);
  const branchName = optionalString(value.branchName);
  if (!baseRef || !headSha || !branchName) return undefined;
  return {
    baseRef,
    headSha,
    branchName,
    changedFiles: stringArray(value.changedFiles),
    committed: value.committed !== false,
  };
}

function normalizeTask(value: unknown): GoalTask | null {
  if (!isObject(value)) return null;
  const title = typeof value.title === "string" ? value.title : "Goal task";
  const prompt = typeof value.prompt === "string" ? value.prompt : title;
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    title,
    prompt,
    status: isTaskStatus(value.status) ? value.status : "pending",
    ...(optionalString(value.workerId) ? { workerId: optionalString(value.workerId) } : {}),
    attempts: typeof value.attempts === "number" && value.attempts >= 0 ? value.attempts : 0,
    ...(stringArray(value.dependsOn).length > 0 ? { dependsOn: stringArray(value.dependsOn) } : {}),
    ...(optionalString(value.parallelGroup)
      ? { parallelGroup: optionalString(value.parallelGroup) }
      : {}),
    ...(stringArray(value.expectedChangedScope).length > 0
      ? { expectedChangedScope: stringArray(value.expectedChangedScope) }
      : {}),
    integration: foldGoalTaskIntegration(
      isTaskIntegration(value.integration)
        ? value.integration
        : typeof value.mergeStrategy === "string"
          ? (value.mergeStrategy as GoalTaskMergeStrategy)
          : undefined,
    ),
    ...(normalizeTaskWorktree(value.worktree)
      ? { worktree: normalizeTaskWorktree(value.worktree) }
      : {}),
    ...(normalizeTaskCandidate(value.candidate)
      ? { candidate: normalizeTaskCandidate(value.candidate) }
      : {}),
    ...(normalizeVerification(value.verification)
      ? { verification: normalizeVerification(value.verification) }
      : {}),
    ...(optionalString(value.lastSummary)
      ? { lastSummary: optionalString(value.lastSummary) }
      : {}),
  };
}

function normalizeEvidence(value: unknown): GoalEvidence | null {
  if (!isObject(value)) return null;
  const label = typeof value.label === "string" ? value.label : "Evidence";
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    kind: isEvidenceKind(value.kind) ? value.kind : "summary",
    label,
    ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
    ...(optionalString(value.content) ? { content: optionalString(value.content) } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
  };
}

function normalizeVerifier(value: unknown): GoalVerifier | undefined {
  if (!isObject(value)) return undefined;
  const description = typeof value.description === "string" ? value.description : "Goal verifier";
  return {
    description,
    ...(optionalString(value.command) ? { command: optionalString(value.command) } : {}),
    ...(optionalString(value.cwd) ? { cwd: optionalString(value.cwd) } : {}),
    ...(normalizeVerification(value.lastResult)
      ? { lastResult: normalizeVerification(value.lastResult) }
      : {}),
  };
}

function isIntegrationStatus(value: unknown): value is GoalIntegrationStatus {
  return value === "none" || value === "applied" || value === "committed";
}

function normalizeIntegration(value: unknown): GoalIntegrationState | undefined {
  if (!isObject(value)) return undefined;
  if (!isIntegrationStatus(value.status)) return undefined;
  return {
    status: value.status,
    ...(optionalString(value.headSha) ? { headSha: optionalString(value.headSha) } : {}),
    ...(optionalString(value.baseRef) ? { baseRef: optionalString(value.baseRef) } : {}),
    ...(stringArray(value.files).length > 0 ? { files: stringArray(value.files) } : {}),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
  };
}

/**
 * Back-compat shim: infer the typed integration state from legacy evidence
 * labels for runs persisted before {@link GoalIntegrationState} existed. This is
 * the ONLY place label-matching is allowed to survive; it migrates old runs once.
 */
function inferIntegrationFromEvidence(
  evidence: readonly GoalEvidence[],
): GoalIntegrationState | undefined {
  const committed = evidence.find((item) => item.label === "Integrated Goal changes committed");
  const applied = evidence.find(
    (item) =>
      item.label === "Integrated worktree applied to main" ||
      item.label === "Goal decision: apply_integration_to_main",
  );
  if (!committed && !applied) return undefined;
  const source = committed ?? applied!;
  return {
    status: committed ? "committed" : "applied",
    updatedAt: source.createdAt,
  };
}

/**
 * Back-compat shim: infer the most recent non-audit worker completion time from
 * legacy "Worker <id> done/failed" evidence for runs persisted before
 * {@link GoalRun.lastSubstantiveWorkerAt} existed.
 */
function inferLastSubstantiveWorkerAt(evidence: readonly GoalEvidence[]): string | undefined {
  const workerEvidence = evidence
    .filter((item) => /^Worker\s+\S+\s+(done|failed)$/.test(item.label))
    .map((item) => item.createdAt)
    .sort((a, b) => b.localeCompare(a));
  return workerEvidence[0];
}

function normalizeCompletionAudit(value: unknown): GoalCompletionAudit | undefined {
  if (!isObject(value)) return undefined;
  return {
    status: isVerificationStatus(value.status) ? value.status : "unknown",
    summary: typeof value.summary === "string" ? value.summary : "",
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : nowIso(),
    ...(optionalString(value.verifierCheckedAt)
      ? { verifierCheckedAt: optionalString(value.verifierCheckedAt) }
      : {}),
    ...(optionalString(value.outputPath) ? { outputPath: optionalString(value.outputPath) } : {}),
  };
}

function normalizeRun(value: unknown, fallbackProjectPath: string): GoalRun | null {
  if (!isObject(value)) return null;
  const title = typeof value.title === "string" ? value.title : "Untitled goal";
  const goal = typeof value.goal === "string" ? value.goal : title;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : nowIso();
  const projectPath =
    typeof value.projectPath === "string" ? value.projectPath : fallbackProjectPath;
  const prerequisites = Array.isArray(value.prerequisites)
    ? value.prerequisites
        .map(normalizePrerequisite)
        .filter((item): item is GoalPrerequisite => !!item)
    : [];
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map(normalizeTask).filter((item): item is GoalTask => !!item)
    : [];
  const computedStatus = deriveRunnableStatus(
    isRunStatus(value.status) ? value.status : "draft",
    prerequisites,
  );
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.map(normalizeEvidence).filter((item): item is GoalEvidence => !!item)
    : [];
  const integration =
    normalizeIntegration(value.integration) ?? inferIntegrationFromEvidence(evidence);
  const lastSubstantiveWorkerAt =
    optionalString(value.lastSubstantiveWorkerAt) ?? inferLastSubstantiveWorkerAt(evidence);

  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    title,
    goal,
    status: computedStatus,
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
    projectPath,
    successCriteria: stringArray(value.successCriteria),
    prerequisites,
    harness: Array.isArray(value.harness)
      ? value.harness.map(normalizeHarnessItem).filter((item): item is GoalHarnessItem => !!item)
      : [],
    evidencePlan: Array.isArray(value.evidencePlan)
      ? value.evidencePlan
          .map(normalizeEvidencePlanItem)
          .filter((item): item is GoalEvidencePlan => !!item)
      : [],
    references: Array.isArray(value.references)
      ? value.references.map(normalizeReference).filter((item): item is GoalReference => !!item)
      : [],
    tasks,
    evidence,
    ...(normalizeVerifier(value.verifier) ? { verifier: normalizeVerifier(value.verifier) } : {}),
    ...(normalizeCompletionAudit(value.completionAudit)
      ? { completionAudit: normalizeCompletionAudit(value.completionAudit) }
      : {}),
    ...(integration ? { integration } : {}),
    ...(lastSubstantiveWorkerAt ? { lastSubstantiveWorkerAt } : {}),
    blockers: dedupeGoalBlockers(stringArray(value.blockers)),
    ...(optionalString(value.activeWorkerId)
      ? { activeWorkerId: optionalString(value.activeWorkerId) }
      : {}),
    ...(optionalString(value.continueRequestedAt)
      ? { continueRequestedAt: optionalString(value.continueRequestedAt) }
      : {}),
  };
}

function sortNewestFirst(runs: GoalRun[]): GoalRun[] {
  return [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isActiveGoalRun(run: GoalRun): boolean {
  return (
    run.status === "running" ||
    run.status === "verifying" ||
    run.activeWorkerId !== undefined ||
    run.tasks.some((task) => task.status === "running" || task.status === "verifying")
  );
}

function omittedActiveGoalRuns(
  previousRuns: readonly GoalRun[],
  nextRuns: readonly GoalRun[],
): GoalRun[] {
  const nextIds = new Set(nextRuns.map((run) => run.id));
  return previousRuns.filter((run) => isActiveGoalRun(run) && !nextIds.has(run.id));
}

export function dedupeGoalBlockers(blockers: readonly string[]): string[] {
  return Array.from(new Set(blockers.map((item) => item.trim()).filter(Boolean)));
}

export function appendGoalBlockers(
  blockers: readonly string[],
  nextBlockers: string | readonly string[] | undefined,
): string[] {
  const additions = typeof nextBlockers === "string" ? [nextBlockers] : (nextBlockers ?? []);
  return dedupeGoalBlockers([...blockers, ...additions]);
}

function deriveRunnableStatus(
  requestedStatus: GoalRunStatus,
  prerequisites: readonly GoalPrerequisite[],
): GoalRunStatus {
  if (
    requestedStatus === "passed" ||
    requestedStatus === "failed" ||
    requestedStatus === "paused"
  ) {
    return requestedStatus;
  }
  if (hasBlockingGoalPrerequisites(prerequisites)) return "blocked";
  return requestedStatus;
}

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn);
  writeQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

/**
 * Persist runs to disk. MUST be called while holding the goal-store lock (it is
 * not reentrant). Re-reads on-disk state for the omitted-active-run guard, then
 * writes goals.json + meta.json + journals atomically.
 */
async function writeGoalRunsFileCore(
  normalizedCwd: string,
  runs: readonly GoalRun[],
): Promise<void> {
  const dir = projectDir(normalizedCwd);
  await mkdir(dir, { recursive: true });
  const goalsPath = join(dir, "goals.json");
  const existingRuns = await readGoalRunsFile(normalizedCwd);
  const omittedActive = omittedActiveGoalRuns(existingRuns, runs);
  if (omittedActive.length > 0) {
    const timestamp = nowIso();
    const rejectedIds = new Set(omittedActive.map((run) => run.id));
    const repairedRuns = existingRuns.map((run) =>
      rejectedIds.has(run.id)
        ? {
            ...run,
            evidence: [
              ...run.evidence,
              createGoalEvidence({
                kind: "summary",
                label: "Goal store write rejected",
                content:
                  "Rejected an attempted Goal overwrite that omitted active work; preserving existing durable state.",
                createdAt: timestamp,
              }),
            ],
            updatedAt: timestamp,
          }
        : run,
    );
    await atomicWriteJson(goalsPath, sortNewestFirst(repairedRuns));
    await Promise.all(
      repairedRuns.map((run) => writeGoalProgressJournalFromRun(normalizedCwd, run)),
    );
    return;
  }
  const sorted = sortNewestFirst([...runs]);
  await atomicWriteJson(goalsPath, sorted);
  await atomicWriteJson(join(dir, "meta.json"), {
    path: normalizedCwd,
    name: basename(normalizedCwd),
  });
  await Promise.all(sorted.map((run) => writeGoalProgressJournalFromRun(normalizedCwd, run)));
}

async function writeGoalRunsFile(cwd: string, runs: readonly GoalRun[]): Promise<void> {
  const normalizedCwd = normalizeProjectPath(cwd);
  const dir = projectDir(normalizedCwd);
  await withGoalStoreLock(dir, () => writeGoalRunsFileCore(normalizedCwd, runs));
}

/**
 * Cross-process-atomic read-modify-write. Reads the current runs INSIDE the
 * store lock, applies `mutate`, and writes the result before releasing the lock
 * so concurrent processes (the parent orchestrator and worker subprocesses both
 * writing via the goals tool) can never lose each other's field-level updates.
 */
async function mutateGoalRunsLocked<T>(
  cwd: string,
  mutate: (
    runs: GoalRun[],
  ) =>
    | { runs: readonly GoalRun[]; result: T; write?: boolean }
    | Promise<{ runs: readonly GoalRun[]; result: T; write?: boolean }>,
): Promise<T> {
  return enqueueWrite(async () => {
    const normalizedCwd = normalizeProjectPath(cwd);
    const dir = projectDir(normalizedCwd);
    return withGoalStoreLock(dir, async () => {
      const runs = await readGoalRunsFile(normalizedCwd);
      const outcome = await mutate(runs);
      if (outcome.write !== false) {
        await writeGoalRunsFileCore(normalizedCwd, outcome.runs);
      }
      return outcome.result;
    });
  });
}

const GOAL_STORE_LOCK_WAIT_MS = 10_000;
const GOAL_STORE_STALE_LOCK_MS = 30_000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function shouldRemoveGoalStoreLock(lockPath: string): Promise<boolean> {
  let lockStats: Awaited<ReturnType<typeof stat>>;
  try {
    lockStats = await stat(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - lockStats.mtimeMs > GOAL_STORE_STALE_LOCK_MS) return true;

  try {
    const [pidLine] = (await readFile(lockPath, "utf-8")).split("\n");
    const pid = Number(pidLine?.trim());
    return !isProcessAlive(pid);
  } catch {
    return false;
  }
}

async function withGoalStoreLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, "goals.lock");
  const deadline = Date.now() + GOAL_STORE_LOCK_WAIT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
      await handle.close();
      try {
        return await fn();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (err) {
      await handle?.close().catch(() => undefined);
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await shouldRemoveGoalStoreLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tmpPath, path);
}

async function readGoalRunsFile(cwd: string): Promise<GoalRun[]> {
  const normalizedCwd = normalizeProjectPath(cwd);
  try {
    const data = await readFile(join(projectDir(normalizedCwd), "goals.json"), "utf-8");
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return sortNewestFirst(
      parsed
        .map((item) => normalizeRun(item, normalizedCwd))
        .filter((run): run is GoalRun => run !== null),
    );
  } catch {
    return [];
  }
}

export function hashPath(cwd: string): string {
  return createHash("sha256").update(normalizeProjectPath(cwd)).digest("hex").slice(0, 16);
}

export function projectDir(cwd: string): string {
  return join(goalsBaseDir(), hashPath(cwd));
}

async function discoverGoalRunsById(id: string): Promise<GoalRun | null> {
  try {
    const entries = await readdir(goalsBaseDir(), { withFileTypes: true });
    const matches: GoalRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const dir = join(goalsBaseDir(), entry.name);
        const meta = await readProjectMeta(dir);
        const fallbackProjectPath = meta?.path ?? dir;
        const data = await readFile(join(dir, "goals.json"), "utf-8");
        const parsed: unknown = JSON.parse(data);
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          const run = normalizeRun(item, fallbackProjectPath);
          if (run && (run.id === id || run.id.startsWith(id))) matches.push(run);
        }
      } catch {
        continue;
      }
    }
    return sortNewestFirst(matches)[0] ?? null;
  } catch {
    return null;
  }
}

async function readProjectMeta(dir: string): Promise<{ path?: string } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "meta.json"), "utf-8"));
    return isObject(parsed) && typeof parsed.path === "string" ? { path: parsed.path } : null;
  } catch {
    return null;
  }
}

export function createGoalTask(input: GoalTaskInput): GoalTask {
  return {
    id: input.id ?? randomUUID(),
    title: input.title,
    prompt: input.prompt,
    status: input.status ?? "pending",
    ...(input.workerId ? { workerId: input.workerId } : {}),
    attempts: input.attempts ?? 0,
    ...(input.dependsOn && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
    ...(input.parallelGroup ? { parallelGroup: input.parallelGroup } : {}),
    ...(input.expectedChangedScope && input.expectedChangedScope.length > 0
      ? { expectedChangedScope: input.expectedChangedScope }
      : {}),
    integration: foldGoalTaskIntegration(input.integration ?? input.mergeStrategy),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.candidate ? { candidate: input.candidate } : {}),
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.lastSummary ? { lastSummary: input.lastSummary } : {}),
  };
}

export function createGoalEvidence(input: GoalEvidenceInput): GoalEvidence {
  return {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    label: input.label,
    ...(input.path ? { path: input.path } : {}),
    ...(input.content ? { content: input.content } : {}),
    createdAt: input.createdAt ?? nowIso(),
  };
}

export function createGoalRun(cwd: string, input: GoalRunInput): GoalRun {
  const normalizedCwd = normalizeProjectPath(cwd);
  const timestamp = nowIso();
  const prerequisites = input.prerequisites ?? [];
  const status = deriveRunnableStatus(input.status ?? "draft", prerequisites);
  return {
    id: input.id ?? randomUUID(),
    title: input.title,
    goal: input.goal,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    projectPath: normalizedCwd,
    successCriteria: input.successCriteria ?? [],
    prerequisites,
    harness: input.harness ?? [],
    evidencePlan: input.evidencePlan ?? [],
    references: input.references ?? [],
    tasks: input.tasks ?? [],
    evidence: input.evidence ?? [],
    ...(input.verifier ? { verifier: input.verifier } : {}),
    ...(input.completionAudit ? { completionAudit: input.completionAudit } : {}),
    ...(input.integration ? { integration: input.integration } : {}),
    ...(input.lastSubstantiveWorkerAt
      ? { lastSubstantiveWorkerAt: input.lastSubstantiveWorkerAt }
      : {}),
    blockers: dedupeGoalBlockers(input.blockers ?? []),
    ...(input.activeWorkerId ? { activeWorkerId: input.activeWorkerId } : {}),
    ...(input.continueRequestedAt ? { continueRequestedAt: input.continueRequestedAt } : {}),
  };
}

export async function loadGoalRuns(cwd: string): Promise<GoalRun[]> {
  return readGoalRunsFile(cwd);
}

export function loadGoalRunsSync(cwd: string): GoalRun[] {
  const normalizedCwd = normalizeProjectPath(cwd);
  try {
    const data = readFileSync(join(projectDir(normalizedCwd), "goals.json"), "utf-8");
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return sortNewestFirst(
      parsed
        .map((item) => normalizeRun(item, normalizedCwd))
        .filter((run): run is GoalRun => run !== null),
    );
  } catch {
    return [];
  }
}

export async function saveGoalRuns(cwd: string, runs: readonly GoalRun[]): Promise<void> {
  return enqueueWrite(() => writeGoalRunsFile(cwd, runs));
}

export function saveGoalRunsSync(cwd: string, runs: readonly GoalRun[]): void {
  const normalizedCwd = normalizeProjectPath(cwd);
  const sorted = sortNewestFirst([...runs]);
  writeFileSync(
    join(projectDir(normalizedCwd), "goals.json"),
    JSON.stringify(sorted, null, 2) + "\n",
    "utf-8",
  );
}

export async function reconcileActiveGoalRuns(
  cwd: string,
  options: ReconcileActiveGoalRunsOptions = {},
): Promise<GoalReconciliationResult> {
  return mutateGoalRunsLocked(cwd, (runs) => {
    const timestamp = nowIso();
    const repairedRunIds: string[] = [];
    let evidenceCount = 0;
    const nextRuns = runs.map((run): GoalRun => {
      let next = run;
      const evidence: GoalEvidence[] = [];
      const blockers = new Set(run.blockers);
      let repaired = false;

      if (run.activeWorkerId && !options.isWorkerActive?.(run.activeWorkerId, run)) {
        const workerId = run.activeWorkerId;
        next = { ...next, activeWorkerId: undefined };
        evidence.push(
          createGoalEvidence({
            kind: "summary",
            label: "Goal worker reconciled",
            content: `Cleared stale activeWorkerId ${workerId}; no in-memory Goal worker was observed after startup/runtime reconciliation.`,
            createdAt: timestamp,
          }),
        );
        repaired = true;
      }

      const tasks = next.tasks.map((task) => {
        if (task.status !== "running" && task.status !== "verifying") return task;
        const workerId = task.workerId;
        if (workerId && options.isWorkerActive?.(workerId, run)) return task;
        repaired = true;
        evidence.push(
          createGoalEvidence({
            kind: "summary",
            label: "Goal task reconciled",
            content: `Reset stale task "${task.title}" (${task.id}) from ${task.status} to pending; no in-memory worker/verifier was observed.`,
            createdAt: timestamp,
          }),
        );
        return {
          ...task,
          status: "pending" as const,
          lastSummary: `Reset from stale ${task.status} state during Goal reconciliation.`,
        };
      });
      next = { ...next, tasks };

      if (next.status === "running") {
        const hasRunningWorker =
          next.activeWorkerId !== undefined &&
          options.isWorkerActive?.(next.activeWorkerId, run) === true;
        const hasActiveTask = next.tasks.some(
          (task) =>
            (task.status === "running" || task.status === "verifying") &&
            task.workerId !== undefined &&
            options.isWorkerActive?.(task.workerId, run) === true,
        );
        if (!hasRunningWorker && !hasActiveTask) {
          next = { ...next, status: "ready" };
          repaired = true;
        }
      } else if (next.status === "verifying" && !options.isVerifierActive?.(next)) {
        const blocker = "Verifier was interrupted; rerun or continue the Goal to verify again.";
        blockers.add(blocker);
        evidence.push(
          createGoalEvidence({
            kind: "summary",
            label: "Goal verifier reconciled",
            content:
              "Reset stale verifying state to ready because no in-memory verifier process was observed.",
            createdAt: timestamp,
          }),
        );
        next = { ...next, status: "ready" };
        repaired = true;
      }

      if (!repaired) return run;
      repairedRunIds.push(run.id);
      evidenceCount += evidence.length;
      return {
        ...next,
        evidence: [...next.evidence, ...evidence],
        blockers: dedupeGoalBlockers([...blockers]),
        updatedAt: timestamp,
      };
    });

    return {
      runs: nextRuns,
      write: repairedRunIds.length > 0,
      result: { runs: sortNewestFirst(nextRuns), repairedRunIds, evidenceCount },
    };
  });
}

export async function upsertGoalRun(cwd: string, input: GoalRun | GoalRunInput): Promise<GoalRun> {
  return mutateGoalRunsLocked(cwd, (runs) => {
    const existingIndex = input.id ? runs.findIndex((run) => run.id === input.id) : -1;
    const existing = existingIndex >= 0 ? runs[existingIndex] : undefined;
    const merged: GoalRun = existing
      ? {
          ...existing,
          ...input,
          id: existing.id,
          projectPath: normalizeProjectPath(cwd),
          createdAt: existing.createdAt,
          updatedAt: nowIso(),
          successCriteria: input.successCriteria ?? existing.successCriteria,
          prerequisites: input.prerequisites ?? existing.prerequisites,
          harness: input.harness ?? existing.harness,
          evidencePlan: input.evidencePlan ?? existing.evidencePlan,
          references: mergeGoalReferences(existing.references ?? [], input.references),
          tasks: mergeGoalTasks(existing.tasks, input.tasks),
          evidence: mergeGoalEvidence(existing.evidence, input.evidence),
          blockers: input.blockers
            ? dedupeGoalBlockers(input.blockers)
            : dedupeGoalBlockers(existing.blockers),
          status: deriveRunnableStatus(
            input.status ?? existing.status,
            input.prerequisites ?? existing.prerequisites,
          ),
        }
      : createGoalRun(cwd, input);

    const nextRuns = existingIndex >= 0 ? [...runs] : [merged, ...runs];
    if (existingIndex >= 0) nextRuns[existingIndex] = merged;
    return { runs: nextRuns, result: merged };
  });
}

export async function getGoalRun(cwd: string, id: string): Promise<GoalRun | null> {
  const runs = await loadGoalRuns(cwd);
  return (
    runs.find((run) => run.id === id || run.id.startsWith(id)) ?? (await discoverGoalRunsById(id))
  );
}

export async function getActiveGoalRun(cwd: string): Promise<GoalRun | null> {
  const runs = await loadGoalRuns(cwd);
  return (
    runs.find((run) => run.status === "running" || run.status === "verifying") ??
    runs.find((run) => run.status === "ready" || run.status === "blocked") ??
    runs.find((run) => run.status === "draft" || run.status === "paused") ??
    runs[0] ??
    null
  );
}

export async function appendGoalDecision(
  cwd: string,
  runId: string,
  decision: GoalControllerDecision | { kind: string; reason?: string; content?: string },
): Promise<GoalRun | null> {
  const parts = [`kind=${decision.kind}`];
  if ("reason" in decision && decision.reason) parts.push(`reason=${decision.reason}`);
  if ("content" in decision && decision.content) parts.push(decision.content);
  if ("task" in decision && decision.task) {
    const task = decision.task as GoalTask;
    parts.push(`task=${task.id}`, `title=${task.title}`);
    if (task.workerId) parts.push(`worker=${task.workerId}`);
  }
  if ("attempts" in decision && typeof decision.attempts === "number")
    parts.push(`attempts=${decision.attempts}`);
  if ("workerId" in decision && decision.workerId) parts.push(`worker=${decision.workerId}`);
  if ("command" in decision && decision.command) parts.push(`verifier=${decision.command}`);
  if ("status" in decision && decision.status) parts.push(`status=${decision.status}`);
  parts.push(`timestamp=${nowIso()}`);
  return appendGoalEvidence(cwd, runId, {
    kind: "summary",
    label: `Goal decision: ${decision.kind}`,
    content: parts.join("; "),
  });
}

export async function appendGoalEvidence(
  cwd: string,
  runId: string,
  input: GoalEvidenceInput,
): Promise<GoalRun | null> {
  const discovered = await getGoalRun(cwd, runId);
  const writeCwd = discovered?.projectPath ?? cwd;
  return mutateGoalRunsLocked(writeCwd, (runs) => {
    const index = runs.findIndex((run) => run.id === runId || run.id.startsWith(runId));
    if (index === -1) return { runs, result: null, write: false };
    const run = runs[index];
    const updated: GoalRun = {
      ...run,
      evidence: [...run.evidence, createGoalEvidence(input)],
      updatedAt: nowIso(),
    };
    const nextRuns = [...runs];
    nextRuns[index] = updated;
    return { runs: nextRuns, result: updated };
  });
}

export async function updateGoalTask(
  cwd: string,
  runId: string,
  taskId: string,
  patch: Partial<GoalTask> | GoalTaskInput,
): Promise<GoalRun | null> {
  const discovered = await getGoalRun(cwd, runId);
  const writeCwd = discovered?.projectPath ?? cwd;
  return mutateGoalRunsLocked(writeCwd, (runs) => {
    const runIndex = runs.findIndex((run) => run.id === runId || run.id.startsWith(runId));
    if (runIndex === -1) return { runs, result: null, write: false };
    const run = runs[runIndex];
    const taskIndex = run.tasks.findIndex(
      (task) => task.id === taskId || task.id.startsWith(taskId),
    );
    const tasks = [...run.tasks];
    if (taskIndex === -1) {
      if ("title" in patch && "prompt" in patch && patch.title && patch.prompt) {
        tasks.push(
          createGoalTask({
            ...patch,
            title: patch.title,
            prompt: patch.prompt,
          }),
        );
      } else {
        return { runs, result: null, write: false };
      }
    } else {
      const existingTask = tasks[taskIndex];
      tasks[taskIndex] = {
        ...existingTask,
        ...patch,
        id: existingTask.id,
        title: patch.title ?? existingTask.title,
        prompt: patch.prompt ?? existingTask.prompt,
      };
    }

    const updated: GoalRun = { ...run, tasks, updatedAt: nowIso() };
    const nextRuns = [...runs];
    nextRuns[runIndex] = updated;
    return { runs: nextRuns, result: updated };
  });
}

/**
 * Record the typed integration state from code (git truth), so the controller
 * never has to parse evidence labels to know whether candidates reached main.
 */
export async function setGoalIntegrationState(
  cwd: string,
  runId: string,
  state: GoalIntegrationState,
): Promise<GoalRun | null> {
  const discovered = await getGoalRun(cwd, runId);
  const writeCwd = discovered?.projectPath ?? cwd;
  return mutateGoalRunsLocked(writeCwd, (runs) => {
    const index = runs.findIndex((run) => run.id === runId || run.id.startsWith(runId));
    if (index === -1) return { runs, result: null, write: false };
    const run = runs[index];
    const updated: GoalRun = { ...run, integration: state, updatedAt: nowIso() };
    const nextRuns = [...runs];
    nextRuns[index] = updated;
    return { runs: nextRuns, result: updated };
  });
}

/**
 * Stamp the most recent substantive (non-audit, non-integration) worker
 * completion time, driving verifier/audit staleness deterministically.
 */
export async function recordGoalSubstantiveWorker(
  cwd: string,
  runId: string,
  atIso: string,
): Promise<GoalRun | null> {
  const discovered = await getGoalRun(cwd, runId);
  const writeCwd = discovered?.projectPath ?? cwd;
  return mutateGoalRunsLocked(writeCwd, (runs) => {
    const index = runs.findIndex((run) => run.id === runId || run.id.startsWith(runId));
    if (index === -1) return { runs, result: null, write: false };
    const run = runs[index];
    const updated: GoalRun = { ...run, lastSubstantiveWorkerAt: atIso, updatedAt: nowIso() };
    const nextRuns = [...runs];
    nextRuns[index] = updated;
    return { runs: nextRuns, result: updated };
  });
}

/**
 * Infer whether a prerequisite is locally resolvable by the agent or genuinely
 * external (user-supplied). An explicit `kind` wins; otherwise a runnable
 * `checkCommand` implies the agent can both check and satisfy it locally.
 */
export function prerequisiteKind(item: GoalPrerequisite): GoalPrerequisiteKind {
  if (item.kind) return item.kind;
  return item.checkCommand?.trim() ? "local" : "external";
}

function isUnmetGoalPrerequisite(item: GoalPrerequisite): boolean {
  return item.status !== "met" || !item.evidence?.trim();
}

/**
 * Local unmet prerequisites no longer block the Goal — the controller schedules
 * a worker task to resolve them. Only unmet **external** prerequisites (true
 * user-supplied inputs) are blocking.
 */
export function isBlockingGoalPrerequisite(item: GoalPrerequisite): boolean {
  return isUnmetGoalPrerequisite(item) && prerequisiteKind(item) === "external";
}

export function isUnmetLocalGoalPrerequisite(item: GoalPrerequisite): boolean {
  return isUnmetGoalPrerequisite(item) && prerequisiteKind(item) === "local";
}

export function unmetLocalGoalPrerequisites(run: GoalRun): GoalPrerequisite[] {
  return run.prerequisites.filter(isUnmetLocalGoalPrerequisite);
}

export function goalHasUnmetLocalPrerequisites(run: GoalRun): boolean {
  return run.prerequisites.some(isUnmetLocalGoalPrerequisite);
}

export function hasBlockingGoalPrerequisites(prerequisites: readonly GoalPrerequisite[]): boolean {
  return prerequisites.some(isBlockingGoalPrerequisite);
}

export function goalHasBlockingPrerequisites(run: GoalRun): boolean {
  return hasBlockingGoalPrerequisites(run.prerequisites);
}

export function formatGoalPrerequisiteInstruction(item: GoalPrerequisite): string {
  const instructions = item.instructions?.trim();
  if (instructions) return instructions;
  if (item.status === "met" && !item.evidence?.trim()) {
    return "Prerequisite is marked met but has no recorded check evidence; verify it locally and record non-secret evidence.";
  }
  if (item.status === "unknown") {
    return "Check this prerequisite locally and record non-secret evidence before workers can start.";
  }
  return "User must provide this prerequisite.";
}

export function formatGoalBlockingPrerequisiteList(
  prerequisites: readonly GoalPrerequisite[],
): string {
  const missing = prerequisites.filter(isBlockingGoalPrerequisite);
  if (missing.length === 0) return "Goal has no missing user prerequisites.";
  return missing
    .map((item) => `${item.label}: ${formatGoalPrerequisiteInstruction(item)}`)
    .join("; ");
}

export function formatGoalBlockingPrerequisites(run: GoalRun): string {
  return formatGoalBlockingPrerequisiteList(run.prerequisites);
}

export function summarizeGoalCountsFromRuns(runs: readonly GoalRun[]): GoalCounts {
  const counts: GoalCounts = {
    total: runs.length,
    active: 0,
    blocked: 0,
    pending: 0,
    running: 0,
    passed: 0,
    failed: 0,
  };

  for (const run of runs) {
    if (run.status === "blocked") counts.blocked++;
    if (run.status === "running" || run.status === "verifying") counts.running++;
    if (run.status === "passed") counts.passed++;
    if (run.status === "failed") counts.failed++;
    if (run.status === "draft" || run.status === "ready" || run.status === "paused")
      counts.pending++;
    if (run.status !== "passed" && run.status !== "failed") counts.active++;
  }

  return counts;
}

export async function summarizeGoalCounts(cwd: string): Promise<GoalCounts> {
  return summarizeGoalCountsFromRuns(await loadGoalRuns(cwd));
}

async function writeGoalProgressJournalFromRun(cwd: string, run: GoalRun): Promise<string> {
  const dir = join(projectDir(cwd), "journals");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${run.id}.md`);
  const lines = [
    `# ${run.title}`,
    "",
    `Status: ${run.status}`,
    `Goal: ${run.goal}`,
    "",
    "## Success criteria",
    ...(run.successCriteria.length
      ? run.successCriteria.map((item) => `- ${item}`)
      : ["- none recorded"]),
    "",
    "## Prerequisites",
    ...(run.prerequisites.length
      ? run.prerequisites.map(
          (item) => `- [${item.status}] ${item.label}${item.evidence ? ` — ${item.evidence}` : ""}`,
        )
      : ["- none"]),
    "",
    "## References",
    ...(run.references?.length
      ? run.references.map(
          (item) =>
            `- [${item.kind}] ${item.id}: ${item.label}${item.value ? ` — ${item.value}` : ""}${item.path ? ` (${item.path})` : ""}`,
        )
      : ["- none"]),
    "",
    "## Tasks",
    ...(run.tasks.length
      ? run.tasks.map(
          (task) =>
            `- [${task.status}] ${task.title} (attempts: ${task.attempts})${task.lastSummary ? ` — ${task.lastSummary}` : ""}`,
        )
      : ["- none"]),
    "",
    "## Verifier",
    run.verifier?.lastResult
      ? `- ${run.verifier.lastResult.status}: ${run.verifier.lastResult.summary}${run.verifier.lastResult.outputPath ? ` (${run.verifier.lastResult.outputPath})` : ""}`
      : `- ${run.verifier?.command ?? "none"}`,
    "",
    "## Final completion audit",
    run.completionAudit
      ? `- ${run.completionAudit.status}: ${run.completionAudit.summary}${run.completionAudit.outputPath ? ` (${run.completionAudit.outputPath})` : ""}`
      : "- none",
    "",
    "## Blockers",
    ...(run.blockers.length ? run.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Recent evidence",
    ...run.evidence
      .slice(-10)
      .map(
        (item) =>
          `- ${item.createdAt} [${item.kind}] ${item.label}${item.path ? ` (${item.path})` : ""}${item.content ? ` — ${item.content}` : ""}`,
      ),
    "",
  ];
  await writeFile(path, lines.join("\n"), "utf-8");
  return path;
}

export async function writeGoalProgressJournal(cwd: string, runId: string): Promise<string | null> {
  const run = await getGoalRun(cwd, runId);
  if (!run) return null;
  return writeGoalProgressJournalFromRun(run.projectPath, run);
}
