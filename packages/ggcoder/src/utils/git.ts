import { execFile } from "node:child_process";

export function getGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      },
    );
  });
}

/** Count staged, modified, deleted, renamed, and untracked files. */
export function getGitDirtyFileCount(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd, timeout: 2000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.split(/\r?\n/).filter(Boolean).length);
      },
    );
  });
}

/**
 * Whether `cwd` is inside a git work tree. Distinct from getGitBranch, which
 * returns null both for non-repos AND for freshly-init'd repos with no commits
 * (rev-parse HEAD fails before the first commit).
 */
export function isGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd, timeout: 2000 },
      (error, stdout) => {
        resolve(!error && stdout.trim() === "true");
      },
    );
  });
}
