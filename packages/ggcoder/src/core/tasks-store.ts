import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const TASKS_BASE = join(homedir(), ".gg-tasks", "projects");

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  /** @deprecated Old field — migrated to title+prompt on load. */
  text?: string;
  details?: string;
  status: "pending" | "in-progress" | "done";
  createdAt: string;
}

export interface PendingTaskInfo {
  id: string;
  title: string;
  prompt: string;
}

function hashPath(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function projectDir(cwd: string): string {
  return join(TASKS_BASE, hashPath(cwd));
}

function taskFilePath(cwd: string): string {
  return join(projectDir(cwd), "tasks.json");
}

function migrateTask(task: TaskRecord): TaskRecord {
  if (!task.prompt && task.text) {
    return { ...task, title: task.title || task.text, prompt: task.text, text: undefined };
  }
  return task;
}

export function createTaskRecord(title: string, prompt: string): TaskRecord {
  return {
    id: randomUUID(),
    title,
    prompt,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export async function loadTasks(cwd: string): Promise<TaskRecord[]> {
  try {
    const data = await readFile(taskFilePath(cwd), "utf-8");
    const raw = JSON.parse(data) as TaskRecord[];
    return raw.map(migrateTask);
  } catch {
    return [];
  }
}

export function loadTasksSync(cwd: string): TaskRecord[] {
  try {
    const data = readFileSync(taskFilePath(cwd), "utf-8");
    const raw = JSON.parse(data) as TaskRecord[];
    return raw.map(migrateTask);
  } catch {
    return [];
  }
}

export async function saveTasks(cwd: string, tasks: readonly TaskRecord[]): Promise<void> {
  const dir = projectDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2) + "\n", "utf-8");
  const meta = JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n";
  await writeFile(join(dir, "meta.json"), meta, "utf-8");
}

export function saveTasksSync(cwd: string, tasks: readonly TaskRecord[]): void {
  writeFileSync(taskFilePath(cwd), JSON.stringify(tasks, null, 2) + "\n", "utf-8");
}

export function getNextPendingTask(cwd: string): PendingTaskInfo | null {
  const pending = loadTasksSync(cwd).find((task) => task.status === "pending");
  if (!pending) return null;
  return {
    id: pending.id,
    title: pending.title,
    prompt: pending.prompt || pending.text || pending.title,
  };
}

/**
 * Drop every completed task and persist the pruned list, returning the
 * survivors. Used by the desktop app so finished tasks disappear from the Tasks
 * modal on completion instead of lingering with a "done" badge. No-op write
 * when nothing was done (keeps the file untouched on idle runs).
 */
export function pruneDoneTasksSync(cwd: string): TaskRecord[] {
  const tasks = loadTasksSync(cwd);
  const remaining = tasks.filter((task) => task.status !== "done");
  if (remaining.length !== tasks.length) saveTasksSync(cwd, remaining);
  return remaining;
}

export function markTaskInProgress(cwd: string, taskId: string): void {
  const tasks = loadTasksSync(cwd);
  if (tasks.length === 0) return;
  const updated = tasks.map((task) =>
    task.id === taskId ? { ...task, status: "in-progress" as const } : task,
  );
  saveTasksSync(cwd, updated);
}
