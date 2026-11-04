// Git state for the project health checklist: stamped onto each record by the
// `checklist` tool, and compared against the live tree by the snapshot so
// findings from an older tree aren't shown as current.
import { CHECKLIST_FILE } from "./checklist-items.js";
import { runBackgroundGit } from "../utils/git.js";

export interface GitState {
  readonly commit: string | null;
  readonly uncommittedChanges: boolean;
}

/**
 * Short HEAD commit and whether the work tree differs from it. The record file
 * itself is ignored, since earlier records always leave it modified. Outside a
 * repo (or before the first commit) the commit is null.
 */
export async function readGitState(cwd: string, signal?: AbortSignal): Promise<GitState> {
  let commit: string | null = null;
  try {
    const { stdout } = await runBackgroundGit(["rev-parse", "--short", "HEAD"], {
      cwd,
      timeoutMs: 5000,
      ...(signal ? { signal } : {}),
    });
    commit = stdout.trim() || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    // An unborn repository can still have uncommitted files. Inspect status
    // even when it has no HEAD yet.
  }
  try {
    const { stdout } = await runBackgroundGit(
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd, timeoutMs: 10000, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
    const changed = stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 3)
      .some((line) => line.slice(3).replace(/^"|"$/g, "") !== CHECKLIST_FILE);
    return { commit, uncommittedChanges: changed };
  } catch (error) {
    if (signal?.aborted || commit !== null) throw error;
    return { commit, uncommittedChanges: false };
  }
}

/**
 * Whether the project has visibly moved on since a record was written: a
 * different HEAD, or local edits on a tree that was clean when checked. Edits
 * on top of an already-dirty tree can't be told apart, so this can miss
 * changes but never invents one. Unknown live state means "not changed".
 */
export function changedSinceCheck(
  recorded: { readonly checkedAt: string | null } & GitState,
  current: GitState | null,
): boolean {
  if (recorded.checkedAt === null || current === null) return false;
  if (recorded.commit !== current.commit) return true;
  return current.uncommittedChanges && !recorded.uncommittedChanges;
}
