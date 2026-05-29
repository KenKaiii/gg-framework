import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { killProcessTree } from "../utils/process.js";
import { log } from "./logger.js";
import {
  appendGoalEvidence,
  projectDir,
  updateGoalTask,
  upsertGoalRun,
  getGoalRun,
  type GoalRun,
} from "./goal-store.js";
import {
  checkpointGoalWorkingTree,
  createGoalWorkerWorktree,
  type GoalWorktreeCommandRunner,
  type GoalWorktreeCandidate,
} from "./goal-worktree.js";
import { APPLY_INTEGRATION_TO_MAIN_TASK_TITLE } from "./goal-controller.js";

const DEFAULT_GOAL_WORKER_MAX_TURNS = 12;
export const DEFAULT_GOAL_WORKER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SUMMARY_CHARS = 4000;

export interface GoalWorkerRecord {
  id: string;
  pid: number;
  goalRunId: string;
  goalTaskId: string;
  cwd: string;
  projectPath: string;
  worktree?: GoalWorktreeCandidate;
  provider: Provider;
  model: string;
  startedAt: string;
  logFile: string;
  status: "running" | "done" | "failed" | "stopped";
  exitCode: number | null;
  currentActivity?: string;
}

export interface GoalWorkerToolUse {
  name: string;
  ok: boolean;
}

export interface GoalWorkerCompletion {
  worker: GoalWorkerRecord;
  summary: string;
  status: "done" | "failed";
  exitCode: number;
  toolsUsed: GoalWorkerToolUse[];
  reason?: "exit" | "spawn_error" | "timeout";
}

export type GoalWorkerCompletionListener = (completion: GoalWorkerCompletion) => void;

interface GoalWorkerCompletionSubscription {
  projectPath?: string;
  listener: GoalWorkerCompletionListener;
}

export interface GoalWorkerContext {
  cwd: string;
  goalRunId: string;
  goalTaskId: string;
  taskTitle?: string;
}

export interface StartGoalWorkerOptions extends GoalWorkerContext {
  provider: Provider;
  model: string;
  prompt: string;
  systemPrompt?: string;
  parentCacheKey?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  timeoutMs?: number;
  isolateWorktree?: boolean;
  worktreeBaseRef?: string;
  worktreesRoot?: string;
  worktreeCommandRunner?: GoalWorktreeCommandRunner;
  onComplete?: (completion: GoalWorkerCompletion) => void;
}

const workers = new Map<string, GoalWorkerRecord>();
const children = new Map<string, ChildProcess>();
const completionSubscriptions = new Set<GoalWorkerCompletionSubscription>();
const pendingCompletions: GoalWorkerCompletion[] = [];
const MAX_PENDING_COMPLETIONS = 100;

function getCliPath(): string {
  return process.argv[1] ?? "";
}

export function buildGoalWorkerSystemPrompt(context: GoalWorkerContext): string {
  const title = context.taskTitle ? ` (${context.taskTitle})` : "";
  const locationContract =
    context.taskTitle === APPLY_INTEGRATION_TO_MAIN_TASK_TITLE
      ? "Cwd is the user's main checkout; this is the controlled exception to worker isolation and may apply approved candidate packets/worktrees into main, verify, and record evidence before release."
      : "Cwd is the worker candidate checkout in an isolated git worktree; do not merge or touch the main checkout. Record a candidate packet: base SHA, branch/worktree path, changed files, diffstat, patch path or reproduction steps, verifier result, evidence paths, risks.";
  return [
    "You are a disposable Goal worker for GG Coder.",
    `Context: cwd=${context.cwd}; run_id=${context.goalRunId}; task_id=${context.goalTaskId}${title}.`,
    "Follow only the assigned user task. Keep changes focused. Use local/free tools and source_path/docs/kencode research when relevant.",
    "Proof rule: model the intended experience, choose the required senses/signals for goal-specific failures, then create the simplest local/free proof path. Use tests, CLIs, logs, screenshots/video, generated assets, protocol traces, database/API/contract/perf checks, or source/docs comparison only when they directly observe those signals; do not default to generic artifacts and do not rely on narrative or human visual inspection.",
    "Background processes are worker-owned and must be cleaned up before exit; if a later verifier needs a server, record exact orchestrator instructions instead of leaving your server running.",
    locationContract,
    "Preserve task-graph metadata from the prompt: depends_on, parallel_group, expected_changed_scope, merge_strategy.",
    `Record durable proof and task status with goals({ action: "evidence" | "task", run_id: "${context.goalRunId}", task_id: "${context.goalTaskId}", ... }) using command/file/screenshot/log evidence, not narrative-only claims.`,
    "Do not mark the whole goal complete; only the coordinator/verifier can complete it.",
  ].join(" ");
}

function appendSummary(summary: string, text: string): string {
  const next = summary + text;
  return next.length > MAX_SUMMARY_CHARS ? next.slice(next.length - MAX_SUMMARY_CHARS) : next;
}

function completionMatchesProject(
  completion: GoalWorkerCompletion,
  projectPath: string | undefined,
): boolean {
  return projectPath === undefined || completion.worker.projectPath === projectPath;
}

function emitGoalWorkerCompletion(completion: GoalWorkerCompletion): void {
  let delivered = false;
  for (const subscription of completionSubscriptions) {
    if (!completionMatchesProject(completion, subscription.projectPath)) continue;
    delivered = true;
    try {
      subscription.listener(completion);
    } catch (err) {
      log("ERROR", "goal-worker", err instanceof Error ? err.message : String(err));
    }
  }
  if (delivered) return;

  pendingCompletions.push(completion);
  if (pendingCompletions.length > MAX_PENDING_COMPLETIONS) {
    pendingCompletions.splice(0, pendingCompletions.length - MAX_PENDING_COMPLETIONS);
  }
}

export function subscribeGoalWorkerCompletions(
  listener: GoalWorkerCompletionListener,
  projectPath?: string,
): () => void {
  const subscription: GoalWorkerCompletionSubscription = { listener, projectPath };
  completionSubscriptions.add(subscription);

  for (let index = 0; index < pendingCompletions.length; ) {
    const completion = pendingCompletions[index]!;
    if (!completionMatchesProject(completion, projectPath)) {
      index += 1;
      continue;
    }
    pendingCompletions.splice(index, 1);
    try {
      listener(completion);
    } catch (err) {
      log("ERROR", "goal-worker", err instanceof Error ? err.message : String(err));
    }
  }

  return () => {
    completionSubscriptions.delete(subscription);
  };
}

function formatActivity(name: string, args: Record<string, unknown>): string {
  const firstString = Object.values(args).find((value) => typeof value === "string") as
    | string
    | undefined;
  return firstString ? `${name}: ${firstString.slice(0, 80)}` : name;
}

async function setRunWorker(
  cwd: string,
  runId: string,
  workerId: string | undefined,
): Promise<void> {
  const run = await getGoalRun(cwd, runId);
  if (!run) return;
  const patch: GoalRun = workerId
    ? { ...run, activeWorkerId: workerId, status: "running" }
    : {
        ...run,
        activeWorkerId: undefined,
        status: run.status === "running" ? "ready" : run.status,
      };
  await upsertGoalRun(cwd, patch);
}

export async function startGoalWorker(options: StartGoalWorkerOptions): Promise<GoalWorkerRecord> {
  const cliPath = getCliPath();
  if (!cliPath) throw new Error("Cannot start Goal worker: CLI path is unavailable.");

  const existing = listGoalWorkers(options.cwd).find(
    (worker) => worker.goalRunId === options.goalRunId && worker.status === "running",
  );
  if (existing) return existing;

  const workerId = randomUUID().slice(0, 8);
  const projectPath = options.cwd;
  let worktree: GoalWorktreeCandidate | undefined;
  if (options.isolateWorktree !== false) {
    try {
      const checkpoint = await checkpointGoalWorkingTree({
        projectPath,
        message: `goal(${options.goalRunId}): checkpoint uncommitted work before worker ${workerId}`,
        ...(options.worktreeCommandRunner ? { commandRunner: options.worktreeCommandRunner } : {}),
      });
      if (checkpoint.committed) {
        await appendGoalEvidence(projectPath, options.goalRunId, {
          kind: "summary",
          label: "Goal working tree checkpoint",
          content: `Auto-committed uncommitted work before worker ${workerId} (reversible). sha=${checkpoint.sha}; files=${(checkpoint.files ?? []).join(", ")}`,
        });
      }
      worktree = await createGoalWorkerWorktree({
        projectPath,
        goalRunId: options.goalRunId,
        goalTaskId: options.goalTaskId,
        workerId,
        ...(options.worktreeBaseRef ? { baseRef: options.worktreeBaseRef } : {}),
        ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
        ...(options.worktreeCommandRunner ? { commandRunner: options.worktreeCommandRunner } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateGoalTask(projectPath, options.goalRunId, options.goalTaskId, {
        status: "failed",
        workerId,
        lastSummary: message,
      });
      await appendGoalEvidence(projectPath, options.goalRunId, {
        kind: "summary",
        label: `Worker ${workerId} worktree failed`,
        content: message,
      });
      throw error;
    }
  }
  const workerCwd = worktree?.path ?? projectPath;
  const workerDir = join(projectDir(projectPath), "workers");
  await mkdir(workerDir, { recursive: true });
  const logFile = join(workerDir, `${workerId}.ndjson`);
  const logStream = createWriteStream(logFile, { flags: "a" });

  const cliArgs = [
    "--json",
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--max-turns",
    String(options.maxTurns ?? DEFAULT_GOAL_WORKER_MAX_TURNS),
    "--system-prompt",
    options.systemPrompt ??
      buildGoalWorkerSystemPrompt({
        cwd: workerCwd,
        goalRunId: options.goalRunId,
        goalTaskId: options.goalTaskId,
        ...(options.taskTitle ? { taskTitle: options.taskTitle } : {}),
      }),
  ];
  if (options.parentCacheKey) {
    cliArgs.push("--prompt-cache-key", `${options.parentCacheKey}:goal`);
  }
  if (options.thinkingLevel) {
    cliArgs.push("--thinking", options.thinkingLevel);
  }
  cliArgs.push(options.prompt);

  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    cwd: workerCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GG_GOAL_PROJECT_PATH: projectPath },
  });

  const record: GoalWorkerRecord = {
    id: workerId,
    pid: child.pid ?? 0,
    goalRunId: options.goalRunId,
    goalTaskId: options.goalTaskId,
    cwd: workerCwd,
    projectPath,
    ...(worktree ? { worktree } : {}),
    provider: options.provider,
    model: options.model,
    startedAt: new Date().toISOString(),
    logFile,
    status: "running",
    exitCode: null,
  };
  workers.set(workerId, record);
  children.set(workerId, child);

  await updateGoalTask(projectPath, options.goalRunId, options.goalTaskId, {
    status: "running",
    workerId,
    ...(worktree ? { worktree: { ...worktree, status: "created" } } : {}),
  });
  if (worktree) {
    await appendGoalEvidence(projectPath, options.goalRunId, {
      kind: "summary",
      label: `Worker ${workerId} worktree created`,
      content: `base_ref=${worktree.baseRef}; branch=${worktree.branchName}; path=${worktree.path}`,
      path: worktree.path,
    });
  }
  await setRunWorker(projectPath, options.goalRunId, workerId);

  let summary = "";
  let stderr = "";
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const activeTools = new Map<string, string>();
  const toolsUsed: GoalWorkerToolUse[] = [];

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    logStream.write(line + "\n");
    try {
      const event = JSON.parse(line) as { type?: string } & Record<string, unknown>;
      if (event.type === "text_delta" && typeof event.text === "string") {
        summary = appendSummary(summary, event.text);
      } else if (event.type === "tool_call_start") {
        const name = typeof event.name === "string" ? event.name : "tool";
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
        activeTools.set(toolCallId, name);
        const args =
          typeof event.args === "object" && event.args !== null
            ? (event.args as Record<string, unknown>)
            : {};
        record.currentActivity = formatActivity(name, args);
        void appendGoalEvidence(projectPath, options.goalRunId, {
          kind: "log",
          label: `Worker ${workerId} tool start`,
          content: record.currentActivity,
          path: logFile,
        });
      } else if (event.type === "tool_call_end") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const name = activeTools.get(toolCallId);
        activeTools.delete(toolCallId);
        if (name) toolsUsed.push({ name, ok: event.isError !== true });
      } else if (event.type === "agent_done") {
        summary = appendSummary(summary, "\n[agent_done]");
      } else if (event.type === "error") {
        const message = typeof event.message === "string" ? event.message : "Worker error";
        summary = appendSummary(summary, `\n[error] ${message}`);
      }
    } catch {
      summary = appendSummary(summary, line + "\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderr = appendSummary(stderr, text);
    logStream.write(JSON.stringify({ type: "stderr", text }) + "\n");
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_GOAL_WORKER_TIMEOUT_MS;
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      record.status = "failed";
      if (child.pid) killProcessTree(child.pid);
      child.kill("SIGTERM");
    }, timeoutMs);
    timeout.unref?.();
  }

  child.on("close", (code) => {
    void (async () => {
      if (timeout) clearTimeout(timeout);
      rl.close();
      logStream.end();
      children.delete(workerId);
      record.exitCode = timedOut ? 124 : code;
      if (record.status === "stopped") {
        log("INFO", "goal-worker", `Worker ${workerId} stopped`, {
          code: String(code ?? 1),
          goalRunId: options.goalRunId,
          goalTaskId: options.goalTaskId,
        });
        return;
      }
      const hasDurableProofTool = toolsUsed.some(
        (tool) => tool.ok && ["goals", "bash", "write", "edit"].includes(tool.name),
      );
      const emptySuccessfulExit =
        code === 0 && !summary.trim() && !stderr.trim() && !hasDurableProofTool;
      record.status = !timedOut && code === 0 && !emptySuccessfulExit ? "done" : "failed";
      const finalSummary = timedOut
        ? `Worker timed out after ${timeoutMs}ms and its process tree was terminated.`
        : emptySuccessfulExit
          ? "Worker exited 0 without durable proof evidence or summary; coordinator validation required."
          : summary.trim() ||
            stderr.trim() ||
            (code === 0 ? "Worker completed." : "Worker failed.");
      const finalCode = timedOut ? 124 : (code ?? (record.status === "done" ? 0 : 1));
      await updateGoalTask(projectPath, options.goalRunId, options.goalTaskId, {
        status: record.status,
        workerId,
        lastSummary: finalSummary,
      });
      await appendGoalEvidence(projectPath, options.goalRunId, {
        kind: "log",
        label: timedOut ? `Worker ${workerId} timeout` : `Worker ${workerId} ${record.status}`,
        content: finalSummary,
        path: logFile,
      });
      await setRunWorker(projectPath, options.goalRunId, undefined);
      const completion: GoalWorkerCompletion = {
        worker: { ...record },
        summary: finalSummary,
        status: record.status,
        exitCode: finalCode,
        toolsUsed: [...toolsUsed],
        reason: timedOut ? "timeout" : "exit",
      };
      options.onComplete?.(completion);
      emitGoalWorkerCompletion(completion);
      log("INFO", "goal-worker", `Worker ${workerId} exited`, {
        code: String(code ?? 1),
        goalRunId: options.goalRunId,
        goalTaskId: options.goalTaskId,
      });
    })().catch((err: unknown) => {
      log("ERROR", "goal-worker", err instanceof Error ? err.message : String(err));
    });
  });

  child.on("error", (err) => {
    void (async () => {
      logStream.end();
      children.delete(workerId);
      record.exitCode = 1;
      record.status = "failed";
      const finalSummary = `Failed to spawn Goal worker: ${err.message}`;
      await updateGoalTask(projectPath, options.goalRunId, options.goalTaskId, {
        status: "failed",
        workerId,
        lastSummary: finalSummary,
      });
      await appendGoalEvidence(projectPath, options.goalRunId, {
        kind: "log",
        label: `Worker ${workerId} spawn failed`,
        content: err.message,
        path: logFile,
      });
      await setRunWorker(projectPath, options.goalRunId, undefined);
      const completion: GoalWorkerCompletion = {
        worker: { ...record },
        summary: finalSummary,
        status: "failed",
        exitCode: 1,
        toolsUsed: [...toolsUsed],
        reason: "spawn_error",
      };
      options.onComplete?.(completion);
      emitGoalWorkerCompletion(completion);
    })().catch((error: unknown) => {
      log("ERROR", "goal-worker", error instanceof Error ? error.message : String(error));
    });
  });

  log("INFO", "goal-worker", `Worker ${workerId} started`, {
    pid: String(record.pid),
    goalRunId: options.goalRunId,
    goalTaskId: options.goalTaskId,
  });
  return record;
}

export function listGoalWorkers(projectPath?: string): GoalWorkerRecord[] {
  const records = [...workers.values()];
  return projectPath ? records.filter((record) => record.projectPath === projectPath) : records;
}

export async function stopGoalWorker(workerId: string): Promise<string> {
  const record = workers.get(workerId);
  if (!record) return `No Goal worker with id "${workerId}".`;
  const child = children.get(workerId);
  if (!child || record.status !== "running") return `Goal worker ${workerId} is not running.`;

  record.status = "stopped";
  try {
    if (child.pid) killProcessTree(child.pid);
  } catch {
    child.kill("SIGTERM");
  }
  children.delete(workerId);
  await updateGoalTask(record.projectPath, record.goalRunId, record.goalTaskId, {
    status: "blocked",
    workerId,
    lastSummary: "Worker stopped by user.",
  });
  await appendGoalEvidence(record.projectPath, record.goalRunId, {
    kind: "summary",
    label: `Worker ${workerId} stopped`,
    content: "Worker stopped by user.",
    path: record.logFile,
  });
  await setRunWorker(record.projectPath, record.goalRunId, undefined);
  return `Goal worker ${workerId} stopped.`;
}

export function shutdownGoalWorkers(projectPath?: string): void {
  for (const record of listGoalWorkers(projectPath)) {
    const child = children.get(record.id);
    if (!child || !child.pid) continue;
    killProcessTree(child.pid);
    children.delete(record.id);
    record.status = "stopped";
  }
}

export function hasGoalWorkerLog(record: GoalWorkerRecord): boolean {
  return existsSync(record.logFile);
}
