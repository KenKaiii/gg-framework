import { useEffect, useState } from "react";
import { deleteGoal, listGoals, selectProject, waitForReady, type GoalSummary } from "../agent";
import { GoalForm } from "./GoalForm";
import "./placeholder.css";

/** How often the open goal list refreshes each goal's status. */
const GOAL_STATUS_REFRESH_MS = 4000;

/**
 * A goal's state on its row, only when it's worth a glance: running, paused
 * by the user, or cut off mid-work. Briefing and finished goals carry none.
 */
const STATUS_LABEL: Partial<Record<NonNullable<GoalSummary["status"]>, string>> = {
  running: "Running now",
  paused: "Paused",
  interrupted: "Interrupted",
};
const STATUS_TITLE: Partial<Record<NonNullable<GoalSummary["status"]>, string>> = {
  running: "The coordinator is working on this now",
  paused: "Paused. Open it and resume to carry on",
  interrupted: "Stopped mid-work. Opening it carries it on",
};

/** "2 folders · 1 file" style summary of a goal's attached context. */
export function contextSummary(goal: GoalSummary): string | null {
  const folders = goal.context.filter((c) => c.kind === "folder").length;
  const files = goal.context.length - folders;
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} ${folders === 1 ? "folder" : "folders"}`);
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Placeholder (the fork owns the desktop design) for upstream's GoalPicker, the
 * Goals counterpart of the project picker. A goal is one ongoing conversation,
 * so choosing a row reopens its latest session directly.
 */
export function GoalList({
  onChosen,
  onClose,
}: {
  /** Called after this window has been pointed at the goal's coordinator. */
  onChosen: (cwd: string) => void;
  /** Back to Home. */
  onClose?: () => void;
}): React.ReactElement {
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<GoalSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const q = query.trim().toLowerCase();
  const filteredGoals = q
    ? goals.filter((g) => g.name.toLowerCase().includes(q) || g.goal.toLowerCase().includes(q))
    : goals;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void waitForReady()
      .then(() => listGoals())
      .then((g) => {
        if (cancelled) return;
        setGoals(g);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  // Goals keep working while the list is open: refresh their status quietly
  // (no loading state), so "Running now" and "Paused" stay true.
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      void listGoals()
        .then((g) => {
          if (!cancelled) setGoals(g);
        })
        .catch(() => undefined);
    }, GOAL_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  function choose(goal: GoalSummary): void {
    if (busy) return;
    setBusy(true);
    setOpenError(null);
    void selectProject(goal.path, goal.latestSessionPath ?? undefined)
      .then(() => onChosen(goal.path))
      .catch((reason: unknown) => {
        setOpenError(reason instanceof Error ? reason.message : String(reason));
        setBusy(false);
      });
  }

  function confirmDelete(): void {
    const goal = pendingDelete;
    if (!goal || deleting) return;
    setDeleting(true);
    setOpenError(null);
    void deleteGoal(goal.id)
      .then(() => setGoals((prev) => prev.filter((g) => g.id !== goal.id)))
      .catch((reason: unknown) =>
        setOpenError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => {
        setDeleting(false);
        setPendingDelete(null);
      });
  }

  const newGoalButton = (
    <button type="button" disabled={busy} onClick={() => setShowNew(true)}>
      New goal
    </button>
  );

  return (
    <section className="placeholder-goals" aria-label="Goals">
      <div className="placeholder-bar" data-tauri-drag-region>
        {onClose && (
          <button type="button" onClick={onClose}>
            Back
          </button>
        )}
        <h1>Choose a goal</h1>
        {!loading && !loadError && <span className="placeholder-muted">{goals.length}</span>}
        {!loading && goals.length > 0 && (
          <input
            type="text"
            placeholder={"Search goals…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search goals"
          />
        )}
        {!showNew && newGoalButton}
      </div>

      <div className="placeholder-scroll">
        {showNew && (
          <GoalForm
            onCancel={() => setShowNew(false)}
            onCreated={(goal) => {
              setShowNew(false);
              onChosen(goal.path);
            }}
          />
        )}
        {openError && (
          <p role="alert" className="placeholder-attention">
            {openError}
          </p>
        )}
        {loading && <p className="placeholder-muted">Loading goals{"…"}</p>}
        {!loading && loadError && (
          <p role="alert">
            <span className="placeholder-muted">Couldn't load your goals.</span>{" "}
            <button type="button" onClick={() => setReloadNonce((n) => n + 1)}>
              Try again
            </button>
          </p>
        )}
        {!loading && !loadError && goals.length === 0 && !showNew && (
          <p>
            <span className="placeholder-muted">
              No goals yet. Give Kleio something bigger than one session.
            </span>{" "}
            {newGoalButton}
          </p>
        )}
        {!loading && goals.length > 0 && filteredGoals.length === 0 && (
          <p className="placeholder-muted">{`No goals match “${query.trim()}”`}</p>
        )}
        {!loading && filteredGoals.length > 0 && (
          <ul className="placeholder-list">
            {filteredGoals.map((g) => {
              const context = contextSummary(g);
              const status = g.status ? STATUS_LABEL[g.status] : undefined;
              return (
                <li key={g.path} className="placeholder-row">
                  <button type="button" disabled={busy} onClick={() => choose(g)}>
                    <strong>{g.name}</strong>
                  </button>
                  <span className="placeholder-notice-body">
                    {context && <span className="placeholder-muted">{context} </span>}
                    <span>{g.goal}</span>
                  </span>
                  {status && g.status && (
                    <span
                      className={g.status === "interrupted" ? "placeholder-attention" : undefined}
                      title={STATUS_TITLE[g.status]}
                    >
                      {status}
                    </span>
                  )}
                  <span className="placeholder-muted">{g.lastActiveDisplay}</span>
                  <button
                    type="button"
                    aria-label={`Delete ${g.name}`}
                    disabled={busy || deleting}
                    onClick={() => setPendingDelete(g)}
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {pendingDelete && (
          <div
            role="alertdialog"
            aria-label="Delete goal"
            className="placeholder-notice"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || deleting) return;
              event.stopPropagation();
              setPendingDelete(null);
            }}
          >
            <p className="placeholder-notice-body">
              {`Delete “${pendingDelete.name}” and its conversation? Your attached folders and files are not touched. This can’t be undone.`}
            </p>
            <button
              type="button"
              autoFocus
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>{" "}
            <button type="button" disabled={deleting} onClick={confirmDelete}>
              Delete goal
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
