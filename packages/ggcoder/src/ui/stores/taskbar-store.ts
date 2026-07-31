import { useEffect } from "react";
import { createStore, useStore } from "./create-store.js";
import type { BackgroundTaskSnapshot, ProcessManager } from "../../core/process-manager.js";

interface TaskBarState {
  bgTasks: BackgroundTaskSnapshot[];
  focused: boolean;
  expanded: boolean;
  selectedIndex: number;
}

export const taskBarStore = createStore<TaskBarState>({
  bgTasks: [],
  focused: false,
  expanded: false,
  selectedIndex: 0,
});

export function useTaskBarStore() {
  return useStore(taskBarStore);
}

// ── Actions ──────────────────────────────────────────────

export function focusTaskBar() {
  const { bgTasks } = taskBarStore.getSnapshot();
  if (bgTasks.length > 0) {
    taskBarStore.setState({ focused: true });
  }
}

export function exitTaskBar() {
  taskBarStore.setState({ focused: false, expanded: false });
}

export function expandTaskBar() {
  taskBarStore.setState({ expanded: true, selectedIndex: 0 });
}

export function collapseTaskBar() {
  taskBarStore.setState({ expanded: false });
}

export function navigateTaskBar(index: number) {
  taskBarStore.setState({ selectedIndex: index });
}

export async function killTask(pm: ProcessManager, id: string): Promise<string> {
  return pm.stop(id);
}

// ── Effects (call from component) ────────────────────────

/** Poll ProcessManager every 2s and auto-manage panel state. */
export function useTaskBarPolling(pm: ProcessManager | undefined) {
  useEffect(() => {
    if (!pm) return;
    const poll = () => {
      const tasks = pm.list();
      const prev = taskBarStore.getSnapshot();
      taskBarStore.setState({ bgTasks: tasks });

      // Keep retained completions reachable; exit only after backend expiry.
      if (tasks.length === 0 && (prev.focused || prev.expanded)) {
        taskBarStore.setState({ focused: false, expanded: false });
      }

      // Clamp selected index
      const maxIdx = Math.min(tasks.length, 5) - 1;
      if (prev.selectedIndex > maxIdx && maxIdx >= 0) {
        taskBarStore.setState({ selectedIndex: maxIdx });
      }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [pm]);
}
