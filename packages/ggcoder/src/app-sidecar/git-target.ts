import {
  getGitBranch,
  getGitDirtyFileCount,
  isGitRepo,
  type GitReadOptions,
} from "../utils/git.js";
import { getGitHubRepoSlug } from "../utils/github.js";

export interface GitState {
  branch: string | null;
  isRepo: boolean;
  dirtyFileCount: number;
  gitHubSlug: string | null;
  /**
   * False when git didn't answer whether this is a repo, or how many files
   * changed in one (a timeout on a busy machine): isRepo and dirtyFileCount
   * are then placeholders, and the caller should read again with more time.
   */
  settled: boolean;
}

/** Read a folder's git state; each part falls back on its own when git fails. */
export async function readGitState(dir: string, options: GitReadOptions = {}): Promise<GitState> {
  const [branch, isRepo, dirtyFileCount, gitHubSlug] = await Promise.all([
    getGitBranch(dir, options).catch(() => null),
    isGitRepo(dir, options).catch(() => null),
    getGitDirtyFileCount(dir, options).catch(() => null),
    getGitHubRepoSlug(dir).catch(() => null),
  ]);
  return {
    branch,
    isRepo: isRepo ?? false,
    dirtyFileCount: dirtyFileCount ?? 0,
    gitHubSlug,
    // Outside a repo the count fails by design; only a repo needs one.
    settled: isRepo === false || (isRepo === true && dirtyFileCount !== null),
  };
}
