import { theme } from "./theme";
import { XIcon } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import type { ProjectTask } from "./agent";

/**
 * Task list modal. Mirrors the CLI's task pane: shows every project task with
 * its status, lets the user run one task (fresh session, end-to-end) or run all
 * pending tasks sequentially, and delete tasks. The agent loop streams progress
 * back into the transcript — this modal just kicks things off and reflects the
 * live status updates pushed via the `tasks_list` SSE event.
 */
interface Props {
  tasks: readonly ProjectTask[];
  /** True while the agent is running (task or chat) — disables run actions. */
  running: boolean;
  onRun: (id: string) => void;
  onRunAll: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const STATUS_STYLE: Record<ProjectTask["status"], { label: string; color: string }> = {
  pending: { label: "Pending", color: theme.textMuted },
  "in-progress": { label: "Running", color: theme.warning },
  done: { label: "Done", color: theme.success },
};

export function TasksModal({
  tasks,
  running,
  onRun,
  onRunAll,
  onDelete,
  onClose,
}: Props): React.ReactElement {
  const pending = tasks.filter((t) => t.status !== "done");
  const hasPending = pending.length > 0;

  return (
    <Modal title="Tasks" onClose={onClose}>
      {tasks.length === 0 ? (
        <div className="tasks-empty" style={{ color: theme.textMuted }}>
          No tasks yet. Ask the agent to add tasks, then run them here.
        </div>
      ) : (
        <>
          <div className="tasks-list">
            {tasks.map((task) => {
              const status = STATUS_STYLE[task.status];
              const isDone = task.status === "done";
              return (
                <div className="tasks-item" key={task.id}>
                  <span className="tasks-dot" style={{ color: status.color }} title={status.label}>
                    {isDone ? "\u2713" : task.status === "in-progress" ? "\u23FA" : "\u25CB"}
                  </span>
                  <span
                    className="tasks-title"
                    style={{ color: isDone ? theme.textMuted : theme.text }}
                    title={task.prompt}
                  >
                    {task.title}
                  </span>
                  <span className="tasks-status" style={{ color: status.color }}>
                    {status.label}
                  </span>
                  {!isDone && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost tasks-run-one"
                      disabled={running}
                      title="Run this task in a fresh session"
                      onClick={() => onRun(task.id)}
                    >
                      Run
                    </button>
                  )}
                  <button
                    type="button"
                    className="tasks-delete"
                    style={{ color: theme.textDim }}
                    title="Delete task"
                    aria-label={`Delete ${task.title}`}
                    onClick={() => onDelete(task.id)}
                  >
                    <XIcon size={12} weight="bold" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="tasks-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={running || !hasPending}
              title={
                hasPending
                  ? "Run all pending tasks, one fresh session each"
                  : "No pending tasks to run"
              }
              onClick={onRunAll}
            >
              {`Run all (${pending.length})`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
