import { runBackgroundGit } from "../utils/git.js";
import { log } from "../core/logger.js";

/** Read-only companion to a completed check; never supplies verification evidence. */
export async function collectVerificationReview(cwd: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted)
    return "Review not collected: cancelled. The check result above is unchanged.";
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 5_000);
  const started = performance.now();
  try {
    const options = { cwd, signal: combined, timeoutMs: 3_000, maxBuffer: 128 * 1024 };
    // Use the existing hardened runner: no repo hooks, filters, external diff,
    // textconv, submodule traversal or lazy network fetch. No model shell text.
    const [status, diff] = await Promise.all([
      runBackgroundGit(["status", "--short", "--untracked-files=normal", "--", "."], options),
      runBackgroundGit(
        ["diff", "--no-color", "--no-renames", "--ignore-submodules=all", "--", "."],
        options,
      ),
    ]);
    log("DEBUG", "verification-review", "Collected worktree review", {
      cwd,
      ms: Math.round(performance.now() - started),
    });
    return (
      "Read-only review (not another verification check). Tracked worktree diff against the index only; staged/untracked contents are not shown. Submodule contents are excluded. Inspect relevant omitted files separately.\n\n" +
      "Status:\n" +
      (status.stdout || "(clean)\n") +
      "\nWorktree diff:\n" +
      (diff.stdout || "(no tracked worktree changes)\n")
    );
  } catch {
    log("DEBUG", "verification-review", "Worktree review unavailable or incomplete", {
      cwd,
      ms: Math.round(performance.now() - started),
    });
    return "Review unavailable or incomplete (not a Git repo, output limit, timeout, or cancellation). The check result above is unchanged; do not claim the diff was reviewed.";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
