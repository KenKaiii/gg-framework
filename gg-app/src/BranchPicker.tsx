import { useEffect, useState } from "react";
import { getGitBranches, switchGitBranch, type BranchPlacement, type GitBranches } from "./agent";

/** "today", "3 days ago", "5 months ago": how long since a branch's last commit. */
export function lastCommitLabel(seconds: number, now: number): string {
  const days = Math.floor((now / 1000 - seconds) / 86_400);
  if (days < 1) return "today";
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years <= 1 ? "a year ago" : `${years} years ago`;
}

/**
 * Pick, filter or create a branch. Picking one switches this checkout, unless
 * other windows share it: then this window opens the branch in its own
 * worktree, so theirs stays where it is.
 */
export function BranchPicker({
  running,
  onMoveToWorktree,
}: {
  running: boolean;
  onMoveToWorktree?: (path: string, sessionPath: string | null) => Promise<void>;
}): React.ReactElement {
  // The clock is read when the list arrives, so ages don't shift per render.
  const [data, setData] = useState<{ list: GitBranches; at: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Only asked when other windows share this folder; their branch is theirs.
  const [placement, setPlacement] = useState<BranchPlacement>("worktree");

  useEffect(() => {
    let cancelled = false;
    getGitBranches()
      .then((branches) => {
        if (!cancelled) {
          setData({ list: branches, at: Date.now() });
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  if (failed) return <p className="deck-note">Couldn&apos;t read this project&apos;s branches.</p>;
  if (!data) return <p className="deck-note">Loading&hellip;</p>;
  const list = data.list;
  const now = data.at;

  const needle = query.trim();
  const lower = needle.toLowerCase();
  const shown = list.branches.filter((b) => b.name.toLowerCase().includes(lower));
  const canCreate = needle.length > 0 && !list.branches.some((b) => b.name === needle);
  const locked = running ? "Switching branches waits until the agent finishes." : list.locked;
  const busy = pending !== null || locked !== null;

  async function pick(branch: string, create: boolean): Promise<void> {
    setPending(branch);
    setError(null);
    try {
      const shared = data?.list.sharedWith !== null && data?.list.sharedWith !== undefined;
      const result = await switchGitBranch(branch, create, shared ? placement : "worktree");
      if (result.kind === "moved") {
        if (!onMoveToWorktree) throw new Error(`“${branch}” is open in ${result.path}.`);
        await onMoveToWorktree(result.path, result.sessionPath);
        return;
      }
      setQuery("");
      setReload((n) => n + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="branch-picker">
      <input
        className="modal-input branch-filter"
        type="text"
        value={query}
        placeholder="Filter or name a new branch"
        aria-label="Filter branches, or name a new one"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || busy) return;
          const exact = list.branches.find((b) => b.name === needle);
          if (exact && !exact.current) void pick(exact.name, false);
          else if (canCreate) void pick(needle, true);
        }}
      />
      {locked ? (
        <p className="deck-note">{locked}</p>
      ) : list.sharedWith ? (
        <fieldset className="branch-placement">
          <legend className="deck-note">
            {list.sharedWith} also use this folder. Open the branch you pick:
          </legend>
          <label className="modal-radio">
            <input
              type="radio"
              name="branch-placement"
              checked={placement === "worktree"}
              onChange={() => setPlacement("worktree")}
            />
            <span>In its own worktree, for this window only</span>
          </label>
          <label className="modal-radio">
            <input
              type="radio"
              name="branch-placement"
              checked={placement === "here"}
              onChange={() => setPlacement("here")}
            />
            <span>Here, switching the other windows too</span>
          </label>
          {placement === "worktree" && list.setup && (
            <p className="deck-note branch-setup">
              A new worktree runs <code>{list.setup}</code> first.
            </p>
          )}
        </fieldset>
      ) : null}
      {error && (
        <p className="deck-note" role="alert">
          {error}
        </p>
      )}
      <ul
        className="git-list"
        aria-label="Branches"
        aria-busy={pending !== null || undefined}
        hidden={shown.length === 0 && !canCreate}
      >
        {canCreate && (
          <li>
            <button
              type="button"
              className="git-row git-link branch-row"
              disabled={busy}
              onClick={() => void pick(needle, true)}
            >
              <span className="git-title trunc">Create branch “{needle}”</span>
              <span className="git-meta">
                {pending === needle ? "Creating…" : `from ${list.current ?? "this commit"}`}
              </span>
            </button>
          </li>
        )}
        {shown.map((b) => (
          <li key={b.name}>
            <button
              type="button"
              className="git-row git-link branch-row"
              aria-current={b.current || undefined}
              disabled={b.current || busy}
              title={b.worktree ? `Checked out in ${b.worktree}` : b.name}
              onClick={() => void pick(b.name, false)}
            >
              <span className="git-title trunc">{b.name}</span>
              <span className="git-meta">
                {pending === b.name
                  ? "Switching…"
                  : b.current
                    ? "Current"
                    : b.worktree
                      ? "Open in another folder"
                      : lastCommitLabel(b.updatedAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && !canCreate && <p className="deck-note">No branches match.</p>}
    </div>
  );
}
