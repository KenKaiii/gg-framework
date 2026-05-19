import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../core/logger.js";

const TASKS_BASE = join(homedir(), ".gg-tasks", "projects");

interface Task {
  id: string;
  title: string;
  prompt: string;
  /** @deprecated Old field — migrated to title+prompt on load */
  text?: string;
  details?: string;
  status: "pending" | "in-progress" | "done";
  createdAt: string;
}

function hashPath(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function projectDir(cwd: string): string {
  return join(TASKS_BASE, hashPath(cwd));
}

async function loadTasks(cwd: string): Promise<Task[]> {
  try {
    const data = await readFile(join(projectDir(cwd), "tasks.json"), "utf-8");
    const raw = JSON.parse(data) as Task[];
    // Migrate old tasks that only have `text` (no title/prompt split)
    return raw.map((t) => {
      if (!t.prompt && t.text) {
        return { ...t, title: t.text, prompt: t.text, text: undefined };
      }
      return t;
    });
  } catch {
    return [];
  }
}

async function saveTasks(cwd: string, tasks: Task[]): Promise<void> {
  const dir = projectDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2) + "\n", "utf-8");
  // Also write meta so the task pane can find this project
  const meta = JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n";
  await writeFile(join(dir, "meta.json"), meta, "utf-8");
}

const TasksParams = z.object({
  action: z
    .enum(["add", "list", "done", "remove"])
    .describe("Action: add a task, list tasks, mark done, or remove"),
  title: z
    .string()
    .optional()
    .describe("Short task title for display (max ~10 words, required for add)"),
  prompt: z
    .string()
    .optional()
    .describe(
      "The standalone prompt sent to an agent with no context (required for add). " +
        "Concise, actionable instruction with file paths and what to change.",
    ),
  id: z.string().optional().describe("Task ID (required for done/remove — use list to find IDs)"),
});

export function createTasksTool(cwd: string): AgentTool<typeof TasksParams> {
  // Mutex to serialize concurrent tool calls (agent loop runs tools in parallel)
  let pending: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    // Update pending chain (swallow errors so the queue keeps moving)
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return {
    name: "tasks",
    description:
      "Manage the project task list. Each task has a short title (shown in " +
      "the task pane) and a prompt (sent as a standalone instruction to an " +
      "agent with no context). Write prompts as concise, actionable directives " +
      "with specific file paths — the agent must complete it from the prompt alone. " +
      "When adding multiple tasks, order them by dependency — foundational work " +
      "first, then core logic, integration, UI, and tests.",
    parameters: TasksParams,
    executionMode: "sequential",
    execute({ action, title, prompt, id }) {
      return enqueue(async () => {
        switch (action) {
          case "add": {
            if (!title) return "Error: title is required for add action.";
            if (!prompt) return "Error: prompt is required for add action.";
            const tasks = await loadTasks(cwd);
            const newTask: Task = {
              id: randomUUID(),
              title,
              prompt,
              status: "pending",
              createdAt: new Date().toISOString(),
            };
            tasks.push(newTask);
            await saveTasks(cwd, tasks);
            log("INFO", "tasks", `Task added: ${title}`, { id: newTask.id });
            return `Task added: "${title}" (id: ${newTask.id.slice(0, 8)})`;
          }

          case "list": {
            const tasks = await loadTasks(cwd);
            if (tasks.length === 0) return "No tasks.";
            const lines = tasks.map((t) => {
              const check = t.status === "done" ? "✓" : t.status === "in-progress" ? "~" : " ";
              return `[${check}] ${t.title}  (id: ${t.id.slice(0, 8)}, ${t.status})`;
            });
            log("INFO", "tasks", `Listed ${tasks.length} tasks`);
            return lines.join("\n");
          }

          case "done": {
            if (!id) return "Error: id is required for done action.";
            const tasks = await loadTasks(cwd);
            const task = tasks.find((t) => t.id === id || t.id.startsWith(id));
            if (!task) return `Error: no task found matching id "${id}".`;
            task.status = "done";
            await saveTasks(cwd, tasks);
            log("INFO", "tasks", `Task done: ${task.title}`, { id: task.id });
            return `Marked done: "${task.title}"`;
          }

          case "remove": {
            if (!id) return "Error: id is required for remove action.";
            const tasks = await loadTasks(cwd);
            const idx = tasks.findIndex((t) => t.id === id || t.id.startsWith(id));
            if (idx === -1) return `Error: no task found matching id "${id}".`;
            const removed = tasks.splice(idx, 1)[0];
            await saveTasks(cwd, tasks);
            log("INFO", "tasks", `Task removed: ${removed.title}`, { id: removed.id });
            return `Removed: "${removed.title}"`;
          }
        }
      });
    },
  };
}
