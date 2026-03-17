import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme/theme.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ── Types ────────────────────────────────────────────────

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

// ── Persistence (inline — avoids cross-package dep) ──────

const TASKS_BASE = join(homedir(), ".gg-tasks", "projects");

function hashPath(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

async function loadTasks(cwd: string): Promise<Task[]> {
  try {
    const data = await readFile(join(TASKS_BASE, hashPath(cwd), "tasks.json"), "utf-8");
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
  const dir = join(TASKS_BASE, hashPath(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2) + "\n", "utf-8");

  // Also write meta so gg-tasks standalone can find this project
  const metaPath = join(dir, "meta.json");
  const meta = JSON.stringify({ path: cwd, name: basename(cwd) }, null, 2) + "\n";
  await writeFile(metaPath, meta, "utf-8");
}

// ── Banner ───────────────────────────────────────────────

const TASK_LOGO = [
  " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
  " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
  " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
];

const GRADIENT = [
  "#4ade80",
  "#5ad89a",
  "#6fd2b4",
  "#85ccce",
  "#60a5fa",
  "#85ccce",
  "#6fd2b4",
  "#5ad89a",
];

const GAP = "   ";

function TaskGradientText({ text }: { text: string }) {
  const chars: React.ReactNode[] = [];
  let colorIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      chars.push(ch);
    } else {
      const color = GRADIENT[colorIdx % GRADIENT.length];
      chars.push(
        <Text key={i} color={color}>
          {ch}
        </Text>,
      );
      colorIdx++;
    }
  }
  return <Text>{chars}</Text>;
}

// ── Component ────────────────────────────────────────────

interface TaskOverlayProps {
  cwd: string;
  onClose: () => void;
  onWorkOnTask: (title: string, prompt: string, id: string) => void;
  onRunAllTasks: () => void;
  agentRunning?: boolean;
}

export function TaskOverlay({
  cwd,
  onClose,
  onWorkOnTask,
  onRunAllTasks,
  agentRunning,
}: TaskOverlayProps) {
  const theme = useTheme();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<"normal" | "adding" | "editing">("normal");
  const [inputText, setInputText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback((msg: string) => {
    setStatus(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 2500);
  }, []);

  // Load tasks on mount and poll for external changes (e.g. from the tasks tool)
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadTasks(cwd).then((t) => {
        if (cancelled) return;
        setTasks((prev) => {
          // Only update if the data actually changed (avoid clobbering user edits mid-flight)
          const prevJson = JSON.stringify(prev);
          const newJson = JSON.stringify(t);
          if (prevJson === newJson) return prev;
          return t;
        });
        setLoaded(true);
      });
    };
    load();
    const interval = setInterval(load, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cwd]);

  // Persist on user-initiated change (debounced to avoid racing with poll)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveTasks(cwd, tasks);
    }, 100);
  }, [tasks, cwd, loaded]);

  // Clamp index
  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= tasks.length) {
      setSelectedIndex(tasks.length - 1);
    }
  }, [tasks.length, selectedIndex]);

  useInput((input, key) => {
    // ── Input mode ──
    if (mode === "adding" || mode === "editing") {
      if (key.escape) {
        setMode("normal");
        setInputText("");
        return;
      }
      if (key.return) {
        const text = inputText.trim();
        if (text) {
          if (mode === "adding") {
            const newTask: Task = {
              id: randomUUID(),
              title: text,
              prompt: text,
              status: "pending",
              createdAt: new Date().toISOString(),
            };
            setTasks((prev) => [...prev, newTask]);
            setSelectedIndex(tasks.length);
          } else {
            setTasks((prev) =>
              prev.map((t, i) => (i === selectedIndex ? { ...t, title: text } : t)),
            );
          }
        }
        setMode("normal");
        setInputText("");
        return;
      }
      if (key.backspace || key.delete) {
        setInputText((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputText((prev) => prev + input);
      }
      return;
    }

    // ── Normal mode ──

    // Close overlay
    if (key.escape || input === "~") {
      onClose();
      return;
    }

    // Jump to top (g) / bottom (G)
    if (input === "g") {
      setSelectedIndex(0);
      return;
    }
    if (input === "G") {
      setSelectedIndex(tasks.length - 1);
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1));
      return;
    }

    if (input === "a") {
      setMode("adding");
      setInputText("");
      return;
    }

    if (input === "e" && tasks.length > 0) {
      const task = tasks[selectedIndex];
      if (task) {
        setMode("editing");
        setInputText(task.title);
      }
      return;
    }

    if (input === "d" && tasks.length > 0) {
      setTasks((prev) => prev.filter((_, i) => i !== selectedIndex));
      showStatus("Deleted");
      return;
    }

    if (input === "t" && tasks.length > 0) {
      setTasks((prev) =>
        prev.map((t, i) => {
          if (i !== selectedIndex) return t;
          return { ...t, status: t.status === "done" ? "pending" : "done" };
        }),
      );
      return;
    }

    // Work on it — send to agent loop and close overlay
    if (key.return && tasks.length > 0) {
      if (agentRunning) {
        showStatus("Agent is busy — wait for it to finish");
        return;
      }
      const task = tasks[selectedIndex];
      if (task) {
        setTasks((prev) =>
          prev.map((t, i) => (i === selectedIndex ? { ...t, status: "in-progress" } : t)),
        );
        onWorkOnTask(task.title, task.prompt, task.id);
      }
      return;
    }

    // Run all pending tasks sequentially
    if (input === "r") {
      if (agentRunning) {
        showStatus("Agent is busy — wait for it to finish");
        return;
      }
      const hasPending = tasks.some((t) => t.status === "pending");
      if (!hasPending) {
        showStatus("No pending tasks to run");
        return;
      }
      onRunAllTasks();
      return;
    }
  });

  const maxVisible = 15;
  const startIdx = Math.max(0, selectedIndex - maxVisible + 1);
  const visibleTasks = tasks.slice(startIdx, startIdx + maxVisible);

  const home = process.env.HOME ?? "";
  const displayPath = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const inProgressCount = tasks.filter((t) => t.status === "in-progress").length;

  return (
    <Box flexDirection="column">
      {/* Banner */}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Box>
          <TaskGradientText text={TASK_LOGO[0]} />
          <Text>{GAP}</Text>
          <Text color="#4ade80" bold>
            Task Pane
          </Text>
          {agentRunning && <Text color="#fbbf24"> (agent running)</Text>}
        </Box>
        <Box>
          <TaskGradientText text={TASK_LOGO[1]} />
          <Text>{GAP}</Text>
          <Text color={theme.textDim}>{displayPath}</Text>
        </Box>
        <Box>
          <TaskGradientText text={TASK_LOGO[2]} />
          <Text>{GAP}</Text>
          <Text>
            <Text color="#4ade80">{doneCount} done</Text>
            <Text color={theme.textDim}> · </Text>
            <Text color="#fbbf24">{inProgressCount} active</Text>
            <Text color={theme.textDim}> · </Text>
            <Text color={theme.text}>{pendingCount} pending</Text>
          </Text>
        </Box>
      </Box>

      {tasks.length === 0 && mode === "normal" && (
        <Text color={theme.textDim}>
          {"  No tasks. Press "}
          <Text color={theme.primary}>a</Text>
          {" to add one."}
        </Text>
      )}

      {visibleTasks.map((task, vi) => {
        const realIdx = startIdx + vi;
        const selected = realIdx === selectedIndex;
        const prefix = selected ? "❯ " : "  ";
        const check = task.status === "done" ? "✓" : task.status === "in-progress" ? "~" : " ";
        const color = selected
          ? theme.primary
          : task.status === "done"
            ? "#4ade80"
            : task.status === "in-progress"
              ? "#fbbf24"
              : theme.text;
        return (
          <Text key={task.id} color={color} bold={selected}>
            {prefix}[{check}] {task.title}
          </Text>
        );
      })}

      {mode !== "normal" && (
        <Box>
          <Text color={theme.primary}>{mode === "adding" ? " + " : " ✎ "}</Text>
          <Text>{inputText}</Text>
          <Text color={theme.textDim}>█</Text>
        </Box>
      )}

      {status && <Text color="#4ade80">{" " + status}</Text>}

      <Box marginTop={1}>
        <Text color={theme.textDim}>
          <Text color={theme.primary}>↑↓</Text>
          {" move · "}
          <Text color={theme.primary}>g/G</Text>
          {" jump · ("}
          <Text color={theme.primary}>a</Text>
          {")dd · ("}
          <Text color={theme.primary}>e</Text>
          {")dit · ("}
          <Text color={theme.primary}>d</Text>
          {")elete · ("}
          <Text color={theme.primary}>t</Text>
          {")oggle · "}
          <Text color={theme.primary}>Enter</Text>
          {" start · ("}
          <Text color={theme.primary}>r</Text>
          {")un all · "}
          <Text color={theme.primary}>ESC</Text>
          {" close"}
        </Text>
      </Box>
    </Box>
  );
}
