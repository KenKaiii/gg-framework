import { execFile } from "node:child_process";

/**
 * Parse an `owner/repo` slug from a GitHub remote URL. Handles the three
 * common remote shapes: https (`https://github.com/o/r(.git)`), scp-style ssh
 * (`git@github.com:o/r(.git)`), and explicit ssh/git URLs
 * (`ssh://git@github.com/o/r`). Returns null for non-GitHub remotes.
 */
export function parseGitHubSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    ) ?? /^[^@/\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/** The `owner/repo` slug of the cwd's `origin` remote, or null when absent/non-GitHub. */
export function getGitHubRepoSlug(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 2000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parseGitHubSlug(stdout));
    });
  });
}

export interface GitHubOpenCounts {
  issues: number;
  prs: number;
}

function ghSearchTotalCount(slug: string, qualifier: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "api",
        `search/issues?q=repo:${slug}+${qualifier}+is:open&per_page=1`,
        "--jq",
        ".total_count",
      ],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const count = Number.parseInt(stdout.trim(), 10);
        if (Number.isNaN(count)) {
          reject(new Error(`unexpected gh output: ${stdout.trim()}`));
          return;
        }
        resolve(count);
      },
    );
  });
}

/**
 * Open issue + PR counts for a GitHub repo, via the `gh` CLI's own auth.
 * Returns null on ANY failure (gh missing, not authenticated, offline, rate
 * limited) — callers treat null as "unknown" and keep the UI chip hidden.
 */
export async function getGitHubOpenCounts(slug: string): Promise<GitHubOpenCounts | null> {
  try {
    const [issues, prs] = await Promise.all([
      ghSearchTotalCount(slug, "is:issue"),
      ghSearchTotalCount(slug, "is:pr"),
    ]);
    return { issues, prs };
  } catch {
    return null;
  }
}
