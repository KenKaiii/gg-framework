import { useId, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createGoal, selectProject, type GoalSummary } from "../agent";
import "./placeholder.css";

/** Mirrors the sidecar's limits in `core/goals-store.ts`. */
const NAME_MAX = 15;
const GOAL_MAX = 2000;
export const GOAL_INSTRUCTIONS_MAX = 4000;
export const GOAL_CONTEXT_MAX = 20;

export interface ContextPick {
  path: string;
  kind: "folder" | "file";
}

/** Last path segment, for a compact row label (the full path is the tooltip). */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Placeholder for upstream's GoalInstructionsField: rules the coordinator and
 * its workers follow for the whole goal. Shared by New goal and the goal's
 * settings.
 */
export function GoalInstructionsField({
  value,
  onChange,
  disabled = false,
  placeholder = "Keep the current design. Ask before adding dependencies.",
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
}): React.ReactElement {
  const id = useId();
  const hintId = useId();
  return (
    <>
      <label htmlFor={id}>
        Instructions <span className="placeholder-muted">(optional)</span>
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={GOAL_INSTRUCTIONS_MAX}
        rows={3}
        disabled={disabled}
        aria-describedby={hintId}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={hintId} className="placeholder-muted">
        Rules for the whole goal. The coordinator and its workers follow them throughout.
      </span>
    </>
  );
}

/**
 * Placeholder for upstream's GoalContextPicker: a goal's attached folders and
 * files, added with the native picker and removed one by one. Shared by New
 * goal and the goal's settings.
 */
export function GoalContextField({
  value,
  onChange,
  disabled = false,
  onError,
}: {
  value: readonly ContextPick[];
  onChange: (next: ContextPick[]) => void;
  disabled?: boolean;
  /** A picker failure, for the form's error line. */
  onError: (message: string) => void;
}): React.ReactElement {
  const contextId = useId();

  async function add(kind: "folder" | "file"): Promise<void> {
    try {
      const picked = await openDialog({
        directory: kind === "folder",
        multiple: true,
        title: kind === "folder" ? "Add folders to this goal" : "Add files to this goal",
      });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length > 0) {
        const seen = new Set(value.map((c) => c.path));
        const added = paths
          .filter((p) => !seen.has(p))
          .map((p): ContextPick => ({ path: p, kind }));
        onChange([...value, ...added].slice(0, GOAL_CONTEXT_MAX));
      }
    } catch (e) {
      onError(`Couldn't open the picker: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const full = value.length >= GOAL_CONTEXT_MAX;
  return (
    <>
      <span id={contextId}>
        Context{" "}
        <span className="placeholder-muted">
          {value.length > 0 ? `(${value.length} of ${GOAL_CONTEXT_MAX})` : "(optional)"}
        </span>
      </span>
      <span>
        <button type="button" disabled={disabled || full} onClick={() => void add("folder")}>
          Add folders
        </button>{" "}
        <button type="button" disabled={disabled || full} onClick={() => void add("file")}>
          Add files
        </button>
      </span>
      {value.length > 0 ? (
        <ul className="placeholder-list" aria-labelledby={contextId}>
          {value.map((item) => (
            <li key={item.path} title={item.path}>
              {baseName(item.path)}{" "}
              <span className="placeholder-muted">
                {item.kind === "folder" ? "folder" : "file"}
              </span>{" "}
              <button
                type="button"
                aria-label={`Remove ${baseName(item.path)}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((c) => c.path !== item.path))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="placeholder-muted">
          Folders and files the goal is about, like repos, specs or mock-ups.
        </span>
      )}
    </>
  );
}

/**
 * Placeholder (the fork owns the desktop design) for upstream's New goal modal:
 * a name, the objective in a sentence or two, optional folders and files for
 * context, and standing instructions. Creating it opens the goal, where the
 * coordinator replies on its own. The sidecar validates every field; its
 * reason is shown as is.
 */
export function GoalForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  /** Called after the goal exists and this window is pointed at it. */
  onCreated: (goal: GoalSummary) => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState<ContextPick[]>([]);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const nameCountId = useId();
  const goalId = useId();

  const canCreate = name.trim().length > 0 && goal.trim().length > 0 && !busy;

  async function create(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createGoal({
        name: name.trim(),
        goal: goal.trim(),
        context: context.map((c) => c.path),
        instructions: instructions.trim(),
      });
      // A goal opens as its own coordinator session in a fresh conversation.
      await selectProject(created.path);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="placeholder-form"
      aria-label="New goal"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <label htmlFor={nameId}>Name</label>
      <input
        id={nameId}
        value={name}
        maxLength={NAME_MAX}
        aria-describedby={nameCountId}
        placeholder="API latency"
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <span id={nameCountId} className="placeholder-muted">
        {`${name.length}/${NAME_MAX}`}
      </span>

      <label htmlFor={goalId}>Goal</label>
      <textarea
        id={goalId}
        value={goal}
        maxLength={GOAL_MAX}
        rows={3}
        placeholder="Get checkout loading under one second on mobile"
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void create();
          }
        }}
      />

      <GoalContextField value={context} onChange={setContext} disabled={busy} onError={setError} />
      <GoalInstructionsField value={instructions} onChange={setInstructions} disabled={busy} />

      {error && (
        <p role="alert" className="placeholder-attention">
          {error}
        </p>
      )}
      <span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>{" "}
        <button type="submit" disabled={!canCreate}>
          {busy ? "Creating…" : "Create goal"}
        </button>
      </span>
    </form>
  );
}
