import { watch as fsWatch } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CHAT_AGENT_IDS, chatAgentSessionsDir } from "../chat-agents/index.js";
import { log } from "../core/logger.js";
import { buildSnapshot, levelForXp, rankForLevel } from "../core/progress/ranks.js";
import { loadProgress, peekProgress, updateProgress } from "../core/progress/store.js";
import { awardPrompt, awardCommits } from "../core/progress/engine.js";
import { detectNewCommits, repoKey } from "../core/progress/git-xp.js";
import { rebuildFromSessions } from "../core/progress/rebuild.js";
import type { RoyaleBugCategory } from "./royale-bug.js";

/** What a finished run did, beyond its commits, for GG Royale. */
export interface RunExtras {
  /** The goal this run worked on (its coordinator's run), if any. */
  goalId?: string | null;
  /** The run handed work to workers (spawn_agent). */
  workers?: boolean;
  /** A deploy or publish command ran and succeeded. */
  deployed?: boolean;
}

/** One run's outcome as GG Royale hears it (counts and labels only). */
export interface RunOutcome extends RunExtras {
  commits: number;
  bug?: RoyaleBugCategory | null;
}
import type { ProgressFile, ProgressSnapshot } from "../core/progress/types.js";

// ── Progress ("Ranks") ──────────────────────────────────────────────────
// Daemon-level XP/rank manager: one durable file (~/.gg/progress.json), awards
// applied under a file lock, snapshots broadcast to EVERY session's SSE clients,
// and an fs.watch on ~/.gg so writes from OTHER daemon processes (dev + packaged
// app side by side) re-broadcast here too — deduped by the lastEvent nonce.
// XP failures are debug-log-only; progress must never break a run.

export interface ProgressManager {
  /** Current snapshot for GET /progress + the SSE ready path. */
  snapshot: () => ProgressSnapshot;
  /** Award XP for one successfully completed run (prompt + any new commits). */
  awardRun: (
    cwd: string,
    runStartedAt: number,
    originId?: string,
    bug?: RoyaleBugCategory | null,
    extras?: RunExtras,
  ) => Promise<void>;
  /** Close the ~/.gg fs.watch + clear any pending debounce (leak-free shutdown). */
  dispose: () => void;
}

export async function createProgressManager(
  agentDir: string,
  broadcastAll: (snapshot: ProgressSnapshot, originId?: string) => void,
  /** Optional: called after each successful run award with the number of newly
   *  detected commits (0 if none). Must not throw (GG Royale reporting). */
  onRunAwarded?: (outcome: RunOutcome) => void,
): Promise<ProgressManager> {
  // Boot: recovery chain main → backup → coding + chat session rebuild → empty.
  const coderSessionsDir = path.join(agentDir, "sessions");
  let file: ProgressFile = await loadProgress({
    rebuild: () =>
      rebuildFromSessions([
        coderSessionsDir,
        ...CHAT_AGENT_IDS.map((agentId) => chatAgentSessionsDir(coderSessionsDir, agentId)),
      ]),
  });
  // Don't re-celebrate an old levelUp event on boot.
  let lastSeenNonce: string | null = file.lastEvent?.nonce ?? null;
  log("INFO", "app-sidecar", "progress loaded", {
    xp: String(file.xp),
    level: String(levelForXp(file.xp)),
  });

  function snapshot(): ProgressSnapshot {
    return buildSnapshot(file);
  }

  async function awardRun(
    cwd: string,
    runStartedAt: number,
    originId?: string,
    bug?: RoyaleBugCategory | null,
    extras: RunExtras = {},
  ): Promise<void> {
    try {
      const now = Date.now();
      let newCommits = 0;
      const updated = await updateProgress(async (f) => {
        const levelBefore = levelForXp(f.xp);
        awardPrompt(f, now, cwd);

        // Commit XP: probe repo root + HEAD, then score lastHead..HEAD bounded
        // by the run window. First sight of a repo records HEAD, scores nothing.
        const probe = await detectNewCommits(cwd, undefined, runStartedAt);
        if (probe) {
          const key = repoKey(probe.repoRoot);
          const lastHead = f.repos[key]?.lastHead;
          if (lastHead && lastHead !== probe.head) {
            const detected = await detectNewCommits(cwd, lastHead, runStartedAt);
            if (detected && detected.commits.length > 0) {
              awardCommits(f, detected.commits, now, cwd);
              newCommits = detected.commits.length;
            }
          }
          f.repos[key] = { lastHead: probe.head };
        }

        // One combined lastEvent per run so other windows celebrate exactly once.
        const levelAfter = levelForXp(f.xp);
        const levelUp =
          levelAfter > levelBefore
            ? { from: levelBefore, to: levelAfter, rankName: rankForLevel(levelAfter).name }
            : null;
        f.lastEvent = { nonce: randomUUID(), levelUp };
        return { file: f, levelledUp: levelUp !== null };
      });
      file = updated;
      lastSeenNonce = updated.lastEvent?.nonce ?? null;
      broadcastAll(buildSnapshot(updated), originId);
      try {
        onRunAwarded?.({ commits: newCommits, ...(bug ? { bug } : {}), ...extras });
      } catch (err) {
        log("DEBUG", "app-sidecar", "run outcome hook failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      log("DEBUG", "app-sidecar", "progress award failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Watch ~/.gg (dir watch survives the atomic tmp+rename) for progress.json
  // writes from other daemon processes; debounce, reload read-only, dedupe by nonce.
  let watchDebounce: NodeJS.Timeout | null = null;
  let progressWatcher: ReturnType<typeof fsWatch> | null = null;
  try {
    const watcher = fsWatch(agentDir, (_event, filename) => {
      if (filename !== "progress.json") return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        void (async () => {
          const reloaded = await peekProgress();
          if (!reloaded) return;
          const nonce = reloaded.lastEvent?.nonce ?? null;
          if (nonce === lastSeenNonce) return;
          file = reloaded;
          lastSeenNonce = nonce;
          broadcastAll(buildSnapshot(reloaded));
        })();
      }, 150);
    });
    watcher.unref();
    progressWatcher = watcher;
  } catch (err) {
    log("DEBUG", "app-sidecar", "progress watch unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Dispose closes the fs.watch handle (baseline #8: it was previously never
  // closed — a per-daemon leak) and clears any pending debounce timer.
  function dispose(): void {
    if (watchDebounce) {
      clearTimeout(watchDebounce);
      watchDebounce = null;
    }
    try {
      progressWatcher?.close();
    } catch {
      // Already closed / never opened — nothing to do.
    }
    progressWatcher = null;
  }

  return { snapshot, awardRun, dispose };
}
