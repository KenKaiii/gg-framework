import { useEffect, useRef, useState, type RefObject } from "react";
import type { NotesTask } from "./notes-types";

interface Props {
  tasks: NotesTask[];
  addInputRef: RefObject<HTMLInputElement | null>;
  onCreateTask(text: string): void;
  onEditTask(id: string, text: string): void;
  onToggleTask(id: string): void;
  onMoveTask(id: string, direction: "up" | "down"): void;
  onArchiveTask(id: string): void;
}

export function NotesTaskList({
  tasks,
  addInputRef,
  onCreateTask,
  onEditTask,
  onToggleTask,
  onMoveTask,
  onArchiveTask,
}: Props): React.ReactElement {
  const activeTasks = tasks.filter((task) => task.archivedAt === null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [focusEditId, setFocusEditId] = useState<string | null>(null);
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (focusEditId === null) return;
    editButtonRefs.current.get(focusEditId)?.focus();
    setFocusEditId(null);
  }, [focusEditId]);

  const addTask = (): void => {
    const text = draft.trim();
    if (!text) return;
    onCreateTask(text);
    setDraft("");
    setAnnouncement(`Created task: ${text}`);
    addInputRef.current?.focus();
  };

  const finishEdit = (task: NotesTask, save: boolean): void => {
    const text = editText.trim();
    if (save && text) {
      onEditTask(task.id, text);
      if (text !== task.text) setAnnouncement(`Edited task: ${text}`);
    }
    setEditingId(null);
    setFocusEditId(task.id);
  };

  return (
    <>
      <form
        className="notes-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          addTask();
        }}
      >
        <label htmlFor="notes-add-task">Add a Notes task</label>
        <div className="notes-add-controls">
          <input
            ref={addInputRef}
            id="notes-add-task"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={!draft.trim()}>
            Add task
          </button>
        </div>
      </form>

      <div className="notes-task-list">
        {activeTasks.length === 0 && <p className="notes-empty">No active tasks.</p>}
        {activeTasks.map((task, index) => (
          <div
            className={`notes-task-row${task.status === "done" ? " is-done" : ""}`}
            key={task.id}
          >
            {editingId === task.id ? (
              <form
                className="notes-edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  finishEdit(task, true);
                }}
              >
                <label htmlFor={`notes-edit-${task.id}`}>Edit task: {task.text}</label>
                <input
                  id={`notes-edit-${task.id}`}
                  value={editText}
                  autoFocus
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    finishEdit(task, false);
                  }}
                />
                <div className="notes-task-actions">
                  <button type="submit" disabled={!editText.trim()}>
                    Save
                  </button>
                  <button type="button" onClick={() => finishEdit(task, false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <label className="notes-task-check">
                  <input
                    type="checkbox"
                    checked={task.status === "done"}
                    aria-label={`${task.status === "done" ? "Reopen" : "Complete"} task: ${task.text}`}
                    onChange={() => {
                      onToggleTask(task.id);
                      setAnnouncement(
                        `${task.status === "done" ? "Reopened" : "Completed"} task: ${task.text}`,
                      );
                    }}
                  />
                  <span>{task.text}</span>
                </label>
                <div className="notes-task-actions">
                  <button
                    type="button"
                    aria-label={`Move task up: ${task.text}`}
                    disabled={index === 0}
                    onClick={() => {
                      onMoveTask(task.id, "up");
                      setAnnouncement(`Moved task up: ${task.text}`);
                    }}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    aria-label={`Move task down: ${task.text}`}
                    disabled={index === activeTasks.length - 1}
                    onClick={() => {
                      onMoveTask(task.id, "down");
                      setAnnouncement(`Moved task down: ${task.text}`);
                    }}
                  >
                    Move down
                  </button>
                  <button
                    ref={(element) => {
                      if (element) editButtonRefs.current.set(task.id, element);
                      else editButtonRefs.current.delete(task.id);
                    }}
                    type="button"
                    aria-label={`Edit task: ${task.text}`}
                    onClick={() => {
                      setEditingId(task.id);
                      setEditText(task.text);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Archive task: ${task.text}`}
                    onClick={() => {
                      onArchiveTask(task.id);
                      setAnnouncement(`Archived task: ${task.text}`);
                      addInputRef.current?.focus();
                    }}
                  >
                    Archive
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="notes-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  );
}
