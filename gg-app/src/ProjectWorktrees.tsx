import { useEffect, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Badge } from "./Badge";
import { ConfirmModal } from "./ConfirmModal";
import { listGitWorktrees, removeGitWorktree, type GitWorktree } from "./agent";

/** "2 changes", "3 commits ahead", "Clean": what a worktree holds right now. */
export function worktreeStatus(w: GitWorktree, mainBranch: string | null): string {
  if (w.missing) return "Folder deleted";
  const parts: string[] = [];
  if (w.dirty > 0) parts.push(`${w.dirty} ${w.dirty === 1 ? "change" : "changes"}`);
  if (w.ahead > 0) {
    parts.push(
      `${w.ahead} ${w.ahead === 1 ? "commit" : "commits"} ahead of ${mainBranch ?? "main folder"}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Clean";
}

/**
 * A project's worktrees in Home: open one (a new conversation on its branch) or
 * remove a GG-made one once it's merged or empty. Hidden when there are none.
 */
export function ProjectWorktrees({
  projectPath,
  busy,
  onOpen,
}: {
  projectPath: string;
  busy: boolean;
  onOpen: (path: string) => void;
}): React.ReactElement | null {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [mainBranch, setMainBranch] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<GitWorktree | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGitWorktrees(projectPath)
      .then((list) => {
        if (cancelled) return;
        setWorktrees(list.worktrees);
        setMainBranch(list.mainBranch);
      })
      .catch(() => {
        // Not a repo, or git unavailable: the section stays hidden.
        if (!cancelled) setWorktrees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, reload]);

  if (worktrees.length === 0) return null;

  async function remove(w: GitWorktree, force: boolean): Promise<void> {
    setRemoving(w.path);
    setError(null);
    try {
      await removeGitWorktree(projectPath, w.path, force);
      setConfirm(null);
      setReload((n) => n + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setConfirm(null);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="picker-worktrees" aria-labelledby="picker-worktrees-title">
      <h2 id="picker-worktrees-title" className="picker-section-title">
        Worktrees
      </h2>
      {error && (
        <div className="picker-error" role="alert">
          {error}
        </div>
      )}
      <div className="picker-reveal">
        {worktrees.map((w) => (
          <div key={w.path} className="picker-item-wrap">
            <button
              type="button"
              className="picker-item"
              disabled={busy || w.missing}
              onClick={() => onOpen(w.path)}
              title={w.path}
            >
              <span className="picker-row">
                <span className="picker-name" style={{ color: theme.text }}>
                  {w.branch ?? "Detached"}
                </span>
                {!w.managed && <Badge>Your worktree</Badge>}
              </span>
              <span className="picker-meta" style={{ color: theme.textMuted }}>
                {worktreeStatus(w, mainBranch)}
              </span>
            </button>
            {w.managed && (
              <button
                type="button"
                className="picker-hide"
                aria-label={`Remove the ${w.branch ?? "detached"} worktree`}
                title="Remove this worktree (the branch stays)"
                disabled={removing !== null}
                onClick={() => (w.dirty > 0 ? setConfirm(w) : void remove(w, false))}
              >
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <ConfirmModal
          title="Remove worktree?"
          message={`The ${confirm.branch ?? "detached"} worktree has ${confirm.dirty} uncommitted ${
            confirm.dirty === 1 ? "change" : "changes"
          } that will be lost. Its branch and commits stay.`}
          confirmLabel="Remove"
          busy={removing !== null}
          onConfirm={() => void remove(confirm, true)}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
