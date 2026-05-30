import { DEFAULT_GOAL_VERIFIER_FIX_LIMIT } from "../core/goal-controller.js";
import {
  formatGoalBlockingPrerequisites,
  goalHasBlockingPrerequisites,
  type GoalRun,
} from "../core/goal-store.js";
import type { GoalWorkerCompletion, GoalWorkerToolUse } from "../core/goal-worker.js";

export const GOAL_WORKER_EVENT_PREFIX = "[event:goal_worker_complete]";
export const GOAL_VERIFIER_EVENT_PREFIX = "[event:goal_verifier_complete]";
export const GOAL_EVENT_PAYLOAD_PREFIX = "goal_event_payload: ";
export const GOAL_EVENT_PAYLOAD_VERSION = 1;

export type GoalSyntheticEventKind = "worker" | "verifier";

export interface GoalTaskStateSnapshot {
  id: string;
  title: string;
  status: GoalRun["tasks"][number]["status"];
  attempts: number;
  workerId?: string;
  dependsOn?: string[];
  parallelGroup?: string;
  expectedChangedScope?: string[];
  integration?: GoalRun["tasks"][number]["integration"];
}

export interface GoalPrerequisiteStateSnapshot {
  id: string;
  label: string;
  status: GoalRun["prerequisites"][number]["status"];
  instructions?: string;
  evidence?: string;
}

export interface GoalEvidencePlanStateSnapshot {
  id: string;
  label: string;
  status: GoalRun["evidencePlan"][number]["status"];
  mechanism: GoalRun["evidencePlan"][number]["mechanism"];
  command?: string;
  path?: string;
  evidence?: string;
}

export interface GoalVerifierStateSnapshot {
  description: string;
  command?: string;
  cwd?: string;
  lastStatus?: NonNullable<NonNullable<GoalRun["verifier"]>["lastResult"]>["status"];
  outputPath?: string;
}

export interface GoalEvidenceStateSnapshot {
  label: string;
  kind: GoalRun["evidence"][number]["kind"];
  path?: string;
}

export interface GoalReferenceStateSnapshot {
  id: string;
  kind: NonNullable<GoalRun["references"]>[number]["kind"];
  label: string;
  value?: string;
  path?: string;
}

export interface GoalStateSnapshot {
  status: GoalRun["status"];
  userPrerequisites: string;
  verifier: GoalVerifierStateSnapshot | null;
  blockers: string[];
  prerequisites: GoalPrerequisiteStateSnapshot[];
  evidencePlan: GoalEvidencePlanStateSnapshot[];
  references: GoalReferenceStateSnapshot[];
  tasks: GoalTaskStateSnapshot[];
  evidenceCount: number;
  latestEvidence?: GoalEvidenceStateSnapshot;
}

export interface GoalSyntheticEventPayloadBase {
  version: typeof GOAL_EVENT_PAYLOAD_VERSION;
  kind: GoalSyntheticEventKind;
  runId: string;
  goal: string;
  status: string;
  exitCode: number;
  summary: string;
  summaryRedacted: boolean;
  goalState: GoalStateSnapshot;
}

export interface GoalWorkerSyntheticEventPayload extends GoalSyntheticEventPayloadBase {
  kind: "worker";
  taskId: string;
  task: string;
  worker: string;
  workerLogFile: string;
  toolsUsed: GoalWorkerToolUse[];
  reason?: GoalWorkerCompletion["reason"];
}

export interface GoalVerifierSyntheticEventPayload extends GoalSyntheticEventPayloadBase {
  kind: "verifier";
  command: string;
  outputPath?: string;
  fixAttempts: number;
  fixLimit: number;
  completionGuidance: string;
}

export type GoalSyntheticEventPayload =
  | GoalWorkerSyntheticEventPayload
  | GoalVerifierSyntheticEventPayload;

export interface GoalSyntheticEventInfo {
  kind: GoalSyntheticEventKind;
  runId?: string;
  goal?: string;
  taskId?: string;
  task?: string;
  worker?: string;
  status?: string;
  exitCode?: number;
  summary?: string;
  command?: string;
  outputPath?: string;
  toolsUsed?: GoalWorkerToolUse[];
  fixAttempts?: number;
  fixLimit?: number;
  goalState?: GoalStateSnapshot;
  payload?: GoalSyntheticEventPayload;
}

const GOAL_ORCHESTRATOR_INSTRUCTIONS = `coordinator_instructions:
1. Call goals({ action: "status", run_id }) before deciding.
2. Briefly say what you are doing as the coordinator so the chat shows progress.
3. Inspect durable tasks, verifier state, blockers, and evidence. Also inspect Goal references.
4. Take exactly one next control-loop action: add/update the next Goal task, run/record verification, run/record the final completion audit, pause/block with evidence, or complete only if verifier plus final-audit evidence proves the success criteria and mandatory references.
5. Do not merely narrate and do not ask the user to open the Goal pane.`;

function headerValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ");
}

const SENSITIVE_GOAL_EVENT_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|AUTH)[A-Z0-9_]*\s*=\s*[^\s'"]+/gi,
  /\b(?:sk|pk|ghp|gho|github_pat|glpat|xox[baprs])-[-_A-Za-z0-9]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const REDACTION_MARKER = "[REDACTED_GOAL_EVENT_SECRET]";

export function sanitizeGoalSyntheticEventText(value: string): { text: string; redacted: boolean } {
  let text = value;
  for (const pattern of SENSITIVE_GOAL_EVENT_PATTERNS) {
    text = text.replace(pattern, REDACTION_MARKER);
  }
  return { text, redacted: text !== value };
}

function formatPayloadLine(payload: GoalSyntheticEventPayload): string {
  return `${GOAL_EVENT_PAYLOAD_PREFIX}${JSON.stringify(payload)}`;
}

export function buildGoalStateSnapshot(run: GoalRun): GoalStateSnapshot {
  const latestEvidence = run.evidence.at(-1);
  return {
    status: run.status,
    userPrerequisites: goalHasBlockingPrerequisites(run)
      ? formatGoalBlockingPrerequisites(run)
      : "(none)",
    verifier: run.verifier
      ? {
          description: run.verifier.description,
          ...(run.verifier.command ? { command: run.verifier.command } : {}),
          ...(run.verifier.cwd ? { cwd: run.verifier.cwd } : {}),
          ...(run.verifier.lastResult
            ? {
                lastStatus: run.verifier.lastResult.status,
                ...(run.verifier.lastResult.outputPath
                  ? { outputPath: run.verifier.lastResult.outputPath }
                  : {}),
              }
            : {}),
        }
      : null,
    blockers: [...run.blockers],
    prerequisites: run.prerequisites.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      ...(item.instructions ? { instructions: item.instructions } : {}),
      ...(item.evidence ? { evidence: item.evidence } : {}),
    })),
    evidencePlan: run.evidencePlan.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      mechanism: item.mechanism,
      ...(item.command ? { command: item.command } : {}),
      ...(item.path ? { path: item.path } : {}),
      ...(item.evidence ? { evidence: item.evidence } : {}),
    })),
    references: (run.references ?? []).map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      ...(item.value ? { value: item.value } : {}),
      ...(item.path ? { path: item.path } : {}),
    })),
    tasks: run.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      attempts: task.attempts,
      ...(task.workerId ? { workerId: task.workerId } : {}),
      ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}),
      ...(task.parallelGroup ? { parallelGroup: task.parallelGroup } : {}),
      ...(task.expectedChangedScope?.length
        ? { expectedChangedScope: task.expectedChangedScope }
        : {}),
      ...(task.integration ? { integration: task.integration } : {}),
    })),
    evidenceCount: run.evidence.length,
    ...(latestEvidence
      ? {
          latestEvidence: {
            label: latestEvidence.label,
            kind: latestEvidence.kind,
            ...(latestEvidence.path ? { path: latestEvidence.path } : {}),
          },
        }
      : {}),
  };
}

function formatGoalState(snapshot: GoalStateSnapshot): string {
  const tasks =
    snapshot.tasks
      .map((task) => {
        const metadata = [
          task.dependsOn?.length ? `depends_on=${task.dependsOn.join(",")}` : undefined,
          task.parallelGroup ? `parallel_group=${task.parallelGroup}` : undefined,
          task.expectedChangedScope?.length
            ? `expected_changed_scope=${task.expectedChangedScope.join(",")}`
            : undefined,
          task.integration ? `integration=${task.integration}` : undefined,
        ]
          .filter((item): item is string => item !== undefined)
          .join("; ");
        return `- ${task.id}: ${task.status}; attempts=${task.attempts}; title=${task.title}${metadata ? `; ${metadata}` : ""}`;
      })
      .join("\n") || "(none)";
  const blockers =
    snapshot.blockers.length > 0
      ? snapshot.blockers.map((blocker) => `- ${blocker}`).join("\n")
      : "(none)";
  const verifier = snapshot.verifier?.command
    ? `${snapshot.verifier.command}; cwd=${snapshot.verifier.cwd ?? "main"}; last=${snapshot.verifier.lastStatus ?? "none"}; output=${snapshot.verifier.outputPath ?? "none"}`
    : "(none - define an exact verifier before completion)";
  const prerequisites = snapshot.prerequisites.length
    ? snapshot.prerequisites
        .map(
          (item) =>
            `- ${item.id}: ${item.status}; ${item.label}${item.instructions ? `; instructions=${item.instructions}` : ""}${item.evidence ? `; evidence=${item.evidence}` : ""}`,
        )
        .join("\n")
    : "(none)";
  const evidencePlan = snapshot.evidencePlan.length
    ? snapshot.evidencePlan.map((item) => `- ${item.id}: ${item.status}; ${item.label}`).join("\n")
    : "(none)";
  const references = snapshot.references.length
    ? snapshot.references
        .map(
          (item) =>
            `- ${item.id}: ${item.kind}; ${item.label}${item.value ? `; value=${item.value}` : ""}${item.path ? `; path=${item.path}` : ""}`,
        )
        .join("\n")
    : "(none)";
  const latestEvidence = snapshot.latestEvidence
    ? `${snapshot.latestEvidence.label}${snapshot.latestEvidence.path ? ` (${snapshot.latestEvidence.path})` : ""}`
    : "(none)";
  return `current_goal_state:\nstatus: ${snapshot.status}\nuser_prerequisites: ${snapshot.userPrerequisites}\nverifier: ${verifier}\nevidence_count: ${snapshot.evidenceCount}\nlatest_evidence: ${latestEvidence}\nblockers:\n${blockers}\nprerequisites:\n${prerequisites}\nevidence_plan:\n${evidencePlan}\nreferences:\n${references}\ntasks:\n${tasks}`;
}

export function buildGoalWorkerSyntheticEventPayload(
  run: GoalRun,
  taskTitle: string,
  completion: GoalWorkerCompletion,
): GoalWorkerSyntheticEventPayload {
  const sanitizedSummary = sanitizeGoalSyntheticEventText(completion.summary.trim() || "(empty)");
  const stateSnapshot = buildGoalStateSnapshot(run);
  const stateJson = JSON.stringify(stateSnapshot);
  const sanitizedStateJson = sanitizeGoalSyntheticEventText(stateJson);
  return {
    version: GOAL_EVENT_PAYLOAD_VERSION,
    kind: "worker",
    runId: run.id,
    goal: run.title,
    taskId: completion.worker.goalTaskId,
    task: taskTitle,
    worker: completion.worker.id,
    workerLogFile: completion.worker.logFile,
    status: completion.status,
    exitCode: completion.exitCode,
    toolsUsed: [...completion.toolsUsed],
    summary: sanitizedSummary.text,
    summaryRedacted: sanitizedSummary.redacted || sanitizedStateJson.redacted,
    goalState: JSON.parse(sanitizedStateJson.text) as GoalStateSnapshot,
    ...(completion.reason ? { reason: completion.reason } : {}),
  };
}

export function formatGoalWorkerCompletionEvent(
  run: GoalRun,
  taskTitle: string,
  completion: GoalWorkerCompletion,
): string {
  const payload = buildGoalWorkerSyntheticEventPayload(run, taskTitle, completion);
  const toolsUsed =
    payload.toolsUsed.length > 0
      ? payload.toolsUsed.map((tool) => `${tool.ok ? "✓" : "✗"}${tool.name}`).join(", ")
      : "(none)";
  const reason = payload.reason ? ` reason=${payload.reason}` : "";
  const redactionNotice = payload.summaryRedacted
    ? "\nredaction_notice: summary contained secret-like material and was redacted before synthetic-event handoff"
    : "";
  return `${GOAL_WORKER_EVENT_PREFIX} run_id="${headerValue(payload.runId)}" goal="${headerValue(payload.goal)}" task_id="${headerValue(payload.taskId)}" task="${headerValue(payload.task)}" worker="${headerValue(payload.worker)}" status=${payload.status} exit_code=${payload.exitCode}${reason}
${formatPayloadLine(payload)}
tools_used: ${toolsUsed}${redactionNotice}
${formatGoalState(payload.goalState)}
summary:
${payload.summary}

${GOAL_ORCHESTRATOR_INSTRUCTIONS}`;
}

export function buildGoalVerifierSyntheticEventPayload(
  run: GoalRun,
  status: "pass" | "fail",
  command: string,
  exitCode: number,
  summary: string,
): GoalVerifierSyntheticEventPayload {
  const fixAttempts = run.tasks.filter((task) => task.title === "Fix verifier failure").length;
  const outputPath = run.verifier?.lastResult?.outputPath;
  const sanitizedSummary = sanitizeGoalSyntheticEventText(summary.trim() || "(empty)");
  const stateSnapshot = buildGoalStateSnapshot(run);
  const stateJson = JSON.stringify(stateSnapshot);
  const sanitizedStateJson = sanitizeGoalSyntheticEventText(stateJson);
  return {
    version: GOAL_EVENT_PAYLOAD_VERSION,
    kind: "verifier",
    runId: run.id,
    goal: run.title,
    status,
    exitCode,
    command,
    ...(outputPath ? { outputPath } : {}),
    fixAttempts,
    fixLimit: DEFAULT_GOAL_VERIFIER_FIX_LIMIT,
    completionGuidance:
      status === "pass"
        ? "Complete only if goals(status) shows success criteria, required evidence, verifier output, and final completion audit match the original objective exactly. If the final audit is missing or stale, create/run that audit before completion."
        : "Create one bounded fix task with the verifier command, exit code, output path, and failure summary unless the limit or repeated-failure guard is reached.",
    summary: sanitizedSummary.text,
    summaryRedacted: sanitizedSummary.redacted || sanitizedStateJson.redacted,
    goalState: JSON.parse(sanitizedStateJson.text) as GoalStateSnapshot,
  };
}

export function formatGoalVerifierCompletionEvent(
  run: GoalRun,
  status: "pass" | "fail",
  command: string,
  exitCode: number,
  summary: string,
): string {
  const payload = buildGoalVerifierSyntheticEventPayload(run, status, command, exitCode, summary);
  return `${GOAL_VERIFIER_EVENT_PREFIX} run_id="${headerValue(payload.runId)}" goal="${headerValue(payload.goal)}" status=${payload.status} exit_code=${payload.exitCode}
${formatPayloadLine(payload)}
command: ${payload.command}
output_path: ${payload.outputPath ?? "not recorded"}
fix_attempts: ${payload.fixAttempts}/${payload.fixLimit}
completion_guidance: ${payload.completionGuidance}
${formatGoalState(payload.goalState)}
summary:
${payload.summary}

${GOAL_ORCHESTRATOR_INSTRUCTIONS}`;
}

export function isGoalSyntheticEvent(text: string): boolean {
  return text.startsWith(GOAL_WORKER_EVENT_PREFIX) || text.startsWith(GOAL_VERIFIER_EVENT_PREFIX);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGoalWorkerToolUse(value: unknown): value is GoalWorkerToolUse {
  return isObject(value) && typeof value.name === "string" && typeof value.ok === "boolean";
}

function isGoalWorkerToolUseArray(value: unknown): value is GoalWorkerToolUse[] {
  return Array.isArray(value) && value.every(isGoalWorkerToolUse);
}

function isGoalStateSnapshot(value: unknown): value is GoalStateSnapshot {
  if (!isObject(value)) return false;
  if (typeof value.status !== "string") return false;
  if (typeof value.userPrerequisites !== "string") return false;
  if (!isStringArray(value.blockers)) return false;
  if (!Array.isArray(value.prerequisites)) return false;
  if (!Array.isArray(value.evidencePlan)) return false;
  if (!Array.isArray(value.tasks)) return false;
  if (typeof value.evidenceCount !== "number") return false;
  if (value.verifier !== null && value.verifier !== undefined && !isObject(value.verifier)) {
    return false;
  }
  if (value.latestEvidence !== undefined && !isObject(value.latestEvidence)) return false;
  return true;
}

function isGoalSyntheticEventPayload(value: unknown): value is GoalSyntheticEventPayload {
  if (!isObject(value)) return false;
  if (value.version !== GOAL_EVENT_PAYLOAD_VERSION) return false;
  if (value.kind !== "worker" && value.kind !== "verifier") return false;
  if (typeof value.runId !== "string") return false;
  if (typeof value.goal !== "string") return false;
  if (typeof value.status !== "string") return false;
  if (typeof value.exitCode !== "number") return false;
  if (typeof value.summary !== "string") return false;
  if (typeof value.summaryRedacted !== "boolean") return false;
  if (!isGoalStateSnapshot(value.goalState)) return false;

  if (value.kind === "worker") {
    return (
      typeof value.taskId === "string" &&
      typeof value.task === "string" &&
      typeof value.worker === "string" &&
      typeof value.workerLogFile === "string" &&
      isGoalWorkerToolUseArray(value.toolsUsed) &&
      (value.reason === undefined || typeof value.reason === "string")
    );
  }

  return (
    typeof value.command === "string" &&
    typeof value.fixAttempts === "number" &&
    typeof value.fixLimit === "number" &&
    typeof value.completionGuidance === "string" &&
    (value.outputPath === undefined || typeof value.outputPath === "string")
  );
}

function normalizeParsedGoalStateSnapshot(value: unknown): unknown {
  if (!isObject(value)) return value;
  return {
    references: [],
    ...value,
  };
}

function normalizeParsedGoalSyntheticEventPayload(value: unknown): unknown {
  if (!isObject(value)) return value;
  return {
    ...value,
    summaryRedacted: typeof value.summaryRedacted === "boolean" ? value.summaryRedacted : false,
    goalState: normalizeParsedGoalStateSnapshot(value.goalState),
  };
}

function parsePayload(text: string): GoalSyntheticEventPayload | null {
  const payloadLine = text.split("\n").find((line) => line.startsWith(GOAL_EVENT_PAYLOAD_PREFIX));
  if (!payloadLine) return null;
  try {
    const parsed: unknown = JSON.parse(payloadLine.slice(GOAL_EVENT_PAYLOAD_PREFIX.length));
    const normalized = normalizeParsedGoalSyntheticEventPayload(parsed);
    return isGoalSyntheticEventPayload(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function quotedField(text: string, field: string): string | undefined {
  const match = new RegExp(`${field}="((?:\\\\.|[^"])*)"`).exec(text);
  if (!match) return undefined;
  try {
    const parsed: unknown = JSON.parse(`"${match[1]}"`);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function tokenField(text: string, field: string): string | undefined {
  const match = new RegExp(`${field}=([^\\s\\n]+)`).exec(text);
  return match?.[1];
}

function goalSyntheticEventInfoFromPayload(
  payload: GoalSyntheticEventPayload,
): GoalSyntheticEventInfo {
  const base = {
    kind: payload.kind,
    runId: payload.runId,
    goal: payload.goal,
    status: payload.status,
    exitCode: payload.exitCode,
    summary: payload.summary,
    goalState: payload.goalState,
    payload,
  };

  if (payload.kind === "worker") {
    return {
      ...base,
      taskId: payload.taskId,
      task: payload.task,
      worker: payload.worker,
      toolsUsed: payload.toolsUsed,
    };
  }

  return {
    ...base,
    command: payload.command,
    ...(payload.outputPath ? { outputPath: payload.outputPath } : {}),
    fixAttempts: payload.fixAttempts,
    fixLimit: payload.fixLimit,
  };
}

export function parseGoalSyntheticEvent(text: string): GoalSyntheticEventInfo | null {
  const kind = text.startsWith(GOAL_WORKER_EVENT_PREFIX)
    ? "worker"
    : text.startsWith(GOAL_VERIFIER_EVENT_PREFIX)
      ? "verifier"
      : null;
  if (kind === null) return null;

  const payload = parsePayload(text);
  if (payload) return goalSyntheticEventInfoFromPayload(payload);

  const exitCodeRaw = tokenField(text, "exit_code");
  const exitCode = exitCodeRaw === undefined ? undefined : Number(exitCodeRaw);
  return {
    kind,
    ...(quotedField(text, "run_id") ? { runId: quotedField(text, "run_id") } : {}),
    ...(quotedField(text, "goal") ? { goal: quotedField(text, "goal") } : {}),
    ...(quotedField(text, "task_id") ? { taskId: quotedField(text, "task_id") } : {}),
    ...(quotedField(text, "task") ? { task: quotedField(text, "task") } : {}),
    ...(quotedField(text, "worker") ? { worker: quotedField(text, "worker") } : {}),
    ...(tokenField(text, "status") ? { status: tokenField(text, "status") } : {}),
    ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
  };
}

export function shouldContinueGoalRun(run: GoalRun): boolean {
  if (
    run.status === "blocked" ||
    run.status === "paused" ||
    run.status === "passed" ||
    run.status === "failed"
  ) {
    return false;
  }
  if (run.activeWorkerId) return false;
  return !run.tasks.some((task) => task.status === "running" || task.status === "verifying");
}
