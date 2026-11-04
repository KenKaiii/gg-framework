// Detect and score new commits made during an agent run. All failures are silent —
// progress must never break a run.

import crypto from "node:crypto";
import { runBackgroundGit } from "../../utils/git.js";
import type { ScoredCommit } from "./types.js";

const GIT_TIMEOUT_MS = 5_000;
const MAX_COMMITS_PER_DETECT = 50;
/** Commits authored earlier than runStart - 5min are treated as imports (pull), not work. */
const AUTHOR_WINDOW_SLACK_MS = 5 * 60 * 1000;

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const { stdout } = await runBackgroundGit(args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    input,
  });
  return stdout;
}

/** Stable key for a repo root, used in ProgressFile.repos. */
export function repoKey(repoRoot: string): string {
  return crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

export interface DetectResult {
  repoRoot: string;
  head: string;
  commits: ScoredCommit[];
}

/**
 * Detect new, scoreable commits since `lastHead`.
 * - `lastHead` undefined (first time seeing this repo) → record HEAD, score nothing.
 * - Merge commits excluded; commits authored before the run window excluded.
 * - Any git failure → null (silent).
 */
export async function detectNewCommits(
  cwd: string,
  lastHead: string | undefined,
  runStartedAt: number,
): Promise<DetectResult | null> {
  try {
    const repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    if (!repoRoot || !head) return null;

    if (!lastHead || lastHead === head) {
      return { repoRoot, head, commits: [] };
    }

    const sinceIso = new Date(runStartedAt - AUTHOR_WINDOW_SLACK_MS).toISOString();
    let shas: string[];
    try {
      const out = await git(cwd, [
        "rev-list",
        `${lastHead}..HEAD`,
        "--no-merges",
        `--since=${sinceIso}`,
        `--max-count=${MAX_COMMITS_PER_DETECT}`,
      ]);
      shas = out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // lastHead may be gone (rebase/gc) — reset the baseline without scoring.
      return { repoRoot, head, commits: [] };
    }

    const commits: ScoredCommit[] = [];
    for (const sha of shas.reverse()) {
      const scored = await scoreCommit(cwd, sha);
      if (scored) commits.push(scored);
    }
    return { repoRoot, head, commits };
  } catch {
    return null;
  }
}

async function scoreCommit(cwd: string, sha: string): Promise<ScoredCommit | null> {
  try {
    // Lines changed: numstat sums added+deleted; binary files show "-" and count 0.
    const numstat = await git(cwd, ["show", "--numstat", "--format=", sha]);
    let linesChanged = 0;
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const added = parseInt(parts[0], 10);
      const deleted = parseInt(parts[1], 10);
      if (Number.isFinite(added)) linesChanged += added;
      if (Number.isFinite(deleted)) linesChanged += deleted;
    }

    // Patch-id dedupe: revert/recommit of the same diff scores 0.
    let patchId = "";
    try {
      const diff = await git(cwd, ["show", sha]);
      const out = await git(cwd, ["patch-id", "--stable"], diff);
      patchId = out.trim().split(" ")[0] ?? "";
    } catch {
      patchId = "";
    }

    return { sha, patchId, linesChanged };
  } catch {
    return null;
  }
}
